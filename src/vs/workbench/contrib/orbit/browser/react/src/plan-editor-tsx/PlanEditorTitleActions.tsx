/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React from 'react';
import { ModelDropdown } from '../orbit-settings-tsx/ModelDropdown.js';
import { useIsDark } from '../util/services.js';
import { usePlanBuildButtonPhase } from '../util/planBuildButtonState.js';
import { PlanBuildButton } from './PlanBuildButton.js';
import '../styles.css';

export interface PlanEditorTitleActionsProps {
	threadId?: string;
	isDraft?: boolean;
	isDirty?: boolean; // accepted but display handled by parent PlanEditor
	isSaving?: boolean;
	isStarting?: boolean;
	onSaveToWorkspace?: () => void;
	onBuild?: () => void;
}

export const PlanEditorTitleActions: React.FC<PlanEditorTitleActionsProps> = ({
	threadId,
	isDraft,
	isSaving,
	isStarting,
	onSaveToWorkspace,
	onBuild,
}) => {
	const isDark = useIsDark();
	// Keep the Save button disabled while a build is in flight. The Build button
	// owns its own phase rendering via PlanBuildButton; we only need the boolean.
	const buildPhase = usePlanBuildButtonPhase(threadId, { isSaving, isStarting });
	const isBuilding = buildPhase === 'building';

	return (
		<div className={`@@void-scope ${isDark ? 'dark' : ''}`}>
			<div className="@@plan-editor-breadcrumb-actions-inner">
				{isDraft && onSaveToWorkspace && (
					<button
						type="button"
						onClick={onSaveToWorkspace}
						disabled={isSaving || isBuilding}
						className="@@plan-editor-btn @@plan-editor-btn-secondary @@plan-editor-save-btn"
						title="Save plan to .void/plans/"
					>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
							<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
							<polyline points="17 21 17 13 7 13 7 21" />
							<polyline points="7 3 7 8 15 8" />
						</svg>
						<span className="@@plan-editor-save-label">Save</span>
					</button>
				)}
				<ModelDropdown
					featureName="Chat"
					className="@@plan-editor-model-dropdown min-w-[64px] max-w-[min(140px,22vw)] text-xs leading-5 px-1 shrink-0"
				/>
				{onBuild && (
					<PlanBuildButton
						threadId={threadId}
						isDraft={isDraft}
						isSaving={isSaving}
						isStarting={isStarting}
						onBuild={onBuild}
						hideKbdHint
					/>
				)}
			</div>
		</div>
	);
};