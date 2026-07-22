/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as React from 'react';
import { SquareTerminal } from 'lucide-react';
import { TerminalLocation, TerminalExitReason } from '../../../../../../../../platform/terminal/common/terminal.js';
import { ConfirmOnKill } from '../../../../../../../../workbench/contrib/terminal/common/terminal.js';
import type { ITerminalInstance } from '../../../../../../terminal/browser/terminal.js';
import { URI } from '../../../../../../../../base/common/uri.js';
import { useAccessor } from '../../util/services.js';
import { getConnectedDocument, getConnectedWindow } from '../../util/connectedWindow.js';
import type { WorkspacePanelProps } from './workspaceTypes.js';

/**
 * Resolve the cwd for a new agent-window terminal.
 *
 * Matches VS Code's own terminal-creation precedence: the last-active workspace
 * root (so a multi-root workspace opens the terminal where the user was last
 * working), falling back to the first workspace folder, then undefined (which
 * lets the terminal backend pick the default — typically the user's home or the
 * workspace root).
 */
/**
 * Whether the terminal may take focus right now. Reattaching/activating a
 * terminal must not yank the caret out of an input the user is typing in
 * (e.g. the chat composer when the window reopens with surviving terminals).
 */
const canStealFocus = (host: HTMLElement): boolean => {
	try {
		const doc = getConnectedDocument(host);
		const active = doc.activeElement as HTMLElement | null;
		if (!active || active === doc.body) {
			return true;
		}
		if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable) {
			return false;
		}
		return true;
	} catch {
		return true;
	}
};

const resolveCwd = (
	agentFolders: URI[],
): URI | undefined => {
	if (agentFolders.length > 0) {
		return agentFolders[0];
	}
	return undefined;
};

