/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React from 'react';
import { Check } from 'lucide-react';
import { usePlanBuildButtonPhase } from '../util/planBuildButtonState.js';
import { OrbitProgressIndicator } from '../util/OrbitProgressIndicator.js';
import '../styles.css';

/**
 * Shared Build button for Plan Mode — the single source of truth for the
 * label / icon / kbd-hint rendering that was previously duplicated three ways
 * (sidebar PlanCard, breadcrumb PlanEditorTitleActions, in-pane PlanEditor
 * toolbar) with visible differences.
 *
 * Wraps the already-shared `usePlanBuildButtonPhase` hook (unchanged) and
 * standardizes on the breadcrumb's mature 4-state phase machine + idle-state
 * play-triangle icon everywhere. Reuses the existing `.plan-editor-btn*` CSS
 * family (styles.css), so the fix is centralizing the React rendering logic,
 * not the CSS.
 *
 * scope-tailwind note: `.plan-editor-btn*` classes are defined in styles.css
 * and reach the DOM via the `@@`-prefix ignore mechanism (scope-tailwind does
 * not prefix `@@`-prefixed classes), so they correctly match the CSS selectors
 * regardless of where this component is mounted.
 */
export interface PlanBuildButtonProps {
	threadId?: string;
	/** True when a save is in flight (breadcrumb/title-bar context). */
	isSaving?: boolean;
	/** True when the build kick-off is in flight (breadcrumb/title-bar context). */
	isStarting?: boolean;
	/** True when the plan has unsaved edits — disables Build until auto-save
	 * flushes (in-pane PlanEditor toolbar context). */
	isDirty?: boolean;
	onBuild?: () => void;
	/** Hide the ⌘↵ kbd hint (e.g. in contexts where the shortcut doesn't apply). */
	hideKbdHint?: boolean;
	/** Optional extra class on the button element. */
	className?: string;
	/** When true, the button is a draft (unsaved) — adjusts the title text. */
	isDraft?: boolean;
}

export const PlanBuildButton: React.FC<PlanBuildButtonProps> = ({
	threadId,
	isSaving,
	isStarting,
	isDirty,
	onBuild,
	hideKbdHint,
	className = '',
	isDraft,
}) => {
	const buildPhase = usePlanBuildButtonPhase(threadId, { isSaving, isStarting });
	const isBuilding = buildPhase === 'building';
	const isBuilt = buildPhase === 'built';
	const isFailed = buildPhase === 'failed';

	const title = isDraft
		? 'Save and send plan to agent'
		: isBuilt
			? 'Agent finished — click to run again'
			: isFailed
				? 'Build failed — click to try again'
				: 'Send plan to agent and start execution';

	const disabled = isBuilding || isSaving || isDirty;

	const stateClass = isBuilt
		? '@@plan-editor-btn-built'
		: isFailed
			? '@@plan-editor-btn-failed'
			: '@@plan-editor-btn-primary';

	return (
		<button
			type="button"
			onClick={onBuild}
			disabled={disabled}
			className={`@@plan-editor-btn @@plan-editor-build-btn ${stateClass}${isBuilding ? ' @@is-building' : ''} ${className}`}
			title={isDirty ? 'Save plan before building' : title}
			aria-busy={isBuilding}
			aria-label={isBuilt ? 'Built' : isFailed ? 'Build failed' : 'Build plan'}
		>
			{isBuilding ? (
				<>
					<OrbitProgressIndicator size="xs" variant="foreground" label="Building" />
					<span className="@@plan-editor-build-label">Building…</span>
				</>
			) : isBuilt ? (
				<>
					<Check className="@@plan-editor-build-icon" size={12} strokeWidth={3} aria-hidden />
					<span className="@@plan-editor-build-label">Built</span>
				</>
			) : isFailed ? (
				<>
					<span className="@@plan-editor-btn-status-dot" aria-hidden />
					<span className="@@plan-editor-build-label">Failed</span>
				</>
			) : (
				<>
					<svg className="@@plan-editor-build-icon" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
						<polygon points="5 3 19 12 5 21 5 3" />
					</svg>
					<span className="@@plan-editor-build-label">Build</span>
					{!hideKbdHint && (
						<span className="@@plan-editor-btn-kbd" aria-hidden>⌘↵</span>
					)}
				</>
			)}
		</button>
	);
};
