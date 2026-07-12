/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as React from 'react';
import { Plus, X } from 'lucide-react';
import { URI } from '../../../../../../../base/common/uri.js';
import { StorageScope, StorageTarget } from '../../../../../../../platform/storage/common/storage.js';
import { ConnectedWindowProvider, useConnectedDocument } from '../sidebar-tsx/contexts/ConnectedWindowContext.js';
import { useAccessor } from '../util/services.js';
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
	const terminalStore = accessor.get('IAgentWindowTerminalStore');
	const agentWindowService = accessor.get('IAgentWindowService');
	const storageService = accessor.get('IStorageService');
	const textFileService = accessor.get('ITextFileService');
	const dialogService = accessor.get('IDialogService');

	const [tabs, setTabs] = React.useState<WorkspaceTab[]>([]);
	const tabsRef = React.useRef(tabs);
	tabsRef.current = tabs;
	const [activeId, setActiveId] = React.useState<string | null>(null);
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
	const idCounterSeeded = React.useRef(false);
	if (!idCounterSeeded.current) {
		idCounterSeeded.current = true;
		let maxId = 0;
		for (const e of terminalStore.entries) {
			const m = /-(\d+)$/.exec(e.id);
			if (m) { maxId = Math.max(maxId, parseInt(m[1], 10)); }
		}
		idCounter.current = maxId;
	}
	const addBtnRef = React.useRef<HTMLButtonElement | null>(null);
	const addMenuRef = React.useRef<HTMLDivElement | null>(null);

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

	// Reattach agent-window terminals after IDE reload.
	React.useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const entries = await terminalStore.reattachOnStartup();
				if (cancelled || entries.length === 0) {
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
			}
		})();
		return () => { cancelled = true; };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const openPanel = React.useCallback((kind: PanelKind, resource?: string) => {
		setAddMenuOpen(false);
		const meta = panelMetaFor(kind);
		setTabs(prev => {
			if (!meta.allowMultiple) {
				const existing = prev.find(t => t.kind === kind);
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

			const id = `ws-${kind}-${++idCounter.current}`;
			const title = resource ? basename(resource) : meta.label;
			setActiveId(id);
			return [...prev, {
				id,
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
		const sub = agentWindowService.onDidRequestWorkspacePanel(({ kind, resource }) => {
			if (kind === 'browser') {
				const existing = tabsRef.current.find(t => t.kind === 'browser');
				if (existing) {
					setActiveId(existing.id);
					return;
				}
			}
			openPanel(kind as PanelKind, resource);
		});
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
		setTabs(prev => prev.map(t => {
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
		}));
	}, []);

	const closeTab = React.useCallback(async (id: string) => {
		const tab = tabsRef.current.find(t => t.id === id);
		if (tab?.kind === 'files' && tab.resource) {
			try {
				const uri = tryParseUri(tab.resource);
				// Prefer the panel's own handle (correct for both a tracked file AND
				// an ephemeral fallback model) over `textFileService.isDirty`, which
				// only ever knows about the former.
				const handle = fileHandlesRef.current.get(id);
				const dirty = handle ? handle.isDirty() : (uri ? textFileService.isDirty(uri) : false);
				if (uri && dirty) {
					let action: 'save' | 'discard' | 'cancel' = 'cancel';
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
					if (action === 'cancel') {
						return;
					}
					if (action === 'save') {
						if (handle) { await handle.save(); } else { await textFileService.save(uri); }
					} else if (action === 'discard') {
						if (handle) { await handle.discard(); } else { await textFileService.revert(uri, { force: true }); }
					}
				}
			} catch {
				// If dirty check/save fails, still allow close — don't trap the user.
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
				<div className="agent-workspace-tabs" role="tablist">
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
								className={`agent-workspace-tab${isActive ? ' active' : ''}${dirty ? ' dirty' : ''}`}
								onClick={() => setActiveId(tab.id)}
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
