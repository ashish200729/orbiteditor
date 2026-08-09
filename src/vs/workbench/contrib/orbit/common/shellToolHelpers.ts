/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import { RawToolParamsObj } from './sendLLMMessageTypes.js';
import {
	DEFAULT_AWAIT_SHELL_BLOCK_UNTIL_MS,
	DEFAULT_SHELL_BLOCK_UNTIL_MS,
	MAX_SHELL_BLOCK_UNTIL_MS,
	MIN_NOTIFY_DEBOUNCE_MS,
	MIN_SHELL_BLOCK_UNTIL_MS,
} from './prompt/prompts.js';
import type { BuiltinToolCallParams, BuiltinToolResultType } from './toolsServiceTypes.js';
import { isAbsolute, normalize, resolve } from '../../../../base/common/path.js';

const isFalsy = (u: unknown) => !u || u === 'null' || u === 'undefined';

export const validateShellStr = (argName: string, value: unknown) => {
	if (value === null) throw new Error(`Invalid LLM output: ${argName} was null.`);
	if (typeof value !== 'string') throw new Error(`Invalid LLM output format: ${argName} must be a string, but its type is "${typeof value}". Full value: ${JSON.stringify(value)}.`);
	return value;
};

export const validateShellOptionalStr = (argName: string, str: unknown) => {
	if (isFalsy(str)) return null;
	return validateShellStr(argName, str);
};

export const parseOptionalIntInRange = (name: string, raw: unknown, min: number, max: number, dflt: number): number => {
	if (isFalsy(raw)) return dflt;
	const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
		throw new Error(`Invalid LLM output format: ${name} must be an integer. Full value: ${JSON.stringify(raw)}.`);
	}
	if (parsed < min || parsed > max) {
		throw new Error(`Invalid ${name}: ${parsed}. Must be between ${min} and ${max}.`);
	}
	return parsed;
};

export const parseOptionalBool = (raw: unknown, dflt: boolean): boolean => {
	if (isFalsy(raw)) return dflt;
	if (typeof raw === 'boolean') return raw;
	if (raw === 'true') return true;
	if (raw === 'false') return false;
	throw new Error(`Invalid LLM output format: expected boolean, got ${JSON.stringify(raw)}.`);
};

/**
 * Reject pathological regex patterns that can cause catastrophic backtracking
 * (ReDoS) or that are simply too long. The pattern is run against the live
 * terminal output stream on every onData, so a pattern like `(a+)+$` could pin
 * the main thread for seconds. Also verifies the pattern actually compiles so an
 * invalid regex surfaces as a clean tool error instead of throwing later.
 */
