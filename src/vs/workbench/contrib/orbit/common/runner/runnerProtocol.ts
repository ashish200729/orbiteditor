/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Orbit Runner protocol v1 — editor-side mirror of `orbit-runner/src/protocol`.
 * Wire version: `orbit-runner-protocol/1`
 */

export const RUNNER_PROTOCOL_VERSION = 'orbit-runner-protocol/1' as const;

export const RUNNER_PROTOCOL_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
export const RUNNER_PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const RUNNER_HEARTBEAT_INTERVAL_MS = 15_000;
export const RUNNER_DEFAULT_WS_PORT = 7421;
export const RUNNER_DEFAULT_HTTP_PORT = 7420;
/** Default WebSocket path on the runner (see DirectWebSocketTransport). */
export const RUNNER_DEFAULT_WS_PATH = '/ws';

export const RUNNER_TASK_STATES = [
	'CREATED',
	'QUEUED',
	'ASSIGNED',
	'PROVISIONING',
	'PREPARING_WORKSPACE',
	'RUNNING',
	'WAITING_FOR_APPROVAL',
	'VERIFYING',
	'FINALIZING',
	'COMPLETED',
	'FAILED',
	'CANCELLING',
	'CANCELLED',
	'TIMED_OUT',
	'LOST',
] as const;

export type RunnerTaskState = typeof RUNNER_TASK_STATES[number];

export const RUNNER_TERMINAL_STATES: ReadonlySet<RunnerTaskState> = new Set([
	'COMPLETED',
	'FAILED',
	'CANCELLED',
	'TIMED_OUT',
	'LOST',
]);

/** Capability keys aligned with orbit-runner CapabilitySchema. */
export const RUNNER_CAPABILITY_KEYS = [
	'browser',
	'computer_use',
	'semantic_search',
	'local_workspace_transfer',
	'git_github',
	'git_gitlab',
	'git_push',
	'shell',
	'file_tools',
	'provider_sync',
] as const;

export type RunnerCapabilityKey = typeof RUNNER_CAPABILITY_KEYS[number];

export type RunnerCapabilities = {
	browser: boolean;
	computer_use: boolean;
	semantic_search: boolean;
	local_workspace_transfer: boolean;
	git_github: boolean;
	git_gitlab: boolean;
	git_push: boolean;
	shell: boolean;
	file_tools: boolean;
	provider_sync?: boolean;
};

/** v1 advertised defaults — unsupported features are false. */
export const RUNNER_V1_CAPABILITIES: RunnerCapabilities = {
	browser: false,
	computer_use: false,
	semantic_search: false,
	local_workspace_transfer: false,
	git_github: true,
	git_gitlab: true,
	git_push: true,
	shell: true,
	file_tools: true,
	provider_sync: true,
};

export const RUNNER_V1_UNSUPPORTED_CAPABILITIES: ReadonlySet<RunnerCapabilityKey> = new Set([
	'browser',
	'computer_use',
	'semantic_search',
	'local_workspace_transfer',
]);

export type RunnerGitProvider = 'github' | 'gitlab';

export type RunnerModelSelection = {
	provider: string;
	modelId: string;
	baseUrl?: string;
};

export type RunnerGitSpec = {
	provider: RunnerGitProvider;
	repoUrl: string;
	branch?: string;
	/** Full 40-char commit SHA — required by orbit-runner Zod schema. */
	commit: string;
	shallow?: boolean;
};

export type RunnerChatMode = 'agent' | 'plan' | 'normal';

// ─── Message types (aligned with orbit-runner MessageTypeSchema) ────────────

export const RUNNER_MESSAGE_TYPES = [
	'hello',
	'welcome',
	'pair.redeem',
	'pair.result',
	'auth',
	'auth.result',
	'heartbeat',
	'heartbeat.ack',
	'task.create',
	'task.created',
	'task.accept',
	'task.cancel',
	'task.subscribe',
	'task.unsubscribe',
	'task.snapshot',
	'task.lease.renew',
	'task.lease',
	'task.state',
	'task.event',
	'event.ack',
	'event.replay',
	'approval.request',
	'approval.response',
	'capabilities.negotiate',
	'capabilities.result',
	'provider.catalog.request',
	'provider.catalog.response',
	'provider.provision.request',
	'provider.provision.result',
	'provider.revoke.request',
	'provider.revoke.result',
	'provider.probe.request',
	'provider.probe.result',
	'model.resolve.request',
	'model.resolve.result',
	'device.revoke',
	'device.revoke.result',
	'error',
] as const;

export type RunnerMessageType = typeof RUNNER_MESSAGE_TYPES[number];

export type RunnerEnvelope = {
	protocol: typeof RUNNER_PROTOCOL_VERSION;
	type: string;
	id: string;
	ts: number;
	payload: unknown;
};

export type RunnerHelloPayload = {
	clientName?: string;
	clientVersion?: string;
	deviceId?: string;
};

export type RunnerWelcomePayload = {
	runnerId: string;
	runnerVersion: string;
	protocol: typeof RUNNER_PROTOCOL_VERSION;
	capabilities: RunnerCapabilities;
	uiLabel: 'Self-hosted Runner';
	transportMode?: 'direct' | 'relay';
};

