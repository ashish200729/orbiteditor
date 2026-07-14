/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { MCPServerOfName, MCPConfigFileJSON, MCPConfigFileEntryJSON, MCPServer, MCPToolCallParams, RawMCPToolCall, MCPServerEventResponse, mergeMcpConfigs } from './mcpServiceTypes.js';
import { Event, Emitter } from '../../../../base/common/event.js';
import { InternalToolInfo } from './prompt/prompts.js';
import { IVoidSettingsService } from './orbitSettingsService.js';
import { MCPUserStateOfName } from './orbitSettingsTypes.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';


/** Scope of an MCP server: global (user) config or the current workspace's `.orbit/mcp.json`. */
export type MCPScope = 'user' | 'project';

type MCPServiceState = {
	mcpServerOfName: MCPServerOfName,
	// scope of each server by name (user vs project). Project overrides user on name collision.
	scopeOfName: { [serverName: string]: MCPScope },
	// merged enable state: user servers read from settings, project servers from workspace storage.
	isOnOfName: { [serverName: string]: boolean },
	error: string | undefined, // global parsing error
}

export interface IMCPService {
	readonly _serviceBrand: undefined;
	/** Opens the mcp.json for the given scope (defaults to user) in the editor. */
	revealMCPConfigFile(scope?: MCPScope): Promise<void>;
	toggleServerIsOn(serverName: string, isOn: boolean): Promise<void>;
	/** Run the OAuth login for a remote server that reported 'needs-auth'. */
	authenticateMCPServer(serverName: string): Promise<{ ok: boolean; error?: string }>;

	/** True if the current workspace has a folder we can write a project mcp.json into. */
	hasWorkspaceFolder(): boolean;

	/** Add a server to the given scope's mcp.json (creating the file if needed). */
	addMCPServer(name: string, entry: MCPConfigFileEntryJSON, scope: MCPScope): Promise<void>;
	/** Remove a server from the given scope's mcp.json. */
	removeMCPServer(name: string, scope: MCPScope): Promise<void>;
	/** Update an existing server's entry in the given scope's mcp.json. */
	updateMCPServer(name: string, entry: MCPConfigFileEntryJSON, scope: MCPScope): Promise<void>;
	/** True when a server with this name already exists in the given scope. */
	serverExists(name: string, scope: MCPScope): Promise<boolean>;

	readonly state: MCPServiceState; // NOT persisted
	onDidChangeState: Event<void>;

	getMCPTools(): InternalToolInfo[] | undefined;
	callMCPTool(toolData: MCPToolCallParams, token?: CancellationToken): Promise<{ result: RawMCPToolCall }>;
	stringifyResult(result: RawMCPToolCall): string
}

export const IMCPService = createDecorator<IMCPService>('mcpConfigService');



const MCP_CONFIG_FILE_NAME = 'mcp.json';
// Default mcp.json written when the user has no config. The built-in
// `orbit-ide-browser` server (Browser Automation toggle in Settings) covers
// the common case of agent-driven browser automation without needing an
// external stdio server, so we no longer ship `chrome-devtools` by default.
const MCP_CONFIG_SAMPLE = {
	mcpServers: {}
};
const MCP_CONFIG_SAMPLE_STRING = JSON.stringify(MCP_CONFIG_SAMPLE, null, 2);

// Workspace-scoped storage key holding the enable map for project MCP servers,
// so toggling a `.orbit/mcp.json` server in one folder does not affect another.
const WORKSPACE_MCP_ENABLE_KEY = 'orbit.mcp.workspaceEnabled';


class MCPService extends Disposable implements IMCPService {
	_serviceBrand: undefined;


	private readonly channel: IChannel // MCPChannel

	// list of MCP servers pulled from mcpChannel
	state: MCPServiceState = {
		mcpServerOfName: {},
		scopeOfName: {},
		isOnOfName: {},
		error: undefined,
	}

	// Emitters for server events
	private readonly _onDidChangeState = new Emitter<void>();
	public readonly onDidChangeState = this._onDidChangeState.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IProductService private readonly productService: IProductService,
		@IEditorService private readonly editorService: IEditorService,
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this.channel = this.mainProcessService.getChannel('void-channel-mcp')


