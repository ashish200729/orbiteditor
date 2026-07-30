/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { dirname } from '../../../../base/common/resources.js';
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
import { MCPServerOfName, MCPConfigFileJSON, MCPConfigFileEntryJSON, MCPServer, MCPToolCallParams, RawMCPToolCall, MCPServerEventResponse, mergeMcpConfigsForProjects } from './mcpServiceTypes.js';
import { Event, Emitter } from '../../../../base/common/event.js';
import { InternalToolInfo } from './prompt/prompts.js';
import { IVoidSettingsService } from './orbitSettingsService.js';
import { MCPUserStateOfName } from './orbitSettingsTypes.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { AGENT_PROJECT_WORKSPACES_STORAGE_KEY } from './storageKeys.js';
import { parseAgentWorkspaceState } from './agentWorkspaceHelpers.js';


/** Scope of an MCP server: global (user) config or the current workspace's `.orbit/mcp.json`. */
export type MCPScope = 'user' | 'project';

type MCPServiceState = {
	mcpServerOfName: MCPServerOfName,
	// scope of each server by name (user vs project). Project overrides user on name collision.
	scopeOfName: { [serverName: string]: MCPScope },
	// For project-scoped servers in a multi-root agent workspace, records the
	// workspace-folder URI string whose `.orbit/mcp.json` contributed the
	// winning entry on a name collision. `undefined` for user-scoped servers
	// and for project servers sourced from the IDE's first workspace folder
	// (legacy path). Lets the UI attribute a server to its source folder
	// instead of collapsing every project server to a bare 'project' label. #9.
	projectFolderOfName: { [serverName: string]: string | undefined },
	// merged enable state: user servers read from settings, project servers from workspace storage.
	isOnOfName: { [serverName: string]: boolean },
	error: string | undefined, // global parsing error
}

export interface IMCPService {
	readonly _serviceBrand: undefined;
	/** Opens the mcp.json for the given scope (defaults to user) in the editor. */
	revealMCPConfigFile(scope?: MCPScope, projectFolderUri?: string): Promise<void>;
	toggleServerIsOn(serverName: string, isOn: boolean): Promise<void>;
	/** Run the OAuth login for a remote server that reported 'needs-auth'. */
	authenticateMCPServer(serverName: string): Promise<{ ok: boolean; error?: string }>;

	/** True if the current workspace has a folder we can write a project mcp.json into. */
	hasWorkspaceFolder(): boolean;

	/** Add a server to the given scope's mcp.json (creating the file if needed). */
	addMCPServer(name: string, entry: MCPConfigFileEntryJSON, scope: MCPScope, projectFolderUri?: string): Promise<void>;
	/** Remove a server from the given scope's mcp.json. */
	removeMCPServer(name: string, scope: MCPScope, projectFolderUri?: string): Promise<void>;
	/** Update an existing server's entry in the given scope's mcp.json. */
	updateMCPServer(name: string, entry: MCPConfigFileEntryJSON, scope: MCPScope, projectFolderUri?: string): Promise<void>;
	/** True when a server with this name already exists in the given scope. */
	serverExists(name: string, scope: MCPScope, projectFolderUri?: string): Promise<boolean>;

	readonly state: MCPServiceState; // NOT persisted
	onDidChangeState: Event<void>;

	getMCPTools(agentWorkspaceId?: string | null): InternalToolInfo[] | undefined;
	callMCPTool(toolData: MCPToolCallParams, token?: CancellationToken, agentWorkspaceId?: string | null): Promise<{ result: RawMCPToolCall }>;
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
const IDE_MCP_CONTEXT = 'ide';
const PROJECT_RUNTIME_PREFIX = 'orbit-project:';

const agentMcpContext = (workspaceId: string | null): string => `agent:${workspaceId ?? 'no-repo'}`;
// Preserve historical user server ids so OAuth tokens and cached auth sessions
// continue to resolve after the context-isolation upgrade.
const runtimeUserName = (name: string): string => name;
const runtimeProjectName = (context: string, name: string): string => `${PROJECT_RUNTIME_PREFIX}${encodeURIComponent(context)}:${encodeURIComponent(name)}`;


class MCPService extends Disposable implements IMCPService {
	_serviceBrand: undefined;


