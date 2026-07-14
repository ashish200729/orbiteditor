/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js';
import { isABuiltinToolName } from '../../common/prompt/prompts.js';

/**
 * Whether tool params should be normalized (path/content aliasing + snake_case
 * conversion). Only BUILT-IN tools want this — their validators destructure fixed
 * snake_case keys. MCP / unknown tools have arbitrary schemas (e.g. camelCase
 * `maxResults`), so their params must pass through verbatim. When no tool name is
 * available we keep the historical behavior and normalize.
 *
 * `mcpToolNames`, when provided, takes precedence: a real MCP tool with this exact
 * name (e.g. one literally named `read_file`) is never treated as the builtin Read
 * tool, even though `read_file` also resolves to Read as a builtin-name synonym.
 */
const shouldNormalizeForTool = (toolName: string | undefined, mcpToolNames?: Iterable<string>): boolean =>
	toolName === undefined || isABuiltinToolName(toolName, { mcpToolNames });

const PATH_FIELDS = [
	{ field: 'path', target: 'path' },
	{ field: 'uri', target: 'uri' },
	{ field: 'file_path', target: 'path' },
	{ field: 'filePath', target: 'path' },
	{ field: 'target_file', target: 'path' },
	{ field: 'targetFile', target: 'path' },
] as const;
const CONTENT_FIELDS = [
	{ field: 'contents', target: 'contents' },
	{ field: 'content', target: 'contents' },
	{ field: 'old_string', target: 'old_string' },
	{ field: 'oldString', target: 'old_string' },
	{ field: 'new_string', target: 'new_string' },
	{ field: 'newString', target: 'new_string' },
	{ field: 'search_replace_blocks', target: 'search_replace_blocks' },
	{ field: 'searchReplaceBlocks', target: 'search_replace_blocks' },
	{ field: 'new_content', target: 'new_content' },
	{ field: 'newContent', target: 'new_content' },
] as const;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Convert a camelCase or PascalCase key to snake_case. Keys that are already
 * snake_case (or contain no uppercase letters) are returned unchanged so we
 * never double-convert or mangle identifiers like `-B`, `-A`, `-i` that some
 * tools (e.g. Grep) use verbatim.
 *
 * Mirrors the `SnakeCase` mapped type in prompts.ts so the canonical key we
 * produce matches what the validate functions destructure.
 */
const camelToSnakeCase = (key: string): string => {
	if (!key) return key;
	// Leave flags like "-B", "-A", "-i" and already-snake_case keys alone.
	// Also skip anything starting with "-" so ripgrep-style flags are preserved.
	if (!/[A-Z]/.test(key) || key.startsWith('-')) return key;
	// Insert "_" before each uppercase letter, then lowercase. Existing
	// underscores (e.g. "glob_Pattern") are preserved and not doubled.
	return key.replace(/([A-Z])/g, (match, _group: string, offset: number) => {
		const prev = key[offset - 1];
		return prev === '_' ? match.toLowerCase() : `_${match.toLowerCase()}`;
	});
};

/**
 * Convert every top-level key of `parsed` to its snake_case form, preserving
 * values. Keys that are already snake_case pass through untouched. When both a
 * camelCase and a snake_case variant exist in the input, the snake_case value
 * wins (it is what the schema asked for).
 */
const normalizeAllKeysToSnakeCase = (parsed: Record<string, unknown>): Record<string, unknown> => {
	const out: Record<string, unknown> = {};
	// Process already-snake_case keys first so a later camelCase variant cannot
	// overwrite the canonical value. Iteration order is insertion order, so we
	// do two passes to guarantee snake_case wins regardless of input order.
	const keys = Object.keys(parsed);
	// Pass 1: keys that are already snake_case (no conversion needed).
	for (const key of keys) {
		const snake = camelToSnakeCase(key);
		if (snake === key) {
			out[snake] = parsed[key];
		}
	}
	// Pass 2: camelCase keys, only filling in gaps left by snake_case keys.
	for (const key of keys) {
		const snake = camelToSnakeCase(key);
		if (snake !== key && out[snake] === undefined) {
			out[snake] = parsed[key];
		}
	}
	return out;
};

