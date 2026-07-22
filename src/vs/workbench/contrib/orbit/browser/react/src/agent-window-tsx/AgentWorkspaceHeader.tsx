/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Laptop } from 'lucide-react';
import { isMacintosh, isWindows } from '../../../../../../../base/common/platform.js';
import { useAccessor, useAgentWorkspaceState } from '../util/services.js';
import { AgentWorkspacePicker } from './AgentWorkspacePicker.js';

/**
 * Cursor-style workspace chrome for the Agents landing page: two compact
 * text controls sitting directly above the composer (not a full-width bar).
 *
 * Class names are plain in source (scope-tailwind → `void-*`); styles live in
 * `browser/media/agentWindow.css`.
 */
export const AgentWorkspaceHeader = () => {
	const accessor = useAccessor();
	const workspaceService = accessor.get('IAgentProjectWorkspaceService');
	const state = useAgentWorkspaceState();

	const [pickerOpen, setPickerOpen] = useState(false);
	const [displayPath, setDisplayPath] = useState<string | undefined>();
	const anchorRef = useRef<HTMLButtonElement>(null);

	const active = state.activeWorkspaceId ? state.workspaces[state.activeWorkspaceId] : null;
	const label = active?.name ?? 'Select Workspace';
	const hasWorkspace = !!active;
	const localEnvironmentLabel = isWindows ? 'This PC' : isMacintosh ? 'This Mac' : 'This Machine';

	useEffect(() => {
		let cancelled = false;
		const first = active?.folders[0];
		if (!first) {
			setDisplayPath(undefined);
			return;
		}
		void workspaceService.resolveDisplayPath(first.uri).then(p => {
			if (!cancelled) {
				setDisplayPath(p);
			}
		});
		return () => { cancelled = true; };
	}, [active, workspaceService]);

	useEffect(() => {
		if (workspaceService.consumePendingOpenPicker()) {
			setPickerOpen(true);
		}
		const d = workspaceService.onDidRequestOpenPicker(() => {
			// Clear the one-shot pending flag when a mounted header handles the
			// request. Otherwise a later remount reopens a picker the user closed.
			if (workspaceService.consumePendingOpenPicker()) {
				setPickerOpen(true);
			}
		});
		return () => d.dispose();
	}, [workspaceService]);

	const toggle = useCallback(() => {
		setPickerOpen(v => !v);
	}, []);

	const close = useCallback(() => {
		setPickerOpen(false);
	}, []);

	return (
		<div className="agent-workspace-header">
			<button
				ref={anchorRef}
				type="button"
				className={`agent-workspace-header-btn agent-workspace-header-btn--primary${hasWorkspace ? '' : ' is-placeholder'}${pickerOpen ? ' is-open' : ''}`}
				onClick={toggle}
				title={displayPath ?? label}
				aria-haspopup="dialog"
				aria-expanded={pickerOpen}
				aria-label={hasWorkspace ? `Workspace: ${label}` : 'Select workspace'}
			>
				<span className="agent-workspace-header-btn-label">{label}</span>
				<ChevronDown size={12} strokeWidth={2} className="agent-workspace-header-btn-chevron" aria-hidden />
			</button>
			<button
				type="button"
				className="agent-workspace-header-btn agent-workspace-header-btn--env"
				disabled
				title="Local machine"
				aria-label={`Environment: ${localEnvironmentLabel}`}
			>
				<Laptop size={12} strokeWidth={1.75} className="agent-workspace-header-btn-icon" aria-hidden />
				<span className="agent-workspace-header-btn-label">{localEnvironmentLabel}</span>
				<ChevronDown size={12} strokeWidth={2} className="agent-workspace-header-btn-chevron" aria-hidden />
			</button>
			<AgentWorkspacePicker
				open={pickerOpen}
				onClose={close}
				anchorRef={anchorRef}
			/>
		</div>
	);
};
