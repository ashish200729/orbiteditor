/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type {
	RunnerCapabilities,
	RunnerChatMode,
	RunnerGitSpec,
	RunnerModelSelection,
	RunnerTaskEventPayload,
	RunnerTaskState,
} from './runnerProtocol.js';

/** Execution target shown in the composer selector. Never labeled "Cloud". */
export type ExecutionTargetKind = 'local' | 'runner';

export type ExecutionTargetId = 'local' | `runner:${string}`;

export function parseExecutionTargetId(value: string | undefined | null): ExecutionTargetId {
	if (!value || value === 'local') {
		return 'local';
	}
	if (value.startsWith('runner:') && value.length > 'runner:'.length) {
		return value as `runner:${string}`;
	}
	return 'local';
}

export function executionTargetKindOf(id: ExecutionTargetId): ExecutionTargetKind {
	return id === 'local' ? 'local' : 'runner';
}

export function runnerIdFromExecutionTarget(id: ExecutionTargetId): string | undefined {
	if (id === 'local') {
		return undefined;
	}
	return id.slice('runner:'.length);
}

export function makeRunnerExecutionTarget(runnerId: string): ExecutionTargetId {
	return `runner:${runnerId}`;
}

export type RunnerConnectionStatus = 'unknown' | 'online' | 'offline' | 'busy' | 'error' | 'connecting';

export type RunnerInfo = {
	id: string;
	name: string;
	hostUrl: string;
	deviceId: string;
	status: RunnerConnectionStatus;
	lastSeenAt?: number;
	lastError?: string;
	capabilities?: RunnerCapabilities;
	protocolVersion?: string;
	createdAt: number;
	updatedAt: number;
};

/** Stored credential blob — never log `credential`. */
export type PairedRunnerCredential = {
	runnerId: string;
	deviceId: string;
	/** Runner-issued device credential (secret). */
	credential: string;
	hostUrl: string;
	name: string;
	createdAt: number;
	updatedAt: number;
};

export type PairedRunnerStore = {
	version: 1;
	runners: PairedRunnerCredential[];
};

export type RemoteTaskSummary = {
	taskId: string;
	runnerId: string;
	state: RunnerTaskState;
	prompt: string;
	git?: RunnerGitSpec;
	model?: RunnerModelSelection;
	chatMode?: RunnerChatMode;
	/** Snapshot of editor auto-approve prefs sent with this task. */
	autoApprove?: { edits?: boolean; terminal?: boolean };
	editorThreadId?: string;
	/** Local message count when the remote turn was submitted; preserves mixed transcript order. */
	editorMessageIndex?: number;
	/** Stable identity of the local transcript prefix where this remote turn was attached. */
	editorHistoryAnchor?: string;
	parentTaskId?: string;
	/**
	 * HEAD commit on the runner workspace after completion (from artifact.branch).
	 * Used to pin continuation `git.commit` to the remote branch tip.
	 */
	headCommit?: string;
	createdAt: number;
	updatedAt: number;
	lastSeq: number;
	lastError?: string;
};

export type RemoteTaskPermissionRequest = {
	taskId: string;
	approvalId: string;
	toolCallId?: string;
	toolName: string;
	summary: string;
	toolArgs?: unknown;
	receivedAt: number;
};

export type RemoteTaskLiveState = {
	summary: RemoteTaskSummary;
	events: RunnerTaskEventPayload[];
	pendingPermission?: RemoteTaskPermissionRequest;
	reconnecting: boolean;
	connected: boolean;
};

export type CreateRemoteTaskRequest = {
	runnerId: string;
	prompt: string;
	git: RunnerGitSpec;
	model: RunnerModelSelection;
	chatMode: RunnerChatMode;
	/** Mirrors Orbit Editor Settings → Tools auto-approve (edits / terminal). */
	autoApprove?: { edits?: boolean; terminal?: boolean };
	editorThreadId?: string;
	editorMessageIndex?: number;
	editorHistoryAnchor?: string;
	parentTaskId?: string;
	requestedCapabilities?: Partial<RunnerCapabilities>;
};

export type PairRunnerRequest = {
	code: string;
	hostUrl: string;
	deviceName?: string;
};

export type PairRunnerResult =
	| { ok: true; runner: RunnerInfo }
	| { ok: false; error: string; code?: string };

export type TestConnectionResult =
	| { ok: true; latencyMs: number; capabilities?: RunnerCapabilities }
	| { ok: false; error: string; code?: string };
