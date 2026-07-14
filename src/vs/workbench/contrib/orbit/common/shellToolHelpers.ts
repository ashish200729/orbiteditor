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
	if (pattern.length > 1024) {
		throw new Error(`Invalid ${argName}: pattern is too long (${pattern.length} chars, max 1024).`);
	}
	// Block nested quantifiers (e.g. "(a+)+", "(\w*)*") — a classic ReDoS pattern.
	if (/\([^)]*[+*][^)]*\)[+*]/.test(pattern) || /\([^)]*[+*][^)]*\)\{/.test(pattern)) {
		throw new Error(`Invalid ${argName}: nested quantifiers (e.g. "(a+)+") are not allowed (ReDoS risk).`);
	}
	// Block alternation-based catastrophic patterns: many alternatives inside a
	// quantifier (e.g. "(a|b|c|d|e|f)+", "(a|aa)*") cause O(2^n) backtracking.
	// A group with 3+ alternations followed by a quantifier is a strong heuristic
	// for alternation-based ReDoS.
	if (/\([^)]+\|[^)]+\|[^)]*\)[*+]/.test(pattern) || /\([^)]+\|[^)]+\|[^)]*\)\{/.test(pattern)) {
		throw new Error(`Invalid ${argName}: alternation with 3+ branches inside a quantifier is not allowed (ReDoS risk).`);
	}
	try {
		// Matches the flags the terminal service uses to run the pattern.
		void new RegExp(pattern, 'm');
	} catch (e) {
		throw new Error(`Invalid ${argName}: not a valid regular expression. ${e instanceof Error ? e.message : String(e)}`);
	}
};

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

/** Escape a path for use inside a double-quoted shell string. */
export const escapeShellPath = (path: string): string => {
	if (/^[A-Za-z0-9_./@-]+$/.test(path)) {
		return path;
	}
	return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

/** Prefix cd when the requested cwd differs from the shell's current cwd. */
export const buildShellCommandWithCwd = (command: string, workingDirectory: string | null, currentWorkingDirectory: string | null): { command: string; workingDirectory: string | null } => {
	if (!workingDirectory || workingDirectory === currentWorkingDirectory) {
		return { command, workingDirectory: currentWorkingDirectory };
	}
	const cdTarget = escapeShellPath(workingDirectory);
	return { command: `cd ${cdTarget} && ${command}`, workingDirectory };
};

export const stringOfShellResult = (_params: BuiltinToolCallParams['Shell'], result: Awaited<BuiltinToolResultType['Shell']>): string => {
	if (result.kind === 'backgrounded') {
		return `Command sent in background. shell_id="${result.shellId}"${result.pid ? `, pid=${result.pid}` : ''}. Use AwaitShell with this shell_id to check status, or let notify_on_output wake you.`;
	}
	const output = result.result ?? '';
	if (result.kind === 'done') {
		return `${output}\n(exit code ${result.exitCode})`;
	}
	return `${output}\nCommand did not finish within ${result.elapsedMs}ms. shell_id="${result.shellId}" is still alive. Use AwaitShell to keep waiting.`;
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
