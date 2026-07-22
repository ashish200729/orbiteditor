/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as React from 'react';
import { Plus, X } from 'lucide-react';
import { URI } from '../../../../../../../base/common/uri.js';
import { StorageScope, StorageTarget } from '../../../../../../../platform/storage/common/storage.js';
import { ConnectedWindowProvider, useConnectedDocument } from '../sidebar-tsx/contexts/ConnectedWindowContext.js';
import { useAccessor, useAgentWorkspaceState } from '../util/services.js';
import { VsCodeFileIcon } from '../sidebar-tsx/utils/fileIcons.js';
import {
	PANEL_METAS,
	PanelKind,
	WorkspaceTab,
	WorkspacePanelProps,
	FileCloseHandle,
	panelMetaFor,
} from './workspace/workspaceTypes.js';
import { WorkspaceEmptyState } from './workspace/WorkspaceEmptyState.js';
import { ChangesPanel } from './workspace/ChangesPanel.js';
import { TerminalPanel } from './workspace/TerminalPanel.js';
import { FileEditorPanel } from './workspace/FileEditorPanel.js';
import { BrowserPanel } from './workspace/BrowserPanel.js';
import { FilesExplorerPanel } from './workspace/FilesExplorerPanel.js';

const EXPLORER_VISIBLE_KEY = 'orbit.agentWindow.explorerVisible';

/** Normalize file resources so path and URI forms dedupe to the same tab. */
const normalizeFileResource = (resource: string): string => {
	try {
		if (resource.includes('://')) {
			return URI.parse(resource).toString();
		}
		return URI.file(resource).toString();
	} catch {
		return resource;
	}
};

const tryParseUri = (resource: string): URI | undefined => {
	try {
		return resource.includes('://') ? URI.parse(resource) : URI.file(resource);
	} catch {
		return undefined;
	}
};

const basename = (p: string): string => {
	try {
		const u = p.includes('://') ? URI.parse(p) : URI.file(p);
		const path = u.path || u.fsPath;
		const cleaned = path.replace(/[\\/]+$/, '');
		const idx = cleaned.lastIndexOf('/');
		return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
	} catch {
		const cleaned = p.replace(/[\\/]+$/, '');
		const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
		return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
	}
};

/**
 * Cursor-style agent workspace:
 *  tab strip (Changes | files… | +)
 *  body = panel column  |  optional side file explorer (when a File tab is active)
 */