	private readonly channel: IChannel // MCPChannel

	// list of MCP servers pulled from mcpChannel
	state: MCPServiceState = {
		mcpServerOfName: {},
		scopeOfName: {},
		projectFolderOfName: {},
		isOnOfName: {},
		error: undefined,
	}
	private readonly runtimeServerOfName: MCPServerOfName = {};
	private configuredRuntimeNames = new Set<string>();
	private readonly knownExternalRuntimeNames = new Set<string>();
	private readonly logicalRuntimeNameByContext = new Map<string, Record<string, string>>();
	private readonly scopeOfNameByContext = new Map<string, Record<string, MCPScope>>();
	private readonly projectFolderOfNameByContext = new Map<string, Record<string, string | undefined>>();
	private readonly isOnOfNameByContext = new Map<string, Record<string, boolean>>();

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
			this._setRuntimeMCPServerState(e.response.name, e.response.newServer)
		}
		this._register((this.channel.listen('onAdd_server') satisfies Event<MCPServerEventResponse>)(onEvent));
		this._register((this.channel.listen('onUpdate_server') satisfies Event<MCPServerEventResponse>)(onEvent));
		this._register((this.channel.listen('onDelete_server') satisfies Event<MCPServerEventResponse>)(onEvent));

		// Sync the Browser Automation setting to the main-process MCP channel so
		// the built-in `orbit-ide-browser` server enables/disables live.
		this._register(voidSettingsService.onDidChangeState(() => {
			const enabled = voidSettingsService.state.globalSettings.browserAutomationEnabled;
			this.channel.call('setBrowserAutomationEnabled', { enabled }).then(
				() => {
					// Clear a prior sync error once the toggle succeeds again.
					if (this.state.error?.includes('Browser Automation')) {
						void this._setHasError(undefined);
					}
				},
				(err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					console.error('Error syncing browser automation enabled flag:', err);
					void this._setHasError(
						`Browser Automation could not be ${enabled ? 'enabled' : 'disabled'}: ${message}. Check MCP / main-process logs, then toggle again.`,
					);
				},
			);
		}));

