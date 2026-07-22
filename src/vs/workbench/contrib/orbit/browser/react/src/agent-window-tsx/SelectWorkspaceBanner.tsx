/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React from 'react';
import { FolderOpen } from 'lucide-react';
import { isMacintosh } from '../../../../../../../base/common/platform.js';
import { useAccessor, useAgentWorkspaceState } from '../util/services.js';

/**
 * Quiet empty-state CTA for the Agents landing page when no workspace is
 * active. Hidden once a workspace is selected — the header already shows the
 * project name.
 *
 * Kept intentionally minimal (no hero card / lift / gradient) so it reads as
 * product chrome, not marketing.
 */
export const SelectWorkspaceBanner = () => {
	const accessor = useAccessor();
	const workspaceService = accessor.get('IAgentProjectWorkspaceService');
	const keybindingService = accessor.get('IKeybindingService');
	const state = useAgentWorkspaceState();

	const active = state.activeWorkspaceId ? state.workspaces[state.activeWorkspaceId] : null;
	const shortcut = keybindingService.lookupKeybinding('orbit.action.selectAgentWorkspace')?.getLabel() ?? (isMacintosh ? '⌘.' : 'Ctrl+.');

	if (active) {
		return null;
	}

	return (
		<button
			type="button"
			className="agent-select-workspace-banner"
			onClick={() => workspaceService.requestOpenPicker()}
			aria-label="Select workspace"
		>
			<FolderOpen size={15} strokeWidth={1.75} className="agent-select-workspace-banner-icon" aria-hidden />
			<span className="agent-select-workspace-banner-text">
				<span className="agent-select-workspace-banner-title">Select a workspace</span>
				<span className="agent-select-workspace-banner-sub">Give the agent project context</span>
			</span>
			<kbd className="agent-select-workspace-banner-kbd">{shortcut}</kbd>
		</button>
	);
};