export type RunnerPairRedeemPayload = {
	pairingCode: string;
	deviceName: string;
	devicePublicKey?: string;
};

export type RunnerPairResultPayload = {
	runnerId: string;
	deviceId: string;
	credential: string;
	expiresAt: number | null;
};

export type RunnerAuthPayload = {
	deviceId: string;
	credential: string;
};

export type RunnerAuthResultPayload = {
	ok: boolean;
	error?: string;
	capabilities?: RunnerCapabilities;
};

export type RunnerTaskCreatePayload = {
	taskId?: string;
	parentTaskId?: string;
	prompt: string;
	model: RunnerModelSelection;
	git: RunnerGitSpec;
	requestedCapabilities?: Partial<RunnerCapabilities>;
	metadata?: Record<string, unknown>;
};

export type RunnerTaskCreatedPayload = {
	taskId: string;
	state: RunnerTaskState;
};

export type RunnerTaskStateChangedPayload = {
	taskId: string;
	from: RunnerTaskState;
	to: RunnerTaskState;
	reason?: string;
};

export type RunnerTaskSubscribePayload = {
	taskId: string;
	/** Next sequence number needed, inclusive. */
	fromSeq: number;
};

export type RunnerTaskEventPayload = {
	taskId: string;
	seq: number;
	kind: string;
	data: unknown;
	ts: number;
};

export type RunnerApprovalRequestPayload = {
	taskId: string;
	approvalId: string;
	toolCallId?: string;
	toolName: string;
	toolArgs: unknown;
	reason?: string;
};

export type RunnerTaskSnapshotPayload = {
	taskId: string;
	state: RunnerTaskState;
	lastSeq: number;
	error?: string;
	pendingApproval?: RunnerApprovalRequestPayload;
};

export type RunnerApprovalResponsePayload = {
	taskId: string;
	approvalId: string;
	decision: 'allow' | 'deny';
	remember?: boolean;
};

export type RunnerErrorPayload = {
	code: string;
	message: string;
	retriable?: boolean;
	relatedId?: string;
};

export type RunnerErrorCode =
	| 'protocol_version_mismatch'
	| 'unauthorized'
	| 'UNAUTHORIZED'
	| 'pairing_expired'
	| 'EXPIRED'
	| 'pairing_invalid'
	| 'INVALID_CODE'
	| 'capability_unsupported'
	| 'CAPABILITY_UNSUPPORTED'
	| 'repo_unsupported'
	| 'runner_offline'
	| 'task_not_found'
	| 'TASK_NOT_FOUND'
	| 'invalid_message'
	| 'BAD_MESSAGE'
	| 'rate_limited'
	| 'internal'
	| 'INTERNAL';

// ─── Validation ─────────────────────────────────────────────────────────────

export function isRunnerTaskState(value: unknown): value is RunnerTaskState {
	return typeof value === 'string' && (RUNNER_TASK_STATES as readonly string[]).includes(value);
}

export function isRunnerProtocolVersion(value: unknown): value is typeof RUNNER_PROTOCOL_VERSION {
	return value === RUNNER_PROTOCOL_VERSION;
}

export function isRunnerMessageType(value: unknown): value is RunnerMessageType {
	return typeof value === 'string' && (RUNNER_MESSAGE_TYPES as readonly string[]).includes(value);
}

export type ParseRunnerMessageResult =
	| { ok: true; message: RunnerEnvelope }
	| { ok: false; error: RunnerErrorPayload };

export function parseRunnerWireMessage(raw: unknown): ParseRunnerMessageResult {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		return { ok: false, error: { code: 'invalid_message', message: 'Message must be a JSON object.' } };
	}
	const obj = raw as Record<string, unknown>;
	if (!isRunnerProtocolVersion(obj.protocol)) {
		return {
			ok: false,
			error: {
				code: 'protocol_version_mismatch',
				message: `Unsupported protocol version "${String(obj.protocol)}". Expected ${RUNNER_PROTOCOL_VERSION}.`,
			},
		};
	}
	if (typeof obj.id !== 'string' || !obj.id) {
		return { ok: false, error: { code: 'invalid_message', message: 'Missing message id.' } };
	}
	if (typeof obj.ts !== 'number' || !Number.isFinite(obj.ts)) {
		return { ok: false, error: { code: 'invalid_message', message: 'Missing or invalid timestamp.' } };
	}
	if (typeof obj.type !== 'string' || !obj.type) {
		return { ok: false, error: { code: 'invalid_message', message: 'Missing message type.' } };
	}
	if (!isRunnerMessageType(obj.type)) {
		return { ok: false, error: { code: 'invalid_message', message: `Unknown message type "${obj.type}".` } };
	}
	if (!('payload' in obj)) {
		return { ok: false, error: { code: 'invalid_message', message: 'Missing payload.' } };
	}
	return {
		ok: true,
		message: {
			protocol: RUNNER_PROTOCOL_VERSION,
			type: obj.type,
			id: obj.id,
			ts: obj.ts as number,
			payload: obj.payload,
		},
	};
}