export const TerminalPanel = ({ tab, isActive, setTitle }: WorkspacePanelProps) => {
	const accessor = useAccessor();
	const terminalInstanceService = accessor.get('ITerminalInstanceService');
	const terminalService = accessor.get('ITerminalService');
	const terminalConfigService = accessor.get('ITerminalConfigurationService');
	const agentProjectWorkspaceService = accessor.get('IAgentProjectWorkspaceService');
	const terminalStore = accessor.get('IAgentWindowTerminalStore');
	const notificationService = accessor.get('INotificationService');

	const hostRef = React.useRef<HTMLDivElement | null>(null);
	const termHostRef = React.useRef<HTMLDivElement | null>(null);
	const instanceRef = React.useRef<ITerminalInstance | null>(null);
	const handleRef = React.useRef<{ setPtyId: (id: number) => void; setTitle: (t: string) => void; dispose: () => void } | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [exited, setExited] = React.useState<number | boolean | null>(null);
	// True when this panel skipped spawning a shell because no agent workspace
	// folder is selected (No Repo / empty state). Renders an actionable
	// placeholder instead of a blank black surface. M3.
	const [noWorkspace, setNoWorkspace] = React.useState(false);
	// The mount effect below runs once ([] deps) but its body resumes after an
	// `await`; by then the `isActive` value closed over at mount time can be
	// stale (the user may have already switched tabs). Read the current value
	// through this ref instead of the effect's captured `isActive`.
	const isActiveRef = React.useRef(isActive);
	isActiveRef.current = isActive;

	// Create (or adopt a reattached) terminal once and attach its xterm surface
	// into this pane's DOM. The instance is NOT registered with
	// ITerminalGroupService, so it never appears as a tab in the main IDE's
	// terminal panel — it lives entirely inside this agent-window tab.
	React.useEffect(() => {
		const host = hostRef.current;
		if (!host) {
			return;
		}
		let disposed = false;
		let ro: ResizeObserver | undefined;
		const listeners: { dispose(): void }[] = [];

		const layoutNow = () => {
			const inst = instanceRef.current;
			if (!inst || inst.isDisposed) {
				return;
			}
			const rect = host.getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0) {
				inst.layout({ width: rect.width, height: rect.height });
			}
		};

		const applyTitle = (title: string | undefined) => {
			const t = title || 'Terminal';
			setTitle(t);
			handleRef.current?.setTitle(t);
		};

		const wireInstance = (instance: ITerminalInstance) => {
			instanceRef.current = instance;
			// Mirror the shell title into the tab strip + the persisted store entry.
			applyTitle(instance.title);
			listeners.push(instance.onTitleChanged(() => applyTitle(instance.title)));
			// Once the pty has spawned, record its persistent id so the store can
			// reattach this shell after an IDE reload.
			listeners.push(instance.onProcessIdReady(() => {
				const pid = instance.persistentProcessId;
				if (typeof pid === 'number') {
					handleRef.current?.setPtyId(pid);
				}
			}));
			// If the process exits on its own, clear the persisted entry so we
			// don't try to reattach a dead pty next launch, and show an "exited"
			// placeholder instead of leaving a dead, unresponsive terminal surface
			// with a stale instance ref sitting behind it.
			listeners.push(instance.onExit((code) => {
				handleRef.current?.dispose();
				handleRef.current = null;
				instanceRef.current = null;
				if (!disposed) { setExited(typeof code === 'number' ? code : true); }
			}));
		};

		(async () => {
			try {
				await terminalService.whenConnected;
				if (disposed) {
					return;
				}

				// Wait for the store's (shared) reattach pass so a workspace switch
				// or IDE reload can stash surviving ptys before we decide to spawn.
				await terminalStore.reattachOnStartup();
				if (disposed) {
					return;
				}

				// 1) Adopt a reattached instance if the store pre-created one for
				//    this tab id (happens after an IDE reload with a surviving pty).
				let instance = terminalStore.takeReattachedInstance(tab.id);

				// 2) Otherwise create a fresh, ungrouped terminal instance. Using
				//    ITerminalInstanceService.createInstance directly (instead of
				//    ITerminalService.createTerminal) skips the group registration
				//    that would add a tab to the main IDE's terminal panel.
				if (!instance) {
					// Prefer this tab's own persisted cwd (its pty died but the entry
					// survived) over the generic last-active-root fallback, so a fresh
					// shell reopens where the old one was rather than at the workspace
					// root.
				const persistedCwd = terminalStore.entries.find(e => e.id === tab.id)?.cwd;
				const cwd = persistedCwd ?? resolveCwd(agentProjectWorkspaceService.getActiveFolders());
				if (!cwd && !persistedCwd) {
					// No Repo / empty workspace: surface an actionable placeholder
					// instead of silently rendering a blank, dead terminal surface.
					// M3. The retry effect below watches the workspace service and
					// re-runs this mount logic once a folder is selected.
					setTitle?.('Terminal');
					if (!disposed) { setNoWorkspace(true); }
					return;
				}
					instance = terminalInstanceService.createInstance(
						{
							cwd,
							name: 'Agent · Terminal',
							forceShellIntegration: true,
						},
						TerminalLocation.Panel, // target metadata only; NOT added to any group
					);
				}

				if (disposed) {
					try { instance.dispose(); } catch { /* ignore */ }
					return;
				}

				// Register a store entry (or adopt the existing one for this tab id)
				// so the pty id + title persist across reloads.
				if (!handleRef.current) {
					handleRef.current = terminalStore.registerTerminal({
						id: tab.id,
						title: instance.title || 'Terminal',
						cwd: typeof instance.shellLaunchConfig.cwd === 'string'
							? instance.shellLaunchConfig.cwd
							: instance.shellLaunchConfig.cwd?.toString(),
						ptyId: typeof instance.persistentProcessId === 'number'
							? instance.persistentProcessId
							: undefined,
					});
				}

				wireInstance(instance);
				// Reattached instances often already have a pty id before
				// onProcessIdReady fires (or before we subscribe to it).
				const existingPtyId = instance.persistentProcessId;
				if (typeof existingPtyId === 'number') {
					handleRef.current?.setPtyId(existingPtyId);
				}
				// Build the xterm host from the CONNECTED (aux) document so xterm's
				// internal getWindow(host) resolves the aux window, not the main
				// window (delegateNodeFactories makes hostRef.current.ownerDocument
				// the main document). Same cross-window fix as FileEditorPanel.
				const auxDoc = getConnectedDocument(host);
				const termHost = auxDoc.createElement('div');
				termHost.style.position = 'absolute';
				termHost.style.inset = '0';
				termHost.style.width = '100%';
				termHost.style.height = '100%';
				host.appendChild(termHost);
				termHostRef.current = termHost;
				instance.attachToElement(termHost);
				layoutNow();
				// Use the ref, not the `isActive` captured when this effect was
				// created — we're resuming after an `await`, and the user may have
				// already switched to a different tab by now.
				instance.setVisible(isActiveRef.current);
				if (isActiveRef.current && canStealFocus(host)) {
					instance.focus();
				}

				// Resize observer from the CONNECTED (pop-out) window.
				const win = getConnectedWindow(termHost) as Window & typeof globalThis;
				if (typeof win.ResizeObserver === 'function') {
					// Best-effort: constructing/observing from a foreign (pop-out) window
					// can throw if the host document has already disconnected. A failure
					// here must not fall through to the outer catch and blank an otherwise
					// working terminal via setError — the terminal just won't auto-resize.
					try {
						ro = new win.ResizeObserver(() => layoutNow());
						ro.observe(termHost);
						ro.observe(host);
					} catch { /* ignore */ }
				}
			} catch (e: unknown) {
				if (!disposed) {
					setError(String((e as { message?: string })?.message ?? e));
				}
			}
		})();

		return () => {
			disposed = true;
			ro?.disconnect();
			for (const l of listeners) {
				try { l.dispose(); } catch { /* ignore */ }
			}
			listeners.length = 0;

			const inst = instanceRef.current;
			instanceRef.current = null;
			if (terminalStore.windowTeardownActive || terminalStore.workspaceTransitionActive) {
				// Agents window closing, OR active workspace just switched — this is
				// NOT a user tab close. Detach the surface/process but keep the pty
				// (and do NOT dispose the store handle: during a workspace switch
				// `_storageKey()` already points at the NEW workspace, so removeEntry
				// would corrupt that workspace's persisted terminals).
				if (inst) {
					try { inst.detachFromElement(); } catch { /* ignore */ }
					try { inst.detachProcessAndDispose(TerminalExitReason.User); } catch { /* ignore */ }
				}
				handleRef.current = null; // deliberately NOT disposed — entry must persist
			} else if (inst) {
				// Kill-confirm consistent with the IDE's `terminal.integrated.confirmOnKill`
				// setting. We only treat it as "needs confirming" when the shell has
				// child processes (closing a bare prompt shell is never surprising).
				//
				// This used to show an async confirm dialog here and kill/detach based
				// on the answer — but a React effect cleanup can't be awaited, so that
				// dialog was fire-and-forget: it could still be pending when the whole
				// window (or the app) tears down, stacking dialogs across several
				// terminals closing at once, and a slow answer could race a *new* mount
				// for the same tab id and dispose ITS store entry instead of the old
				// one's. Default to the same safe choice a veto would make — detach and
				// keep the pty alive, dropping the store entry so it isn't
				// auto-reattached — without a dialog that can't correctly gate anything
				// during an unmount anyway.
				const confirmOnKill: ConfirmOnKill = terminalConfigService.config.confirmOnKill;
				const needsConfirm = (confirmOnKill === 'always' || confirmOnKill === 'panel') && inst.hasChildProcesses;
				if (needsConfirm) {
					try { inst.detachFromElement(); } catch { /* ignore */ }
					// detachProcessAndDispose is async; the sync try/catch can't catch a
					// rejected promise, so attach a .catch to avoid an unhandled rejection
					// if the detach fails (e.g. the pty host is already gone). Dropping the
					// store entry immediately (below) is intentional — see the comment above.
					try { void inst.detachProcessAndDispose(TerminalExitReason.User).catch(() => { /* ignore */ }); } catch { /* ignore */ }
					handleRef.current?.dispose();
					handleRef.current = null;
					// The shell (and whatever is running in it) was deliberately kept
					// alive — but it is no longer reachable from any tab. Silent
					// orphaning looked like a hang ("my build kept running"); say so.
					// Sanitize the terminal title to prevent command: link injection
					// via VS Code's parseLinkedText in notification rendering.
					const sanitizedTitle = (inst.title || 'Terminal').replace(/[[\]()]/g, '');
					notificationService.info(
						`Terminal "${sanitizedTitle}" was closed while a process was running. The process was left running in the background.`,
					);
				} else {
					try {
						inst.detachFromElement();
						inst.dispose(TerminalExitReason.User);
					} catch { /* ignore */ }
					handleRef.current?.dispose();
					handleRef.current = null;
				}
			} else {
				handleRef.current?.dispose();
				handleRef.current = null;
			}
		// Remove the dynamically created xterm host (created in the aux doc).
		if (termHostRef.current && termHostRef.current.parentNode) {
			termHostRef.current.parentNode.removeChild(termHostRef.current);
		}
		termHostRef.current = null;
	};
	// Re-run the mount effect when `noWorkspace` flips back to false (after the
	// user picks a workspace). On the initial mount `noWorkspace` is false, so
	// this runs once; if it bailed with noWorkspace=true and the retry effect
	// below clears it, this re-runs and spawns the shell. M3.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [noWorkspace]);

	// Retry: when this panel bailed with `noWorkspace=true`, watch the workspace
	// service and clear the flag the moment a folder becomes available so the
	// mount effect above re-runs and spawns the shell. M3.
	React.useEffect(() => {
		if (!noWorkspace) {
			return;
		}
		const check = () => {
			if (agentProjectWorkspaceService.getActiveFolders().length > 0) {
				setNoWorkspace(false);
			}
		};
		check();
		const d1 = agentProjectWorkspaceService.onDidChangeActiveWorkspace(check);
		const d2 = agentProjectWorkspaceService.onDidChangeState(check);
		return () => { d1.dispose(); d2.dispose(); };
	}, [noWorkspace, agentProjectWorkspaceService]);

	// Pause rendering + relayout/focus when this tab becomes active/inactive.
	// setVisible(false) stops the xterm WebGL renderer and data processing while
	// the host is display:none'd, which saves GPU/CPU and avoids zero-size
	// renderer glitches.
	React.useEffect(() => {
		const inst = instanceRef.current;
		const host = hostRef.current;
		if (!inst || inst.isDisposed) {
			return;
		}
		inst.setVisible(isActive);
		if (isActive) {
			if (host) {
				const rect = host.getBoundingClientRect();
				if (rect.width > 0 && rect.height > 0) {
					inst.layout({ width: rect.width, height: rect.height });
				}
			}
			if (host && canStealFocus(host)) {
				inst.focus();
			}
		}
	}, [isActive]);

	return (
		<div className="agent-workspace-terminal">
			{error ? (
				<div className="agent-workspace-placeholder">
					<SquareTerminal size={22} strokeWidth={1.5} className="agent-workspace-placeholder-icon" />
					<div className="agent-workspace-placeholder-label">Terminal failed to start</div>
					<div className="agent-workspace-placeholder-detail">{error}</div>
				</div>
			) : exited !== null ? (
				<div className="agent-workspace-placeholder">
					<SquareTerminal size={22} strokeWidth={1.5} className="agent-workspace-placeholder-icon" />
					<div className="agent-workspace-placeholder-label">Shell exited</div>
					{typeof exited === 'number' && (
						<div className="agent-workspace-placeholder-detail">Exit code {exited}</div>
					)}
				</div>
			) : noWorkspace ? (
				<div className="agent-workspace-placeholder">
					<SquareTerminal size={22} strokeWidth={1.5} className="agent-workspace-placeholder-icon" />
					<div className="agent-workspace-placeholder-label">No workspace selected</div>
					<div className="agent-workspace-placeholder-detail">
						Select a workspace to start a terminal.
					</div>
					<button
						type="button"
						className="agent-workspace-placeholder-action"
						onClick={() => agentProjectWorkspaceService.requestOpenPicker()}
					>
						Open Workspace
					</button>
				</div>
			) : (
				<div className="agent-workspace-terminal-surface" ref={hostRef} />
			)}
		</div>
	);
};