		// Re-merge when the workspace folders change (e.g. opening a project folder
		// makes its .orbit/mcp.json available). Also rebuild the per-file watchers so the
		// new project config file is observed for live edits.
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this._refreshMCPConfigFileWatchers();
			this._refreshMCPServers().catch(err => console.error('Error refreshing MCP after workspace change:', err));
		}));

		// Agent-window workspace switches persist to APPLICATION storage — re-merge MCP.
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, AGENT_PROJECT_WORKSPACES_STORAGE_KEY, this._store)(() => {
			this._refreshMCPConfigFileWatchers();
			this._refreshMCPServers().catch(err => console.error('Error refreshing MCP after agent workspace change:', err));
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
				const message = error instanceof Error ? error.message : String(error);
				await this._setHasError(
					`Browser Automation could not be synced on startup: ${message}. Toggle it in Settings to retry.`,
				);
			}
			try {
				await this.channel.call('emitBuiltinServers', {});
			} catch (error) {
				console.error('Error emitting built-in MCP servers:', error);
				const message = error instanceof Error ? error.message : String(error);
				await this._setHasError(
					`Built-in MCP servers failed to start: ${message}. Open Settings → MCP and refresh, or restart Orbit.`,
				);
			}
		} catch (error) {
			console.error('Error initializing MCPService:', error);
			const message = error instanceof Error ? error.message : String(error);
			await this._setHasError(`MCP failed to initialize: ${message}`);
		}
	}

	private _publishIDEState(): void {
		const mapping = this.logicalRuntimeNameByContext.get(IDE_MCP_CONTEXT) ?? {};
		const mcpServerOfName: MCPServerOfName = {};
		for (const [logicalName, runtimeName] of Object.entries(mapping)) {
			const server = this.runtimeServerOfName[runtimeName];
			if (server) mcpServerOfName[logicalName] = server;
		}
		// Built-ins are global and are not part of a config context.
		for (const [name, server] of Object.entries(this.runtimeServerOfName)) {
			if (!this.knownExternalRuntimeNames.has(name)) mcpServerOfName[name] = server;
		}
		this.state = {
			...this.state,
			mcpServerOfName,
			scopeOfName: { ...(this.scopeOfNameByContext.get(IDE_MCP_CONTEXT) ?? {}) },
			projectFolderOfName: { ...(this.projectFolderOfNameByContext.get(IDE_MCP_CONTEXT) ?? {}) },
			isOnOfName: { ...(this.isOnOfNameByContext.get(IDE_MCP_CONTEXT) ?? {}) },
		};
		this._onDidChangeState.fire();
	}

	private readonly _setRuntimeMCPServerState = async (serverName: string, newServer: MCPServer | undefined) => {
		if (newServer === undefined) {
			delete this.runtimeServerOfName[serverName];
		} else {
			this.runtimeServerOfName[serverName] = newServer;
		}
		this._publishIDEState();
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
		// Watch user + IDE projects + every configured agent workspace project.
		const userUri = await this._getMCPConfigFilePath('user');
		const projectUris = await this._getEveryProjectMCPConfigUri();
		const watched = [userUri, ...projectUris].filter((u): u is URI => !!u);
		for (const uri of watched) {
			this._configWatcherStore.add(this.fileService.watch(uri));
		}

		this._configWatcherStore.add(this.fileService.onDidFilesChange(async e => {
			const changed = watched.some(uri => e.contains(uri));
			if (!changed) return;
			await this._refreshMCPServers();
		}));
	}

	private _getAgentProjectUrisByContext(): Map<string, URI[]> {
		const result = new Map<string, URI[]>();
		const raw = this.storageService.get(AGENT_PROJECT_WORKSPACES_STORAGE_KEY, StorageScope.APPLICATION);
		const state = parseAgentWorkspaceState(raw);
		result.set(agentMcpContext(null), []);
		for (const [workspaceId, workspace] of Object.entries(state.workspaces)) {
			const uris: URI[] = [];
			for (const folder of workspace.folders) {
				try { uris.push(URI.joinPath(URI.parse(folder.uri), '.orbit', MCP_CONFIG_FILE_NAME)); } catch { /* skip */ }
			}
			result.set(agentMcpContext(workspaceId), uris);
		}
		return result;
	}

	private async _getEveryProjectMCPConfigUri(): Promise<URI[]> {
		const all = [...await this._getAllProjectMCPConfigUris()];
		for (const uris of this._getAgentProjectUrisByContext().values()) all.push(...uris);
		const seen = new Set<string>();
		return all.filter(uri => {
			const key = uri.toString();
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}

	// Client-side functions

	public hasWorkspaceFolder(): boolean {
		return this.workspaceContextService.getWorkspace().folders.length > 0;
	}

	public async revealMCPConfigFile(scope: MCPScope = 'user', projectFolderUri?: string): Promise<void> {
		try {
			let mcpConfigUri = await this._getMCPConfigFilePath(scope, projectFolderUri);
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

	public getMCPTools(agentWorkspaceId?: string | null): InternalToolInfo[] | undefined {
		const allTools: InternalToolInfo[] = []
		const context = agentWorkspaceId === undefined ? IDE_MCP_CONTEXT : agentMcpContext(agentWorkspaceId);
		const mapping = this.logicalRuntimeNameByContext.get(context) ?? {};
		const servers = new Map<string, MCPServer>();
		for (const [logicalName, runtimeName] of Object.entries(mapping)) {
			const server = this.runtimeServerOfName[runtimeName];
			if (server) servers.set(logicalName, server);
		}
		for (const [name, server] of Object.entries(this.runtimeServerOfName)) {
			if (!this.knownExternalRuntimeNames.has(name)) servers.set(name, server);
		}
		for (const [serverName, server] of servers) {
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
	private async _getMCPConfigFilePath(scope: MCPScope, projectFolderUri?: string): Promise<URI | undefined> {
		if (scope === 'user') {
			const appName = this.productService.dataFolderName
			const userHome = await this.pathService.userHome();
			return URI.joinPath(userHome, appName, MCP_CONFIG_FILE_NAME)
		}
		if (projectFolderUri) {
			try { return URI.joinPath(URI.parse(projectFolderUri), '.orbit', MCP_CONFIG_FILE_NAME); } catch { return undefined; }
		}
		// project scope: <first IDE workspace folder>/.orbit/mcp.json
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
	private async _parseMCPConfigFileForScope(scope: MCPScope, projectFolderUri?: string): Promise<MCPConfigFileJSON | null> {
		const mcpConfigUri = await this._getMCPConfigFilePath(scope, projectFolderUri);
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

	private async _parseMCPConfigFileAtUri(mcpConfigUri: URI, scopeLabel: string): Promise<MCPConfigFileJSON | null> {
		try {
			const exists = await this._configFileExists(mcpConfigUri);
			if (!exists) {
				return null;
			}
			const fileContent = await this.fileService.readFile(mcpConfigUri);
			const configFileJson = JSON.parse(fileContent.value.toString());
			if (!configFileJson.mcpServers) {
				throw new Error('Missing mcpServers property');
			}
			return configFileJson as MCPConfigFileJSON;
		} catch (error) {
			// Only surface parse errors for the primary project path / user via caller.
			console.warn(`[mcp] Error parsing ${scopeLabel} MCP config at ${mcpConfigUri.fsPath}:`, error);
			return null;
		}
	}

	/** All IDE project-scope mcp.json URIs. Agent contexts are loaded separately. */
	private async _getAllProjectMCPConfigUris(): Promise<URI[]> {
		const uris: URI[] = [];
		const seen = new Set<string>();
		const push = (uri: URI) => {
			const key = uri.toString().toLowerCase();
			if (seen.has(key)) {
				return;
			}
			seen.add(key);
			uris.push(uri);
		};

		for (const folder of this.workspaceContextService.getWorkspace().folders) {
			push(URI.joinPath(folder.uri, '.orbit', MCP_CONFIG_FILE_NAME));
		}
		return uris;
	}

	// Merge user + all project mcp.json files (agent multi-root). Later project files win on name collision.
	// Tracks which workspace-folder URI contributed each project server so the UI
	// can attribute a server to its source folder in a multi-root workspace. #9.
	private async _loadMergedConfig(projectUris: URI[]): Promise<{
		merged: MCPConfigFileJSON,
		scopeOfName: { [name: string]: MCPScope },
		projectFolderOfName: { [name: string]: string | undefined },
	}> {
		const userConfig = await this._parseMCPConfigFileForScope('user');
		// Derive each project URI's workspace-folder URI (parent of `.orbit/mcp.json`).
		const folderOfProjectUri = (mcpUri: URI): string => dirname(dirname(mcpUri)).toString();
		const projects: Array<{ config: MCPConfigFileJSON | null; folderUri: string }> = [];
		for (const uri of projectUris) {
			const projectConfig = await this._parseMCPConfigFileAtUri(uri, 'project');
			projects.push({ config: projectConfig, folderUri: folderOfProjectUri(uri) });
		}
		const { mcpServers, scopeOfName, projectFolderOfName } = mergeMcpConfigsForProjects(userConfig, projects);
		return { merged: { mcpServers }, scopeOfName, projectFolderOfName };
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
		const contexts = new Map<string, URI[]>();
		contexts.set(IDE_MCP_CONTEXT, await this._getAllProjectMCPConfigUris());
		for (const [context, uris] of this._getAgentProjectUrisByContext()) contexts.set(context, uris);

		const runtimeServers: Record<string, MCPConfigFileEntryJSON> = {};
		const runtimeIsOn: Record<string, boolean> = {};
		const nextMappings = new Map<string, Record<string, string>>();
		const nextScopes = new Map<string, Record<string, MCPScope>>();
		const nextFolders = new Map<string, Record<string, string | undefined>>();
		const nextEnabled = new Map<string, Record<string, boolean>>();
		for (const [context, projectUris] of contexts) {
			const { merged, scopeOfName, projectFolderOfName } = await this._loadMergedConfig(projectUris);
			const logicalToRuntime: Record<string, string> = {};
			const logicalEnabled = context === IDE_MCP_CONTEXT
				? this._buildIsOnOfName(scopeOfName)
				: Object.fromEntries(Object.entries(scopeOfName).map(([name, scope]) => [name, scope === 'user'
					? (this.voidSettingsService.state.mcpUserStateOfName[name]?.isOn ?? true)
					: true]));
			for (const [logicalName, entry] of Object.entries(merged.mcpServers)) {
				const runtimeName = scopeOfName[logicalName] === 'project'
					? runtimeProjectName(context, logicalName)
					: runtimeUserName(logicalName);
				logicalToRuntime[logicalName] = runtimeName;
				runtimeServers[runtimeName] = entry;
				runtimeIsOn[runtimeName] = logicalEnabled[logicalName] ?? true;
			}
			nextMappings.set(context, logicalToRuntime);
			nextScopes.set(context, scopeOfName);
			nextFolders.set(context, projectFolderOfName);
			nextEnabled.set(context, logicalEnabled);
		}

		const oldConfigFileNames = [...this.configuredRuntimeNames];
		const newConfigFileNames = Object.keys(runtimeServers);
		this.configuredRuntimeNames = new Set(newConfigFileNames);
		for (const name of newConfigFileNames) this.knownExternalRuntimeNames.add(name);

		const oldUserNames = Object.entries(this.state.scopeOfName).filter(([, scope]) => scope === 'user').map(([name]) => name);
		const ideScopes = nextScopes.get(IDE_MCP_CONTEXT) ?? {};
		const newUserNames = Object.entries(ideScopes).filter(([, scope]) => scope === 'user').map(([name]) => name);
		const addedLogicalUserNames = newUserNames.filter(name => !oldUserNames.includes(name));
		const removedLogicalUserNames = oldUserNames.filter(name => !newUserNames.includes(name));

		this.logicalRuntimeNameByContext.clear();
		this.scopeOfNameByContext.clear();
		this.projectFolderOfNameByContext.clear();
		this.isOnOfNameByContext.clear();
		for (const [key, value] of nextMappings) this.logicalRuntimeNameByContext.set(key, value);
		for (const [key, value] of nextScopes) this.scopeOfNameByContext.set(key, value);
		for (const [key, value] of nextFolders) this.projectFolderOfNameByContext.set(key, value);
		for (const [key, value] of nextEnabled) this.isOnOfNameByContext.set(key, value);
		this._publishIDEState();

		const addedServerNames = newConfigFileNames.filter(serverName => !oldConfigFileNames.includes(serverName));
		const removedServerNames = oldConfigFileNames.filter(serverName => !newConfigFileNames.includes(serverName));

		// set isOn to any new USER servers in the config (project enable lives in workspace storage)
		const addedUserStateOfName: MCPUserStateOfName = {}
		for (const name of addedLogicalUserNames) {
			addedUserStateOfName[name] = { isOn: true }
		}
		await this.voidSettingsService.addMCPUserStateOfNames(addedUserStateOfName);

		// delete isOn for any user servers that no longer show up in the config
		await this.voidSettingsService.removeMCPUserStateOfNames(removedLogicalUserNames);

		// set all servers to loading
		for (const serverName of newConfigFileNames) {
			this._setRuntimeMCPServerState(serverName, { status: 'loading', tools: [] })
		}
		const updatedServerNames = newConfigFileNames.filter(serverName => !addedServerNames.includes(serverName) && !removedServerNames.includes(serverName))

		// combined userStateOfName for the channel (unique names across scopes)
		const combinedUserStateOfName: MCPUserStateOfName = {}
		for (const [name, isOn] of Object.entries(runtimeIsOn)) { combinedUserStateOfName[name] = { isOn } }

		this.channel.call('refreshMCPServers', {
			mcpConfigFileJSON: { mcpServers: runtimeServers },
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
		const runtimeName = this.logicalRuntimeNameByContext.get(IDE_MCP_CONTEXT)?.[serverName] ?? serverName;

		const scope = this.state.scopeOfName[serverName] ?? 'user';
		if (scope === 'project') {
			const map = this._readWorkspaceEnableMap();
			map[serverName] = isOn;
			this._writeWorkspaceEnableMap(map);
		} else {
			await this.voidSettingsService.setMCPServerState(serverName, { isOn });
		}
		const enabled = { ...(this.isOnOfNameByContext.get(IDE_MCP_CONTEXT) ?? {}), [serverName]: isOn };
		this.isOnOfNameByContext.set(IDE_MCP_CONTEXT, enabled);
		this._setRuntimeMCPServerState(runtimeName, { status: 'loading', tools: [] })
		this.channel.call('toggleMCPServer', { serverName: runtimeName, isOn })
	}

	// ---- config file mutation (marketplace + Add dialog) ------------------------------

	private async _readOrInitConfig(scope: MCPScope, projectFolderUri?: string): Promise<{ uri: URI, json: MCPConfigFileJSON }> {
		const uri = await this._getMCPConfigFilePath(scope, projectFolderUri);
		if (!uri) throw new Error(`No ${scope} MCP config path available (open a workspace folder first).`);
		if (!(await this._configFileExists(uri))) {
			await this._createMCPConfigFile(uri);
		}
		const parsed = await this._parseMCPConfigFileForScope(scope, projectFolderUri);
		const json: MCPConfigFileJSON = parsed?.mcpServers ? parsed : { mcpServers: {} };
		return { uri, json };
	}

	private async _writeConfig(uri: URI, json: MCPConfigFileJSON): Promise<void> {
		const buffer = VSBuffer.fromString(JSON.stringify(json, null, 2));
		await this.fileService.writeFile(uri, buffer);
		// The file watcher fires _refreshMCPServers; nudge in case it debounces.
		await this._refreshMCPServers();
	}

	public async serverExists(name: string, scope: MCPScope, projectFolderUri?: string): Promise<boolean> {
		const parsed = await this._parseMCPConfigFileForScope(scope, projectFolderUri);
		return !!parsed?.mcpServers?.[name];
	}

	public async addMCPServer(name: string, entry: MCPConfigFileEntryJSON, scope: MCPScope, projectFolderUri?: string): Promise<void> {
		const { uri, json } = await this._readOrInitConfig(scope, projectFolderUri);
		json.mcpServers[name] = entry;
		await this._writeConfig(uri, json);
	}

	public async updateMCPServer(name: string, entry: MCPConfigFileEntryJSON, scope: MCPScope, projectFolderUri?: string): Promise<void> {
		const { uri, json } = await this._readOrInitConfig(scope, projectFolderUri);
		json.mcpServers[name] = entry;
		await this._writeConfig(uri, json);
	}

	public async removeMCPServer(name: string, scope: MCPScope, projectFolderUri?: string): Promise<void> {
		const uri = await this._getMCPConfigFilePath(scope, projectFolderUri);
		if (!uri || !(await this._configFileExists(uri))) return;
		const parsed = await this._parseMCPConfigFileForScope(scope, projectFolderUri);
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
		const runtimeName = this.logicalRuntimeNameByContext.get(IDE_MCP_CONTEXT)?.[serverName] ?? serverName;
		// Reflect the in-flight state immediately; the channel will emit the final state.
		this._setRuntimeMCPServerState(runtimeName, { status: 'loading', tools: [] });
		try {
			const result = await this.channel.call<{ ok: boolean; error?: string }>('authenticateMCPServer', { serverName: runtimeName });
			return result ?? { ok: false, error: 'Authentication failed.' };
		} catch (err) {
			return { ok: false, error: `${err}` };
		}
	}

	public async callMCPTool(toolData: MCPToolCallParams, token?: CancellationToken, agentWorkspaceId?: string | null): Promise<{ result: RawMCPToolCall }> {
		const context = agentWorkspaceId === undefined ? IDE_MCP_CONTEXT : agentMcpContext(agentWorkspaceId);
		const runtimeName = this.logicalRuntimeNameByContext.get(context)?.[toolData.serverName] ?? toolData.serverName;
		const result = await this.channel.call<RawMCPToolCall>('callTool', { ...toolData, serverName: runtimeName }, token);
		if (result.event === 'error') {
			throw new Error(`Error: ${result.text}`)
		}
		return { result };
	}
}

registerSingleton(IMCPService, MCPService, InstantiationType.Eager);
