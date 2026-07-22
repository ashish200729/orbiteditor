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
	const selected = threadsState.agentWindowThreadId
		? threadsState.allThreads[threadsState.agentWindowThreadId]
		: undefined;
	const isReady = selected?.agentWorkspaceId === workspaceState.activeWorkspaceId;

	React.useEffect(() => {
		chatThreadService.ensureAgentWindowThread(workspaceState.activeWorkspaceId);
	}, [chatThreadService, workspaceState.activeWorkspaceId]);

	// Never mount an enabled composer against the IDE selection while the scoped
	// Agents selection is being established or changed.
	return isReady ? <Sidebar className="" isAgentWindow /> : null;
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
