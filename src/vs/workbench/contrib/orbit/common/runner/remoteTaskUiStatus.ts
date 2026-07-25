/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { RunnerTaskState } from './runnerProtocol.js';
import { isTerminalTaskState } from './taskStateMachine.js';
import type { RemoteTaskLiveState, RemoteTaskSummary } from './runnerTypes.js';

/**
 * UI phases for a remote task thread. Surfaces a single, user-facing label
 * instead of the raw runner state machine so the Agents list, command bar,
 * and inline cards stay in sync. Pure mapping — no React or service deps.
 *
 * Phases:
 * - `connecting`    — CREATED/QUEUED before the WebSocket authenticated
 * - `reconnecting`  — mid-run WebSocket reconnect in progress
 * - `provisioning`  — runner is preparing workspace/environment
 * - `running`       — agent is actively streaming
 * - `awaiting`      — waiting for user approval
 * - `failed`        — terminal failure (FAILED/CANCELLED/TIMED_OUT/LOST)
 * - `done`          — COMPLETED
 * - `idle`          — no remote task (or live state missing)
 */
export type RemoteTaskUiPhase =
	| 'connecting'
	| 'reconnecting'
	| 'provisioning'
	| 'running'
	| 'awaiting'
	| 'failed'
	| 'done'
	| 'idle';

const PROVISIONING_STATES: ReadonlySet<RunnerTaskState> = new Set<RunnerTaskState>([
	'ASSIGNED',
	'PROVISIONING',
	'PREPARING_WORKSPACE',
]);

/** Map a runner task + live state to a UI phase. Returns `idle` when missing. */
export function remoteTaskUiPhase(
	summary: RemoteTaskSummary | undefined,
	live: RemoteTaskLiveState | undefined,
): RemoteTaskUiPhase {
	if (!summary) {
		return 'idle';
	}
	if (live?.pendingPermission) {
		return 'awaiting';
	}
	const state = summary.state;
	if (state === 'COMPLETED') {
		return 'done';
	}
	if (state === 'FAILED' || state === 'CANCELLED' || state === 'TIMED_OUT' || state === 'LOST') {
		return 'failed';
	}
	if (state === 'WAITING_FOR_APPROVAL') {
		return 'awaiting';
	}
	// Reconnecting mid-task wins over running/provisioning labels.
	if (live?.reconnecting && !isTerminalTaskState(state)) {
		return 'reconnecting';
	}
	if (state === 'RUNNING' || state === 'VERIFYING' || state === 'FINALIZING') {
		return 'running';
	}
	if (PROVISIONING_STATES.has(state)) {
		return 'provisioning';
	}
	// CREATED / QUEUED: still connecting until the WebSocket is connected
	// (the service only flips `connected` after auth succeeds, so it doubles as
	// the "authenticated" signal here).
	if (state === 'CREATED' || state === 'QUEUED') {
		return live?.connected ? 'provisioning' : 'connecting';
	}
	if (state === 'CANCELLING') {
		return 'running';
	}
	return 'idle';
}

/** True when the phase should drive a Running spinner / orange pill. */
export function isRemoteTaskUiPhaseActive(phase: RemoteTaskUiPhase): boolean {
	return phase === 'connecting'
		|| phase === 'reconnecting'
		|| phase === 'provisioning'
		|| phase === 'running'
		|| phase === 'awaiting';
}

/** Human-readable label for command-bar / status pills. */
export function remoteTaskUiPhaseLabel(phase: RemoteTaskUiPhase): string {
	switch (phase) {
		case 'connecting': return 'Connecting';
		case 'reconnecting': return 'Reconnecting';
		case 'provisioning': return 'Provisioning';
		case 'running': return 'Running';
		case 'awaiting': return 'Awaiting approval';
		case 'failed': return 'Failed';
		case 'done': return 'Done';
		case 'idle':
		default:
			return 'Done';
	}
}

/**
 * Friendly, sentence-style label rendered in-stream (the shimmer status line
 * beneath the user's message). Mirrors the lightweight "Setting up workspace"
 * phrasing instead of the terse command-bar pill from {@link remoteTaskUiPhaseLabel}.
 */
export function remoteTaskUiPhaseStatusLabel(phase: RemoteTaskUiPhase): string {
	switch (phase) {
		case 'connecting': return 'Connecting to runner';
		case 'reconnecting': return 'Reconnecting to runner';
		case 'provisioning': return 'Setting up workspace';
		case 'running': return 'Planning next moves';
		case 'awaiting': return 'Awaiting approval';
		case 'failed': return 'Failed';
		case 'done': return 'Done';
		case 'idle':
		default:
			return 'Done';
	}
}

/**
 * Coarse `IsRunningType`-compatible value for the running-thread map.
 * Returns `undefined` for terminal/idle phases so the chat list stops
 * showing a spinner once a remote task completes or fails.
 *
 * `'idle'` is used for connecting/provisioning/running because the chat
 * list only needs "something is happening" — the precise phase is shown in
 * the command bar / inline card via {@link remoteTaskUiPhase}.
 */
export function remoteTaskUiRunningValue(
	summary: RemoteTaskSummary | undefined,
	live: RemoteTaskLiveState | undefined,
): 'idle' | 'awaiting_user' | undefined {
	const phase = remoteTaskUiPhase(summary, live);
	if (phase === 'awaiting') {
		return 'awaiting_user';
	}
	if (phase === 'connecting' || phase === 'reconnecting' || phase === 'provisioning' || phase === 'running') {
		return 'idle';
	}
	return undefined;
}

