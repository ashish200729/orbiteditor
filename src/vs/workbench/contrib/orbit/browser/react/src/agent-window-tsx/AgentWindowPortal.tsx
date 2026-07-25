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
