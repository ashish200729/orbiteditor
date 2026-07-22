/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight, Cloud, Folder, FolderPlus, Home, Laptop, Loader2, Search, X } from 'lucide-react';
import { URI } from '../../../../../../../base/common/uri.js';
import { isMacintosh, isWindows } from '../../../../../../../base/common/platform.js';
import { isValidWorkspaceFolderName, normalizeFolderUriKey } from '../../../../common/agentWorkspaceHelpers.js';
import { useAccessor, useAgentWorkspaceState } from '../util/services.js';
import { getConnectedDocument, getConnectedWindow } from '../util/connectedWindow.js';

export type AgentWorkspacePickerProps = {
	open: boolean;
	onClose: () => void;
	anchorRef?: React.RefObject<HTMLElement | null>;
};

type RecentRow = { uri: URI; display: string; stale: boolean };

type Section = {
	id: 'recents' | 'sources' | 'actions';
	label: string;
	items: PickerItem[];
};

type PickerItem =
	| { kind: 'recent'; row: RecentRow; active: boolean }
	| { kind: 'source'; id: 'no-repo' | 'this-mac' | 'cloud'; label: string; icon: React.ReactNode; active: boolean; disabled?: boolean; hasChevron?: boolean; onSelect: () => Promise<void> }
	| { kind: 'action'; id: 'new-folder'; label: string; icon: React.ReactNode; onSelect: () => Promise<void> };

type PickerPosition = { top: number; left: number; width: number; maxHeight: number };

const MENU_WIDTH = 320;
const MENU_MAX_HEIGHT = 420;
const MENU_MIN_HEIGHT = 180;
const PADDING = 8;
const GAP = 6;
const LOCAL_SOURCE_LABEL = isWindows ? 'On This PC' : isMacintosh ? 'On This Mac' : 'On This Machine';

/**
 * Cursor-style workspace picker for the Agents window (local-only v1).
 *
 * Portaled to the connected document body so it escapes overflow clipping.
 * Position tracks the anchor on scroll/resize and flips above when needed.
 */