		const onEvent = (e: MCPServerEventResponse) => {
			this._setMCPServerState(e.response.name, e.response.newServer)
		}
		this._register((this.channel.listen('onAdd_server') satisfies Event<MCPServerEventResponse>)(onEvent));
		this._register((this.channel.listen('onUpdate_server') satisfies Event<MCPServerEventResponse>)(onEvent));
		this._register((this.channel.listen('onDelete_server') satisfies Event<MCPServerEventResponse>)(onEvent));

		// Sync the Browser Automation setting to the main-process MCP channel so
		// the built-in `orbit-ide-browser` server enables/disables live.
		this._register(voidSettingsService.onDidChangeState(() => {
			const enabled = voidSettingsService.state.globalSettings.browserAutomationEnabled;
			this.channel.call('setBrowserAutomationEnabled', { enabled }).catch(() => { /* ignore */ });
		}));

		// Re-merge when the workspace folders change (e.g. opening a project folder
		// makes its .orbit/mcp.json available). Also rebuild the per-file watchers so the
		// new project config file is observed for live edits.
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this._refreshMCPConfigFileWatchers();
			this._refreshMCPServers().catch(err => console.error('Error refreshing MCP after workspace change:', err));
		}));

		this._initialize();
	}


	private async _initialize() {
		try {
			await this.voidSettingsService.waitForInitState;

			// Create the USER mcp.json if it doesn't exist (project file is only
			// created lazily on first project-scoped add).
			const userConfigUri = await this._getMCPConfigFilePath('user');
			const fileExists = userConfigUri ? await this._configFileExists(userConfigUri) : false;
			if (userConfigUri && !fileExists) {
				await this._createMCPConfigFile(userConfigUri);
				console.log('MCP Config file created:', userConfigUri.toString());
			}
			await this._addMCPConfigFileWatcher();
			await this._refreshMCPServers();
			// Sync Browser Automation BEFORE emitting built-in servers.
			try {
				const enabled = this.voidSettingsService.state.globalSettings.browserAutomationEnabled;
				await this.channel.call('setBrowserAutomationEnabled', { enabled });
			} catch (error) {
				console.error('Error syncing browser automation enabled flag:', error);
			}
			try {
				await this.channel.call('emitBuiltinServers', {});
			} catch (error) {
				console.error('Error emitting built-in MCP servers:', error);
			}
		} catch (error) {
			console.error('Error initializing MCPService:', error);
		}
	}

	private readonly _setMCPServerState = async (serverName: string, newServer: MCPServer | undefined) => {
		if (newServer === undefined) {
			const { [serverName]: removed, ...remainingServers } = this.state.mcpServerOfName;
			this.state = {
				...this.state,
				mcpServerOfName: remainingServers
			}
		} else {
			this.state = {
				...this.state,
				mcpServerOfName: {
					...this.state.mcpServerOfName,
					[serverName]: newServer
				}
			}
		}
		this._onDidChangeState.fire();
	}

	private readonly _setHasError = async (errMsg: string | undefined) => {
		this.state = {
			...this.state,
			error: errMsg,
		}
		this._onDidChangeState.fire();
	}

	// Create the file/directory if it doesn't exist
	private async _createMCPConfigFile(mcpConfigUri: URI): Promise<void> {
		await this.fileService.createFile(mcpConfigUri.with({ path: mcpConfigUri.path }));
		const buffer = VSBuffer.fromString(MCP_CONFIG_SAMPLE_STRING);
		await this.fileService.writeFile(mcpConfigUri, buffer);
	}


	// Holds the current per-file config watchers. Replaced wholesale on workspace-folder
	// changes so the new project config file is watched and stale handles are released.
	private readonly _configWatcherStore = this._register(new DisposableStore());

	private async _addMCPConfigFileWatcher(): Promise<void> {
		this._refreshMCPConfigFileWatchers();
	}

	private async _refreshMCPConfigFileWatchers(): Promise<void> {
		this._configWatcherStore.clear();
		// Watch both user and project config files. The project URI can change when the
		// workspace folders change, so this is re-invoked from the workspace-change listener.
		for (const scope of ['user', 'project'] as const) {
			const uri = await this._getMCPConfigFilePath(scope);
			if (!uri) continue;
			this._configWatcherStore.add(this.fileService.watch(uri));
		}

		this._configWatcherStore.add(this.fileService.onDidFilesChange(async e => {
			const userUri = await this._getMCPConfigFilePath('user');
			const projectUri = await this._getMCPConfigFilePath('project');
			const changed = (userUri && e.contains(userUri)) || (projectUri && e.contains(projectUri));
			if (!changed) return;
			await this._refreshMCPServers();
		}));
	}

	// Client-side functions

	public hasWorkspaceFolder(): boolean {
		return this.workspaceContextService.getWorkspace().folders.length > 0;
	}

	public async revealMCPConfigFile(scope: MCPScope = 'user'): Promise<void> {
		try {
			let mcpConfigUri = await this._getMCPConfigFilePath(scope);
			if (!mcpConfigUri) return;
			// Create-on-reveal for project scope so the user gets an editable file.
			if (scope === 'project' && !(await this._configFileExists(mcpConfigUri))) {
				await this._createMCPConfigFile(mcpConfigUri);
			}
			await this.editorService.openEditor({
				resource: mcpConfigUri,
				options: {
					pinned: true,
					revealIfOpened: true,
				}
			});
		} catch (error) {
			console.error('Error opening MCP config file:', error);
		}
	}

	public getMCPTools(): InternalToolInfo[] | undefined {
		const allTools: InternalToolInfo[] = []
		for (const serverName in this.state.mcpServerOfName) {
			const server = this.state.mcpServerOfName[serverName];
			server.tools?.forEach(tool => {
				allTools.push({
					description: tool.description || '',
					params: this._transformInputSchemaToParams(tool.inputSchema),
					name: tool.name,
					mcpServerName: serverName,
					annotations: tool.annotations,
				})
			})
		}
		if (allTools.length === 0) return undefined
		return allTools
	}

	private _transformInputSchemaToParams(inputSchema?: Record<string, any>): { [paramName: string]: { description: string } } {

		if (!inputSchema || !inputSchema.properties) return {};

		const params: { [paramName: string]: { description: string } } = {};
		Object.keys(inputSchema.properties).forEach(paramName => {
			const propertyValues = inputSchema.properties[paramName];

			if (typeof propertyValues !== 'object') {
				console.warn(`Invalid property value for ${paramName}: expected object, got ${typeof propertyValues}`);
				return;
			}

			params[paramName] = {
				description: JSON.stringify(propertyValues.description || '', null, 2) || '',
			}
		});
		return params;
	}

	// Returns the config file URI for the given scope, or undefined if unavailable
	// (project scope with no workspace folder open).
	private async _getMCPConfigFilePath(scope: MCPScope): Promise<URI | undefined> {
		if (scope === 'user') {
			const appName = this.productService.dataFolderName
			const userHome = await this.pathService.userHome();
			return URI.joinPath(userHome, appName, MCP_CONFIG_FILE_NAME)
		}
		// project scope: <first workspace folder>/.orbit/mcp.json
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) return undefined;
		return URI.joinPath(folders[0].uri, '.orbit', MCP_CONFIG_FILE_NAME);
	}

	private async _configFileExists(mcpConfigUri: URI): Promise<boolean> {
		try {
			await this.fileService.stat(mcpConfigUri);
			return true;
		} catch (error) {
			return false;
		}
	}


	// Parse a single scope's config file. Returns null if the file doesn't exist
	// (project scope commonly has none) and sets the global error only for user scope
	// parse failures — a malformed project file shouldn't wipe the user's servers.
	private async _parseMCPConfigFileForScope(scope: MCPScope): Promise<MCPConfigFileJSON | null> {
		const mcpConfigUri = await this._getMCPConfigFilePath(scope);
		if (!mcpConfigUri) return null;
		if (!(await this._configFileExists(mcpConfigUri))) return null;
		try {
			const fileContent = await this.fileService.readFile(mcpConfigUri);
			const contentString = fileContent.value.toString();
			const configFileJson = JSON.parse(contentString);
			if (!configFileJson.mcpServers) {
				throw new Error('Missing mcpServers property');
			}
			return configFileJson as MCPConfigFileJSON;
		} catch (error) {
			const fullError = `Error parsing ${scope} MCP config file: ${error}`;
			this._setHasError(fullError)
			return null;
		}
	}

	// Merge user + project configs. Project overrides user on name collision.
	// Returns the merged server map plus the scope each name resolved to.
	private async _loadMergedConfig(): Promise<{ merged: MCPConfigFileJSON, scopeOfName: { [name: string]: MCPScope } }> {
		const userConfig = await this._parseMCPConfigFileForScope('user');
		const projectConfig = await this._parseMCPConfigFileForScope('project');
		const { mcpServers, scopeOfName } = mergeMcpConfigs(userConfig, projectConfig);
		return { merged: { mcpServers }, scopeOfName };
	}

	// ---- workspace-scoped enable map (project servers) --------------------------------

	private _readWorkspaceEnableMap(): { [name: string]: boolean } {
		try {
			const raw = this.storageService.get(WORKSPACE_MCP_ENABLE_KEY, StorageScope.WORKSPACE);
			if (!raw) return {};
			return JSON.parse(raw) as { [name: string]: boolean };
		} catch {
			return {};
		}
	}

	private _writeWorkspaceEnableMap(map: { [name: string]: boolean }): void {
		this.storageService.store(WORKSPACE_MCP_ENABLE_KEY, JSON.stringify(map), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	// Builds the combined enable map: user servers from settings, project servers
	// from workspace storage (default on).
	private _buildIsOnOfName(scopeOfName: { [name: string]: MCPScope }): { [name: string]: boolean } {
		const wsEnable = this._readWorkspaceEnableMap();
		const isOnOfName: { [name: string]: boolean } = {};
		for (const [name, scope] of Object.entries(scopeOfName)) {
			if (scope === 'project') {
				isOnOfName[name] = wsEnable[name] ?? true;
			} else {
				isOnOfName[name] = this.voidSettingsService.state.mcpUserStateOfName[name]?.isOn ?? true;
			}
		}
		return isOnOfName;
	}

	// Handle server state changes
	private async _refreshMCPServers(): Promise<void> {

		this._setHasError(undefined)

		const { merged: newConfigFileJSON, scopeOfName } = await this._loadMergedConfig();
		if (!newConfigFileJSON?.mcpServers) { console.log(`Not setting state: no MCP servers found`); return }

		const oldConfigFileNames = Object.keys(this.state.mcpServerOfName)
		const newConfigFileNames = Object.keys(newConfigFileJSON.mcpServers)

		const addedServerNames = newConfigFileNames.filter(serverName => !oldConfigFileNames.includes(serverName));
		const removedServerNames = oldConfigFileNames.filter(serverName => !newConfigFileNames.includes(serverName));

		// set isOn to any new USER servers in the config (project enable lives in workspace storage)
		const addedUserStateOfName: MCPUserStateOfName = {}
		for (const name of addedServerNames) {
			if (scopeOfName[name] === 'user') addedUserStateOfName[name] = { isOn: true }
		}
		await this.voidSettingsService.addMCPUserStateOfNames(addedUserStateOfName);

		// delete isOn for any user servers that no longer show up in the config
		const removedUserServerNames = removedServerNames.filter(n => this.state.scopeOfName[n] === 'user' || this.state.scopeOfName[n] === undefined)
		await this.voidSettingsService.removeMCPUserStateOfNames(removedUserServerNames);

		// build combined enable map + record scope in state
		const isOnOfName = this._buildIsOnOfName(scopeOfName);
		this.state = { ...this.state, scopeOfName, isOnOfName };

		// set all servers to loading
		for (const serverName in newConfigFileJSON.mcpServers) {
			this._setMCPServerState(serverName, { status: 'loading', tools: [] })
		}
		const updatedServerNames = newConfigFileNames.filter(serverName => !addedServerNames.includes(serverName) && !removedServerNames.includes(serverName))

		// combined userStateOfName for the channel (unique names across scopes)
		const combinedUserStateOfName: MCPUserStateOfName = {}
		for (const [name, isOn] of Object.entries(isOnOfName)) { combinedUserStateOfName[name] = { isOn } }

		this.channel.call('refreshMCPServers', {
			mcpConfigFileJSON: newConfigFileJSON,
			addedServerNames,
			removedServerNames,
			updatedServerNames,
			userStateOfName: combinedUserStateOfName,
		})
	}

	stringifyResult(result: RawMCPToolCall): string {
		let toolResultStr: string
		if (result.event === 'text') {
			toolResultStr = result.text
		} else if (result.event === 'image') {
			toolResultStr = result.text?.trim()
				? result.text
				: `[Image: ${result.image.mimeType}]`
		} else if (result.event === 'audio') {
			toolResultStr = `[Audio content]`
		} else if (result.event === 'resource') {
			toolResultStr = `[Resource content]`
		} else {
			toolResultStr = JSON.stringify(result)
		}
		return toolResultStr
	}

	// toggle MCP server and persist isOn in the right store for its scope
	public async toggleServerIsOn(serverName: string, isOn: boolean): Promise<void> {
		this._setMCPServerState(serverName, { status: 'loading', tools: [] })

		const scope = this.state.scopeOfName[serverName] ?? 'user';
		if (scope === 'project') {
			const map = this._readWorkspaceEnableMap();
			map[serverName] = isOn;
			this._writeWorkspaceEnableMap(map);
		} else {
			await this.voidSettingsService.setMCPServerState(serverName, { isOn });
		}
		this.state = { ...this.state, isOnOfName: { ...this.state.isOnOfName, [serverName]: isOn } };
		this._onDidChangeState.fire();
		this.channel.call('toggleMCPServer', { serverName, isOn })
	}

	// ---- config file mutation (marketplace + Add dialog) ------------------------------

	private async _readOrInitConfig(scope: MCPScope): Promise<{ uri: URI, json: MCPConfigFileJSON }> {
		const uri = await this._getMCPConfigFilePath(scope);
		if (!uri) throw new Error(`No ${scope} MCP config path available (open a workspace folder first).`);
		if (!(await this._configFileExists(uri))) {
			await this._createMCPConfigFile(uri);
		}
		const parsed = await this._parseMCPConfigFileForScope(scope);
		const json: MCPConfigFileJSON = parsed?.mcpServers ? parsed : { mcpServers: {} };
		return { uri, json };
	}

	private async _writeConfig(uri: URI, json: MCPConfigFileJSON): Promise<void> {
		const buffer = VSBuffer.fromString(JSON.stringify(json, null, 2));
		await this.fileService.writeFile(uri, buffer);
		// The file watcher fires _refreshMCPServers; nudge in case it debounces.
		await this._refreshMCPServers();
	}

	public async serverExists(name: string, scope: MCPScope): Promise<boolean> {
		const parsed = await this._parseMCPConfigFileForScope(scope);
		return !!parsed?.mcpServers?.[name];
	}

	public async addMCPServer(name: string, entry: MCPConfigFileEntryJSON, scope: MCPScope): Promise<void> {
		const { uri, json } = await this._readOrInitConfig(scope);
		json.mcpServers[name] = entry;
		await this._writeConfig(uri, json);
	}

	public async updateMCPServer(name: string, entry: MCPConfigFileEntryJSON, scope: MCPScope): Promise<void> {
		const { uri, json } = await this._readOrInitConfig(scope);
		json.mcpServers[name] = entry;
		await this._writeConfig(uri, json);
	}

	public async removeMCPServer(name: string, scope: MCPScope): Promise<void> {
		const uri = await this._getMCPConfigFilePath(scope);
		if (!uri || !(await this._configFileExists(uri))) return;
		const parsed = await this._parseMCPConfigFileForScope(scope);
		if (!parsed?.mcpServers) return;
		delete parsed.mcpServers[name];
		// clean up workspace enable entry for project servers
		if (scope === 'project') {
			const map = this._readWorkspaceEnableMap();
			if (name in map) { delete map[name]; this._writeWorkspaceEnableMap(map); }
		}
		await this._writeConfig(uri, parsed);
	}


	public async authenticateMCPServer(serverName: string): Promise<{ ok: boolean; error?: string }> {
		// Reflect the in-flight state immediately; the channel will emit the final state.
		this._setMCPServerState(serverName, { status: 'loading', tools: [] });
		try {
			const result = await this.channel.call<{ ok: boolean; error?: string }>('authenticateMCPServer', { serverName });
			return result ?? { ok: false, error: 'Authentication failed.' };
		} catch (err) {
			return { ok: false, error: `${err}` };
		}
	}

	public async callMCPTool(toolData: MCPToolCallParams, token?: CancellationToken): Promise<{ result: RawMCPToolCall }> {
		const result = await this.channel.call<RawMCPToolCall>('callTool', toolData, token);
		if (result.event === 'error') {
			throw new Error(`Error: ${result.text}`)
		}
		return { result };
	}
}

registerSingleton(IMCPService, MCPService, InstantiationType.Eager);
