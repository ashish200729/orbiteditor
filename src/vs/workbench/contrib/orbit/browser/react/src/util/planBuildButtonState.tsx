/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import { PlanBuildState } from '../../../../common/chatThreadServiceTypes.js';
import { useAccessor } from './services.js';

/** Visual phase for the plan Build button. */
export type PlanBuildButtonPhase = 'idle' | 'building' | 'built' | 'failed';

export function resolvePlanBuildButtonPhase(
	planBuildState: PlanBuildState,
	opts?: { isSaving?: boolean; isStarting?: boolean },
): PlanBuildButtonPhase {
	if (opts?.isSaving || opts?.isStarting) {
		return 'building';
	}
	if (planBuildState === 'building') {
		return 'building';
	}
	if (planBuildState === 'built') {
		return 'built';
	}
	if (planBuildState === 'failed') {
		return 'failed';
	}
	return 'idle';
}

/**
 * Pure predicate: true when a new Build can start for the given plan build
 * state. Used by the BuildPlanDraftAction command to guard re-entrancy (e.g. a
 * rapid double-click) without needing a new service API — the state machine
 * already encodes "building" as the in-flight signal. A 'built' state is still
 * startable (re-run); only an active 'building' blocks.
 */
export function canStartPlanBuild(planBuildState: PlanBuildState): boolean {
	return planBuildState !== 'building';
}

export function usePlanBuildButtonPhase(
	threadId: string | undefined,
	opts?: { isSaving?: boolean; isStarting?: boolean },
): PlanBuildButtonPhase {
	const accessor = useAccessor();
	const chatThreadService = accessor.get('IChatThreadService');

	const [planBuildState, setPlanBuildState] = useState<PlanBuildState>(() =>
		threadId ? chatThreadService.getPlanBuildState(threadId) : 'idle',
	);

	useEffect(() => {
		if (!threadId) {
			setPlanBuildState('idle');
			return;
		}
		setPlanBuildState(chatThreadService.getPlanBuildState(threadId));
		const disposable = chatThreadService.onDidChangePlanBuildState(({ threadId: changedId }) => {
			if (changedId === threadId) {
				setPlanBuildState(chatThreadService.getPlanBuildState(threadId));
			}
		});
		return () => disposable.dispose();
	}, [threadId, chatThreadService]);

	return resolvePlanBuildButtonPhase(planBuildState, opts);
}