export const AgentWorkspacePicker = ({ open, onClose, anchorRef }: AgentWorkspacePickerProps) => {
	const accessor = useAccessor();
	const workspaceService = accessor.get('IAgentProjectWorkspaceService');
	const chatThreadsService = accessor.get('IChatThreadService');
	const dialogService = accessor.get('IDialogService');
	const fileDialogService = accessor.get('IFileDialogService');
	const state = useAgentWorkspaceState();
	const [search, setSearch] = useState('');
	const [recents, setRecents] = useState<RecentRow[] | null>(null);
	const [pos, setPos] = useState<PickerPosition | null>(null);
	const [activeIndex, setActiveIndex] = useState(-1);
	const [isActing, setIsActing] = useState(false);

	const menuRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const actionPendingRef = useRef(false);
	const listboxId = useId();

	useEffect(() => {
		if (!open) {
			return;
		}
		setSearch('');
		setRecents(null);
		setActiveIndex(-1);
		let cancelled = false;
		void workspaceService.getRecentFolderUris().then(async uris => {
			const rows = await Promise.all(uris.slice(0, 8).map(async uri => ({
				uri,
				display: await workspaceService.resolveDisplayPath(uri).catch(() => uri.fsPath || uri.toString()),
				stale: await workspaceService.isFolderStale(uri),
			})));
			if (!cancelled) {
				setRecents(rows);
			}
		}).catch(() => {
			if (!cancelled) {
				setRecents([]);
			}
		});
		const focusWin = (getConnectedWindow(anchorRef?.current ?? undefined) as Window & typeof globalThis) ?? window;
		const focusFrame = focusWin.requestAnimationFrame(() => searchRef.current?.focus());
		return () => {
			cancelled = true;
			focusWin.cancelAnimationFrame(focusFrame);
		};
	}, [open, workspaceService, anchorRef]);

	const computePos = useCallback(() => {
		const anchor = anchorRef?.current;
		if (!anchor) {
			setPos(null);
			return;
		}
		const rect = anchor.getBoundingClientRect();
		const win = getConnectedWindow(anchor) as Window & typeof globalThis;
		const vw = win.innerWidth;
		const vh = win.innerHeight;
		const width = Math.min(MENU_WIDTH, Math.max(0, vw - (PADDING * 2)));
		if (!Number.isFinite(vw) || !Number.isFinite(vh) || width <= 0 || vh <= PADDING * 2) {
			setPos(null);
			return;
		}

		let left = rect.left;
		if (left + width > vw - PADDING) {
			left = Math.max(PADDING, vw - PADDING - width);
		}
		if (left < PADDING) {
			left = PADDING;
		}

		const spaceBelow = vh - PADDING - (rect.bottom + GAP);
		const spaceAbove = rect.top - PADDING - GAP;
		const preferBelow = spaceBelow >= MENU_MIN_HEIGHT || spaceBelow >= spaceAbove;
		let top: number;
		let maxHeight: number;
		if (preferBelow) {
			top = rect.bottom + GAP;
			maxHeight = Math.max(0, Math.min(MENU_MAX_HEIGHT, spaceBelow));
		} else {
			maxHeight = Math.max(0, Math.min(MENU_MAX_HEIGHT, spaceAbove));
			top = Math.max(PADDING, rect.top - GAP - maxHeight);
		}
		setPos({ top, left, width, maxHeight });
	}, [anchorRef]);

	useLayoutEffect(() => {
		if (!open) {
			setPos(null);
			return;
		}
		computePos();
	}, [open, computePos]);

	useEffect(() => {
		if (!open) {
			return;
		}
		const doc = getConnectedDocument(menuRef.current ?? anchorRef?.current ?? undefined);
		const win = getConnectedWindow(menuRef.current ?? anchorRef?.current ?? undefined) as Window & typeof globalThis;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				onClose();
				anchorRef?.current?.focus();
			}
		};
		const onPointer = (e: PointerEvent) => {
			const target = e.target as Node | null;
			if (!target) {
				return;
			}
			if (menuRef.current?.contains(target)) {
				return;
			}
			if (anchorRef?.current?.contains(target)) {
				return;
			}
			onClose();
		};
		const onReflow = () => computePos();
		doc.addEventListener('keydown', onKey, true);
		doc.addEventListener('pointerdown', onPointer, true);
		win.addEventListener('resize', onReflow);
		doc.addEventListener('scroll', onReflow, true);
		return () => {
			doc.removeEventListener('keydown', onKey, true);
			doc.removeEventListener('pointerdown', onPointer, true);
			win.removeEventListener('resize', onReflow);
			doc.removeEventListener('scroll', onReflow, true);
		};
	}, [open, onClose, anchorRef, computePos]);

	const guardRunningAgent = useCallback(async (fromWorkspaceId: string | null): Promise<boolean> => {
		if (!chatThreadsService.hasRunningThreadInWorkspace(fromWorkspaceId)) {
			return true;
		}
		const result = await dialogService.confirm({
			type: 'warning',
			message: 'An agent is still running in this workspace.',
			detail: 'Switching will leave it running in the background and open a new agent in the selected workspace.',
			primaryButton: 'Switch Anyway',
			cancelButton: 'Stay',
		});
		return result.confirmed;
	}, [chatThreadsService, dialogService]);

	const switchToWorkspace = useCallback(async (id: string | null) => {
		const current = state.activeWorkspaceId;
		if (current === id) {
			onClose();
			return;
		}
		const ok = await guardRunningAgent(current);
		if (!ok) {
			return;
		}
		workspaceService.setActiveWorkspace(id);
		chatThreadsService.openNewThread({ agentWorkspaceId: id });
		onClose();
	}, [state.activeWorkspaceId, guardRunningAgent, workspaceService, chatThreadsService, onClose]);

	const openRecentFolder = useCallback(async (uri: URI) => {
		const current = state.activeWorkspaceId;
		const ok = await guardRunningAgent(current);
		if (!ok) {
			return;
		}
		const ws = workspaceService.createWorkspaceFromFolders([uri]);
		chatThreadsService.openNewThread({ agentWorkspaceId: ws.id });
		onClose();
	}, [state.activeWorkspaceId, guardRunningAgent, workspaceService, chatThreadsService, onClose]);

	const openFolderPicker = useCallback(async () => {
		const current = state.activeWorkspaceId;
		const ok = await guardRunningAgent(current);
		if (!ok) {
			return;
		}
		onClose();
		const uri = await workspaceService.openFolderPicker();
		if (uri) {
			const active = workspaceService.getActiveWorkspace();
			chatThreadsService.openNewThread({ agentWorkspaceId: active?.id ?? null });
		}
	}, [state.activeWorkspaceId, guardRunningAgent, workspaceService, chatThreadsService, onClose]);

	const createNewFolder = useCallback(async () => {
		onClose();
		const parent = await fileDialogService.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			title: 'Choose Parent Folder',
			openLabel: 'Select',
		});
		const parentUri = parent?.[0];
		if (!parentUri) {
			return;
		}
		const input = await dialogService.input({
			type: 'none',
			message: 'New folder name',
			primaryButton: 'Create',
			inputs: [{ placeholder: 'my-project' }],
		});
		if (!input.confirmed || !input.values?.[0]?.trim()) {
			return;
		}
		const name = input.values[0].trim();
		if (!isValidWorkspaceFolderName(name, isWindows)) {
			void dialogService.info(
				'Invalid folder name',
				'Choose a name without reserved characters or names, trailing periods or spaces, and keep it under 256 characters.',
			);
			return;
		}
		const current = state.activeWorkspaceId;
		const ok = await guardRunningAgent(current);
		if (!ok) {
			return;
		}
		const created = await workspaceService.createNewFolder(parentUri, name);
		if (!created) {
			void dialogService.info('Could not create folder', `Failed to create "${name}" in the selected parent.`);
			return;
		}
		const active = workspaceService.getActiveWorkspace();
		const nextId = active?.id ?? null;
		if (nextId !== current) {
			chatThreadsService.openNewThread({ agentWorkspaceId: nextId });
		}
	}, [fileDialogService, dialogService, workspaceService, chatThreadsService, guardRunningAgent, state.activeWorkspaceId, onClose]);

	const activeFolderKeys = useMemo(() => {
		const ws = state.activeWorkspaceId ? state.workspaces[state.activeWorkspaceId] : null;
		return new Set((ws?.folders ?? []).map(f => normalizeFolderUriKey(f.uri)));
	}, [state]);

	const filteredRecents = useMemo(() => {
		if (!recents) {
			return [];
		}
		const q = search.trim().toLowerCase();
		if (!q) {
			return recents;
		}
		return recents.filter(r => r.display.toLowerCase().includes(q) || r.uri.fsPath.toLowerCase().includes(q));
	}, [recents, search]);

	const sections: Section[] = useMemo(() => {
		const list: Section[] = [];
		if (filteredRecents.length > 0) {
			list.push({
				id: 'recents',
				label: 'Recents',
				items: filteredRecents.map(row => {
					const active = activeFolderKeys.has(normalizeFolderUriKey(row.uri))
						&& !!state.activeWorkspaceId
						&& (state.workspaces[state.activeWorkspaceId]?.folders.length === 1);
					return { kind: 'recent' as const, row, active };
				}),
			});
		}
		list.push({
			id: 'sources',
			label: 'Sources',
			items: [
				{
					kind: 'source' as const,
					id: 'no-repo' as const,
					label: 'No Repo',
					icon: <Home size={14} strokeWidth={1.75} />,
					active: state.activeWorkspaceId === null,
					onSelect: () => switchToWorkspace(null),
				},
				{
					kind: 'source' as const,
					id: 'this-mac' as const,
					label: LOCAL_SOURCE_LABEL,
					icon: <Laptop size={14} strokeWidth={1.75} />,
					active: false,
					hasChevron: true,
					onSelect: () => openFolderPicker(),
				},
				{
					kind: 'source' as const,
					id: 'cloud' as const,
					label: 'Cloud',
					icon: <Cloud size={14} strokeWidth={1.75} />,
					active: false,
					disabled: true,
					hasChevron: true,
					onSelect: async () => { /* coming soon */ },
				},
			],
		});
		// Single create action — the local-machine source already covers opening folders.
		list.push({
			id: 'actions',
			label: '',
			items: [{
				kind: 'action' as const,
				id: 'new-folder' as const,
				label: 'New Folder',
				icon: <FolderPlus size={14} strokeWidth={1.75} />,
				onSelect: () => createNewFolder(),
			}],
		});
		return list;
	}, [filteredRecents, activeFolderKeys, state, switchToWorkspace, openFolderPicker, createNewFolder]);

	const flatItems = useMemo(() => {
		const out: PickerItem[] = [];
		for (const s of sections) {
			for (const it of s.items) {
				if (it.kind === 'source' && it.disabled) {
					continue;
				}
				out.push(it);
			}
		}
		return out;
	}, [sections]);

	useEffect(() => {
		itemRefs.current.length = flatItems.length;
		setActiveIndex(open && flatItems.length > 0 ? 0 : -1);
	}, [open, flatItems.length, search]);

	useEffect(() => {
		if (activeIndex < 0) {
			return;
		}
		itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
	}, [activeIndex]);

	const activateItem = async (item: PickerItem) => {
		if (actionPendingRef.current) {
			return;
		}
		if (item.kind === 'recent' && item.row.stale) {
			await dialogService.info('This folder no longer exists on disk', item.row.display);
			return;
		}

		actionPendingRef.current = true;
		setIsActing(true);
		try {
			if (item.kind === 'recent') {
				await openRecentFolder(item.row.uri);
			} else {
				await item.onSelect();
			}
		} catch (error) {
			console.error('Error opening agent workspace:', error);
			await dialogService.info(
				'Could not open workspace',
				'Orbit could not complete the workspace change. Your current workspace was left unchanged where possible.',
			);
		} finally {
			actionPendingRef.current = false;
			setIsActing(false);
		}
	};

	const onMenuKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			setActiveIndex(i => Math.min(i + 1, flatItems.length - 1));
			return;
		}
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			setActiveIndex(i => i < 0 ? Math.max(flatItems.length - 1, 0) : Math.max(i - 1, 0));
			return;
		}
		if (e.key === 'Home') {
			e.preventDefault();
			setActiveIndex(flatItems.length > 0 ? 0 : -1);
			return;
		}
		if (e.key === 'End') {
			e.preventDefault();
			setActiveIndex(flatItems.length - 1);
			return;
		}
		if (e.key === 'Enter') {
			if (e.nativeEvent.isComposing) {
				return;
			}
			e.preventDefault();
			const item = flatItems[activeIndex];
			if (item) {
				void activateItem(item);
			}
		}
	};

	if (!open || !pos) {
		return null;
	}

	const doc = getConnectedDocument(anchorRef?.current ?? undefined);
	const showEmptyState = recents !== null && filteredRecents.length === 0 && search.trim().length > 0;
	const isLoadingRecents = recents === null && !search;

	return createPortal(
		<div
			ref={menuRef}
			className="agent-workspace-picker"
			role="dialog"
			aria-label="Open workspace"
			aria-busy={isActing}
			style={{
				top: pos.top,
				left: pos.left,
				width: pos.width,
				maxHeight: pos.maxHeight,
				// Match workbench UI font (portal sits outside .void-scope).
				fontFamily: 'var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, sans-serif)',
				fontSize: 13,
			}}
			onKeyDown={onMenuKeyDown}
		>
			<div className="agent-workspace-picker-search">
				<Search size={14} className="agent-workspace-picker-search-icon" aria-hidden />
				<input
					ref={searchRef}
					type="text"
					placeholder="Search folders…"
					value={search}
					onChange={e => setSearch(e.target.value)}
					className="agent-workspace-picker-search-input"
					aria-label="Search folders"
					role="combobox"
					aria-expanded="true"
					aria-autocomplete="list"
					aria-controls={listboxId}
					aria-activedescendant={activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
					spellCheck={false}
					autoComplete="off"
				/>
				{search && (
					<button
						type="button"
						className="agent-workspace-picker-search-clear"
						onClick={() => { setSearch(''); searchRef.current?.focus(); }}
						aria-label="Clear search"
					>
						<X size={12} strokeWidth={2} />
					</button>
				)}
			</div>

			<div
				id={listboxId}
				className="agent-workspace-picker-body"
				role="listbox"
				aria-label="Workspace choices"
			>
				{isLoadingRecents && (
					<div className="agent-workspace-picker-loading">
						<Loader2 size={14} className="agent-workspace-picker-spinner" aria-hidden />
						<span>Loading…</span>
					</div>
				)}
				{showEmptyState && (
					<div className="agent-workspace-picker-empty">
						<div className="agent-workspace-picker-empty-title">No matching folders</div>
						<div className="agent-workspace-picker-empty-detail">Try a different search</div>
					</div>
				)}
				{sections.map(section => {
					if (section.items.length === 0) {
						return null;
					}
					if (section.id === 'recents' && (isLoadingRecents || showEmptyState)) {
						return null;
					}
					return (
						<div key={section.id} className="agent-workspace-picker-section">
							{section.label ? (
								<div className="agent-workspace-picker-section-label">{section.label}</div>
							) : null}
							{section.items.map(item => {
								const flatIdx = flatItems.indexOf(item);
								const isActive = flatIdx === activeIndex;
								const ref = flatIdx >= 0
									? (el: HTMLButtonElement | null) => { itemRefs.current[flatIdx] = el; }
									: undefined;
								const optionId = flatIdx >= 0 ? `${listboxId}-option-${flatIdx}` : undefined;

								if (item.kind === 'recent') {
									const { row, active } = item;
									return (
										<button
											key={`recent-${row.uri.toString()}`}
											ref={ref}
											id={optionId}
											type="button"
											role="option"
											aria-selected={active}
											className={`agent-workspace-picker-item${row.stale ? ' stale' : ''}${active ? ' selected' : ''}${isActive ? ' active' : ''}`}
											onClick={() => void activateItem(item)}
											onMouseEnter={() => setActiveIndex(flatIdx)}
											disabled={isActing}
											aria-label={row.stale ? `${row.display}, folder no longer exists on disk` : row.display}
										>
											<Folder size={14} strokeWidth={1.75} className="agent-workspace-picker-item-icon" aria-hidden />
											<span className="agent-workspace-picker-item-label">{row.display}</span>
											{row.stale ? (
												<span className="agent-workspace-picker-badge stale">Missing</span>
											) : active ? (
												<Check size={14} strokeWidth={2.25} className="agent-workspace-picker-check" aria-hidden />
											) : null}
										</button>
									);
								}

								if (item.kind === 'source') {
									const { id, label: itemLabel, icon, active, disabled, hasChevron } = item;
									return (
										<button
											key={`source-${id}`}
											ref={ref}
											id={optionId}
											type="button"
											role="option"
											aria-selected={active}
											className={`agent-workspace-picker-item${disabled ? ' disabled' : ''}${active ? ' selected' : ''}${isActive ? ' active' : ''}`}
											onClick={() => !disabled && void activateItem(item)}
											onMouseEnter={() => !disabled && setActiveIndex(flatIdx)}
											disabled={disabled || isActing}
											title={disabled ? 'Coming soon' : undefined}
										>
											<span className="agent-workspace-picker-item-icon" aria-hidden>{icon}</span>
											<span className="agent-workspace-picker-item-label">{itemLabel}</span>
											{active && <Check size={14} strokeWidth={2.25} className="agent-workspace-picker-check" aria-hidden />}
											{!active && hasChevron && !disabled && (
												<ChevronRight size={14} strokeWidth={1.75} className="agent-workspace-picker-chevron" aria-hidden />
											)}
											{disabled && <span className="agent-workspace-picker-badge soon">Soon</span>}
										</button>
									);
								}

								const { id, label: itemLabel, icon } = item;
								return (
									<button
										key={`action-${id}`}
										ref={ref}
										id={optionId}
										type="button"
										role="option"
										aria-selected={false}
										className={`agent-workspace-picker-item action${isActive ? ' active' : ''}`}
										onClick={() => void activateItem(item)}
										onMouseEnter={() => setActiveIndex(flatIdx)}
										disabled={isActing}
									>
										<span className="agent-workspace-picker-item-icon" aria-hidden>{icon}</span>
										<span className="agent-workspace-picker-item-label">{itemLabel}</span>
									</button>
								);
							})}
						</div>
					);
				})}
			</div>
		</div>,
		doc.body
	);
};
