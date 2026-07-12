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

export type AgentWindowPortalTargets = {
	sidebarEl: HTMLElement;
	mainEl: HTMLElement;
	tooltipEl: HTMLElement;
	workspaceEl: HTMLElement;
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
			{createPortal(<ErrorBoundary><ChatHistory /></ErrorBoundary>, sidebarEl)}
			{createPortal(<ErrorBoundary><Sidebar className="" /></ErrorBoundary>, mainEl)}
			{createPortal(<ErrorBoundary><AgentWorkspace /></ErrorBoundary>, workspaceEl)}
			{createPortal(<ErrorBoundary><VoidTooltip /></ErrorBoundary>, tooltipEl)}
		</>
	);
};