const normalizeParsedParams = (parsed: Record<string, unknown>, toolName?: string, mcpToolNames?: Iterable<string>): RawToolParamsObj => {
	// MCP / unknown tools: pass params through verbatim (their schemas are arbitrary and
	// may legitimately use camelCase). Only built-in tools get aliasing + snake_casing.
	if (!shouldNormalizeForTool(toolName, mcpToolNames)) {
		return { ...parsed } as RawToolParamsObj;
	}

	// First, apply field-specific aliases so path/uri/content get mapped to
	// their canonical targets regardless of casing. These take priority over
	// the generic casing conversion because they may also remap the *target*
	// key name (e.g. filePath -> path).
	let rawParams: RawToolParamsObj = { ...parsed } as RawToolParamsObj;

	// Treat null/undefined target values as "not present" so that an alias
	// source (e.g. file_path) can fill in a target (e.g. path) even when the
	// model explicitly sent `path: null`. Some providers/models emit explicit
	// nulls for optional or mis-typed fields.
	const isMissing = (v: unknown) => v === undefined || v === null;

	for (const { field, target } of PATH_FIELDS) {
		if (isMissing(rawParams[target as keyof RawToolParamsObj]) && Object.prototype.hasOwnProperty.call(parsed, field) && !isMissing(parsed[field])) {
			rawParams[target as keyof RawToolParamsObj] = parsed[field] as string;
		}
	}

	for (const { field, target } of CONTENT_FIELDS) {
		if (isMissing(rawParams[target as keyof RawToolParamsObj]) && Object.prototype.hasOwnProperty.call(parsed, field) && !isMissing(parsed[field])) {
			rawParams[target as keyof RawToolParamsObj] = parsed[field] as string;
		}
	}

	// Drop the alias source keys so we don't send duplicates to the validator.
	for (const { field, target } of [...PATH_FIELDS, ...CONTENT_FIELDS]) {
		if (field !== target) {
			delete (rawParams as Record<string, unknown>)[field];
		}
	}

	// Then, generically convert any remaining camelCase keys to snake_case so
	// custom OpenAI-compatible / Anthropic models that ignore the JSON schema
	// still produce arguments the validate functions can destructure.
	rawParams = normalizeAllKeysToSnakeCase(rawParams as Record<string, unknown>) as RawToolParamsObj;

	return rawParams;
};

export const normalizeToolParams = normalizeParsedParams;

const unescapePartialJsonString = (value: string): string => {
	if (!value) {
		return '';
	}
	try {
		return JSON.parse(`"${value}"`);
	} catch {
		return value
			.replace(/\\n/g, '\n')
			.replace(/\\r/g, '\r')
			.replace(/\\t/g, '\t')
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, '\\');
	}
};

const extractStringFieldFromPartialJson = (
	json: string,
	fieldName: string,
): { value: string; isComplete: boolean } | undefined => {
	const keyPattern = new RegExp(`"${escapeRegExp(fieldName)}"\\s*:\\s*"`);
	const match = keyPattern.exec(json);
	if (!match) {
		return undefined;
	}

	let index = match.index + match[0].length;
	let rawValue = '';
	let isComplete = false;

	while (index < json.length) {
		const char = json[index];
		if (char === '\\') {
			if (index + 1 >= json.length) {
				break;
			}
			rawValue += json[index] + json[index + 1];
			index += 2;
			continue;
		}
		if (char === '"') {
			isComplete = true;
			break;
		}
		rawValue += char;
		index += 1;
	}

	return {
		value: unescapePartialJsonString(rawValue),
		isComplete,
	};
};

/**
 * Try to extract a string field from partial JSON, accepting either the
 * canonical snake_case name or its camelCase variant. Returns the value under
 * the canonical `target` name.
 */
const extractStringFieldAcceptingCasing = (
	json: string,
	target: string,
): { value: string; isComplete: boolean } | undefined => {
	const camelVariant = target.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
	const candidates = target === camelVariant ? [target] : [target, camelVariant];
	for (const candidate of candidates) {
		const extracted = extractStringFieldFromPartialJson(json, candidate);
		if (extracted) {
			return extracted;
		}
	}
	return undefined;
};

export const parsePartialToolParams = (toolParamsStr: string, toolName?: string, mcpToolNames?: Iterable<string>): {
	rawParams: RawToolParamsObj;
	doneParams: string[];
	isDone: boolean;
} => {
	const trimmed = toolParamsStr.trim();
	if (!trimmed) {
		return { rawParams: {}, doneParams: [], isDone: false };
	}

	try {
		const parsed = JSON.parse(trimmed);
		if (typeof parsed === 'object' && parsed !== null) {
			const rawParams = normalizeParsedParams(parsed as Record<string, unknown>, toolName, mcpToolNames);
			return {
				rawParams,
				doneParams: Object.keys(rawParams),
				isDone: true,
			};
		}
	} catch {
		// fall through to partial extraction
	}

	// Partial-JSON progressive extraction relies on the built-in path/content field
	// aliases, so skip it for MCP / unknown tools — their params are only surfaced once
	// the JSON fully parses (verbatim, above).
	if (!shouldNormalizeForTool(toolName, mcpToolNames)) {
		return { rawParams: {}, doneParams: [], isDone: false };
	}

	const rawParams: RawToolParamsObj = {};
	const doneParams: string[] = [];

	for (const { field, target } of PATH_FIELDS) {
		const extracted = extractStringFieldAcceptingCasing(trimmed, field);
		if (!extracted) {
			continue;
		}
		rawParams[target as keyof RawToolParamsObj] = extracted.value;
		if (extracted.isComplete) {
			doneParams.push(target);
		}
		break;
	}

	for (const { field, target } of CONTENT_FIELDS) {
		const extracted = extractStringFieldAcceptingCasing(trimmed, field);
		if (!extracted) {
			continue;
		}
		rawParams[target as keyof RawToolParamsObj] = extracted.value;
		if (extracted.isComplete) {
			doneParams.push(target);
		}
	}

	return {
		rawParams,
		doneParams,
		isDone: false,
	};
};
