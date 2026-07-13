/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as React from 'react';
import {
	ChevronDown,
	ChevronRight,
	FolderOpen,
	FolderTree,
	RefreshCw,
	FilePlus,
	FolderPlus,
	ChevronsDownUp,
	Search,
} from 'lucide-react';
import { URI } from '../../../../../../../../base/common/uri.js';
import { parse as parseGlobExpression, type IExpression, type ParsedExpression } from '../../../../../../../../base/common/glob.js';
import { deepClone } from '../../../../../../../../base/common/objects.js';
import { VSBuffer } from '../../../../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../../../../base/common/network.js';
import { basename as resourceBasename, dirname as resourceDirname, joinPath, relativePath as resourceRelativePath } from '../../../../../../../../base/common/resources.js';
import { IFileService, IFileStat } from '../../../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../../../../../platform/configuration/common/configuration.js';
import { isLinux, isMacintosh } from '../../../../../../../../base/common/platform.js';
import { useAccessor } from '../../util/services.js';
import { getConnectedDocument, getConnectedWindow, focusInConnectedWindow } from '../../util/connectedWindow.js';
import { VsCodeFileIcon } from '../../sidebar-tsx/utils/fileIcons.js';
import { PanelPlaceholder } from './PanelPlaceholder.js';

export interface ExplorerNode {
	readonly uri: URI;
	readonly name: string;
	readonly isDirectory: boolean;
	readonly isRoot: boolean;
	readonly depth: number;
	readonly parentKey: string | null;
}

type LoadState = 'idle' | 'loading' | 'error';

type ContextMenuState = {
	x: number;
	y: number;
	node: ExplorerNode;
} | null;

type InlineEdit =
	| { mode: 'rename'; node: ExplorerNode; value: string }
	| { mode: 'newFile' | 'newFolder'; parent: ExplorerNode; value: string }
	| null;

const nodeKey = (uri: URI): string => uri.toString();

type SortOrder = 'default' | 'mixed' | 'filesFirst' | 'type' | 'modified';

const compareNodes = (a: ExplorerNode, b: ExplorerNode, sortOrder: SortOrder): number => {
	if (sortOrder === 'filesFirst') {
		if (a.isDirectory !== b.isDirectory) {
			return a.isDirectory ? 1 : -1;
		}
	} else {
		if (a.isDirectory !== b.isDirectory) {
			return a.isDirectory ? -1 : 1;
		}
	}
	if (sortOrder === 'type') {
		const aExt = a.name.lastIndexOf('.') > 0 ? a.name.slice(a.name.lastIndexOf('.')) : '';
		const bExt = b.name.lastIndexOf('.') > 0 ? b.name.slice(b.name.lastIndexOf('.')) : '';
		if (aExt !== bExt) {
			return aExt.localeCompare(bExt, undefined, { sensitivity: 'base' });
		}
	}
	return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
};

const DEFAULT_EXCLUDES: IExpression = {
	'**/.git': true,
	'**/.DS_Store': true,
	'**/Thumbs.db': true,
};