export function parseRunnerWireJson(text: string): ParseRunnerMessageResult {
	if (text.length > RUNNER_PROTOCOL_MAX_MESSAGE_BYTES) {
		return { ok: false, error: { code: 'invalid_message', message: 'Message exceeds maximum size.', retriable: false } };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ok: false, error: { code: 'invalid_message', message: 'Message is not valid JSON.' } };
	}
	return parseRunnerWireMessage(parsed);
}

export function createRunnerEnvelope(type: RunnerMessageType, payload: unknown, id?: string): RunnerEnvelope {
	return {
		protocol: RUNNER_PROTOCOL_VERSION,
		type,
		id: id ?? generateRunnerMessageId(),
		ts: Date.now(),
		payload,
	};
}

export function generateRunnerMessageId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	// RFC4122 v4-shaped fallback (runner Zod requires UUID) — prefer CSPRNG.
	const bytes = new Uint8Array(16);
	if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
		crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < 16; i++) {
			bytes[i] = Math.floor(Math.random() * 256);
		}
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
	const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Validate welcome.protocol + transportMode for editor connect paths.
 * Returns an error payload when the runner is incompatible with v1 direct WS.
 */
export function validateRunnerWelcome(
	payload: { protocol?: unknown; transportMode?: unknown },
): { ok: true } | { ok: false; error: RunnerErrorPayload } {
	if (!isRunnerProtocolVersion(payload.protocol)) {
		return {
			ok: false,
			error: {
				code: 'protocol_version_mismatch',
				message: `Unsupported protocol version "${String(payload.protocol)}". Expected ${RUNNER_PROTOCOL_VERSION}.`,
				retriable: false,
			},
		};
	}
	const mode = payload.transportMode;
	if (mode !== undefined && mode !== 'direct') {
		return {
			ok: false,
			error: {
				code: 'capability_unsupported',
				message: `Self-hosted Runner v1 supports direct WebSocket only (got transportMode="${String(mode)}"). Relay is planned for v2.`,
				retriable: false,
			},
		};
	}
	return { ok: true };
}

export function formatRunnerError(error: { code?: string; message: string }): string {
	const raw = error.code ?? '';
	const code = raw.toLowerCase();
	const upper = raw.toUpperCase();

	if (code.includes('protocol') || code === 'protocol_version_mismatch') {
		return `Protocol version mismatch: ${error.message}`;
	}
	// Runner wire: EXPIRED; editor legacy: pairing_expired
	if (upper === 'EXPIRED' || code === 'pairing_expired' || (code.includes('pairing') && code.includes('expir'))) {
		return 'Pairing code expired. Generate a new code on the runner dashboard.';
	}
	// Runner wire: INVALID_CODE; editor legacy: pairing_invalid
	if (upper === 'INVALID_CODE' || code === 'pairing_invalid' || code.includes('pairing')) {
		return error.message || 'Invalid pairing code. Check the code and try again.';
	}
	if (upper === 'CAPABILITY_UNSUPPORTED' || code === 'capability_unsupported') {
		return `Unsupported capability: ${error.message}`;
	}
	if (code === 'repo_unsupported') {
		return `Repository not supported for remote tasks: ${error.message}`;
	}
	if (code === 'runner_offline') {
		return 'Self-hosted runner is offline.';
	}
	if (upper === 'UNAUTHORIZED' || code === 'unauthorized' || code.includes('auth')) {
		return error.message || 'Runner rejected credentials. Re-pair this editor.';
	}
	if (upper === 'TASK_NOT_FOUND' || upper === 'NOT_FOUND' || code === 'task_not_found' || code === 'not_found') {
		return error.message || 'Task not found on the runner.';
	}
	if (upper === 'BAD_MESSAGE' || code === 'invalid_message') {
		return error.message || 'Invalid message sent to the runner.';
	}
	if (upper === 'CONTINUATION_UNAVAILABLE' || code === 'continuation_unavailable') {
		return error.message || 'Continuation requires a completed task on the same repository. Start a new remote task instead.';
	}
	if (upper === 'TASK_ID_CONFLICT' || code === 'task_id_conflict') {
		return error.message || 'A task with this ID already exists on the runner. Retry to create a new task.';
	}
	if (upper === 'INVALID_STATE' || code === 'invalid_state') {
		return error.message || 'The runner rejected this action for the current task state.';
	}
	if (upper === 'PROVISION_FAILED' || code === 'provision_failed') {
		return error.message || 'Failed to provision the provider on the runner. Check credentials and try Sync again.';
	}
	return error.message || `Runner error (${error.code ?? 'unknown'})`;
}

/** Normalize partial capabilities against v1 defaults. */
export function normalizeCapabilities(partial?: Partial<RunnerCapabilities>): RunnerCapabilities {
	return {
		...RUNNER_V1_CAPABILITIES,
		...partial,
		// Force unsupported off even if caller sets them true — negotiation rejects separately
		browser: false,
		computer_use: false,
		semantic_search: false,
		local_workspace_transfer: false,
	};
}
