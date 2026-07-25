/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { RUNNER_TERMINAL_STATES, type RunnerTaskState } from './runnerProtocol.js';

/**
 * Allowed task state transitions — mirrors orbit-runner/src/tasks/transitions.ts
 */
const ALLOWED_TRANSITIONS: Readonly<Record<RunnerTaskState, readonly RunnerTaskState[]>> = {
	// LOST from CREATED/QUEUED: editor reconnect exhaustion (task may still exist on runner).
	CREATED: ['QUEUED', 'CANCELLED', 'FAILED', 'LOST'],
	QUEUED: ['ASSIGNED', 'CANCELLING', 'CANCELLED', 'FAILED', 'LOST'],
	ASSIGNED: ['PROVISIONING', 'CANCELLING', 'CANCELLED', 'FAILED', 'TIMED_OUT', 'LOST'],
	PROVISIONING: ['PREPARING_WORKSPACE', 'CANCELLING', 'FAILED', 'TIMED_OUT', 'LOST'],
	PREPARING_WORKSPACE: ['RUNNING', 'CANCELLING', 'FAILED', 'TIMED_OUT', 'LOST'],
	RUNNING: [
		'WAITING_FOR_APPROVAL',
		'VERIFYING',
		'FINALIZING',
		'CANCELLING',
		'FAILED',
		'TIMED_OUT',
		'LOST',
	],
	WAITING_FOR_APPROVAL: ['RUNNING', 'CANCELLING', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'LOST'],
	VERIFYING: ['FINALIZING', 'FAILED', 'CANCELLING', 'LOST'],
	FINALIZING: ['COMPLETED', 'FAILED', 'LOST'],
	COMPLETED: [],
	FAILED: [],
	CANCELLING: ['CANCELLED', 'FAILED', 'LOST'],
	CANCELLED: [],
	TIMED_OUT: [],
	LOST: [],
};

export function getAllowedTransitions(from: RunnerTaskState): readonly RunnerTaskState[] {
	return ALLOWED_TRANSITIONS[from] ?? [];
}

/** Same-state is NOT a transition (matches runner `canTransition`). */
export function canTransitionTaskState(from: RunnerTaskState, to: RunnerTaskState): boolean {
	if (from === to) {
		return false;
	}
	return getAllowedTransitions(from).includes(to);
}

export type TaskStateTransitionResult =
	| { ok: true; from: RunnerTaskState; to: RunnerTaskState }
	| { ok: false; from: RunnerTaskState; to: RunnerTaskState; reason: string };

export function validateTaskStateTransition(from: RunnerTaskState, to: RunnerTaskState): TaskStateTransitionResult {
	if (from === to) {
		return { ok: true, from, to }; // idempotent status republish for UI
	}
	if (canTransitionTaskState(from, to)) {
		return { ok: true, from, to };
	}
	return {
		ok: false,
		from,
		to,
		reason: `Illegal task state transition ${from} → ${to}`,
	};
}

export function isTerminalTaskState(state: RunnerTaskState): boolean {
	return RUNNER_TERMINAL_STATES.has(state);
}

export function isActiveTaskState(state: RunnerTaskState): boolean {
	return !isTerminalTaskState(state);
}

export function applyTaskStateTransition(
	from: RunnerTaskState,
	to: RunnerTaskState,
): { state: RunnerTaskState; error?: string } {
	const result = validateTaskStateTransition(from, to);
	if (result.ok === false) {
		return { state: from, error: result.reason };
	}
	return { state: to };
}
