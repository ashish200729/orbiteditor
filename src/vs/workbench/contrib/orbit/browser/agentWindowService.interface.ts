/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { TextQuoteAttachment } from '../common/chatThreadServiceTypes.js';

export const IAgentWindowService = createDecorator<IAgentWindowService>('agentWindowService');

/** Kinds of panel the agents-window workspace column can host (mirrors PanelKind
 *  in the React workspaceTypes; kept as a string union so this platform-side file
 *  does not depend on the React bundle). */
export type WorkspacePanelKind = 'changes' | 'terminal' | 'files' | 'browser' | 'sideChat';

export interface WorkspacePanelRequest {
	kind: WorkspacePanelKind;
	resource?: string;
	sideChat?: { parentThreadId: string; initialQuotes?: TextQuoteAttachment[] };
}

export interface IAgentWindowService {
	readonly _serviceBrand: undefined;

	/** Fires whenever the window opens or closes (used to sync the main-window pill active state). */
	readonly onDidChangeState: Event<void>;

	/**
	 * Fires when something (e.g. the chat composer's browser button) asks the
	 * agents window to open a panel in its right-side workspace column. The
	 * React `AgentWorkspace` listens and opens/focuses the tab.
	 */
	readonly onDidRequestWorkspacePanel: Event<WorkspacePanelRequest>;

	/** True while the standalone agents window is open. */
	isOpen(): boolean;

	/** Open the agents window, or focus it if already open. */
	open(): Promise<void>;

	/** Bring focus back to the main IDE window (the "IDE" button). */
	focusMainWindow(): Promise<void>;

	/** Toggle the local (agent-window-only) chat-history sidebar. */
	toggleSidebar(): void;

	/** Toggle the right-side workspace pane (Changes / Terminal / File / Browser). */
	toggleWorkspace(): void;

	/**
	 * Open (or focus) a panel in the agents window's right-side workspace column.
	 * Ensures the workspace is visible first. No-op when the window is closed.
	 * For `browser`, `resource` is the initial URL.
	 */
	requestWorkspacePanel(kind: WorkspacePanelKind, resource?: string, sideChat?: WorkspacePanelRequest['sideChat']): void;
	/** Track unsent side-chat draft/quote state for aggregate window-close confirmation. */
	setSideChatDirty(threadId: string, dirty: boolean): void;
	isSideChatDirty(threadId: string): boolean;

	/**
	 * Drain panel requests that were fired while nothing was subscribed yet
	 * (the React workspace mounts asynchronously after the window opens; an
	 * early MCP `agentOpenTab` would otherwise be silently lost and time out).
	 * Called once by `AgentWorkspace` right after it subscribes.
	 */
	consumePendingWorkspacePanelRequests(): WorkspacePanelRequest[];

	/**
	 * Fires when the built-in browser MCP asks to focus an agents-window browser
	 * view (by native view id). React activates the hosting workspace tab.
	 */
	readonly onDidRequestSelectBrowserView: Event<{ browserViewId: string; workspaceTabId: string }>;

	/** Register a native browser view owned by a workspace browser tab. */
	registerBrowserView(browserViewId: string, workspaceTabId: string): IDisposable;

	/** Resolve the workspace tab that hosts a native browser view id. */
	findWorkspaceTabForBrowserView(browserViewId: string): string | undefined;

	/** Returns the agents pop-out window id while open, else undefined. */
	getAuxiliaryWindowId(): number | undefined;
	/** Returns the agents pop-out DOM window while open, else undefined. */
	getAuxiliaryDomWindow(): Window | undefined;
}
