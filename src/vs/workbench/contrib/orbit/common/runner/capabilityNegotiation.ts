/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import {
	RUNNER_V1_CAPABILITIES,
	RUNNER_V1_UNSUPPORTED_CAPABILITIES,
	type RunnerCapabilities,
	type RunnerCapabilityKey,
	type RunnerErrorPayload,
} from './runnerProtocol.js';

export type CapabilityNegotiationResult =
	| { ok: true; agreed: RunnerCapabilities; unsupported: string[] }
	| { ok: false; error: RunnerErrorPayload; rejected: RunnerCapabilityKey[]; unsupported: string[] };

/**
 * Negotiate capabilities — mirrors orbit-runner `negotiateCapabilities`.
 * Requesting an unsupported v1 feature fails clearly (never silently ignored).
 * Unknown capability keys are ignored (forward/back compat with optional caps).
 */
export function negotiateRunnerCapabilities(
	requested: Partial<RunnerCapabilities> | undefined,
): CapabilityNegotiationResult {
	const req = requested ?? {};
	const unsupported: string[] = [];
	const agreed: RunnerCapabilities = { ...RUNNER_V1_CAPABILITIES };

	for (const key of Object.keys(req) as RunnerCapabilityKey[]) {
		if (!Object.prototype.hasOwnProperty.call(RUNNER_V1_CAPABILITIES, key)) {
			continue;
		}
		const value = req[key];
		// `provider_sync` is optional on RunnerCapabilities, so indexing can yield
		// undefined under noUncheckedIndexedAccess — treat absent as unsupported.
		const supported = RUNNER_V1_CAPABILITIES[key] === true;
		if (value === true && !supported) {
			unsupported.push(key);
			agreed[key] = false;
		} else if (typeof value === 'boolean') {
			agreed[key] = value && supported;
		}
	}

	const rejected = unsupported.filter(
		(k): k is RunnerCapabilityKey => RUNNER_V1_UNSUPPORTED_CAPABILITIES.has(k as RunnerCapabilityKey),
	);

	if (unsupported.length > 0) {
		return {
			ok: false,
			rejected: rejected.length > 0 ? rejected : unsupported as RunnerCapabilityKey[],
			unsupported,
			error: {
				code: 'capability_unsupported',
				message: `Self-hosted Runner v1 does not support: ${unsupported.join(', ')}. Use Local execution for these features.`,
				retriable: false,
			},
		};
	}

	return { ok: true, agreed, unsupported: [] };
}

export function defaultRemoteTaskCapabilities(): Partial<RunnerCapabilities> {
	return {
		git_github: true,
		git_gitlab: true,
		// git_push is optional (Cursor-like handoff). Do not require it — older
		// runners reject unknown required caps, and push degrades gracefully.
		shell: true,
		file_tools: true,
		browser: false,
		computer_use: false,
		semantic_search: false,
		local_workspace_transfer: false,
	};
}

export function assertNoUnsupportedCapabilities(
	requested: Partial<RunnerCapabilities> | undefined,
): CapabilityNegotiationResult {
	return negotiateRunnerCapabilities(requested);
}