const INVALID_NAME = /[\\/:*?"<>|]/;

const uniqueChildName = (existing: readonly string[], base: string): string => {
	if (!existing.includes(base)) {
		return base;
	}
	const dot = base.lastIndexOf('.');
	const stem = dot > 0 ? base.slice(0, dot) : base;
	const ext = dot > 0 ? base.slice(dot) : '';
	let i = 1;
	while (existing.includes(`${stem}${i}${ext}`)) {
		i++;
	}
	return `${stem}${i}${ext}`;
};

const isValidEntryName = (name: string): string | null => {
	const trimmed = name.trim();
	if (!trimmed) {
		return 'Name cannot be empty.';
	}
	if (trimmed === '.' || trimmed === '..') {
		return 'Name cannot be "." or "..".';
	}
	if (INVALID_NAME.test(trimmed)) {
		return 'Name contains invalid characters.';
	}
	return null;
};

const readSortOrder = (configurationService: IConfigurationService): SortOrder => {
	const v = configurationService.getValue<string>('explorer.sortOrder');
	if (v === 'mixed' || v === 'filesFirst' || v === 'type' || v === 'modified') {
		return v;
	}
	return 'default';
};

export interface FilesExplorerPanelProps {
	onOpenFile: (uri: URI) => void;
	/** When a resource is renamed/moved, retarget any open file tabs. */
	onResourceMoved?: (from: URI, to: URI) => void;
	activeResource?: string | null;
	compact?: boolean;
}

/**
 * Cursor-style workspace file tree for the Agents window right rail.
 *
 * Production-hardened: single-flight edits, safe context menu, FS race guards,
 * cross-window-correct drag image, and main-explorer feature parity (collapse
 * all, open to side, find in folder, compare, delete permanently, duplicate,
 * cancel-cut, filter-on-type, config-respecting sort order & confirmations).
 */
export const FilesExplorerPanel = ({
	onOpenFile,
	onResourceMoved,
	activeResource,
	compact = true,
}: FilesExplorerPanelProps) => {
	const accessor = useAccessor();
	const fileService = accessor.get('IFileService') as IFileService;
	const workspaceContextService = accessor.get('IWorkspaceContextService') as IWorkspaceContextService;
	const agentProjectWorkspaceService = accessor.get('IAgentProjectWorkspaceService');
	const configurationService = accessor.get('IConfigurationService') as IConfigurationService;
	const dialogService = accessor.get('IDialogService');
	const clipboardService = accessor.get('IClipboardService');
	const nativeHostService = accessor.get('INativeHostService');
	const notificationService = accessor.get('INotificationService');
	const commandService = accessor.get('ICommandService');

	const [roots, setRoots] = React.useState<ExplorerNode[]>([]);
	const [childrenByParent, setChildrenByParent] = React.useState<Record<string, ExplorerNode[]>>({});
	const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());
	const [loadingKeys, setLoadingKeys] = React.useState<Set<string>>(() => new Set());
	const [errorByKey, setErrorByKey] = React.useState<Record<string, string>>({});
	const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
	/** Multi-select set (always includes selectedKey when non-empty). */
	const [selectedKeys, setSelectedKeys] = React.useState<Set<string>>(() => new Set());
	const [rootState, setRootState] = React.useState<LoadState>('loading');
	const [rootError, setRootError] = React.useState<string | null>(null);
	const [refreshTick, setRefreshTick] = React.useState(0);
	const [contextMenu, setContextMenu] = React.useState<ContextMenuState>(null);
	const [inlineEdit, setInlineEdit] = React.useState<InlineEdit>(null);
	const [dropTargetKey, setDropTargetKey] = React.useState<string | null>(null);
	/** Internal cut/copy clipboard for explorer paste. */
	const [fileClipboard, setFileClipboard] = React.useState<{ mode: 'cut' | 'copy'; uris: URI[] } | null>(null);
	/** Filter-on-type string (empty = no filter). */
	const [filterText, setFilterText] = React.useState('');
	/** Resource pinned for "Compare with Selected". */
	const [compareSelectedUri, setCompareSelectedUri] = React.useState<URI | null>(null);
	const [sortOrder, setSortOrder] = React.useState<SortOrder>(() => readSortOrder(configurationService));

	const inlineInputRef = React.useRef<HTMLInputElement | null>(null);
	const filterInputRef = React.useRef<HTMLInputElement | null>(null);
	const treeRef = React.useRef<HTMLDivElement | null>(null);
	const menuRef = React.useRef<HTMLDivElement | null>(null);
	const expandedRef = React.useRef(expanded);
	expandedRef.current = expanded;
	const childrenRef = React.useRef(childrenByParent);
	childrenRef.current = childrenByParent;
	const rootsRef = React.useRef(roots);
	rootsRef.current = roots;
	const loadSeqRef = React.useRef<Record<string, number>>({});
	const rebuildGenRef = React.useRef(0);
	const commitGuardRef = React.useRef(false);
	const inlineCancelledRef = React.useRef(false);
	const anchorKeyRef = React.useRef<string | null>(null);
	const dragUrisRef = React.useRef<URI[]>([]);
	const selectedKeyRef = React.useRef<string | null>(null);
	selectedKeyRef.current = selectedKey;
	const excludeCacheRef = React.useRef<Map<string, { raw: string; parsed: ParsedExpression }>>(new Map());

	React.useEffect(() => {
		if (activeResource) {
			setSelectedKey(activeResource);
			setSelectedKeys(new Set([activeResource]));
		}
	}, [activeResource]);

	// Keep sort order in sync with configuration.
	React.useEffect(() => {
		const sub = configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('explorer.sortOrder')) {
				setSortOrder(readSortOrder(configurationService));
			}
		});
		return () => sub.dispose();
	}, [configurationService]);

	const selectOnly = React.useCallback((key: string) => {
		setSelectedKey(key);
		setSelectedKeys(new Set([key]));
		anchorKeyRef.current = key;
	}, []);

	const selectWithModifiers = React.useCallback((key: string, e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }, rowKeys: string[]) => {
		const multi = e.metaKey || e.ctrlKey;
		if (e.shiftKey && anchorKeyRef.current) {
			const a = rowKeys.indexOf(anchorKeyRef.current);
			const b = rowKeys.indexOf(key);
			if (a >= 0 && b >= 0) {
				const [lo, hi] = a < b ? [a, b] : [b, a];
				const range = new Set(rowKeys.slice(lo, hi + 1));
				setSelectedKeys(range);
				setSelectedKey(key);
				return;
			}
		}
		if (multi) {
			setSelectedKeys(prev => {
				const next = new Set(prev);
				if (next.has(key)) {
					next.delete(key);
				} else {
					next.add(key);
				}
				return next;
			});
			setSelectedKey(key);
			anchorKeyRef.current = key;
			return;
		}
		selectOnly(key);
	}, [selectOnly]);

	const excludesForFolder = React.useCallback((folder: IWorkspaceFolder): ParsedExpression => {
		const config = configurationService.getValue<{ files?: { exclude?: IExpression } }>({ resource: folder.uri });
		const expression = deepClone(config?.files?.exclude ?? DEFAULT_EXCLUDES) as IExpression;
		const raw = JSON.stringify(expression);
		const cached = excludeCacheRef.current.get(folder.uri.toString());
		if (cached && cached.raw === raw) {
			return cached.parsed;
		}
		const parsed = parseGlobExpression(expression);
		excludeCacheRef.current.set(folder.uri.toString(), { raw, parsed });
		return parsed;
	}, [configurationService]);

	const isExcluded = React.useCallback((folder: IWorkspaceFolder, resource: URI, name: string, siblings: readonly string[]): boolean => {
		const rel = resourceRelativePath(folder.uri, resource);
		if (rel === undefined) {
			return false;
		}
		const relPath = rel.replace(/\\/g, '/');
		const hasSibling = (sib: string) => siblings.includes(sib);
		return !!excludesForFolder(folder)(relPath, name, hasSibling);
	}, [excludesForFolder]);

	const getAgentFolders = React.useCallback((): IWorkspaceFolder[] => {
		const uris = agentProjectWorkspaceService.getActiveFolders();
		if (uris.length === 0) {
			return [];
		}
		return uris.map((uri, index) => ({
			uri,
			name: resourceBasename(uri) || `Folder ${index + 1}`,
			index,
			toResource: (relativePath: string) => joinPath(uri, relativePath),
		} as IWorkspaceFolder));
	}, [agentProjectWorkspaceService]);

	const findFolderFor = React.useCallback((resource: URI): IWorkspaceFolder | undefined => {
		const agentFolders = getAgentFolders();
		const fromPool = agentFolders.find(f =>
			resource.scheme === f.uri.scheme
			&& (resource.path === f.uri.path || resource.path.startsWith(f.uri.path.endsWith('/') ? f.uri.path : f.uri.path + '/'))
		);
		if (fromPool) {
			return fromPool;
		}
		// Agent window: do not fall back to IDE folders.
		return undefined;
	}, [getAgentFolders]);

	const toChildNodes = React.useCallback((
		parent: ExplorerNode,
		stats: readonly IFileStat[] | undefined,
		folder: IWorkspaceFolder,
	): ExplorerNode[] => {
		if (!stats?.length) {
			return [];
		}
		const names = stats.map(s => s.name || resourceBasename(s.resource));
		const nodes: ExplorerNode[] = [];
		for (const child of stats) {
			const name = child.name || resourceBasename(child.resource);
			if (isExcluded(folder, child.resource, name, names)) {
				continue;
			}
			nodes.push({
				uri: child.resource,
				name,
				isDirectory: !!child.isDirectory,
				isRoot: false,
				depth: parent.depth + 1,
				parentKey: nodeKey(parent.uri),
			});
		}
		nodes.sort((a, b) => compareNodes(a, b, sortOrder));
		return nodes;
	}, [isExcluded, sortOrder]);

	const loadChildren = React.useCallback(async (parent: ExplorerNode, force = false): Promise<ExplorerNode[]> => {
		const key = nodeKey(parent.uri);
		// Cache hit only when key is present (successful resolve). Error path deletes the
		// key so the next expand retries instead of reusing a stuck empty listing.
		if (!force && (key in childrenRef.current)) {
			return childrenRef.current[key] ?? [];
		}
		const folder = findFolderFor(parent.uri);
		if (!folder) {
			return [];
		}

		const seq = (loadSeqRef.current[key] ?? 0) + 1;
		loadSeqRef.current[key] = seq;

		setLoadingKeys(prev => new Set(prev).add(key));
		setErrorByKey(prev => {
			if (!(key in prev)) {
				return prev;
			}
			const next = { ...prev };
			delete next[key];
			return next;
		});

		try {
			const stat = await fileService.resolve(parent.uri, { resolveMetadata: false });
			if (loadSeqRef.current[key] !== seq) {
				return childrenRef.current[key] ?? [];
			}
			const nodes = toChildNodes(parent, stat.children, folder);
			setChildrenByParent(prev => ({ ...prev, [key]: nodes }));
			return nodes;
		} catch (e: unknown) {
			if (loadSeqRef.current[key] !== seq) {
				return childrenRef.current[key] ?? [];
			}
			const message = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
			setErrorByKey(prev => ({ ...prev, [key]: message || 'Failed to read folder' }));
			// Do not cache [] as success — delete entry so expand retries.
			setChildrenByParent(prev => {
				const next = { ...prev };
				delete next[key];
				return next;
			});
			return [];
		} finally {
			if (loadSeqRef.current[key] === seq) {
				setLoadingKeys(prev => {
					const next = new Set(prev);
					next.delete(key);
					return next;
				});
			}
		}
	}, [fileService, findFolderFor, toChildNodes, workspaceContextService]);

	const ensureExpanded = React.useCallback(async (node: ExplorerNode) => {
		const key = nodeKey(node.uri);
		setExpanded(prev => {
			if (prev.has(key)) {
				return prev;
			}
			const next = new Set(prev);
			next.add(key);
			return next;
		});
		return loadChildren(node, false);
	}, [loadChildren]);

	// Build / rebuild roots
	React.useEffect(() => {
		const gen = ++rebuildGenRef.current;
		const rebuild = async () => {
			setRootState('loading');
			setRootError(null);
			// Cancel any open inline edit so blur doesn't commit against a wiped tree.
			inlineCancelledRef.current = true;
			setInlineEdit(null);
			setContextMenu(null);

			const agentFolders = getAgentFolders();
			const folders = agentFolders;
			if (folders.length === 0) {
				if (rebuildGenRef.current !== gen) {
					return;
				}
				setRoots([]);
				setChildrenByParent({});
				setExpanded(new Set());
				setRootState('idle');
				return;
			}

			const nextRoots: ExplorerNode[] = folders.map((folder, index) => ({
				uri: folder.uri,
				name: folder.name || resourceBasename(folder.uri) || `Folder ${index + 1}`,
				isDirectory: true,
				isRoot: true,
				depth: 0,
				parentKey: null,
			}));

			if (rebuildGenRef.current !== gen) {
				return;
			}

			// Preserve expansion of still-valid keys; always expand roots.
			const prevExpanded = expandedRef.current;
			const nextExpanded = new Set<string>();
			for (const root of nextRoots) {
				nextExpanded.add(nodeKey(root.uri));
			}
			for (const key of prevExpanded) {
				// Keep non-root expanded keys; loadChildren will re-fill on demand.
				nextExpanded.add(key);
			}

			setRoots(nextRoots);
			setExpanded(nextExpanded);
			// Keep previous children until refreshed so UI doesn't flash empty mid-edit.
			setRootState('idle');

			await Promise.all(nextRoots.map(root => loadChildren(root, true)));
			// Re-load any previously expanded non-root dirs that still exist.
			for (const key of prevExpanded) {
				if (nextRoots.some(r => nodeKey(r.uri) === key)) {
					continue;
				}
				try {
					const uri = URI.parse(key);
					const folder = findFolderFor(uri);
					if (!folder) {
						continue;
					}
					const exists = await fileService.exists(uri);
					if (!exists || rebuildGenRef.current !== gen) {
						continue;
					}
					const stub: ExplorerNode = {
						uri,
						name: resourceBasename(uri),
						isDirectory: true,
						isRoot: false,
						depth: 1,
						parentKey: null,
					};
					await loadChildren(stub, true);
				} catch {
					// drop invalid expanded keys silently
				}
			}
		};

		void rebuild().catch((e: unknown) => {
			if (rebuildGenRef.current !== gen) {
				return;
			}
			setRootState('error');
			setRootError(e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e));
		});

		const folderSub = workspaceContextService.onDidChangeWorkspaceFolders(() => {
			excludeCacheRef.current.clear();
			void rebuild();
		});
		const agentSub = agentProjectWorkspaceService.onDidChangeState(() => {
			excludeCacheRef.current.clear();
			void rebuild();
		});
		const configSub = configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('files.exclude')) {
				excludeCacheRef.current.clear();
				void rebuild();
			}
		});

		return () => {
			// Invalidate in-flight rebuild without incrementing (would race next effect).
			rebuildGenRef.current += 1;
			folderSub.dispose();
			agentSub.dispose();
			configSub.dispose();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [workspaceContextService, agentProjectWorkspaceService, configurationService, loadChildren, refreshTick, findFolderFor, fileService, getAgentFolders]);

	// Debounced FS watcher
	React.useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const pending = new Set<string>();

		const flush = () => {
			timer = undefined;
			const keys = [...pending];
			pending.clear();
			const allNodes = [...rootsRef.current, ...Object.values(childrenRef.current).flat()];
			const byKey = new Map(allNodes.map(n => [nodeKey(n.uri), n]));
			for (const key of keys) {
				const node = byKey.get(key);
				if (node?.isDirectory && expandedRef.current.has(key)) {
					void loadChildren(node, true);
				}
			}
			// Prune stale expanded keys whose parent no longer lists them.
			pruneStaleExpanded();
		};

		const schedule = (key: string) => {
			pending.add(key);
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			timer = setTimeout(flush, 250);
		};

		const sub = fileService.onDidFilesChange(e => {
			if (!e.gotAdded() && !e.gotDeleted() && !e.gotUpdated()) {
				return;
			}
			const candidates = new Set<string>();
			for (const root of rootsRef.current) {
				const rootKey = nodeKey(root.uri);
				if (expandedRef.current.has(rootKey) && e.affects(root.uri)) {
					candidates.add(rootKey);
				}
			}
			for (const nodes of Object.values(childrenRef.current)) {
				for (const node of nodes) {
					if (!node.isDirectory) {
						continue;
					}
					const key = nodeKey(node.uri);
					if (expandedRef.current.has(key) && e.affects(node.uri)) {
						candidates.add(key);
					}
				}
			}
			for (const key of candidates) {
				schedule(key);
			}
		});

		return () => {
			sub.dispose();
			if (timer !== undefined) {
				clearTimeout(timer);
			}
		};
	}, [fileService, loadChildren]);

	// Prune expanded keys that are no longer reachable from any parent's children.
	const pruneStaleExpanded = React.useCallback(() => {
		const allChildren = childrenRef.current;
		const reachable = new Set<string>();
		for (const root of rootsRef.current) {
			reachable.add(nodeKey(root.uri));
		}
		// Walk: a key is reachable if it appears as a child of a reachable expanded parent.
		const queue = [...rootsRef.current];
		while (queue.length) {
			const node = queue.shift()!;
			const key = nodeKey(node.uri);
			const kids = allChildren[key];
			if (!kids) {
				continue;
			}
			for (const k of kids) {
				reachable.add(nodeKey(k.uri));
				if (k.isDirectory && expandedRef.current.has(nodeKey(k.uri))) {
					queue.push(k);
				}
			}
		}
		setExpanded(prev => {
			let changed = false;
			const next = new Set<string>();
			for (const k of prev) {
				if (reachable.has(k)) {
					next.add(k);
				} else {
					changed = true;
				}
			}
			return changed ? next : prev;
		});
		setChildrenByParent(prev => {
			let changed = false;
			const next: Record<string, ExplorerNode[]> = {};
			for (const [k, v] of Object.entries(prev)) {
				if (reachable.has(k) || rootsRef.current.some(r => nodeKey(r.uri) === k)) {
					next[k] = v;
				} else {
					changed = true;
				}
			}
			return changed ? next : prev;
		});
	}, []);

	// Focus inline input in the CONNECTED (pop-out) window.
	React.useEffect(() => {
		if (!inlineEdit) {
			return;
		}
		inlineCancelledRef.current = false;
		const win = treeRef.current ? getConnectedWindow(treeRef.current) : window;
		const id = win.requestAnimationFrame(() => {
			const el = inlineInputRef.current;
			if (!el) {
				return;
			}
			focusInConnectedWindow(el);
			el.select();
		});
		return () => win.cancelAnimationFrame(id);
	}, [inlineEdit]);

	// Close context menu — use menuRef so scoped void- classes never break hit-testing.
	React.useEffect(() => {
		if (!contextMenu) {
			return;
		}
		const doc = treeRef.current ? getConnectedWindow(treeRef.current).document : document;
		const onDown = (e: MouseEvent) => {
			const t = e.target as Node;
			if (menuRef.current?.contains(t)) {
				return;
			}
			setContextMenu(null);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				setContextMenu(null);
			}
		};
		doc.addEventListener('mousedown', onDown, true);
		doc.addEventListener('keydown', onKey, true);
		return () => {
			doc.removeEventListener('mousedown', onDown, true);
			doc.removeEventListener('keydown', onKey, true);
		};
	}, [contextMenu]);

	// Clamp context menu into the connected viewport after paint.
	React.useEffect(() => {
		if (!contextMenu || !menuRef.current) {
			return;
		}
		const win = getConnectedWindow(menuRef.current);
		const menu = menuRef.current;
		const rect = menu.getBoundingClientRect();
		const pad = 8;
		let left = contextMenu.x;
		let top = contextMenu.y;
		if (left + rect.width > win.innerWidth - pad) {
			left = Math.max(pad, win.innerWidth - rect.width - pad);
		}
		if (top + rect.height > win.innerHeight - pad) {
			top = Math.max(pad, win.innerHeight - rect.height - pad);
		}
		menu.style.left = `${left}px`;
		menu.style.top = `${top}px`;
	}, [contextMenu]);

	const toggleExpand = React.useCallback((node: ExplorerNode) => {
		const key = nodeKey(node.uri);
		setExpanded(prev => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
				// Force a refetch: the watcher only refreshes EXPANDED dirs, so a
				// collapsed dir's cache goes stale on external changes and was
				// served as-is on re-expand. The stale rows still paint instantly
				// (cache isn't cleared) and swap when the fresh listing lands.
				void loadChildren(node, true);
			}
			return next;
		});
	}, [loadChildren]);

	const handleActivate = React.useCallback((node: ExplorerNode, e?: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }, rowKeys?: string[]) => {
		const key = nodeKey(node.uri);
		if (e && rowKeys) {
			selectWithModifiers(key, e, rowKeys);
		} else {
			selectOnly(key);
		}
		setContextMenu(null);
		// Multi-select modifiers: don't open/toggle, just select.
		if (e && (e.metaKey || e.ctrlKey || e.shiftKey)) {
			return;
		}
		if (node.isDirectory) {
			toggleExpand(node);
			return;
		}
		onOpenFile(node.uri);
	}, [onOpenFile, toggleExpand, selectOnly, selectWithModifiers]);

	const selectedNodes = React.useCallback((): ExplorerNode[] => {
		const all = [...rootsRef.current, ...Object.values(childrenRef.current).flat()];
		const byKey = new Map(all.map(n => [nodeKey(n.uri), n]));
		const keys = selectedKeys.size > 0 ? selectedKeys : (selectedKey ? new Set([selectedKey]) : new Set<string>());
		return [...keys].map(k => byKey.get(k)).filter((n): n is ExplorerNode => !!n && !n.isRoot);
	}, [selectedKeys, selectedKey]);

	/**
	 * Resolve which nodes an action invoked on `node` should apply to: the whole
	 * multi-selection when `node` is part of it, else just `node` — matching the
	 * main explorer. (Delete/Duplicate used to always act on the single node
	 * while the selection visibly included more.)
	 */
	const targetsFor = React.useCallback((node: ExplorerNode): ExplorerNode[] => {
		const key = nodeKey(node.uri);
		if (selectedKeys.has(key) && selectedKeys.size > 1) {
			const sel = selectedNodes().filter(n => !n.isRoot);
			if (sel.length > 0) {
				return sel;
			}
		}
		return node.isRoot ? [] : [node];
	}, [selectedKeys, selectedNodes]);

	const refreshParentOf = React.useCallback(async (resource: URI) => {
		const parentUri = resourceDirname(resource);
		const all = [...rootsRef.current, ...Object.values(childrenRef.current).flat()];
		const parentNode = all.find(n => nodeKey(n.uri) === nodeKey(parentUri));
		if (parentNode) {
			await loadChildren(parentNode, true);
		}
	}, [loadChildren]);

	const cutOrCopy = React.useCallback((mode: 'cut' | 'copy') => {
		setContextMenu(null);
		const nodes = selectedNodes();
		if (nodes.length === 0) {
			return;
		}
		setFileClipboard({ mode, uris: nodes.map(n => n.uri) });
	}, [selectedNodes]);

	const cancelCut = React.useCallback(() => {
		setContextMenu(null);
		setFileClipboard(null);
	}, []);

	const pasteInto = React.useCallback(async (targetDir: ExplorerNode) => {
		setContextMenu(null);
		if (!fileClipboard || !targetDir.isDirectory) {
			return;
		}
		try {
			for (const src of fileClipboard.uris) {
				const srcKey = nodeKey(src);
				const destDirKey = nodeKey(targetDir.uri);
				// Never paste a folder into itself or its own subtree — the drop
				// handler guards this, but Paste didn't (cut A, paste into A →
				// move(A, A/A) fs error).
				if (destDirKey === srcKey || destDirKey.startsWith(srcKey + '/')) {
					continue;
				}
				// Cut+paste into the folder it already lives in is a no-op, not a
				// silent "foo copy".
				if (fileClipboard.mode === 'cut' && nodeKey(resourceDirname(src)) === destDirKey) {
					continue;
				}
				const name = resourceBasename(src);
				let dest = joinPath(targetDir.uri, name);
				let i = 1;
				while (await fileService.exists(dest)) {
					const dot = name.lastIndexOf('.');
					const stem = dot > 0 ? name.slice(0, dot) : name;
					const ext = dot > 0 ? name.slice(dot) : '';
					dest = joinPath(targetDir.uri, `${stem} copy${i > 1 ? ` ${i}` : ''}${ext}`);
					i++;
				}
				if (fileClipboard.mode === 'cut') {
					await fileService.move(src, dest);
					onResourceMoved?.(src, dest);
				} else {
					await fileService.copy(src, dest);
				}
			}
			if (fileClipboard.mode === 'cut') {
				setFileClipboard(null);
			}
			await loadChildren(targetDir, true);
			for (const src of fileClipboard.uris) {
				await refreshParentOf(src);
			}
		} catch (e: unknown) {
			notificationService.error(String((e as Error)?.message ?? e));
		}
	}, [fileClipboard, fileService, loadChildren, onResourceMoved, refreshParentOf, notificationService]);

	const duplicateNode = React.useCallback(async (node: ExplorerNode) => {
		setContextMenu(null);
		// Duplicate the whole selection when invoked on part of it (parity with
		// Cut/Copy), not just the context-menu node.
		const targets = targetsFor(node);
		if (targets.length === 0) {
			return;
		}
		try {
			const all = [...rootsRef.current, ...Object.values(childrenRef.current).flat()];
			const parentKeys = new Set<string>();
			for (const t of targets) {
				const parentUri = resourceDirname(t.uri);
				const name = t.name;
				const dot = name.lastIndexOf('.');
				const stem = dot > 0 ? name.slice(0, dot) : name;
				const ext = dot > 0 ? name.slice(dot) : '';
				let dest = joinPath(parentUri, `${stem} copy${ext}`);
				let i = 1;
				while (await fileService.exists(dest)) {
					dest = joinPath(parentUri, `${stem} copy ${i}${ext}`);
					i++;
				}
				await fileService.copy(t.uri, dest);
				parentKeys.add(nodeKey(parentUri));
			}
			for (const pk of parentKeys) {
				const parentNode = all.find(n => nodeKey(n.uri) === pk);
				if (parentNode) {
					await loadChildren(parentNode, true);
				}
			}
		} catch (e: unknown) {
			notificationService.error(String((e as Error)?.message ?? e));
		}
	}, [fileService, loadChildren, notificationService, targetsFor]);

	const onRowDragStart = React.useCallback((e: React.DragEvent, node: ExplorerNode) => {
		const key = nodeKey(node.uri);
		let uris: URI[];
		if (selectedKeys.has(key) && selectedKeys.size > 1) {
			uris = selectedNodes().map(n => n.uri);
		} else {
			uris = node.isRoot ? [] : [node.uri];
			selectOnly(key);
		}
		if (uris.length === 0) {
			e.preventDefault();
			return;
		}
		dragUrisRef.current = uris;
		const uriList = uris.map(u => u.toString()).join('\n');
		const paths = uris.map(u => u.fsPath || u.path).join('\n');
		e.dataTransfer.effectAllowed = 'copyMove';
		e.dataTransfer.setData('text/uri-list', uriList);
		e.dataTransfer.setData('text/plain', paths);
		// VS Code explorer MIME used by chat/input drop handlers.
		try {
			e.dataTransfer.setData('application/vnd.code.uri-list', uriList);
		} catch { /* some browsers reject custom types */ }
		// Lightweight drag image — use the CONNECTED (aux) document so the image
		// is painted in the window the drag started from, not the main window.
		if (e.dataTransfer.setDragImage) {
			const doc = treeRef.current ? getConnectedDocument(treeRef.current) : document;
			const el = doc.createElement('div');
			el.textContent = uris.length === 1 ? resourceBasename(uris[0]) : `${uris.length} items`;
			el.style.cssText = 'position:absolute;top:-1000px;padding:4px 8px;background:#333;color:#fff;font:12px sans-serif;border-radius:4px;';
			doc.body.appendChild(el);
			e.dataTransfer.setDragImage(el, 0, 0);
			setTimeout(() => el.remove(), 0);
		}
	}, [selectedKeys, selectedNodes, selectOnly]);

	const onRowDragOver = React.useCallback((e: React.DragEvent, node: ExplorerNode) => {
		const folder = node.isDirectory ? node : null;
		if (!folder) {
			return;
		}
		// Don't drop a folder into itself / descendant.
		const dragging = dragUrisRef.current;
		const folderKey = nodeKey(folder.uri);
		if (dragging.some(u => {
			const k = nodeKey(u);
			return folderKey === k || folderKey.startsWith(k.endsWith('/') ? k : k + '/');
		})) {
			return;
		}
		e.preventDefault();
		e.dataTransfer.dropEffect = e.altKey || e.ctrlKey ? 'copy' : 'move';
		setDropTargetKey(folderKey);
	}, []);

	const confirmDragAndDrop = React.useCallback(async (count: number, isCopy: boolean): Promise<boolean> => {
		const confirm = configurationService.getValue<boolean>('explorer.confirmDragAndDrop');
		if (!confirm) {
			return true;
		}
		const verb = isCopy ? 'copy' : 'move';
		const detail = count === 1
			? `Are you sure you want to ${verb} this item?`
			: `Are you sure you want to ${verb} ${count} items?`;
		const result = await dialogService.confirm({
			message: `Confirm ${verb}`,
			detail,
			primaryButton: isCopy ? 'Copy' : 'Move',
			type: 'question',
		});
		return result.confirmed;
	}, [configurationService, dialogService]);

	const onRowDrop = React.useCallback(async (e: React.DragEvent, node: ExplorerNode) => {
		e.preventDefault();
		e.stopPropagation();
		setDropTargetKey(null);
		const folder = node.isDirectory ? node : null;
		if (!folder) {
			return;
		}
		const uris = dragUrisRef.current.length
			? dragUrisRef.current
			: (e.dataTransfer.getData('text/uri-list') || '')
				.split(/\r?\n/)
				.map(s => s.trim())
				.filter(s => s && !s.startsWith('#'))
				.map(s => {
					try { return URI.parse(s); } catch { return null; }
				})
				.filter((u): u is URI => !!u);
		// External OS drop (Finder/Explorer): no uri-list, but real File objects.
		// This used to silently no-op.
		if (uris.length === 0 && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
			try {
				for (const file of Array.from(e.dataTransfer.files)) {
					const data = new Uint8Array(await file.arrayBuffer());
					const name = file.name;
					let dest = joinPath(folder.uri, name);
					let i = 1;
					const dot = name.lastIndexOf('.');
					const stem = dot > 0 ? name.slice(0, dot) : name;
					const ext = dot > 0 ? name.slice(dot) : '';
					while (await fileService.exists(dest)) {
						dest = joinPath(folder.uri, `${stem} copy${i > 1 ? ` ${i}` : ''}${ext}`);
						i++;
					}
					await fileService.createFile(dest, VSBuffer.wrap(data));
				}
				await loadChildren(folder, true);
			} catch (err: unknown) {
				notificationService.error(String((err as Error)?.message ?? err));
			}
			return;
		}
		if (uris.length === 0) {
			return;
		}
		const copy = e.altKey || e.ctrlKey;
		// Honor explorer.confirmDragAndDrop.
		const ok = await confirmDragAndDrop(uris.length, copy);
		if (!ok) {
			dragUrisRef.current = [];
			return;
		}
		try {
			for (const src of uris) {
				if (nodeKey(src) === nodeKey(folder.uri)) {
					continue;
				}
				// Skip dropping into self/descendant
				const srcKey = nodeKey(src);
				const destKey = nodeKey(folder.uri);
				if (destKey === srcKey || destKey.startsWith(srcKey + '/')) {
					continue;
				}
				const name = resourceBasename(src);
				let dest = joinPath(folder.uri, name);
				if (await fileService.exists(dest)) {
					if (nodeKey(dest) === nodeKey(src)) {
						continue;
					}
					// Unique name
					let i = 1;
					const dot = name.lastIndexOf('.');
					const stem = dot > 0 ? name.slice(0, dot) : name;
					const ext = dot > 0 ? name.slice(dot) : '';
					while (await fileService.exists(dest)) {
						dest = joinPath(folder.uri, `${stem} copy${i > 1 ? ` ${i}` : ''}${ext}`);
						i++;
					}
				}
				if (copy) {
					await fileService.copy(src, dest);
				} else {
					await fileService.move(src, dest);
					onResourceMoved?.(src, dest);
				}
				await refreshParentOf(src);
			}
			await loadChildren(folder, true);
		} catch (err: unknown) {
			notificationService.error(String((err as Error)?.message ?? err));
		} finally {
			dragUrisRef.current = [];
		}
	}, [confirmDragAndDrop, fileService, loadChildren, onResourceMoved, refreshParentOf, notificationService]);

	const startRename = React.useCallback((node: ExplorerNode) => {
		if (node.isRoot) {
			return;
		}
		setContextMenu(null);
		inlineCancelledRef.current = false;
		setInlineEdit({ mode: 'rename', node, value: node.name });
	}, []);

	const startNew = React.useCallback(async (parent: ExplorerNode, kind: 'newFile' | 'newFolder') => {
		setContextMenu(null);
		await ensureExpanded(parent);
		const kids = childrenRef.current[nodeKey(parent.uri)] ?? [];
		const base = kind === 'newFile' ? 'untitled.txt' : 'New Folder';
		const value = uniqueChildName(kids.map(k => k.name), base);
		inlineCancelledRef.current = false;
		setInlineEdit({ mode: kind, parent, value });
	}, [ensureExpanded]);

	const cancelInlineEdit = React.useCallback(() => {
		inlineCancelledRef.current = true;
		setInlineEdit(null);
	}, []);

	const commitInlineEdit = React.useCallback(async () => {
		if (commitGuardRef.current || inlineCancelledRef.current) {
			return;
		}
		const edit = inlineEdit;
		if (!edit) {
			return;
		}
		commitGuardRef.current = true;

		const name = edit.value.trim();
		const invalid = isValidEntryName(name);
		if (invalid) {
			if (!name) {
				// Empty cancel is quiet (Escape / empty blur).
				inlineCancelledRef.current = true;
				setInlineEdit(null);
				commitGuardRef.current = false;
				return;
			}
			notificationService.error(invalid);
			// Keep editor open so the user can fix the name.
			commitGuardRef.current = false;
			return;
		}

		try {
			if (edit.mode === 'rename') {
				if (name === edit.node.name) {
					inlineCancelledRef.current = true;
					setInlineEdit(null);
					return;
				}
				const target = joinPath(resourceDirname(edit.node.uri), name);
				// A case-only rename (README → readme) on a case-insensitive FS makes
				// exists(target) resolve to the file itself — that's not a collision.
				const isCaseOnlyRename = target.toString().toLowerCase() === edit.node.uri.toString().toLowerCase();
				if (!isCaseOnlyRename && await fileService.exists(target)) {
					notificationService.error(`A file or folder named "${name}" already exists.`);
					commitGuardRef.current = false;
					return;
				}
				const from = edit.node.uri;
				await fileService.move(from, target);
				setSelectedKey(target.toString());

				// Remap expand/children cache under renamed folder prefix.
				if (edit.node.isDirectory) {
					const fromKey = nodeKey(from);
					const toKey = nodeKey(target);
					setExpanded(prev => {
						const next = new Set<string>();
						for (const k of prev) {
							if (k === fromKey) {
								next.add(toKey);
							} else if (k.startsWith(fromKey + '/')) {
								next.add(toKey + k.slice(fromKey.length));
							} else {
								next.add(k);
							}
						}
						return next;
					});
					// Remap the cached child NODES too — remapping only the map keys
					// left every descendant node with its pre-rename uri/parentKey, so
					// clicking a child opened the dead old path until the fs watcher
					// caught up.
					const rewriteNode = (n: ExplorerNode): ExplorerNode => {
						const k = nodeKey(n.uri);
						if (k !== fromKey && !k.startsWith(fromKey + '/')) {
							return n;
						}
						const newUri = target.with({ path: target.path + n.uri.path.slice(from.path.length) });
						const parentK = n.parentKey && (n.parentKey === fromKey || n.parentKey.startsWith(fromKey + '/'))
							? toKey + n.parentKey.slice(fromKey.length)
							: n.parentKey;
						return { ...n, uri: newUri, parentKey: parentK, name: k === fromKey ? name : n.name };
					};
					setChildrenByParent(prev => {
						const next: Record<string, ExplorerNode[]> = {};
						for (const [k, v] of Object.entries(prev)) {
							const mapped = v.map(rewriteNode);
							if (k === fromKey) {
								next[toKey] = mapped;
							} else if (k.startsWith(fromKey + '/')) {
								next[toKey + k.slice(fromKey.length)] = mapped;
							} else {
								next[k] = mapped;
							}
						}
						return next;
					});
				}

				onResourceMoved?.(from, target);
				if (!edit.node.isDirectory) {
					onOpenFile(target);
				}
			} else {
				const target = joinPath(edit.parent.uri, name);
				if (await fileService.exists(target)) {
					notificationService.error(`A file or folder named "${name}" already exists.`);
					commitGuardRef.current = false;
					return;
				}
				if (edit.mode === 'newFolder') {
					await fileService.createFolder(target);
				} else {
					await fileService.createFile(target, VSBuffer.fromString(''));
					onOpenFile(target);
				}
				setSelectedKey(target.toString());
			}

			const parentUri = edit.mode === 'rename' ? resourceDirname(edit.node.uri) : edit.parent.uri;
			const all = [...rootsRef.current, ...Object.values(childrenRef.current).flat()];
			const parentNode = all.find(n => nodeKey(n.uri) === nodeKey(parentUri))
				?? rootsRef.current.find(n => nodeKey(n.uri) === nodeKey(parentUri));
			if (parentNode) {
				await loadChildren(parentNode, true);
			}
			// Mark cancelled BEFORE closing: the input unmounts on setInlineEdit(null)
			// and its onBlur re-invoked commitInlineEdit with the stale non-null edit
			// — the file was already moved, so the second run hit the "already
			// exists" error with a spurious notification.
			inlineCancelledRef.current = true;
			setInlineEdit(null);
		} catch (e: unknown) {
			notificationService.error(String((e as Error)?.message ?? e));
			// Keep inline edit open on failure so the user can retry/cancel.
		} finally {
			commitGuardRef.current = false;
		}
	}, [inlineEdit, fileService, notificationService, onOpenFile, onResourceMoved, loadChildren]);

	const deleteNode = React.useCallback(async (node: ExplorerNode, permanent: boolean) => {
		setContextMenu(null);
		const targets = targetsFor(node);
		if (targets.length === 0) {
			return;
		}
		const useTrash = !permanent && configurationService.getValue<boolean>('files.enableTrash') !== false;
		const confirmDelete = configurationService.getValue<boolean>('explorer.confirmDelete');

		if (confirmDelete) {
			const what = targets.length === 1 ? `'${targets[0].name}'` : `the ${targets.length} selected items`;
			const result = await dialogService.confirm({
				message: `Are you sure you want to delete ${what}?`,
				detail: useTrash
					? (targets.length === 1 && !targets[0].isDirectory
						? 'You can restore this file from the Trash.'
						: 'You can restore from the Trash.')
					: 'This action is permanent and cannot be undone.',
				primaryButton: useTrash && isMacintosh ? 'Move to Trash' : 'Delete',
				type: 'warning',
			});
			if (!result.confirmed) {
				return;
			}
		}
		try {
			const deletedKeys = new Set<string>();
			const parentKeys = new Set<string>();
			for (const t of targets) {
				try {
					await fileService.del(t.uri, { useTrash, recursive: true });
				} catch (first: unknown) {
					if (!useTrash) {
						throw first;
					}
					const permanentResult = await dialogService.confirm({
						message: `Failed to move '${t.name}' to the Trash. Delete permanently?`,
						detail: String((first as Error)?.message ?? first),
						primaryButton: 'Delete Permanently',
						type: 'warning',
					});
					if (!permanentResult.confirmed) {
						continue;
					}
					await fileService.del(t.uri, { useTrash: false, recursive: true });
				}
				deletedKeys.add(nodeKey(t.uri));
				parentKeys.add(nodeKey(resourceDirname(t.uri)));
			}
			const all = [...rootsRef.current, ...Object.values(childrenRef.current).flat()];
			for (const pk of parentKeys) {
				const parentNode = all.find(n => nodeKey(n.uri) === pk);
				if (parentNode) {
					await loadChildren(parentNode, true);
				}
			}
			// Selection must not keep pointing at dead nodes.
			if (selectedKey && deletedKeys.has(selectedKey)) {
				setSelectedKey(nodeKey(resourceDirname(node.uri)));
			}
			setSelectedKeys(prev => {
				if (![...prev].some(k => deletedKeys.has(k))) {
					return prev;
				}
				return new Set([...prev].filter(k => !deletedKeys.has(k)));
			});
		} catch (e: unknown) {
			notificationService.error(String((e as Error)?.message ?? e));
		}
	}, [configurationService, dialogService, fileService, notificationService, loadChildren, selectedKey, targetsFor]);

	const revealInOS = React.useCallback((node: ExplorerNode) => {
		setContextMenu(null);
		try {
			if (node.uri.scheme !== Schemas.file) {
				notificationService.error('Reveal is only available for local files.');
				return;
			}
			nativeHostService.showItemInFolder(node.uri.fsPath);
		} catch (e: unknown) {
			notificationService.error(String((e as Error)?.message ?? e));
		}
	}, [nativeHostService, notificationService]);

	const copyPath = React.useCallback(async (node: ExplorerNode, relative: boolean) => {
		setContextMenu(null);
		try {
			if (relative) {
				const folder = findFolderFor(node.uri);
				const rel = folder ? resourceRelativePath(folder.uri, node.uri) : undefined;
				await clipboardService.writeText(rel?.replace(/\\/g, '/') || node.uri.fsPath || node.uri.path);
			} else {
				await clipboardService.writeText(node.uri.fsPath || node.uri.path);
			}
		} catch (e: unknown) {
			notificationService.error(String((e as Error)?.message ?? e));
		}
	}, [clipboardService, findFolderFor, notificationService]);

	const openToSide = React.useCallback((node: ExplorerNode) => {
		setContextMenu(null);
		if (node.isDirectory) {
			return;
		}
		// In the agent window, "Open to the Side" opens a new file tab (the
		// agent window's tab strip IS the "side" surface). This mirrors the
		// main explorer's "Open to the Side" which opens in a second editor
		// group.
		onOpenFile(node.uri);
	}, [onOpenFile]);

	const findInFolder = React.useCallback((node: ExplorerNode) => {
		setContextMenu(null);
		if (!node.isDirectory) {
			return;
		}
		// Delegate to the VS Code search command, which opens the Search view
		// in the main IDE window scoped to this folder. The agent window has
		// no search UI, so this is the pragmatic path.
		try {
			void commandService.executeCommand('search.action.findInFolder', node.uri);
		} catch (e: unknown) {
			notificationService.error(String((e as Error)?.message ?? e));
		}
	}, [commandService, notificationService]);

	const findInWorkspace = React.useCallback((node: ExplorerNode) => {
		setContextMenu(null);
		try {
			void commandService.executeCommand('search.action.findInWorkspace');
		} catch (e: unknown) {
			notificationService.error(String((e as Error)?.message ?? e));
		}
	}, [commandService, notificationService]);

	const selectForCompare = React.useCallback((node: ExplorerNode) => {
		setContextMenu(null);
		if (node.isDirectory) {
			return;
		}
		setCompareSelectedUri(node.uri);
	}, []);

	const compareWithSelected = React.useCallback((node: ExplorerNode) => {
		setContextMenu(null);
		if (node.isDirectory || !compareSelectedUri) {
			return;
		}
		try {
			void commandService.executeCommand('compareFiles', node.uri);
		} catch (e: unknown) {
			notificationService.error(String((e as Error)?.message ?? e));
		}
	}, [commandService, notificationService, compareSelectedUri]);

	const collapseAll = React.useCallback(() => {
		setExpanded(prev => {
			const next = new Set<string>();
			// Keep only roots expanded.
			for (const root of rootsRef.current) {
				next.add(nodeKey(root.uri));
			}
			return next;
		});
	}, []);

	const visibleRows = React.useMemo(() => {
		const rows: ExplorerNode[] = [];
		const walk = (nodes: ExplorerNode[]) => {
			for (const node of nodes) {
				rows.push(node);
				const key = nodeKey(node.uri);
				if (node.isDirectory && expanded.has(key)) {
					const kids = childrenByParent[key];
					if (kids) {
						walk(kids);
					}
				}
			}
		};
		walk(roots);
		return rows;
	}, [roots, expanded, childrenByParent]);

	// Hoist rowKeys out of the per-row map so it's O(n), not O(n^2).
	const rowKeys = React.useMemo(() => visibleRows.map(n => nodeKey(n.uri)), [visibleRows]);

	// Filter-on-type: when filterText is non-empty, narrow visibleRows to nodes
	// whose name contains the filter (case-insensitive) or that have a
	// descendant match. We keep ancestors of matches so the tree stays
	// navigable. This mirrors the main explorer's filter mode behavior.
	const filteredRows = React.useMemo(() => {
		if (!filterText.trim()) {
			return visibleRows;
		}
		const needle = filterText.toLowerCase();
		// First pass: collect matching node keys and their ancestor keys.
		const matchKeys = new Set<string>();
		const ancestorKeys = new Set<string>();
		const all = [...roots, ...Object.values(childrenByParent).flat()];
		const byKey = new Map(all.map(n => [nodeKey(n.uri), n]));
		for (const node of all) {
			if (node.name.toLowerCase().includes(needle)) {
				matchKeys.add(nodeKey(node.uri));
				// Walk up ancestors.
				let cur = node;
				while (cur.parentKey) {
					ancestorKeys.add(cur.parentKey);
					const parent = byKey.get(cur.parentKey);
					if (!parent) {
						break;
					}
					cur = parent;
				}
			}
		}
		const keep = new Set<string>([...matchKeys, ...ancestorKeys]);
		// Walk the CACHED tree directly (not visibleRows): a match inside a
		// collapsed directory must still show — filtering visibleRows hid every
		// match whose ancestor was collapsed, which read as "file is gone".
		// (Matches can only come from already-loaded listings, as before.)
		const out: ExplorerNode[] = [];
		const walk = (nodes: ExplorerNode[]) => {
			for (const n of nodes) {
				const k = nodeKey(n.uri);
				if (!keep.has(k)) {
					continue;
				}
				out.push(n);
				const kids = childrenByParent[k];
				if (kids) {
					walk(kids);
				}
			}
		};
		walk(roots);
		return out;
	}, [visibleRows, filterText, roots, childrenByParent]);

	const selectedNode = React.useMemo(
		() => visibleRows.find(n => nodeKey(n.uri) === selectedKey) ?? roots[0] ?? null,
		[visibleRows, selectedKey, roots],
	);

	const onRefresh = React.useCallback(() => {
		setFilterText('');
		setRefreshTick(t => t + 1);
	}, []);

	const onTreeKeyDown = React.useCallback((e: React.KeyboardEvent) => {
		if (inlineEdit) {
			return;
		}
		// If the filter input is focused, let it handle keys. Use the CONNECTED
		// document — in the pop-out, the main window's `document.activeElement`
		// never matches, making this guard dead.
		const activeDoc = treeRef.current ? getConnectedDocument(treeRef.current) : document;
		if (filterInputRef.current && activeDoc.activeElement === filterInputRef.current) {
			return;
		}
		// Navigate what is RENDERED: with a filter active the tree shows
		// filteredRows, and arrowing through unfiltered rows selected invisible
		// nodes (highlight vanished, Enter opened an unseen file).
		const rows = filteredRows;
		const idx = selectedNode ? rows.findIndex(n => nodeKey(n.uri) === nodeKey(selectedNode.uri)) : -1;

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			const next = rows[Math.min(rows.length - 1, Math.max(0, idx) + 1)];
			if (next) {
				setSelectedKey(nodeKey(next.uri));
			}
			return;
		}
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			const next = rows[Math.max(0, (idx < 0 ? 0 : idx) - 1)];
			if (next) {
				setSelectedKey(nodeKey(next.uri));
			}
			return;
		}
		if (e.key === 'Home') {
			e.preventDefault();
			if (rows[0]) {
				setSelectedKey(nodeKey(rows[0].uri));
			}
			return;
		}
		if (e.key === 'End') {
			e.preventDefault();
			const last = rows[rows.length - 1];
			if (last) {
				setSelectedKey(nodeKey(last.uri));
			}
			return;
		}

		if (!selectedNode) {
			return;
		}
		if (e.key === 'ArrowRight') {
			e.preventDefault();
			if (selectedNode.isDirectory && !expanded.has(nodeKey(selectedNode.uri))) {
				toggleExpand(selectedNode);
			} else if (selectedNode.isDirectory) {
				const kids = childrenByParent[nodeKey(selectedNode.uri)];
				if (kids?.[0]) {
					setSelectedKey(nodeKey(kids[0].uri));
				}
			}
			return;
		}
		if (e.key === 'ArrowLeft') {
			e.preventDefault();
			if (selectedNode.isDirectory && expanded.has(nodeKey(selectedNode.uri))) {
				toggleExpand(selectedNode);
			} else if (selectedNode.parentKey) {
				setSelectedKey(selectedNode.parentKey);
			}
			return;
		}
		if (e.key === 'F2') {
			e.preventDefault();
			startRename(selectedNode);
		} else if (e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) {
			e.preventDefault();
			void deleteNode(selectedNode, false);
		} else if (e.shiftKey && (e.key === 'Delete' || (e.key === 'Backspace' && e.altKey && e.metaKey))) {
			// Shift+Delete (Win) / Cmd+Opt+Backspace (Mac) = delete permanently.
			e.preventDefault();
			void deleteNode(selectedNode, true);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			handleActivate(selectedNode);
		} else if (e.key === ' ' || e.key === 'Spacebar') {
			// Space opens the file but keeps focus in the explorer (main explorer behavior).
			e.preventDefault();
			if (!selectedNode.isDirectory) {
				onOpenFile(selectedNode.uri);
			}
		} else if ((e.key === 'c' || e.key === 'C') && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
			e.preventDefault();
			cutOrCopy('copy');
		} else if ((e.key === 'x' || e.key === 'X') && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			cutOrCopy('cut');
		} else if ((e.key === 'v' || e.key === 'V') && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			const target = selectedNode.isDirectory ? selectedNode : (
				[...rootsRef.current, ...Object.values(childrenRef.current).flat()].find(n => nodeKey(n.uri) === selectedNode.parentKey)
				?? rootsRef.current[0]
			);
			if (target?.isDirectory) {
				void pasteInto(target);
			}
		} else if ((e.key === 'a' || e.key === 'A') && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			setSelectedKeys(new Set(filteredRows.filter(n => !n.isRoot).map(n => nodeKey(n.uri))));
		} else if (e.key === 'Escape') {
			// Escape clears cut state (main explorer behavior) and any filter.
			if (fileClipboard?.mode === 'cut') {
				cancelCut();
			}
			if (filterText) {
				setFilterText('');
			}
		}
	}, [inlineEdit, selectedNode, filteredRows, expanded, childrenByParent, toggleExpand, startRename, deleteNode, handleActivate, cutOrCopy, pasteInto, cancelCut, fileClipboard, filterText, onOpenFile]);

	if (rootState === 'error') {
		return <PanelPlaceholder icon={FolderTree} label="Can't load explorer" detail={rootError || 'Unknown error'} />;
	}

	if (rootState === 'idle' && roots.length === 0) {
		return (
			<div className={`agent-workspace-explorer${compact ? ' compact' : ''}`}>
				<div className="agent-workspace-placeholder">
					<FolderOpen size={22} strokeWidth={1.5} className="agent-workspace-placeholder-icon" />
					<div className="agent-workspace-placeholder-label">No folder open</div>
					<div className="agent-workspace-placeholder-detail">Select a workspace to browse files here.</div>
					<button
						type="button"
						className="agent-history-icon-btn"
						style={{ marginTop: 8, width: 'auto', padding: '4px 10px' }}
						onClick={() => agentProjectWorkspaceService.requestOpenPicker()}
					>
						Select Workspace
					</button>
				</div>
			</div>
		);
	}

	const renderInlineCreate = (depth: number) => {
		if (!inlineEdit || inlineEdit.mode === 'rename') {
			return null;
		}
		return (
			<div
				className="agent-workspace-explorer-row editing"
				style={{ paddingLeft: 8 + (depth + 1) * 14 }}
			>
				<span className="agent-workspace-explorer-chevron spacer" />
				<span className="agent-workspace-explorer-icon">
					<VsCodeFileIcon
						filename={inlineEdit.value || (inlineEdit.mode === 'newFolder' ? 'folder' : 'file.txt')}
						size={14}
						isFolder={inlineEdit.mode === 'newFolder'}
					/>
				</span>
				<input
					ref={inlineInputRef}
					className="agent-workspace-explorer-input"
					value={inlineEdit.value}
					onChange={e => setInlineEdit({ ...inlineEdit, value: e.target.value })}
					onBlur={() => void commitInlineEdit()}
					onKeyDown={e => {
						e.stopPropagation();
						if (e.key === 'Enter') {
							e.preventDefault();
							void commitInlineEdit();
						} else if (e.key === 'Escape') {
							e.preventDefault();
							cancelInlineEdit();
						}
					}}
				/>
			</div>
		);
	};

	const resolveNewParent = (): ExplorerNode | null =>
		(selectedNode?.isDirectory ? selectedNode : null)
		?? ([...roots, ...Object.values(childrenRef.current).flat()].find(n => n.isDirectory && nodeKey(n.uri) === selectedNode?.parentKey) ?? null)
		?? roots[0]
		?? null;

	return (
		<div className={`agent-workspace-explorer${compact ? ' compact' : ''}`} ref={treeRef}>
			<div className="agent-workspace-explorer-header">
				<span className="agent-workspace-explorer-title" title={roots[0]?.name}>
					{roots.length === 1 ? roots[0].name : 'Explorer'}
				</span>
				<div className="agent-workspace-explorer-actions">
					<button
						type="button"
						className="agent-workspace-explorer-action"
						title="New File"
						aria-label="New File"
						onClick={() => {
							const parent = resolveNewParent();
							if (parent) {
								void startNew(parent, 'newFile');
							}
						}}
					>
						<FilePlus size={13} strokeWidth={1.75} />
					</button>
					<button
						type="button"
						className="agent-workspace-explorer-action"
						title="New Folder"
						aria-label="New Folder"
						onClick={() => {
							const parent = resolveNewParent();
							if (parent) {
								void startNew(parent, 'newFolder');
							}
						}}
					>
						<FolderPlus size={13} strokeWidth={1.75} />
					</button>
					<button
						type="button"
						className="agent-workspace-explorer-action"
						title="Refresh Explorer"
						aria-label="Refresh explorer"
						onClick={onRefresh}
					>
						<RefreshCw size={13} strokeWidth={1.75} />
					</button>
					<button
						type="button"
						className="agent-workspace-explorer-action"
						title="Collapse Folders in Explorer"
						aria-label="Collapse folders"
						onClick={collapseAll}
					>
						<ChevronsDownUp size={13} strokeWidth={1.75} />
					</button>
				</div>
			</div>

			{/* Filter-on-type input. Focuses on click; Escape clears. */}
			<div className="agent-workspace-explorer-filter">
				<Search size={12} strokeWidth={1.75} className="agent-workspace-explorer-filter-icon" />
				<input
					ref={filterInputRef}
					type="text"
					className="agent-workspace-explorer-filter-input"
					placeholder="Filter files…"
					value={filterText}
					onChange={e => setFilterText(e.target.value)}
					onKeyDown={e => {
						if (e.key === 'Escape') {
							e.preventDefault();
							setFilterText('');
							filterInputRef.current?.blur();
						}
					}}
				/>
			</div>

			{rootState === 'loading' && roots.length === 0 ? (
				<div className="agent-workspace-file-loading">Loading…</div>
			) : (
				<div
					className="agent-workspace-explorer-tree"
					role="tree"
					aria-label="Workspace files"
					tabIndex={0}
					onKeyDown={onTreeKeyDown}
				>
					{filteredRows.map(node => {
						const key = nodeKey(node.uri);
						const isExpanded = expanded.has(key);
						const isSelected = selectedKeys.has(key) || selectedKey === key;
						const isActiveFile = !!activeResource && activeResource === key;
						const isLoading = loadingKeys.has(key);
						const isDropTarget = dropTargetKey === key;
						const err = errorByKey[key];
						const Chevron = isExpanded ? ChevronDown : ChevronRight;
						const isRenaming = inlineEdit?.mode === 'rename' && nodeKey(inlineEdit.node.uri) === key;

						return (
							<div key={key} role="group">
								<div
									role="treeitem"
									aria-expanded={node.isDirectory ? isExpanded : undefined}
									aria-selected={isSelected || isActiveFile}
									tabIndex={isSelected ? 0 : -1}
									draggable={!node.isRoot && !isRenaming}
									className={`agent-workspace-explorer-row${isSelected ? ' selected' : ''}${isActiveFile && !isSelected ? ' active-file' : ''}${node.isRoot ? ' root' : ''}${isRenaming ? ' editing' : ''}${isDropTarget ? ' drop-target' : ''}${fileClipboard?.mode === 'cut' && fileClipboard.uris.some(u => nodeKey(u) === key) ? ' cut' : ''}${compareSelectedUri && nodeKey(compareSelectedUri) === key ? ' compare-selected' : ''}`}
									style={{ paddingLeft: 8 + node.depth * 14 }}
									title={node.uri.fsPath || node.uri.path}
									onClick={(e) => handleActivate(node, e, rowKeys)}
									onDoubleClick={() => {
										if (!node.isDirectory) {
											onOpenFile(node.uri);
										}
									}}
									onDragStart={(e) => onRowDragStart(e, node)}
									onDragOver={(e) => onRowDragOver(e, node)}
									onDragLeave={() => {
										if (dropTargetKey === key) {
											setDropTargetKey(null);
										}
									}}
									onDrop={(e) => void onRowDrop(e, node)}
									onDragEnd={() => {
										setDropTargetKey(null);
										dragUrisRef.current = [];
									}}
									onContextMenu={(e) => {
										e.preventDefault();
										e.stopPropagation();
										if (!selectedKeys.has(key)) {
											selectOnly(key);
										}
										setContextMenu({ x: e.clientX, y: e.clientY, node });
									}}
								>
									{node.isDirectory ? (
										<span
											className="agent-workspace-explorer-chevron"
											aria-hidden="true"
											onClick={(e) => { e.stopPropagation(); toggleExpand(node); }}
										>
											<Chevron size={12} strokeWidth={2} />
										</span>
									) : (
										<span className="agent-workspace-explorer-chevron spacer" aria-hidden="true" />
									)}
									<span className="agent-workspace-explorer-icon">
										<VsCodeFileIcon
											uri={node.uri}
											filename={node.name}
											size={14}
											isFolder={node.isDirectory}
										/>
									</span>
									{isRenaming ? (
										<input
											ref={inlineInputRef}
											className="agent-workspace-explorer-input"
											value={inlineEdit.value}
											onClick={e => e.stopPropagation()}
											onChange={e => setInlineEdit({ ...inlineEdit, value: e.target.value })}
											onBlur={() => void commitInlineEdit()}
											onKeyDown={e => {
												e.stopPropagation();
												if (e.key === 'Enter') {
													e.preventDefault();
													void commitInlineEdit();
												} else if (e.key === 'Escape') {
													e.preventDefault();
													cancelInlineEdit();
												}
											}}
										/>
									) : (
										<span className="agent-workspace-explorer-name">{node.name}</span>
									)}
									{isLoading && <span className="agent-workspace-explorer-status">…</span>}
								</div>
								{err && isExpanded && (
									<div className="agent-workspace-explorer-error" style={{ paddingLeft: 8 + (node.depth + 1) * 14 }}>
										{err}
									</div>
								)}
								{inlineEdit && inlineEdit.mode !== 'rename' && nodeKey(inlineEdit.parent.uri) === key && isExpanded && (
									renderInlineCreate(node.depth)
								)}
							</div>
						);
					})}
				</div>
			)}

			{contextMenu && (
				<div
					ref={menuRef}
					className="agent-workspace-explorer-menu"
					role="menu"
					style={{ left: contextMenu.x, top: contextMenu.y }}
					onMouseDown={e => e.stopPropagation()}
				>
					{contextMenu.node.isDirectory && (
						<>
							<button type="button" role="menuitem" className="agent-workspace-explorer-menu-item" onClick={() => void startNew(contextMenu.node, 'newFile')}>
								New File…
							</button>
							<button type="button" role="menuitem" className="agent-workspace-explorer-menu-item" onClick={() => void startNew(contextMenu.node, 'newFolder')}>
								New Folder…
							</button>
							<div className="agent-workspace-explorer-menu-sep" />
						</>
					)}
					{!contextMenu.node.isDirectory && (
						<>
							<button type="button" role="menuitem" className="agent-workspace-explorer-menu-item" onClick={() => { setContextMenu(null); onOpenFile(contextMenu.node.uri); }}>
								Open
							</button>
							<button type="button" role="menuitem" className="agent-workspace-explorer-menu-item" onClick={() => openToSide(contextMenu.node)}>
								Open to the Side
								<span className="agent-workspace-explorer-menu-kbd">{isMacintosh ? '⌘↵' : 'Ctrl+Enter'}</span>
							</button>
						</>
					)}
					{contextMenu.node.isDirectory && (
						<button type="button" role="menuitem" className="agent-workspace-explorer-menu-item" onClick={() => findInFolder(contextMenu.node)}>
							Find in Folder…
							<span className="agent-workspace-explorer-menu-kbd">{isMacintosh ? '⇧⌥F' : 'Shift+Alt+F'}</span>
						</button>
					)}
					{contextMenu.node.isRoot && contextMenu.node.isDirectory && (
						<button type="button" role="menuitem" className="agent-workspace-explorer-menu-item" onClick={() => findInWorkspace(contextMenu.node)}>
							Find in Workspace…
						</button>
					)}
					{!contextMenu.node.isDirectory && (
						<>
							<button
								type="button"
								role="menuitem"
								className="agent-workspace-explorer-menu-item"
								disabled={!compareSelectedUri}
								onClick={() => compareWithSelected(contextMenu.node)}
							>
								Compare with Selected
							</button>
							<button type="button" role="menuitem" className="agent-workspace-explorer-menu-item" onClick={() => selectForCompare(contextMenu.node)}>
								Select for Compare
							</button>
						</>
					)}
					<div className="agent-workspace-explorer-menu-sep" />
					{!contextMenu.node.isRoot && (
						<button type="button" role="menuitem" className="agent-workspace-explorer-menu-item" onClick={() => startRename(contextMenu.node)}>
							Rename…
							<span className="agent-workspace-explorer-menu-kbd">F2</span>
						</button>
					)}
					{!contextMenu.node.isRoot && (
						<button type="button" role="menuitem" className="agent-workspace-explorer-menu-item danger" onClick={() => void deleteNode(contextMenu.node, false)}>
							Delete
							<span className="agent-workspace-explorer-menu-kbd">{isMacintosh ? '⌘⌫' : 'Del'}</span>
						</button>
					)}
					{!contextMenu.node.isRoot && (
						<button type="button" role="menuitem" className="agent-workspace-explorer-menu-item danger" onClick={() => void deleteNode(contextMenu.node, true)}>
							Delete Permanently
							<span className="agent-workspace-explorer-menu-kbd">{isMacintosh ? '⌘⌥⌫' : 'Shift+Del'}</span>
						</button>
					)}
					{!contextMenu.node.isRoot && (
						<button type="button" role="menuitem" className="agent-workspace-explorer-menu-item" onClick={() => void duplicateNode(contextMenu.node)}>
							Duplicate
						</button>
					)}
					<div className="agent-workspace-explorer-menu-sep" />
					{!contextMenu.node.isRoot && (
						<button type="button" role="menuitem" className="agent-workspace-explorer-menu-item" onClick={() => cutOrCopy('cut')}>
							Cut
							<span className="agent-workspace-explorer-menu-kbd">{isMacintosh ? '⌘X' : 'Ctrl+X'}</span>
						</button>
					)}
					{!contextMenu.node.isRoot && (
						<button type="button" role="menuitem" className="agent-workspace-explorer-menu-item" onClick={() => cutOrCopy('copy')}>
							Copy
							<span className="agent-workspace-explorer-menu-kbd">{isMacintosh ? '⌘C' : 'Ctrl+C'}</span>
						</button>
					)}
					{(contextMenu.node.isDirectory || contextMenu.node.isRoot) && (
						<button
							type="button"
							role="menuitem"
							className="agent-workspace-explorer-menu-item"
							disabled={!fileClipboard}
							onClick={() => void pasteInto(contextMenu.node)}
						>
							Paste
							<span className="agent-workspace-explorer-menu-kbd">{isMacintosh ? '⌘V' : 'Ctrl+V'}</span>
						</button>
					)}
					<div className="agent-workspace-explorer-menu-sep" />
					<button type="button" role="menuitem" className="agent-workspace-explorer-menu-item" onClick={() => revealInOS(contextMenu.node)}>
						{isLinux ? 'Open Containing Folder' : isMacintosh ? 'Reveal in Finder' : 'Reveal in File Explorer'}
					</button>
					<button type="button" role="menuitem" className="agent-workspace-explorer-menu-item" onClick={() => void copyPath(contextMenu.node, false)}>
						Copy Path
					</button>
					<button type="button" role="menuitem" className="agent-workspace-explorer-menu-item" onClick={() => void copyPath(contextMenu.node, true)}>
						Copy Relative Path
					</button>
				</div>
			)}
		</div>
	);
};
