/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IProcessDetails } from '../../../../platform/terminal/common/terminalProcess.js';
import { ITerminalBackend, TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { ITerminalInstance, ITerminalInstanceService } from '../../terminal/browser/terminal.js';
import { AGENT_WINDOW_TERMINAL_STORAGE_KEY, AGENT_WINDOW_STATE_BY_WORKSPACE_PREFIX } from '../common/storageKeys.js';
import { IAgentProjectWorkspaceService } from './agentProjectWorkspaceService.js';
import { canMigrateLegacyTerminalsToWorkspace } from '../common/agentWorkspaceHelpers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A persisted agent-window terminal slot. Each open Terminal tab in the Agents
 * pop-out has one of these. The `ptyId` is the id the pty host uses to identify
 * the (still-alive) shell process after the renderer detaches; we use it to
 * reattach on the next launch.
 */
export interface IAgentWindowTerminalEntry {
	/** Stable id for this tab (also the React key). */
	id: string;
	/** The pty-host persistent process id, once the shell has spawned. */
	ptyId?: number;
	/** Last known title (mirrors the shell's title so the tab label survives reload). */
	title: string;
	/** The cwd the terminal was launched in (used as a fallback on reattach failure). */
	cwd?: string;
	/** The workspace folder URI string the terminal was launched in. */
	workspaceFolderUri?: string;
}

export interface IAgentWindowTerminalStore {
	readonly _serviceBrand: undefined;

	/** Fires when the list of persisted entries changes (add/remove/ptyId resolved). */
	readonly onDidChangeEntries: Event<void>;

	/** All persisted entries (in tab order). */
	readonly entries: readonly IAgentWindowTerminalEntry[];

	/** Register a new terminal tab. Returns a handle to update/dispose it. */
	registerTerminal(entry: IAgentWindowTerminalEntry): IAgentWindowTerminalHandle;

	/**
	 * Reattach any surviving persisted terminals. Called once on startup after the
	 * terminal backend is connected. For each entry whose pty is still alive in the
	 * pty host, this creates an `ITerminalInstance` reattached to that pty and
	 * stashes it (see {@link takeReattachedInstance}). Entries whose pty died are
	 * not stashed so the caller creates a fresh shell in their place.
	 */
	reattachOnStartup(): Promise<IAgentWindowTerminalEntry[]>;

	/**
	 * Pop and return the reattached instance stashed for `id` (if any). The React
	 * panel calls this on mount to adopt the pre-created instance instead of
	 * spawning a new shell. If undefined, the panel creates a fresh instance.
	 */
	takeReattachedInstance(id: string): ITerminalInstance | undefined;

	/** Remove an entry (e.g. when the user closes the tab and chooses to kill the shell). */
	removeEntry(id: string): void;

	/**
	 * True while the agents window is tearing down (set by AgentWindowService
	 * around the React unmount). TerminalPanel cleanups check this to detach —
	 * keeping the pty AND the persisted entry alive for the next window open —
	 * instead of treating the unmount like a user tab-close (which kills the
	 * shell and drops the entry).
	 */
	readonly windowTeardownActive: boolean;

	/** See {@link windowTeardownActive}. */
	setWindowTeardown(active: boolean): void;

	/**
	 * True briefly after the active agent workspace changes, while React swaps
	 * terminal tabs. TerminalPanel cleanups must detach (not kill) and must NOT
	 * dispose store handles — `removeEntry` would mutate the *new* workspace's
	 * persisted list (often colliding on `ws-terminal-N` ids).
	 */
	readonly workspaceTransitionActive: boolean;

	/** Clear {@link workspaceTransitionActive} after tab sync + reattach settle. */
	endWorkspaceTransition(): void;

	/**
	 * Called after the agents window has fully closed. Clears the once-per-open
	 * reattach guard so the NEXT window open re-runs reattachOnStartup (the
	 * cached promise would otherwise report the first open's results forever),
	 * and detaches any reattached-but-unclaimed instances without killing their
	 * ptys.
	 */
	resetReattachSession(): void;
}

export interface IAgentWindowTerminalHandle extends IDisposable {
	/** Update the pty id once the shell has spawned (so we can reattach after reload). */
	setPtyId(ptyId: number): void;
	/** Update the stored title (mirrors the live shell title). */
	setTitle(title: string): void;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const IAgentWindowTerminalStore = createDecorator<IAgentWindowTerminalStore>('agentWindowTerminalStore');

class AgentWindowTerminalStore extends Disposable implements IAgentWindowTerminalStore {
	declare _serviceBrand: undefined;

	private readonly _onDidChangeEntries = this._register(new Emitter<void>());
	readonly onDidChangeEntries = this._onDidChangeEntries.event;

	private _entries: IAgentWindowTerminalEntry[] = [];
	private _didLoad = false;
	/**
	 * Guards {@link reattachOnStartup} to run its listProcesses+createInstance
	 * work at most once per store instance. Without this, a second call (e.g.
	 * AgentWorkspace's effect re-running, or React invoking it twice) would
	 * create a second `ITerminalInstance` attached to the same still-alive pty,
	 * silently overwriting (and leaking — never disposed) the first one.
	 *
	 * Cleared by {@link resetReattachSession} (window close or workspace switch)
	 * so the next open/switch can reattach again. {@link _reattachGeneration}
	 * invalidates any in-flight `_doReattachOnStartup` so it cannot persist
	 * into a newer workspace's storage key.
	 */
	private _reattachPromise: Promise<IAgentWindowTerminalEntry[]> | undefined;
	private _reattachGeneration = 0;
	/**
	 * Instances created by {@link reattachOnStartup} that haven't been claimed by a
	 * React panel yet. The panel pops its instance via {@link takeReattachedInstance}
	 * on mount. Unclaimed instances are disposed in {@link dispose} to avoid leaks
	 * if a persisted tab never reopens (e.g. the user closed the workspace).
	 */
	private readonly _reattachedInstances = new Map<string, ITerminalInstance>();
	private _windowTeardownActive = false;
	private _workspaceTransitionActive = false;

	get windowTeardownActive(): boolean {
		return this._windowTeardownActive;
	}

	setWindowTeardown(active: boolean): void {
		this._windowTeardownActive = active;
	}

	get workspaceTransitionActive(): boolean {
		return this._workspaceTransitionActive;
	}

	endWorkspaceTransition(): void {
		this._workspaceTransitionActive = false;
	}

	resetReattachSession(): void {
		this._reattachGeneration++;
		this._reattachPromise = undefined;
		for (const instance of this._reattachedInstances.values()) {
			// Unclaimed reattached instance: detach so the pty survives for the
			// next reattach — dispose() would kill it.
			try {
				instance.detachProcessAndDispose(TerminalExitReason.User);
			} catch {
				try { instance.dispose(); } catch { /* ignore */ }
			}
		}
		this._reattachedInstances.clear();
	}

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@ITerminalInstanceService private readonly _terminalInstanceService: ITerminalInstanceService,
		@ILogService private readonly _logService: ILogService,
		@IAgentProjectWorkspaceService private readonly _agentProjectWorkspaceService: IAgentProjectWorkspaceService,
	) {
		super();
		this._load();
		this._register(this._agentProjectWorkspaceService.onDidChangeActiveWorkspace(() => {
			// Drop the previous workspace's once-per-session reattach cache and any
			// unclaimed reattached instances so the newly loaded entries can reattach.
			// Mark a short transition window so TerminalPanel unmounts detach instead
			// of killing shells / calling removeEntry against the new workspace key.
			this._workspaceTransitionActive = true;
			this.resetReattachSession();
			// Load the newly active workspace's terminal set. Do NOT persist here:
			// `setActiveWorkspace` flips state BEFORE firing this event, so
			// `_storageKey()` already resolves to the NEW workspace — persisting
			// now would clobber the new workspace's saved entries with the old
			// workspace's terminals. Entries are already persisted on every
			// mutation while their owning workspace is active.
			this._didLoad = false;
			this._entries = [];
			this._load();
			this._onDidChangeEntries.fire();
			// Kick reattach immediately so TerminalPanels awaiting the shared
			// promise can adopt surviving ptys instead of spawning duplicates.
			void this.reattachOnStartup();
		}));
	}

	private _storageKey(): string {
		const id = this._agentProjectWorkspaceService.getState().activeWorkspaceId ?? 'no-repo';
		return `${AGENT_WINDOW_STATE_BY_WORKSPACE_PREFIX}${id}.terminals`;
	}

	private _load(): void {
		if (this._didLoad) {
			return;
		}
		this._didLoad = true;
		try {
			if (this._agentProjectWorkspaceService.getState().activeWorkspaceId === null) {
				// No Repo cannot own a terminal. Remove any key written by an older
				// buggy build so a surviving IDE pty is never reattached here.
				this._entries = [];
				this._storageService.remove(this._storageKey(), StorageScope.APPLICATION);
				return;
			}
			// Prefer per-workspace state. Legacy terminals may only be adopted after
			// a real workspace is selected and their recorded folder proves they
			// belong to it; No Repo must never inherit an IDE shell on upgrade.
			let raw = this._storageService.get(this._storageKey(), StorageScope.APPLICATION);
			let migratedFromLegacy = false;
			const activeWorkspaceId = this._agentProjectWorkspaceService.getState().activeWorkspaceId;
			if (!raw && activeWorkspaceId) {
				const legacyRaw = this._storageService.get(AGENT_WINDOW_TERMINAL_STORAGE_KEY, StorageScope.WORKSPACE);
				if (legacyRaw) {
					const activeFolders = new Set(this._agentProjectWorkspaceService.getActiveFolders().map(uri => uri.toString()));
					let belongsToActiveWorkspace = false;
					try {
						const legacyEntries = JSON.parse(legacyRaw) as IAgentWindowTerminalEntry[];
						belongsToActiveWorkspace = Array.isArray(legacyEntries)
							&& canMigrateLegacyTerminalsToWorkspace(legacyEntries, activeWorkspaceId, activeFolders);
					} catch { /* discard malformed legacy state below */ }
					// Consume once after a concrete workspace is available. If ownership
					// cannot be proven, discard rather than leaking it into another repo.
					this._storageService.remove(AGENT_WINDOW_TERMINAL_STORAGE_KEY, StorageScope.WORKSPACE);
					if (belongsToActiveWorkspace) {
						raw = legacyRaw;
						migratedFromLegacy = true;
					}
				}
			}
			if (raw) {
				const parsed = JSON.parse(raw) as IAgentWindowTerminalEntry[];
				if (Array.isArray(parsed)) {
					this._entries = parsed.filter(e => e && typeof e.id === 'string');
				}
			}
			// Persist immediately after migration so restored entries survive even if
			// the Agents window never mutates terminals this session (no reattach /
			// register / title change that would otherwise call `_persist`).
			if (migratedFromLegacy) {
				try {
					this._storageService.store(
						this._storageKey(),
						JSON.stringify(this._entries),
						StorageScope.APPLICATION,
						StorageTarget.MACHINE,
					);
				} catch (persistErr) {
					this._logService.warn('[agentWindowTerminalStore] Failed to persist migrated entries:', persistErr);
				}
			}
		} catch (e) {
			this._logService.warn('[agentWindowTerminalStore] Failed to parse persisted entries:', e);
			this._entries = [];
		}
	}

	private _persist(): void {
		try {
			this._storageService.store(
				this._storageKey(),
				JSON.stringify(this._entries),
				StorageScope.APPLICATION,
				StorageTarget.MACHINE,
			);
		} catch (e) {
			this._logService.warn('[agentWindowTerminalStore] Failed to persist entries:', e);
		}
		this._onDidChangeEntries.fire();
	}

	get entries(): readonly IAgentWindowTerminalEntry[] {
		return this._entries;
	}

	registerTerminal(entry: IAgentWindowTerminalEntry): IAgentWindowTerminalHandle {
		// Replace if the id already exists (e.g. TerminalPanel mounts after
		// reattachOnStartup persisted the entry with a ptyId). Merge so we never
		// wipe a stored ptyId before onProcessIdReady can re-persist it.
		const idx = this._entries.findIndex(e => e.id === entry.id);
		if (idx >= 0) {
			const existing = this._entries[idx];
			this._entries[idx] = {
				...existing,
				...entry,
				ptyId: entry.ptyId ?? existing.ptyId,
			};
		} else {
			this._entries.push(entry);
		}
		this._persist();
		return {
			setPtyId: (ptyId: number) => {
				const found = this._entries.find(e => e.id === entry.id);
				if (found && found.ptyId !== ptyId) {
					found.ptyId = ptyId;
					this._persist();
				}
			},
			setTitle: (title: string) => {
				const found = this._entries.find(e => e.id === entry.id);
				if (found && found.title !== title) {
					found.title = title;
					this._persist();
				}
			},
		dispose: () => {
			// Remove the entry from storage. The React side is responsible for
			// disposing the underlying `ITerminalInstance` (which kills or detaches
			// the pty) before calling this.
			this.removeEntry(entry.id);
		},
		};
	}

	removeEntry(id: string): void {
		const idx = this._entries.findIndex(e => e.id === id);
		if (idx >= 0) {
			this._entries.splice(idx, 1);
			this._persist();
		}
	}

	reattachOnStartup(): Promise<IAgentWindowTerminalEntry[]> {
		if (!this._reattachPromise) {
			this._reattachPromise = this._doReattachOnStartup();
		}
		return this._reattachPromise;
	}

	private async _doReattachOnStartup(): Promise<IAgentWindowTerminalEntry[]> {
		const generation = this._reattachGeneration;
		if (this._entries.length === 0) {
			return [];
		}
		// Snapshot the persisted entries NOW: by the time listProcesses resolves,
		// `this._entries` can contain a terminal freshly created THIS session
		// (registerTerminal pushes into the same array and its live pty shows up
		// in listProcesses) — reattaching that one would attach a second,
		// never-claimed instance to a live pty.
		const snapshot = this._entries.slice();
		const snapshotIds = new Set(snapshot.map(e => e.id));
		const backend = await this._resolveLocalBackend();
		if (generation !== this._reattachGeneration) {
			return [];
		}
		if (!backend) {
			this._logService.warn('[agentWindowTerminalStore] No local terminal backend; cannot reattach.');
			return this._entries.slice();
		}

		// Discover which persisted ptys are still alive in the pty host.
		let alive: Map<number, IProcessDetails>;
		try {
			const processes = await backend.listProcesses();
			alive = new Map(processes.map(p => [p.id, p]));
		} catch (e) {
			// A transient failure here must NOT fall through to the loop below: an
			// empty `alive` map would make every entry look dead, wiping every
			// stored ptyId and persisting that — orphaning shells that are very
			// likely still alive (we just failed to ask). Bail like the
			// no-backend case instead, leaving ptyIds untouched for a later retry.
			this._logService.warn('[agentWindowTerminalStore] listProcesses failed; leaving persisted ptyIds untouched.', e);
			return this._entries.slice();
		}

		if (generation !== this._reattachGeneration) {
			return [];
		}

		const surviving: IAgentWindowTerminalEntry[] = [];
		const createdThisPass: ITerminalInstance[] = [];

		const abortThisPass = (): IAgentWindowTerminalEntry[] => {
			for (const inst of createdThisPass) {
				for (const [id, mapped] of this._reattachedInstances) {
					if (mapped === inst) {
						this._reattachedInstances.delete(id);
					}
				}
				try { inst.detachProcessAndDispose(TerminalExitReason.User); } catch {
					try { inst.dispose(); } catch { /* ignore */ }
				}
			}
			return [];
		};

		for (const entry of snapshot) {
			if (generation !== this._reattachGeneration) {
				return abortThisPass();
			}
			if (entry.ptyId === undefined || !alive.has(entry.ptyId)) {
				// The pty died (or never spawned). The caller will create a fresh shell.
				entry.ptyId = undefined;
				surviving.push(entry); // keep the entry so the new shell can adopt it
				continue;
			}
			try {
				const processDetails = alive.get(entry.ptyId)!;
				const instance = this._terminalInstanceService.createInstance(
					{ attachPersistentProcess: processDetails, forceShellIntegration: true },
					1, // TerminalLocation.Panel — only used as the `target` field; the instance is NOT added to any group.
				);
				// Defensive: dispose any prior unclaimed instance for this id rather
				// than silently dropping the reference (would leak the pty listener).
				const prior = this._reattachedInstances.get(entry.id);
				if (prior) { try { prior.dispose(); } catch { /* ignore */ } }
				this._reattachedInstances.set(entry.id, instance);
				createdThisPass.push(instance);
				surviving.push(entry);
			} catch (e) {
				this._logService.warn(`[agentWindowTerminalStore] Reattach failed for pty ${entry.ptyId}:`, e);
				// Drop the stale ptyId so a fresh shell gets spawned into this entry.
				entry.ptyId = undefined;
				surviving.push(entry);
			}
		}

		if (generation !== this._reattachGeneration) {
			return abortThisPass();
		}

		// Keep any entries registered while we were awaiting (fresh terminals
		// created this session) — they were not part of the snapshot.
		this._entries = [...surviving, ...this._entries.filter(e => !snapshotIds.has(e.id))];
		this._persist();
		return surviving.slice();
	}

	takeReattachedInstance(id: string): ITerminalInstance | undefined {
		const instance = this._reattachedInstances.get(id);
		if (instance) {
			this._reattachedInstances.delete(id);
		}
		return instance;
	}

	public override dispose(): void {
		super.dispose();
		// Dispose any reattached instances that were never claimed by a panel.
		for (const instance of this._reattachedInstances.values()) {
			try { instance.dispose(); } catch { /* ignore */ }
		}
		this._reattachedInstances.clear();
	}

	private async _resolveLocalBackend(): Promise<ITerminalBackend | undefined> {
		try {
			// undefined remoteAuthority = local backend
			return await this._terminalInstanceService.getBackend(undefined);
		} catch {
			return undefined;
		}
	}
}

registerSingleton(IAgentWindowTerminalStore, AgentWindowTerminalStore, InstantiationType.Delayed);