/** True when the summary is in a terminal state (helper re-export for callers). */
export function isRemoteTaskTerminal(summary: RemoteTaskSummary | undefined): boolean {
	return !!summary && isTerminalTaskState(summary.state);
}

/**
 * Minimal message shape for gating the in-stream remote status shimmer.
 * Intentionally loose so React ChatMessage arrays can be passed without coupling.
 */
export type RemoteChatStatusTipMessage = {
	role: string;
	type?: string;
	name?: string;
	displayContent?: string;
	content?: string;
};

/**
 * True when the remote turn tip is waiting for the model (local
 * `isWaitingForAIResponse` parity): no assistant text yet, and no non-setup
 * tool currently running. RemoteSetup's own card carries setup shimmer.
 */
export function isRemoteChatWaitingForResponse(
	tipMessages: ReadonlyArray<RemoteChatStatusTipMessage>,
): boolean {
	for (let i = tipMessages.length - 1; i >= 0; i--) {
		const message = tipMessages[i];
		if (message.role === 'assistant') {
			const text = (message.displayContent || message.content || '').trim();
			if (text.length > 0) {
				return false;
			}
			continue;
		}
		if (message.role === 'tool') {
			if (message.name === 'RemoteSetup') {
				// Setup card owns connecting/provisioning shimmer while running.
				if (message.type === 'running_now') {
					return false;
				}
				continue;
			}
			if (message.type === 'running_now') {
				return false;
			}
			continue;
		}
		if (message.role === 'user') {
			return true;
		}
	}
	return true;
}

export type RemoteChatStatusLineInput = {
	isStopping: boolean;
	phase: RemoteTaskUiPhase;
	pendingApproval: boolean;
	/** True once any runner event has arrived (RemoteSetupCard can render). */
	hasRemoteEvents: boolean;
	tipMessages: ReadonlyArray<RemoteChatStatusTipMessage>;
};

/**
 * Single in-stream status label for Self-hosted Runner turns.
 * Returns null when a card/tool/assistant already shows activity.
 */
export function remoteChatStatusLineLabel(input: RemoteChatStatusLineInput): string | null {
	if (input.isStopping) {
		return 'Stopping';
	}
	if (input.pendingApproval) {
		return null;
	}
	if (input.phase === 'connecting' || input.phase === 'reconnecting' || input.phase === 'provisioning') {
		// Before the first event, show preparing shimmer in the scroll stream.
		// Once events exist, RemoteSetupCard owns the shimmer.
		if (!input.hasRemoteEvents) {
			return remoteTaskUiPhaseStatusLabel(input.phase);
		}
		return null;
	}
	if (input.phase !== 'running') {
		return null;
	}
	if (!isRemoteChatWaitingForResponse(input.tipMessages)) {
		return null;
	}
	return 'Planning next moves';
}

/**
 * Inputs to {@link commandBarThreadStatus}. Mirrors the data the
 * `CommandBarInChat` React component has at render time, kept framework-agnostic
 * so it can be unit tested under the orbit test runner.
 */
export interface CommandBarStatusInput {
	/** Local stream running state, or the remote-derived override. */
	effectiveIsRunning: string | undefined;
	/** True when an AskQuestion tool request is pending on this thread. */
	pendingAskQuestion: boolean;
	/** Distinct remote phase label (Connecting/Provisioning/Running), if any. */
	remotePhaseLabel?: string | undefined;
	/** True when the remote task failed closed — show "Failed" not "Done". */
	remoteFailed?: boolean | undefined;
	/** True when the thread has a user message but no assistant reply (and not running). */
	isDraftThread?: boolean | undefined;
}

export type CommandBarStatusColor = 'orange' | 'yellow' | 'dark';

export interface CommandBarStatus {
	title: string;
	color: CommandBarStatusColor;
}

/**
 * Pure command-bar status decision. Pulled out of `CommandBarInChat` so the
 * label matrix (Connecting / Running / Awaiting / Draft / Done / Failed) can be
 * unit tested without React.
 *
 * Precedence (highest first):
 *  1. `awaiting_user` + pending AskQuestion → "Waiting for answers" (yellow)
 *  2. `awaiting_user`                      → "Awaiting approval"   (yellow)
 *  3. any truthy running state             → remotePhaseLabel ?? "Running" (orange)
 *  4. remoteFailed                         → "Failed"              (dark)
 *  5. isDraftThread                        → "Draft"               (dark)
 *  6. otherwise                            → "Done"                (dark)
 */
export function commandBarThreadStatus(input: CommandBarStatusInput): CommandBarStatus {
	if (input.effectiveIsRunning === 'awaiting_user') {
		return input.pendingAskQuestion
			? { title: 'Waiting for answers', color: 'yellow' }
			: { title: 'Awaiting approval', color: 'yellow' };
	}
	if (input.effectiveIsRunning) {
		return { title: input.remotePhaseLabel ?? 'Running', color: 'orange' };
	}
	if (input.remoteFailed) {
		return { title: 'Failed', color: 'dark' };
	}
	if (input.isDraftThread) {
		return { title: 'Draft', color: 'dark' };
	}
	return { title: 'Done', color: 'dark' };
}