const AgentWorkspaceInner = () => {
	const doc = useConnectedDocument();
	const accessor = useAccessor();
	const agentWorkspaceState = useAgentWorkspaceState();
	const terminalStore = accessor.get('IAgentWindowTerminalStore');
	const agentWindowService = accessor.get('IAgentWindowService');
	const storageService = accessor.get('IStorageService');
	const textFileService = accessor.get('ITextFileService');
	const dialogService = accessor.get('IDialogService');

	const [tabs, setTabs] = React.useState<WorkspaceTab[]>([]);
	const tabsRef = React.useRef(tabs);
	tabsRef.current = tabs;
	const [activeId, setActiveId] = React.useState<string | null>(null);
	const workspaceTabsRef = React.useRef(new Map<string, WorkspaceTab[]>());
	const workspaceActiveTabRef = React.useRef(new Map<string, string | null>());
	const previousWorkspaceKeyRef = React.useRef(agentWorkspaceState.activeWorkspaceId ?? 'no-repo');
	const [addMenuOpen, setAddMenuOpen] = React.useState(false);
	const [explorerVisible, setExplorerVisible] = React.useState(() => {
		try {
			const raw = storageService.get(EXPLORER_VISIBLE_KEY, StorageScope.APPLICATION);
			if (raw === '0' || raw === 'false') {
				return false;
			}
			return true;
		} catch {
			return true;
		}
	});
	// Force re-render for dirty tab markers without storing full dirty maps.
	const [, setDirtyTick] = React.useState(0);
	// Per-tab file close handles (see FileCloseHandle) — lets a `files` panel
	// whose model fell back to an ephemeral (non-textFileService-tracked) model
	// report its OWN dirty/save/discard so the tab dot and close-prompt don't
	// silently miss unsaved edits that `ITextFileService.isDirty` can't see.
	const fileHandlesRef = React.useRef<Map<string, FileCloseHandle>>(new Map());
	const registerFileHandle = React.useCallback((id: string, handle: FileCloseHandle | null) => {
		if (handle) {
			fileHandlesRef.current.set(id, handle);
		} else {
			fileHandlesRef.current.delete(id);
		}
		setDirtyTick(t => t + 1);
	}, []);
	// Seeded past the highest numeric suffix already used by a persisted
	// terminal id (`ws-terminal-N`) so a freshly-minted tab id can never
	// collide with one reattachOnStartup is about to add to `tabs` — both use
	// the same `ws-<kind>-<n>` scheme, and this counter would otherwise reset
	// to 0 on every mount while persisted ids survive across reloads.
	const idCounter = React.useRef(0);
	const bumpIdCounterFromIds = React.useCallback((ids: Iterable<string>) => {
		let maxId = idCounter.current;
		for (const id of ids) {
			const m = /-(\d+)$/.exec(id);
			if (m) {
				maxId = Math.max(maxId, parseInt(m[1], 10));
			}
		}
		idCounter.current = maxId;
	}, []);
	// Initial seed from whatever the store already loaded for the active workspace.
	React.useEffect(() => {
		bumpIdCounterFromIds(terminalStore.entries.map(e => e.id));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	const addBtnRef = React.useRef<HTMLButtonElement | null>(null);
	const addMenuRef = React.useRef<HTMLDivElement | null>(null);
	const tabsListRef = React.useRef<HTMLDivElement | null>(null);
	const sideExplorerRef = React.useRef<HTMLElement | null>(null);
	// Tab ids with a close currently in flight (dialog open / save pending).
	const closingTabsRef = React.useRef<Set<string>>(new Set());

	// File/browser/changes tabs belong to the workspace that opened them. Swap
	// them as a unit on workspace changes so an editor from repo A is never left
	// mounted and writable while repo B (or No Repo) is selected. Terminal tabs
	// are restored independently by AgentWindowTerminalStore.
	React.useEffect(() => {
		const previousKey = previousWorkspaceKeyRef.current;
		const nextKey = agentWorkspaceState.activeWorkspaceId ?? 'no-repo';
		if (previousKey === nextKey) {
			return;
		}
		workspaceTabsRef.current.set(previousKey, tabsRef.current.filter(tab => tab.kind !== 'terminal'));
		workspaceActiveTabRef.current.set(previousKey, activeId);
		const restored = workspaceTabsRef.current.get(nextKey) ?? [];
		const restoredActive = workspaceActiveTabRef.current.get(nextKey) ?? null;
		previousWorkspaceKeyRef.current = nextKey;
		fileHandlesRef.current.clear();
		closingTabsRef.current.clear();
		setTabs(restored);
		setActiveId(restoredActive && restored.some(tab => tab.id === restoredActive)
			? restoredActive
			: (restored[0]?.id ?? null));
	}, [agentWorkspaceState.activeWorkspaceId, activeId]);

	const toggleExplorer = React.useCallback(() => {
		setExplorerVisible(v => {
			const next = !v;
			try {
				storageService.store(EXPLORER_VISIBLE_KEY, next ? '1' : '0', StorageScope.APPLICATION, StorageTarget.USER);
			} catch { /* ignore */ }
			return next;
		});
	}, [storageService]);

	// Dirty markers on file tabs — re-render when any text file dirty state changes.
	React.useEffect(() => {
		const sub = textFileService.files.onDidChangeDirty(() => {
			setDirtyTick(t => t + 1);
		});
		return () => sub.dispose();
	}, [textFileService]);

	// Reattach agent-window terminals after IDE reload AND after each workspace
	// switch (the store resets its once-per-session reattach guard on switch).
	React.useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const entries = await terminalStore.reattachOnStartup();
				if (cancelled) {
					return;
				}
				bumpIdCounterFromIds([
					...terminalStore.entries.map(e => e.id),
					...entries.map(e => e.id),
					...tabsRef.current.map(t => t.id),
				]);
				if (entries.length === 0) {
					return;
				}
				setTabs(prev => {
					const existing = new Set(prev.map(t => t.id));
					const next = [...prev];
					for (const entry of entries) {
						if (existing.has(entry.id)) {
							continue;
						}
						next.push({ id: entry.id, kind: 'terminal' as PanelKind, title: entry.title || 'Terminal' });
						existing.add(entry.id);
					}
					return next;
				});
				setActiveId(cur => cur ?? entries[0]?.id ?? null);
			} catch {
				// best-effort
			} finally {
				if (!cancelled) {
					terminalStore.endWorkspaceTransition();
				}
			}
		})();
		return () => { cancelled = true; };
	}, [terminalStore, agentWorkspaceState.activeWorkspaceId, bumpIdCounterFromIds]);

	// Keep the tab strip in sync with the terminal store's persisted entries.
	// `agentWindowTerminalStore` fires `onDidChangeEntries` on register/remove
	// AND on active-workspace switch (where it reloads `entries` from the new
	// workspace's storage key). Without this subscription, terminals added or
	// removed by another code path — or the entire terminal set swapped in by a
	// workspace switch — never reach `tabs`, so the strip shows stale tabs (or
	// no tabs) until the user manually clicks +. #7.
	React.useEffect(() => {
		const syncFromStore = () => {
			const storeEntries = terminalStore.entries;
			// Compute the next tabs list once, outside the setState updater, so
			// the active-tab fallback below can check the SAME list (reading
			// `tabsRef.current` inside setActiveId would see the pre-update
			// tabs and could keep an activeId pointing at a tab we just dropped).
			const storeIds = new Set(storeEntries.map(e => e.id));
			const byId = new Map(tabsRef.current.map(t => [t.id, t]));
			const seen = new Set<string>();
			let next = tabsRef.current.filter(t => t.kind !== 'terminal' || storeIds.has(t.id));
			for (const entry of storeEntries) {
				if (seen.has(entry.id)) {
					continue;
				}
				const existing = byId.get(entry.id);
				if (existing && existing.kind === 'terminal') {
					const newTitle = entry.title || 'Terminal';
					if (existing.title !== newTitle) {
						next = next.map(t => t.id === entry.id ? { ...t, title: newTitle } : t);
					}
					seen.add(entry.id);
					continue;
				}
				next.push({ id: entry.id, kind: 'terminal' as PanelKind, title: entry.title || 'Terminal' });
				seen.add(entry.id);
			}
			// Keep id minting above every persisted / visible tab id so a new
			// terminal after a workspace switch cannot collide with reloaded ids.
			bumpIdCounterFromIds([
				...next.map(t => t.id),
				...storeEntries.map(e => e.id),
			]);
			setTabs(next);
			setActiveId(cur => {
				if (!cur) {
					return storeEntries[0]?.id ?? null;
				}
				if (next.some(t => t.id === cur)) {
					return cur;
				}
				const firstTerminal = next.find(t => t.kind === 'terminal')?.id ?? null;
				return firstTerminal;
			});
		};
		const sub = terminalStore.onDidChangeEntries(syncFromStore);
		// Run once on mount so a workspace switch that happened between the
		// reattach effect above and this subscription is reflected immediately.
		syncFromStore();
		return () => sub.dispose();
	}, [terminalStore, bumpIdCounterFromIds]);

	const openPanel = React.useCallback((kind: PanelKind, resource?: string, opts?: { reuseExisting?: boolean }) => {
		setAddMenuOpen(false);
		const meta = panelMetaFor(kind);
		// Mint the id OUTSIDE the updater — updaters must stay pure (StrictMode /
		// concurrent React may re-invoke them), and `++idCounter` inside produced a
		// different id per invocation. A deduped open wastes one id; ids only need
		// to be unique, not dense.
		const newId = `ws-${kind}-${++idCounter.current}`;
		setTabs(prev => {
			if (!meta.allowMultiple) {
				const existing = prev.find(t => t.kind === kind);
				if (existing) {
					setActiveId(existing.id);
					return prev;
				}
			}

			// External "show me a browser" requests focus an existing browser tab
			// instead of stacking another. Decided INSIDE the updater so two
			// requests landing in the same tick can't both see "no browser yet"
			// (the old check read tabsRef, which is stale within a batch).
			if (kind === 'browser' && opts?.reuseExisting) {
				const existing = prev.find(t => t.kind === 'browser');
				if (existing) {
					setActiveId(existing.id);
					return prev;
				}
			}

			if (kind === 'files') {
				if (resource) {
					const normalized = normalizeFileResource(resource);
					const existingFile = prev.find(t => t.kind === 'files' && t.resource && normalizeFileResource(t.resource) === normalized);
					if (existingFile) {
						setActiveId(existingFile.id);
						return prev;
					}
					// Prefer filling an empty File tab over stacking another.
					const emptyIdx = prev.findIndex(t => t.kind === 'files' && !t.resource);
					if (emptyIdx >= 0) {
						const next = [...prev];
						next[emptyIdx] = {
							...next[emptyIdx],
							resource: normalized,
							title: basename(resource),
						};
						setActiveId(next[emptyIdx].id);
						return next;
					}
				} else {
					const existingEmpty = prev.find(t => t.kind === 'files' && !t.resource);
					if (existingEmpty) {
						setActiveId(existingEmpty.id);
						return prev;
					}
				}
			}

			const title = resource ? basename(resource) : meta.label;
			setActiveId(newId);
			return [...prev, {
				id: newId,
				kind,
				title,
				resource: resource ? normalizeFileResource(resource) : resource,
			}];
		});
	}, []);

	// Open panels requested from outside the workspace column — e.g. the chat
	// composer's browser button opens the Browser tab here instead of a Simple
	// Browser in the main IDE window. If a Browser tab is already open, focus it
	// rather than stacking another (the composer button is a "show me a browser"
	// affordance, not "open N browsers").
	React.useEffect(() => {
		const handleRequest = ({ kind, resource }: { kind: string; resource?: string }) => {
			// Browser: focus an existing tab rather than stacking another. The
			// dedup happens inside openPanel's setTabs updater so concurrent
			// requests in one tick can't both create a tab.
			openPanel(kind as PanelKind, resource, { reuseExisting: kind === 'browser' });
		};
		const sub = agentWindowService.onDidRequestWorkspacePanel(handleRequest);
		// Drain requests that fired before this component mounted (e.g. an MCP
		// browser_navigate arriving while the window was still building) — they
		// were emitted into a listener-less emitter and would otherwise be lost.
		for (const pending of agentWindowService.consumePendingWorkspacePanelRequests()) {
			handleRequest(pending);
		}
		return () => sub.dispose();
	}, [agentWindowService, openPanel]);

	// Focus the workspace tab that hosts a native browser view when the MCP
	// server asks to select an agents-window browser tab.
	React.useEffect(() => {
		const sub = agentWindowService.onDidRequestSelectBrowserView(({ workspaceTabId }) => {
			// The tab may have been closed between the MCP server issuing this
			// request and it arriving here — activating a stale id would blank
			// the workspace body (no tab matches `activeId`).
			if (tabsRef.current.some(t => t.id === workspaceTabId)) {
				setActiveId(workspaceTabId);
			}
		});
		return () => sub.dispose();
	}, [agentWindowService]);

	const retargetFileResource = React.useCallback((from: URI, to: URI) => {
		const fromKey = normalizeFileResource(from.toString());
		const toKey = normalizeFileResource(to.toString());
		setTabs(prev => {
			const mapped = prev.map(t => {
				if (t.kind !== 'files' || !t.resource) {
					return t;
				}
				if (normalizeFileResource(t.resource) !== fromKey) {
					return t;
				}
				return {
					...t,
					resource: toKey,
					title: basename(to.toString()),
				};
			});
			// The rename may have made two tabs point at the same file (a tab for
			// `to` was already open) — collapse them onto the first occurrence so
			// openPanel's dedup invariant (one tab per resource) holds.
			const firstIdByKey = new Map<string, string>();
			const deduped: typeof mapped = [];
			for (const t of mapped) {
				if (t.kind === 'files' && t.resource) {
					const key = normalizeFileResource(t.resource);
					const keptId = firstIdByKey.get(key);
					if (keptId !== undefined) {
						// Dropping a duplicate: if it was active, hand focus to the kept tab.
						setActiveId(cur => (cur === t.id ? keptId : cur));
						continue;
					}
					firstIdByKey.set(key, t.id);
				}
				deduped.push(t);
			}
			return deduped.length === prev.length ? mapped : deduped;
		});
	}, []);

	const closeTab = React.useCallback(async (id: string) => {
		// Guard against re-entrancy: a double-click on the × fires closeTab twice;
		// without this both calls see the tab as present and stack two identical
		// save dialogs.
		if (closingTabsRef.current.has(id)) {
			return;
		}
		closingTabsRef.current.add(id);
		try {
			const tab = tabsRef.current.find(t => t.id === id);
			if (!tab) {
				return;
			}
			if (tab.kind === 'files' && tab.resource) {
				const uri = tryParseUri(tab.resource);
				// Prefer the panel's own handle (correct for both a tracked file AND
				// an ephemeral fallback model) over `textFileService.isDirty`, which
				// only ever knows about the former.
				const handle = fileHandlesRef.current.get(id);
				let dirty = false;
				try {
					dirty = handle ? handle.isDirty() : (uri ? textFileService.isDirty(uri) : false);
				} catch {
					// If the dirty check itself fails, don't trap the user — close.
					dirty = false;
				}
				if (uri && dirty) {
					let action: 'save' | 'discard' | 'cancel' = 'cancel';
					let promptFailed = false;
					try {
						await dialogService.prompt({
							type: 'warning',
							message: `Do you want to save the changes you made to ${tab.title}?`,
							detail: 'Your changes will be lost if you don\'t save them.',
							buttons: [
								{
									label: 'Save',
									run: () => { action = 'save'; },
								},
								{
									label: 'Don\'t Save',
									run: () => { action = 'discard'; },
								},
							],
							cancelButton: {
								label: 'Cancel',
								run: () => { action = 'cancel'; },
							},
						});
					} catch {
						// Dialog infrastructure failure — preserve the old behavior of
						// not trapping the user (close without saving).
						promptFailed = true;
					}
					if (!promptFailed) {
						if (action === 'cancel') {
							return;
						}
						if (action === 'save') {
							try {
								if (handle) { await handle.save(); } else { await textFileService.save(uri); }
							} catch { /* verified via the dirty re-check below */ }
							// The panel's save reports failure by staying dirty (its doSave
							// catches internally and shows a banner) — treating that as
							// success here silently discarded the buffer. Abort the close
							// and leave the tab (and its error banner) visible instead.
							let stillDirty = false;
							try {
								stillDirty = handle ? handle.isDirty() : textFileService.isDirty(uri);
							} catch { stillDirty = false; }
							if (stillDirty) {
								return;
							}
						} else if (action === 'discard') {
							try {
								if (handle) { await handle.discard(); } else { await textFileService.revert(uri, { force: true }); }
							} catch { /* user chose to drop the edits — close regardless */ }
						}
					}
				}
			}

			setTabs(prev => {
				const idx = prev.findIndex(t => t.id === id);
				if (idx === -1) {
					return prev;
				}
				const next = prev.filter(t => t.id !== id);
				setActiveId(cur => {
					if (cur !== id) {
						return cur;
					}
					const fallback = next[idx] ?? next[idx - 1] ?? next[next.length - 1] ?? null;
					return fallback ? fallback.id : null;
				});
				return next;
			});
		} finally {
			closingTabsRef.current.delete(id);
		}
	}, [textFileService, dialogService]);

	const setTitle = React.useCallback((id: string, title: string) => {
		// Skip the state update when the title is unchanged. Panels call this on
		// every model resolve; without this guard a same-value write still creates
		// a new tabs array, re-renders the workspace, and hands every mounted panel
		// a fresh callback identity — which used to re-trigger their resolve effects
		// in a self-sustaining loop (blink / stuck "Loading…").
		setTabs(prev => {
			const t = prev.find(x => x.id === id);
			if (!t || t.title === title) {
				return prev;
			}
			return prev.map(x => (x.id === id ? { ...x, title } : x));
		});
	}, []);

	React.useEffect(() => {
		if (!addMenuOpen) {
			return;
		}
		const onPointerDown = (e: MouseEvent) => {
			const target = e.target as Node;
			if (addMenuRef.current?.contains(target) || addBtnRef.current?.contains(target)) {
				return;
			}
			setAddMenuOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				setAddMenuOpen(false);
			}
		};
		doc.addEventListener('mousedown', onPointerDown, true);
		doc.addEventListener('keydown', onKeyDown, true);
		return () => {
			doc.removeEventListener('mousedown', onPointerDown, true);
			doc.removeEventListener('keydown', onKeyDown, true);
		};
	}, [addMenuOpen, doc]);

	const hasTabs = tabs.length > 0;
	const activeTab = tabs.find(t => t.id === activeId) ?? null;
	const hasFileTab = tabs.some(t => t.kind === 'files');
	const showSideExplorer = activeTab?.kind === 'files' && explorerVisible;
	const openFileResources = tabs
		.filter(t => t.kind === 'files' && t.resource)
		.map(t => t.resource!);

	const openFromExplorer = React.useCallback((uri: URI) => {
		openPanel('files', uri.toString());
	}, [openPanel]);

	const navigateFile = React.useCallback((uri: URI) => {
		openPanel('files', uri.toString());
	}, [openPanel]);

	// The CSS-hidden side explorer keeps focusable children in the tab order and
	// `aria-hidden` alone is an a11y violation for them — `inert` removes the
	// whole subtree from focus/interaction while hidden.
	React.useEffect(() => {
		const el = sideExplorerRef.current;
		if (el) {
			(el as HTMLElement & { inert: boolean }).inert = !showSideExplorer;
		}
	}, [showSideExplorer, hasFileTab]);

	// Roving-tabindex keyboard support for the tab strip (ARIA tabs pattern):
	// Left/Right cycle, Home/End jump; selection follows focus.
	const onTabListKeyDown = (e: React.KeyboardEvent) => {
		const list = tabsRef.current;
		if (!list.length) {
			return;
		}
		const idx = list.findIndex(t => t.id === activeId);
		let nextIdx: number;
		switch (e.key) {
			case 'ArrowRight': nextIdx = idx < 0 ? 0 : (idx + 1) % list.length; break;
			case 'ArrowLeft': nextIdx = idx < 0 ? 0 : (idx - 1 + list.length) % list.length; break;
			case 'Home': nextIdx = 0; break;
			case 'End': nextIdx = list.length - 1; break;
			default: return;
		}
		e.preventDefault();
		const next = list[nextIdx];
		setActiveId(next.id);
		tabsListRef.current
			?.querySelector<HTMLElement>(`[data-tab-id="${next.id}"]`)
			?.focus();
	};

	const isTabDirty = (tab: WorkspaceTab): boolean => {
		if (tab.kind !== 'files' || !tab.resource) {
			return false;
		}
		const handle = fileHandlesRef.current.get(tab.id);
		if (handle) {
			return handle.isDirty();
		}
		try {
			const uri = tryParseUri(tab.resource);
			return uri ? textFileService.isDirty(uri) : false;
		} catch {
			return false;
		}
	};

	return (
		<div className="agent-workspace">
			<div className="agent-workspace-tabbar">
				<div className="agent-workspace-tabs" role="tablist" ref={tabsListRef} onKeyDown={onTabListKeyDown}>
					{tabs.map(tab => {
						const isActive = tab.id === activeId;
						const meta = panelMetaFor(tab.kind);
						const Icon = meta.icon;
						const dirty = isTabDirty(tab);
						const fileUri = tab.kind === 'files' && tab.resource ? tryParseUri(tab.resource) : undefined;
						return (
							<div
								key={tab.id}
								role="tab"
								aria-selected={isActive}
								tabIndex={isActive ? 0 : -1}
								data-tab-id={tab.id}
								className={`agent-workspace-tab${isActive ? ' active' : ''}${dirty ? ' dirty' : ''}`}
								onClick={() => setActiveId(tab.id)}
								onAuxClick={(e) => {
									// Middle-click closes, matching IDE tab strips.
									if (e.button === 1) {
										e.preventDefault();
										void closeTab(tab.id);
									}
								}}
								title={tab.resource || tab.title}
							>
								{fileUri ? (
									<span className="agent-workspace-tab-fileicon">
										<VsCodeFileIcon
											uri={fileUri}
											filename={tab.title}
											size={14}
										/>
									</span>
								) : (
									<Icon size={13} strokeWidth={1.75} className="agent-workspace-tab-icon" />
								)}
								<span className="agent-workspace-tab-label">
									{tab.title}
								</span>
								<span className="agent-workspace-tab-endcap">
									{dirty && <span className="agent-workspace-tab-dot" aria-hidden="true" />}
									<button
										type="button"
										className="agent-workspace-tab-close"
										aria-label={dirty ? `Close ${tab.title} (unsaved)` : `Close ${tab.title}`}
										title="Close"
										onClick={(e) => { e.stopPropagation(); void closeTab(tab.id); }}
									>
										<X size={12} strokeWidth={2.25} />
									</button>
								</span>
							</div>
						);
					})}
				</div>

				<div className="agent-workspace-add-wrap">
					<button
						ref={addBtnRef}
						type="button"
						className="agent-workspace-add-btn"
						aria-label="Open panel"
						aria-haspopup="menu"
						aria-expanded={addMenuOpen}
						onClick={() => setAddMenuOpen(v => !v)}
					>
						<Plus size={15} strokeWidth={2} />
					</button>
					{addMenuOpen && (
						<div ref={addMenuRef} role="menu" className="agent-workspace-add-menu">
							{PANEL_METAS.map(meta => {
								const Icon = meta.icon;
								return (
									<button
										key={meta.kind}
										type="button"
										role="menuitem"
										className="agent-workspace-add-menu-item"
										onClick={() => openPanel(meta.kind)}
									>
										<Icon size={14} strokeWidth={1.75} />
										<span>{meta.label}</span>
									</button>
								);
							})}
						</div>
					)}
				</div>
			</div>

			<div className={`agent-workspace-body${showSideExplorer ? ' with-explorer' : ''}`}>
				<div className="agent-workspace-main-col">
					{!hasTabs && <WorkspaceEmptyState onOpen={openPanel} />}
					{tabs.map(tab => {
						const isActive = tab.id === activeId;
						const commonProps: WorkspacePanelProps = {
							tab,
							isActive,
							overlayOpen: addMenuOpen,
							setTitle: (t) => setTitle(tab.id, t),
							close: () => { void closeTab(tab.id); },
							openInWorkspace: openPanel,
							registerFileHandle: (handle) => registerFileHandle(tab.id, handle),
						};
						return (
							<div
								key={tab.id}
								className="agent-workspace-panel-host"
								style={{ display: isActive ? 'flex' : 'none' }}
							>
								{tab.kind === 'files' ? (
									<FileEditorPanel
										{...commonProps}
										explorerVisible={explorerVisible}
										onToggleExplorer={toggleExplorer}
										onNavigateFile={navigateFile}
										openFileResources={openFileResources}
									/>
								) : tab.kind === 'changes' ? (
									<ChangesPanel {...commonProps} />
								) : tab.kind === 'terminal' ? (
									<TerminalPanel {...commonProps} />
								) : (
									<BrowserPanel {...commonProps} />
								)}
							</div>
						);
					})}
				</div>

				{/* Keep explorer mounted whenever any file tab exists so expand/selection survive
				    Terminal/Browser switches and explorer toggles. Hide with CSS when inactive. */}
				{hasFileTab && (
					<aside
						ref={sideExplorerRef}
						className={`agent-workspace-side-explorer${showSideExplorer ? '' : ' hidden'}`}
						aria-label="File explorer"
						aria-hidden={!showSideExplorer}
					>
						<FilesExplorerPanel
							compact
							onOpenFile={openFromExplorer}
							onResourceMoved={retargetFileResource}
							activeResource={activeTab?.kind === 'files' ? (activeTab.resource ?? null) : null}
						/>
					</aside>
				)}
			</div>
		</div>
	);
};

/** Root of the right-side workspace, portaled into the Agents pop-out. */
export const AgentWorkspace = () => {
	return (
		<ConnectedWindowProvider>
			<AgentWorkspaceInner />
		</ConnectedWindowProvider>
	);
};
