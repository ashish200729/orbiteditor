/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as React from 'react';
import { createPortal } from 'react-dom';
import { ChatHistory } from '../chathistory-tsx/ChatHistory.js';
import { Sidebar } from '../sidebar-tsx/Sidebar.js';
import { VoidTooltip } from '../orbit-tooltip/orbitTooltip.js';
import { AgentWorkspace } from './AgentWorkspace.js';
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js';
import { useAccessor, useAgentWorkspaceState, useChatThreadsState } from '../util/services.js';

export type AgentWindowPortalTargets = {
	sidebarEl: HTMLElement;
	mainEl: HTMLElement;
	tooltipEl: HTMLElement;
	workspaceEl: HTMLElement;
};

const AgentWindowChat = () => {
	const accessor = useAccessor();
	const workspaceState = useAgentWorkspaceState();
	const threadsState = useChatThreadsState();
	const chatThreadService = accessor.get('IChatThreadService');
	const agentWindowService = accessor.get('IAgentWindowService');
	const threadId = threadsState.agentWindowThreadId;
	const selected = threadId ? threadsState.allThreads[threadId] : undefined;
	const selectedAgentWorkspaceId = selected?.agentWorkspaceId;

	React.useEffect(() => {
		// Always ensure scope on mount and whenever the active workspace or
		// selected thread changes. A persisted agentWindowThreadId from another
		// workspace (or an IDE-scoped thread with agentWorkspaceId undefined)
		// must not drive Self-hosted Runner submits with the wrong git context.
		if (!threadId || !selected || selectedAgentWorkspaceId !== workspaceState.activeWorkspaceId) {
			chatThreadService.ensureAgentWindowThread(workspaceState.activeWorkspaceId);
		}
	}, [chatThreadService, workspaceState.activeWorkspaceId, threadId, selected, selectedAgentWorkspaceId]);

	const ready = !!threadId
		&& !!selected
		&& selectedAgentWorkspaceId === workspaceState.activeWorkspaceId;

	// A freshly opened window has no focus target: put the caret in the composer once
	// the first thread is on screen so the user can start typing immediately. Once per
	// window — later thread/workspace switches manage their own focus.
	const didInitialFocusRef = React.useRef(false);
	React.useEffect(() => {
		if (!ready || didInitialFocusRef.current) {
			return;
		}
		didInitialFocusRef.current = true;
		const focusComposer = () => { void chatThreadService.focusSelectedChat(true); };
		const auxDoc = agentWindowService.getAuxiliaryDomWindow()?.document;
		if (!auxDoc || auxDoc.visibilityState === 'visible') {
			focusComposer();
			return;
		}
		// The window opens hidden (deferShow) until its first paint is ready. Focusing now
		// would raise it early and reintroduce the stale white first frame, so wait until
		// it is actually shown.
		const onVisibilityChange = () => {
			if (auxDoc.visibilityState === 'visible') {
				auxDoc.removeEventListener('visibilitychange', onVisibilityChange);
				focusComposer();
			}
		};
		auxDoc.addEventListener('visibilitychange', onVisibilityChange);
		return () => auxDoc.removeEventListener('visibilitychange', onVisibilityChange);
	}, [ready, chatThreadService, agentWindowService]);

	if (!ready) {
		// Lightweight placeholder (R4): avoids a blank flash while
		// ensureAgentWindowThread syncs the thread into the active workspace.
		// Keeps height/scroll so the surrounding portal layout doesn't jump.
		return (
			<div className="w-full h-full flex items-center justify-center text-void-fg-3 text-sm select-none">
				Preparing agent…
			</div>
		);
	}
	return <Sidebar key={threadId} className="" isAgentWindow />;
};

/**
 * Renders the agent-window UI via portals into auxiliary-window panes.
 * React roots stay in the main renderer document so event delegation and
 * `instanceof HTMLElement` checks keep working across windows.
 */
export const AgentWindowPortal = ({ sidebarEl, mainEl, tooltipEl, workspaceEl }: AgentWindowPortalTargets) => {
	// Each portal gets its OWN ErrorBoundary. All four portals render under a single
	// React root, so without per-portal boundaries an uncaught throw in any one
	// subtree (AgentWorkspace is the largest/most stateful) unmounts the whole root
	// and blanks the entire window. Isolating them means one pane can fail while the
	// rest keep working — and the failure renders a visible WarningBox instead of a
	// blank window.
	return (
		<>
			{createPortal(<ErrorBoundary><ChatHistory isAgentWindow /></ErrorBoundary>, sidebarEl)}
			{createPortal(<ErrorBoundary><AgentWindowChat /></ErrorBoundary>, mainEl)}
			{createPortal(<ErrorBoundary><AgentWorkspace /></ErrorBoundary>, workspaceEl)}
			{createPortal(<ErrorBoundary><VoidTooltip /></ErrorBoundary>, tooltipEl)}
		</>
	);
};
