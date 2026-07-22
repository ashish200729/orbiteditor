/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { isRecentFolder, IWorkspacesService } from '../../../../platform/workspaces/common/workspaces.js';
import { AGENT_PROJECT_WORKSPACES_STORAGE_KEY } from '../common/storageKeys.js';
import {
	AgentWorkspaceConfig,
	AgentWorkspaceState,
} from '../common/agentProjectWorkspaceTypes.js';
import {
	addFolderToWorkspace,
	createWorkspaceFromFolders,
	getActiveFoldersAsUris,
	parseAgentWorkspaceState,
	removeFolderFromWorkspace,
	resolveDisplayPath,
	setActiveWorkspaceId,
	normalizeFolderUriKey,
	isValidWorkspaceFolderName,
} from '../common/agentWorkspaceHelpers.js';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export const IAgentProjectWorkspaceService = createDecorator<IAgentProjectWorkspaceService>('agentProjectWorkspaceService');

export interface IAgentProjectWorkspaceService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeActiveWorkspace: Event<void>;
	readonly onDidChangeState: Event<void>;

	/** Full persisted state snapshot. */
	getState(): AgentWorkspaceState;

	/** Active workspace config, or null when in No Repo mode. */
	getActiveWorkspace(): AgentWorkspaceConfig | null;

	/** Active workspace folder URIs (empty when No Repo). */
	getActiveFolders(): URI[];

	/** Folder URIs for a specific workspace id (empty if unknown). */
	getWorkspaceFolders(workspaceId: string): URI[];

	/** Switch active workspace. Pass null for No Repo. */
	setActiveWorkspace(id: string | null): void;

	/** Native folder picker → create/switch to a single-folder workspace. */
	openFolderPicker(): Promise<URI | undefined>;

	/** Add a folder root to the active workspace (multi-folder). */
	addFolder(uri: URI): void;

	/** Remove a folder root from the active workspace. */
	removeFolder(uri: URI): void;

	/** Create a new folder on disk under parentUri and add it to the workspace. */
	createNewFolder(parentUri: URI, name: string): Promise<URI | undefined>;

	/** Clear to No Repo mode. */
	clearWorkspace(): void;

	/** Build (or reuse) a workspace from the given folders and activate it. */
	createWorkspaceFromFolders(uris: URI[]): AgentWorkspaceConfig;

	/** Recent workspace configs (most-recent-first). */
	getRecents(): AgentWorkspaceConfig[];

	/** Recent folder URIs from VS Code history + agent workspaces (deduped). */
	getRecentFolderUris(): Promise<URI[]>;

	/** Format a path with ~/ home shortening. */
	resolveDisplayPath(uri: URI | string): Promise<string>;

	/** Check whether a folder still exists on disk. */
	isFolderStale(uri: URI): Promise<boolean>;

	/** Request the workspace picker UI to open (e.g. Cmd/Ctrl+.). */
	requestOpenPicker(): void;
	/** True if a picker open was requested before the header mounted (consume once). */
	consumePendingOpenPicker(): boolean;
	readonly onDidRequestOpenPicker: Event<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class AgentProjectWorkspaceService extends Disposable implements IAgentProjectWorkspaceService {
	declare _serviceBrand: undefined;

	private readonly _onDidChangeActiveWorkspace = this._register(new Emitter<void>());
	readonly onDidChangeActiveWorkspace = this._onDidChangeActiveWorkspace.event;

	private readonly _onDidChangeState = this._register(new Emitter<void>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly _onDidRequestOpenPicker = this._register(new Emitter<void>());
	readonly onDidRequestOpenPicker = this._onDidRequestOpenPicker.event;

	private _state: AgentWorkspaceState;
	private _userHomeFsPath: string | undefined;
	private _pendingOpenPicker = false;

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
		@IFileService private readonly _fileService: IFileService,
		@IPathService private readonly _pathService: IPathService,
		@IWorkspacesService private readonly _workspacesService: IWorkspacesService,
	) {
		super();
		const raw = this._storageService.get(AGENT_PROJECT_WORKSPACES_STORAGE_KEY, StorageScope.APPLICATION);
		this._state = parseAgentWorkspaceState(raw);

		void this._pathService.userHome().then(home => {
			this._userHomeFsPath = home.fsPath;
		}).catch(() => { /* best-effort */ });
	}

	getState(): AgentWorkspaceState {
		return this._state;
	}

	getActiveWorkspace(): AgentWorkspaceConfig | null {
		if (!this._state.activeWorkspaceId) {
			return null;
		}
		return this._state.workspaces[this._state.activeWorkspaceId] ?? null;
	}

	getActiveFolders(): URI[] {
		return getActiveFoldersAsUris(this._state);
	}

	getWorkspaceFolders(workspaceId: string): URI[] {
		const ws = this._state.workspaces[workspaceId];
		if (!ws) {
			return [];
		}
		return ws.folders.map(f => {
			try {
				return URI.parse(f.uri);
			} catch {
				return null;
			}
		}).filter((u): u is URI => !!u);
	}

	setActiveWorkspace(id: string | null): void {
		const prev = this._state.activeWorkspaceId;
		const next = setActiveWorkspaceId(this._state, id);
		if (next === this._state) {
			// Unknown id — helper returned state unchanged; don't persist or fire.
			return;
		}
		this._state = next;
		this._persist();
		this._onDidChangeState.fire();
		if (prev !== this._state.activeWorkspaceId) {
			this._onDidChangeActiveWorkspace.fire();
		}
	}

	async openFolderPicker(): Promise<URI | undefined> {
		const picked = await this._fileDialogService.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			title: 'Open Folder',
			openLabel: 'Open',
		});
		const uri = picked?.[0];
		if (!uri) {
			return undefined;
		}
		this.createWorkspaceFromFolders([uri]);
		return uri;
	}

	addFolder(uri: URI): void {
		const activeId = this._state.activeWorkspaceId;
		if (!activeId) {
			// No active workspace → create a new one from this folder.
			this.createWorkspaceFromFolders([uri]);
			return;
		}
		const next = addFolderToWorkspace(this._state, activeId, uri);
		if (!next || next === this._state) {
			return;
		}
		const previousActiveId = this._state.activeWorkspaceId;
		this._state = next;
		this._persist();
		this._onDidChangeState.fire();
		if (previousActiveId !== this._state.activeWorkspaceId) {
			this._onDidChangeActiveWorkspace.fire();
		}
	}

	removeFolder(uri: URI): void {
		const activeId = this._state.activeWorkspaceId;
		if (!activeId) {
			return;
		}
		const next = removeFolderFromWorkspace(this._state, activeId, uri);
		if (!next || next === this._state) {
			return;
		}
		const previousActiveId = this._state.activeWorkspaceId;
		this._state = next;
		this._persist();
		this._onDidChangeState.fire();
		if (previousActiveId !== this._state.activeWorkspaceId) {
			this._onDidChangeActiveWorkspace.fire();
		}
	}

	async createNewFolder(parentUri: URI, name: string): Promise<URI | undefined> {
		const trimmed = name.trim();
		// Apply universal basename constraints first, then let IPathService apply
		// the target environment's OS rules (including Windows reserved device
		// names, invalid characters, and trailing periods/spaces).
		if (!isValidWorkspaceFolderName(trimmed, false)) {
			return undefined;
		}
		if (!(await this._pathService.hasValidBasename(parentUri, trimmed))) {
			return undefined;
		}
		const folderUri = joinPath(parentUri, trimmed);
		try {
			await this._fileService.createFolder(folderUri);
		} catch {
			// May already exist — still try to open it as a workspace.
			const exists = await this._fileService.exists(folderUri);
			if (!exists) {
				return undefined;
			}
		}
		// Always open as a fresh single-folder workspace (Cursor "New Folder"
		// semantics) — never silently add into the current multi-root.
		this.createWorkspaceFromFolders([folderUri]);
		return folderUri;
	}

	clearWorkspace(): void {
		if (this._state.activeWorkspaceId === null) {
			return;
		}
		this._state = setActiveWorkspaceId(this._state, null);
		this._persist();
		this._onDidChangeState.fire();
		this._onDidChangeActiveWorkspace.fire();
	}

	createWorkspaceFromFolders(uris: URI[]): AgentWorkspaceConfig {
		const previousActiveId = this._state.activeWorkspaceId;
		const { state, workspace } = createWorkspaceFromFolders(uris, this._state);
		if (state === this._state) {
			return workspace;
		}
		this._state = state;
		this._persist();
		this._onDidChangeState.fire();
		if (previousActiveId !== this._state.activeWorkspaceId) {
			this._onDidChangeActiveWorkspace.fire();
		}
		return workspace;
	}

	getRecents(): AgentWorkspaceConfig[] {
		return this._state.recents
			.map(id => this._state.workspaces[id])
			.filter((ws): ws is AgentWorkspaceConfig => !!ws);
	}

	async getRecentFolderUris(): Promise<URI[]> {
		const seen = new Set<string>();
		const result: URI[] = [];
		const push = (uri: URI) => {
			const key = normalizeFolderUriKey(uri);
			if (seen.has(key)) {
				return;
			}
			seen.add(key);
			result.push(uri);
		};

		// Agent workspace recents first (user's agent-window history).
		for (const ws of this.getRecents()) {
			for (const f of ws.folders) {
				try {
					push(URI.parse(f.uri));
				} catch { /* skip */ }
			}
		}

		// Merge VS Code recently opened folders.
		try {
			const recent = await this._workspacesService.getRecentlyOpened();
			for (const entry of recent.workspaces) {
				if (isRecentFolder(entry)) {
					push(entry.folderUri);
				}
			}
		} catch { /* best-effort */ }

		return result;
	}

	async resolveDisplayPath(uri: URI | string): Promise<string> {
		if (!this._userHomeFsPath) {
			try {
				this._userHomeFsPath = (await this._pathService.userHome()).fsPath;
			} catch { /* ignore */ }
		}
		return resolveDisplayPath(uri, this._userHomeFsPath);
	}

	async isFolderStale(uri: URI): Promise<boolean> {
		try {
			return !(await this._fileService.exists(uri));
		} catch {
			return true;
		}
	}

	requestOpenPicker(): void {
		this._pendingOpenPicker = true;
		this._onDidRequestOpenPicker.fire();
	}

	consumePendingOpenPicker(): boolean {
		const pending = this._pendingOpenPicker;
		this._pendingOpenPicker = false;
		return pending;
	}

	private _persist(): void {
		this._storageService.store(
			AGENT_PROJECT_WORKSPACES_STORAGE_KEY,
			JSON.stringify(this._state),
			StorageScope.APPLICATION,
			StorageTarget.USER,
		);
	}
}

registerSingleton(IAgentProjectWorkspaceService, AgentProjectWorkspaceService, InstantiationType.Eager);
