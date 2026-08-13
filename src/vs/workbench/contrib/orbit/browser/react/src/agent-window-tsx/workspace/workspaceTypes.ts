/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { ComponentType } from 'react';
import { GitCompareArrows, Globe, SquareTerminal, FolderTree, MessageSquare } from 'lucide-react';
import type { TextQuoteAttachment } from '../../../../../common/chatThreadServiceTypes.js';

/** The kinds of panel the Agents-window workspace can host. */
export type PanelKind = 'changes' | 'terminal' | 'files' | 'browser' | 'sideChat';

/** One open tab in the workspace tab strip. */
export interface WorkspaceTab {
	/** Stable unique id (also the React key). */
	id: string;
	kind: PanelKind;
	/** Tab label shown in the strip (mutable — a file/browser tab renames itself). */
	title: string;
	/**
	 * For `files`: file URI string when editing a file; omit / undefined for the
	 * workspace Explorer tree tab. For `browser`: the initial URL.
	 */
	resource?: string;
	threadId?: string;
	parentThreadId?: string;
	initialQuotes?: TextQuoteAttachment[];
}

export interface PanelMeta {
	kind: PanelKind;
	label: string;
	/** lucide icon component */
	icon: ComponentType<{ size?: number | string; strokeWidth?: number | string; className?: string }>;
	/** one-line description shown on the empty-state launcher cards */
	hint: string;
	/** Whether the "+" / launcher may open more than one tab of this kind. */
	allowMultiple: boolean;
}

/**
 * Panels users may open directly from the "+" menu or empty-state launcher.
 * Side Chat is intentionally absent: it is contextual and may only be opened
 * from selected conversation text or the `/side` composer command.
 *
 * Ordering also defines the "+" menu / empty-state launch order. The browser is
 * intentionally placed LAST: it's a heavy native surface that takes over the
 * panel, so the lightweight panels (Changes, Terminal, File) get priority and
 * the user is nudged toward them first.
 */
export const PANEL_METAS: readonly PanelMeta[] = [
	{ kind: 'changes', label: 'Changes', icon: GitCompareArrows, hint: 'Review what the agent edited', allowMultiple: false },
	{ kind: 'terminal', label: 'Terminal', icon: SquareTerminal, hint: 'Run commands', allowMultiple: true },
	// File tabs open in the Cursor layout: editor + shared side explorer.
	// Opening without a resource creates an empty file surface with the tree visible.
	{ kind: 'files', label: 'File', icon: FolderTree, hint: 'Browse and edit workspace files', allowMultiple: true },
	{ kind: 'browser', label: 'Browser', icon: Globe, hint: 'Open a live browser', allowMultiple: true },
];

const SIDE_CHAT_PANEL_META: PanelMeta = {
	kind: 'sideChat',
	label: 'Side Chat',
	icon: MessageSquare,
	hint: 'Explore selected conversation text in a side chat',
	allowMultiple: true,
};

export const panelMetaFor = (kind: PanelKind): PanelMeta =>
	kind === 'sideChat' ? SIDE_CHAT_PANEL_META : (PANEL_METAS.find(m => m.kind === kind) ?? PANEL_METAS[0]);

/** Props every workspace panel body receives. */
export interface WorkspacePanelProps {
	tab: WorkspaceTab;
	/** True when this panel is the visible/active tab. Native surfaces (terminal,
	 *  browser) use this to attach/detach or pause layout while hidden. */
	isActive: boolean;
	/**
	 * True while an HTML popover (e.g. the workspace "+" menu) is open over the
	 * panel host. Electron `WebContentsView`s always paint above the HTML layer,
	 * so CSS z-index cannot put menus on top of an active browser tab — the
	 * browser panel must hide its native surface for the duration of the overlay.
	 */
	overlayOpen?: boolean;
	/** Rename the tab (e.g. a file panel sets it to the opened file's basename). */
	setTitle: (title: string) => void;
	/** Close this tab from within the panel. */
	close: () => void;
	/** Open (or focus) another workspace panel — e.g. Changes → open a File tab. */
	openInWorkspace: (kind: PanelKind, resource?: string) => void;
	/**
	 * A `files` panel registers a handle here so the tab strip (dirty dot) and
	 * `closeTab`'s save-prompt can query/act on ITS notion of dirty — which,
	 * for a file whose primary-resolve path failed and fell back to an
	 * ephemeral in-memory model, is NOT the same as `ITextFileService.isDirty`
	 * (that model was never registered with the text-file service, so without
	 * this the close flow silently discarded unsaved edits with no prompt).
	 * Call with `null` on unmount to unregister. Other panel kinds ignore this.
	 */
	registerFileHandle?: (handle: FileCloseHandle | null) => void;
}

/** See {@link WorkspacePanelProps.registerFileHandle}. */
export interface FileCloseHandle {
	isDirty: () => boolean;
	save: () => Promise<void>;
	discard: () => Promise<void>;
}