export const validateShellRegexPattern = (argName: string, pattern: string): void => {
	if (pattern.length > 256) {
		throw new Error(`Invalid ${argName}: pattern is too long (${pattern.length} chars, max 256).`);
	}
	// Keep the accepted grammar deliberately linear-time in JavaScript's
	// backtracking engine. Backreferences/lookarounds, counted repetition, and
	// quantified groups can turn small patterns into exponential work.
	if (/\\[1-9]/.test(pattern) || /\(\?[=!<]/.test(pattern)) {
		throw new Error(`Invalid ${argName}: backreferences and lookarounds are not supported (ReDoS risk).`);
	}
	if (/(^|[^\\])\{/.test(pattern) || /\)(?:[*+?]|\{)/.test(pattern)) {
		throw new Error(`Invalid ${argName}: counted repetition and quantified groups are not supported (ReDoS risk).`);
	}
	const unescaped = pattern.replace(/\\./g, '');
	const unboundedQuantifiers = (unescaped.match(/[*+]/g) ?? []).length;
	const optionalQuantifiers = (unescaped.match(/\?/g) ?? []).length;
	if (unboundedQuantifiers > 1 || optionalQuantifiers > 8) {
		throw new Error(`Invalid ${argName}: the pattern contains too many repetition operators (ReDoS risk).`);
	}
	try {
		// Matches the flags the terminal service uses to run the pattern.
		void new RegExp(pattern, 'm');
	} catch (e) {
		throw new Error(`Invalid ${argName}: not a valid regular expression. ${e instanceof Error ? e.message : String(e)}`);
	}
};

/** Resolve a model-supplied cwd without ever interpolating it into shell text. */
export function resolveShellWorkingDirectory(raw: string | null, defaultRoot: string | undefined): string | null {
	if (!raw) return defaultRoot ? normalize(defaultRoot) : null;
	if (raw.includes('\0')) throw new Error('Invalid working_directory: NUL bytes are not allowed.');
	if (isAbsolute(raw)) return normalize(raw);
	if (!defaultRoot) throw new Error('A relative working_directory requires an active workspace folder.');
	return resolve(defaultRoot, raw);
}

export type NotifyOnOutput = { pattern: string; debounceMs: number; reason: string };

export const parseNotifyOnOutput = (raw: unknown): NotifyOnOutput | null => {
	if (isFalsy(raw)) return null;
	if (typeof raw !== 'string') {
		throw new Error(`Invalid LLM output format: notify_on_output must be a JSON object string. Full value: ${JSON.stringify(raw)}.`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`Invalid notify_on_output: malformed JSON. Full value: ${JSON.stringify(raw)}.`);
	}
	if (!parsed || typeof parsed !== 'object') {
		throw new Error(`Invalid notify_on_output: expected object. Full value: ${JSON.stringify(raw)}.`);
	}
	const obj = parsed as Record<string, unknown>;
	const pattern = validateShellStr('notify_on_output.pattern', obj.pattern);
	// Phase 2.14 (H17) fix: reject pathological regex patterns that can cause
	// catastrophic backtracking (ReDoS). The notify matcher runs the pattern
	// against the live terminal output stream, so a malicious or accidental
	// pattern like `(a+)+$` could pin the main thread for seconds.
	validateShellRegexPattern('notify_on_output.pattern', pattern);
	const debounceMs = parseOptionalIntInRange('notify_on_output.debounce_ms', obj.debounce_ms, MIN_NOTIFY_DEBOUNCE_MS, MAX_SHELL_BLOCK_UNTIL_MS, MIN_NOTIFY_DEBOUNCE_MS);
	const reason = validateShellStr('notify_on_output.reason', obj.reason);
	return { pattern, debounceMs, reason };
};

export const validateShellParams = (params: RawToolParamsObj): BuiltinToolCallParams['Shell'] => {
	const command = validateShellStr('command', params.command);
	const workingDirectory = validateShellOptionalStr('working_directory', params.working_directory);
	const blockUntilMs = parseOptionalIntInRange('block_until_ms', params.block_until_ms, MIN_SHELL_BLOCK_UNTIL_MS, MAX_SHELL_BLOCK_UNTIL_MS, DEFAULT_SHELL_BLOCK_UNTIL_MS);
	const description = validateShellOptionalStr('description', params.description);
	const notifyOnOutput = parseNotifyOnOutput(params.notify_on_output);
	const requestSmartModeApproval = parseOptionalBool(params.request_smart_mode_approval, false);
	const shellId = generateUuid();
	return { command, workingDirectory, blockUntilMs, description, notifyOnOutput, requestSmartModeApproval, shellId };
};

export const validateAwaitShellParams = (params: RawToolParamsObj): BuiltinToolCallParams['AwaitShell'] => {
	const shellId = validateShellOptionalStr('shell_id', params.shell_id);
	const blockUntilMs = parseOptionalIntInRange('block_until_ms', params.block_until_ms, MIN_SHELL_BLOCK_UNTIL_MS, MAX_SHELL_BLOCK_UNTIL_MS, DEFAULT_AWAIT_SHELL_BLOCK_UNTIL_MS);
	const pattern = validateShellOptionalStr('pattern', params.pattern);
	// AwaitShell.pattern is compiled with `new RegExp(pattern, 'm')` and run
	// against the live buffer on every onData — same ReDoS/invalid-regex risk as
	// notify_on_output.pattern, so apply the same guard here.
	if (pattern !== null) {
		validateShellRegexPattern('pattern', pattern);
	}
	return { shellId, blockUntilMs, pattern };
};

const isShellStructuredResult = (value: unknown): value is BuiltinToolResultType['Shell'] =>
	typeof value === 'object' && value !== null && 'kind' in value
	&& (value as { kind: unknown }).kind !== undefined;

const isAwaitShellStructuredResult = (value: unknown): value is BuiltinToolResultType['AwaitShell'] =>
	typeof value === 'object' && value !== null && 'kind' in value
	&& (value as { kind: unknown }).kind !== undefined;

/**
 * Runner `tool.result` events carry plain stdout/stderr text. Local Shell cards expect the
 * structured result object produced by terminalToolService — map remote output here.
 */
export const remoteShellResultFromOutput = (
	output: string,
	ok: boolean,
	params: BuiltinToolCallParams['Shell'],
	errorText?: string,
	structured?: unknown,
): BuiltinToolResultType['Shell'] => {
	if (isShellStructuredResult(structured)) {
		return structured;
	}
	let exitCode = ok ? 0 : 1;
	if (errorText) {
		const match = errorText.match(/^exit (\d+)$/);
		if (match) {
			exitCode = Number(match[1]);
		}
	}
	return {
		kind: 'done',
		result: output,
		exitCode,
		shellId: params.shellId ?? '',
	};
};

/** See {@link remoteShellResultFromOutput}. */
export const remoteAwaitShellResultFromOutput = (
	output: string,
	params: BuiltinToolCallParams['AwaitShell'],
	structured?: unknown,
): BuiltinToolResultType['AwaitShell'] => {
	if (isAwaitShellStructuredResult(structured)) {
		return structured;
	}
	const msMatch = output.match(/^waited (\d+)ms$/);
	if (msMatch) {
		return {
			kind: 'done',
			result: output,
			exitCode: 0,
			runningForMs: Number(msMatch[1]),
			matchedPattern: false,
		};
	}
	return {
		kind: 'timeout',
		result: output,
		runningForMs: params.blockUntilMs,
		matchedPattern: false,
	};
};

export const stringOfShellResult = (_params: BuiltinToolCallParams['Shell'], result: Awaited<BuiltinToolResultType['Shell']>): string => {
	if (!result || typeof result !== 'object' || !('kind' in result)) {
		return typeof result === 'string' ? result : String(result ?? '(no output)');
	}
	if (result.kind === 'backgrounded') {
		return `Command sent in background. shell_id="${result.shellId}"${result.pid ? `, pid=${result.pid}` : ''}. Use AwaitShell with this shell_id to check status, or let notify_on_output wake you.`;
	}
	const output = result.result ?? '';
	if (result.kind === 'done') {
		return `${output}\n(exit code ${result.exitCode})`;
	}
	const elapsedMs = result.elapsedMs ?? _params.blockUntilMs ?? 0;
	const shellId = result.shellId || _params.shellId || 'unknown';
	return `${output}\nCommand did not finish within ${elapsedMs}ms. shell_id="${shellId}" is still alive. Use AwaitShell to keep waiting.`;
};

export const stringOfAwaitShellResult = (_params: BuiltinToolCallParams['AwaitShell'], result: Awaited<BuiltinToolResultType['AwaitShell']>): string => {
	if (result.kind === 'notfound') return result.error!;
	if (result.kind === 'backgrounded') {
		return `${result.result ?? ''}\nReleased to background after ${result.runningForMs}ms.`;
	}
	if (result.matchedPattern) {
		return `${result.result}\nPattern matched after ${result.runningForMs}ms.`;
	}
	if (result.kind === 'done') {
		return `${result.result}\n(exit code ${result.exitCode})`;
	}
	return `${result.result}\nShell still running after ${result.runningForMs}ms.`;
};
