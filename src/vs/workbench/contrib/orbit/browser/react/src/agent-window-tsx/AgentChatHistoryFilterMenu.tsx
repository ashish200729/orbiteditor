/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
	Check,
	ChevronRight,
	Clock,
	Folder,
	FolderOpen,
	LayoutList,
	PencilLine,
	Type,
} from 'lucide-react';
import { getConnectedDocument, getConnectedWindow } from '../util/connectedWindow.js';
import { useIsDark } from '../util/services.js';
import {
	AgentHistoryFilterMode,
	AgentHistoryGrouping,
	AgentHistoryListPrefs,
	AgentHistoryOrdering,
	GROUPING_LABELS,
	ORDERING_LABELS,
	SHOW_SHORT_LABELS,
} from '../../../../common/agentHistoryListHelpers.js';

export type { AgentHistoryFilterMode, AgentHistoryGrouping, AgentHistoryOrdering, AgentHistoryListPrefs };

type Props = {
	open: boolean;
	onClose: () => void;
	prefs: AgentHistoryListPrefs;
	onChangePrefs: (next: AgentHistoryListPrefs) => void;
	onCollapseAll: () => void;
	canCollapseAll: boolean;
	anchorRef: React.RefObject<HTMLElement | null>;
};

type MenuPos = { top: number; left: number } | null;
type FlyoutId = 'grouping' | 'ordering' | 'show' | null;

const MENU_WIDTH = 240;
const FLYOUT_WIDTH = 200;
const PADDING = 8;
const GAP = 4;

type RadioOption<T extends string> = {
	id: T;
	label: string;
	icon: React.ReactNode;
};

const GROUPING_OPTIONS: RadioOption<AgentHistoryGrouping>[] = [
	{ id: 'updated', label: 'Updated', icon: <Clock size={14} strokeWidth={1.75} aria-hidden /> },
	{ id: 'created', label: 'Created', icon: <PencilLine size={14} strokeWidth={1.75} aria-hidden /> },
	{ id: 'workspace', label: 'Workspace', icon: <FolderOpen size={14} strokeWidth={1.75} aria-hidden /> },
	{ id: 'none', label: 'None', icon: <LayoutList size={14} strokeWidth={1.75} aria-hidden /> },
];

const ORDERING_OPTIONS: RadioOption<AgentHistoryOrdering>[] = [
	{ id: 'updated', label: 'Updated', icon: <Clock size={14} strokeWidth={1.75} aria-hidden /> },
	{ id: 'created', label: 'Created', icon: <PencilLine size={14} strokeWidth={1.75} aria-hidden /> },
	{ id: 'name', label: 'Name', icon: <Type size={14} strokeWidth={1.75} aria-hidden /> },
];

const SHOW_OPTIONS: { id: AgentHistoryFilterMode; label: string; hint: string; icon: React.ReactNode }[] = [
	{ id: 'scoped', label: 'Current workspace', hint: 'Threads in this workspace', icon: <Folder size={14} strokeWidth={1.75} aria-hidden /> },
	{ id: 'all', label: 'All workspaces', hint: 'Every thread', icon: <FolderOpen size={14} strokeWidth={1.75} aria-hidden /> },
	{ id: 'unassigned', label: 'Unassigned', hint: 'No workspace attached', icon: <LayoutList size={14} strokeWidth={1.75} aria-hidden /> },
];

/**
 * Anchored, portaled organize menu for the Agents-window chat history list.
 * Mirrors a Cursor-style Grouping / Ordering / Show layout, limited to
 * Orbit-backed options (no Status / PR / Environment / Archived).
 */
export const AgentChatHistoryFilterMenu = ({
	open,
	onClose,
	prefs,
	onChangePrefs,
	onCollapseAll,
	canCollapseAll,
	anchorRef,
}: Props) => {
	const menuRef = useRef<HTMLDivElement>(null);
	const flyoutRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<MenuPos>(null);
	const [flyout, setFlyout] = useState<FlyoutId>(null);
	const [flyoutPos, setFlyoutPos] = useState<MenuPos>(null);
	const isDark = useIsDark();

	const computePos = React.useCallback(() => {
		const anchor = anchorRef.current;
		if (!anchor) {
			setPos(null);
			return;
		}
		const rect = anchor.getBoundingClientRect();
		const win = getConnectedWindow(anchor) as Window & typeof globalThis;
		const vw = win.innerWidth;
		const vh = win.innerHeight;
		const menuHeight = menuRef.current?.offsetHeight ?? 168;
		let left = rect.right - MENU_WIDTH;
		let top = rect.bottom + GAP;
		if (left < PADDING) { left = PADDING; }
		if (left + MENU_WIDTH > vw - PADDING) { left = vw - PADDING - MENU_WIDTH; }
		if (top + menuHeight > vh - PADDING) {
			const aboveTop = rect.top - GAP - menuHeight;
			if (aboveTop > PADDING) {
				top = aboveTop;
			} else {
				top = Math.max(PADDING, vh - PADDING - menuHeight);
			}
		}
		setPos({ top, left });
	}, [anchorRef]);

	const placeFlyout = React.useCallback((rowEl: HTMLElement | null) => {
		if (!rowEl || !menuRef.current) {
			setFlyoutPos(null);
			return;
		}
		const rowRect = rowEl.getBoundingClientRect();
		const menuRect = menuRef.current.getBoundingClientRect();
		const win = getConnectedWindow(rowEl) as Window & typeof globalThis;
		const vw = win.innerWidth;
		const vh = win.innerHeight;
		const flyoutHeight = flyoutRef.current?.offsetHeight ?? 160;
		let left = menuRect.right + GAP;
		if (left + FLYOUT_WIDTH > vw - PADDING) {
			left = menuRect.left - GAP - FLYOUT_WIDTH;
		}
		if (left < PADDING) {
			left = PADDING;
		}
		let top = rowRect.top;
		if (top + flyoutHeight > vh - PADDING) {
			top = Math.max(PADDING, vh - PADDING - flyoutHeight);
		}
		setFlyoutPos({ top, left });
	}, []);

	useLayoutEffect(() => {
		if (!open) {
			setPos(null);
			setFlyout(null);
			setFlyoutPos(null);
			return;
		}
		computePos();
	}, [open, computePos]);

	useLayoutEffect(() => {
		if (!open || !flyout) {
			setFlyoutPos(null);
			return;
		}
		const row = menuRef.current?.querySelector<HTMLElement>(`[data-flyout-row="${flyout}"]`);
		placeFlyout(row ?? null);
	}, [open, flyout, placeFlyout, prefs]);

	useEffect(() => {
		if (!open) {
			return;
		}
		const doc = getConnectedDocument(menuRef.current ?? anchorRef.current ?? undefined);
		const win = getConnectedWindow(doc.body) as Window & typeof globalThis;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				if (flyout) {
					setFlyout(null);
					return;
				}
				onClose();
			}
		};
		const onPointer = (e: MouseEvent) => {
			const t = e.target as Node | null;
			if (!t) {
				return;
			}
			if (
				menuRef.current?.contains(t)
				|| flyoutRef.current?.contains(t)
				|| anchorRef.current?.contains(t)
			) {
				return;
			}
			onClose();
		};
		const onReflow = () => {
			computePos();
			if (flyout) {
				const row = menuRef.current?.querySelector<HTMLElement>(`[data-flyout-row="${flyout}"]`);
				placeFlyout(row ?? null);
			}
		};
		doc.addEventListener('keydown', onKey, true);
		doc.addEventListener('mousedown', onPointer, true);
		win.addEventListener('resize', onReflow);
		doc.addEventListener('scroll', onReflow, true);
		return () => {
			doc.removeEventListener('keydown', onKey, true);
			doc.removeEventListener('mousedown', onPointer, true);
			win.removeEventListener('resize', onReflow);
			doc.removeEventListener('scroll', onReflow, true);
		};
	}, [open, onClose, anchorRef, computePos, placeFlyout, flyout]);

	if (!open || !pos) {
		return null;
	}

	const doc = getConnectedDocument(anchorRef.current ?? undefined);
	const surfaceStyle: React.CSSProperties = {
		backgroundColor: isDark ? '#252526' : '#ffffff',
		opacity: 1,
		fontFamily: 'var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, sans-serif)',
		fontSize: 13,
	};

	const openFlyout = (id: FlyoutId, row: HTMLElement | null) => {
		setFlyout(id);
		// Position after paint so flyout height is measurable
		requestAnimationFrame(() => placeFlyout(row));
	};

	const setGrouping = (grouping: AgentHistoryGrouping) => {
		onChangePrefs({ ...prefs, grouping });
		setFlyout(null);
	};
	const setOrdering = (ordering: AgentHistoryOrdering) => {
		onChangePrefs({ ...prefs, ordering });
		setFlyout(null);
	};
	const setShow = (filterMode: AgentHistoryFilterMode) => {
		onChangePrefs({ ...prefs, filterMode });
		setFlyout(null);
	};

	return createPortal(
		<>
			<div
				ref={menuRef}
				className="agent-history-filter-menu agent-history-filter-menu--anchored"
				role="menu"
				aria-label="Organize chat history"
				style={{
					...surfaceStyle,
					top: pos.top,
					left: pos.left,
					width: MENU_WIDTH,
				}}
			>
				<button
					type="button"
					role="menuitem"
					data-flyout-row="grouping"
					aria-haspopup="menu"
					aria-expanded={flyout === 'grouping'}
					className={`agent-history-organize-row${flyout === 'grouping' ? ' active' : ''}`}
					onMouseEnter={(e) => openFlyout('grouping', e.currentTarget)}
					onFocus={(e) => openFlyout('grouping', e.currentTarget)}
					onClick={(e) => openFlyout('grouping', e.currentTarget)}
				>
					<span className="agent-history-organize-row-label">Grouping</span>
					<span className="agent-history-organize-row-value">
						{GROUPING_LABELS[prefs.grouping]}
						<ChevronRight size={14} strokeWidth={2} aria-hidden />
					</span>
				</button>
				<button
					type="button"
					role="menuitem"
					data-flyout-row="ordering"
					aria-haspopup="menu"
					aria-expanded={flyout === 'ordering'}
					className={`agent-history-organize-row${flyout === 'ordering' ? ' active' : ''}`}
					onMouseEnter={(e) => openFlyout('ordering', e.currentTarget)}
					onFocus={(e) => openFlyout('ordering', e.currentTarget)}
					onClick={(e) => openFlyout('ordering', e.currentTarget)}
				>
					<span className="agent-history-organize-row-label">Ordering</span>
					<span className="agent-history-organize-row-value">
						{ORDERING_LABELS[prefs.ordering]}
						<ChevronRight size={14} strokeWidth={2} aria-hidden />
					</span>
				</button>
				<button
					type="button"
					role="menuitem"
					data-flyout-row="show"
					aria-haspopup="menu"
					aria-expanded={flyout === 'show'}
					className={`agent-history-organize-row${flyout === 'show' ? ' active' : ''}`}
					onMouseEnter={(e) => openFlyout('show', e.currentTarget)}
					onFocus={(e) => openFlyout('show', e.currentTarget)}
					onClick={(e) => openFlyout('show', e.currentTarget)}
				>
					<span className="agent-history-organize-row-label">Show</span>
					<span className="agent-history-organize-row-value">
						{SHOW_SHORT_LABELS[prefs.filterMode]}
						<ChevronRight size={14} strokeWidth={2} aria-hidden />
					</span>
				</button>

				<div className="agent-history-organize-divider" role="separator" />

				<button
					type="button"
					role="menuitem"
					className="agent-history-organize-row agent-history-organize-row--action"
					disabled={!canCollapseAll}
					onMouseEnter={() => setFlyout(null)}
					onClick={() => {
						onCollapseAll();
						onClose();
					}}
				>
					<span className="agent-history-organize-row-label">Collapse All</span>
				</button>
			</div>

			{flyout && flyoutPos && (
				<div
					ref={flyoutRef}
					className="agent-history-filter-menu agent-history-filter-flyout"
					role="menu"
					aria-label={flyout === 'grouping' ? 'Grouping' : flyout === 'ordering' ? 'Ordering' : 'Show'}
					style={{
						...surfaceStyle,
						top: flyoutPos.top,
						left: flyoutPos.left,
						width: flyout === 'show' ? 240 : FLYOUT_WIDTH,
					}}
				>
					{flyout === 'grouping' && GROUPING_OPTIONS.map(opt => {
						const selected = prefs.grouping === opt.id;
						return (
							<button
								key={opt.id}
								type="button"
								role="menuitemradio"
								aria-checked={selected}
								className={`agent-history-flyout-item${selected ? ' selected' : ''}`}
								onClick={() => setGrouping(opt.id)}
							>
								<span className="agent-history-flyout-item-icon">{opt.icon}</span>
								<span className="agent-history-flyout-item-label">{opt.label}</span>
								{selected && <Check size={14} strokeWidth={2.25} className="agent-history-filter-item-check" aria-hidden />}
							</button>
						);
					})}
					{flyout === 'ordering' && ORDERING_OPTIONS.map(opt => {
						const selected = prefs.ordering === opt.id;
						return (
							<button
								key={opt.id}
								type="button"
								role="menuitemradio"
								aria-checked={selected}
								className={`agent-history-flyout-item${selected ? ' selected' : ''}`}
								onClick={() => setOrdering(opt.id)}
							>
								<span className="agent-history-flyout-item-icon">{opt.icon}</span>
								<span className="agent-history-flyout-item-label">{opt.label}</span>
								{selected && <Check size={14} strokeWidth={2.25} className="agent-history-filter-item-check" aria-hidden />}
							</button>
						);
					})}
					{flyout === 'show' && SHOW_OPTIONS.map(opt => {
						const selected = prefs.filterMode === opt.id;
						return (
							<button
								key={opt.id}
								type="button"
								role="menuitemradio"
								aria-checked={selected}
								className={`agent-history-flyout-item agent-history-flyout-item--stacked${selected ? ' selected' : ''}`}
								onClick={() => setShow(opt.id)}
							>
								<span className="agent-history-flyout-item-icon">{opt.icon}</span>
								<span className="agent-history-filter-item-text">
									<span className="agent-history-filter-item-label">{opt.label}</span>
									<span className="agent-history-filter-item-hint">{opt.hint}</span>
								</span>
								{selected && <Check size={14} strokeWidth={2.25} className="agent-history-filter-item-check" aria-hidden />}
							</button>
						);
					})}
				</div>
			)}
		</>,
		doc.body
	);
};
