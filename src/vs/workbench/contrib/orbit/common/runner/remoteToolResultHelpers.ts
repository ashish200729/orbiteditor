/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import type { BuiltinToolCallParams, BuiltinToolResultType, GrepFileResult, ToolCallParams, ToolName } from '../toolsServiceTypes.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);

/** Stable key for “remember this approval” — scoped to identical tool + args, not the whole tool class. */
export const remoteApprovalFingerprint = (toolName: string, args: Record<string, unknown>): string => {
	const keys = Object.keys(args).sort();
	const normalized: Record<string, unknown> = {};
	for (const key of keys) {
		normalized[key] = args[key];
	}
	return `${toolName}:${JSON.stringify(normalized)}`;
};

const fileUriFromArgs = (args: Record<string, unknown>, ...keys: string[]): URI => {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === 'string' && value.trim()) {
			return URI.file(value.trim());
		}
		if (isRecord(value) && typeof value.path === 'string') {
			return URI.file(value.path);
		}
		if (isRecord(value) && typeof value.fsPath === 'string') {
			return URI.file(value.fsPath);
		}
	}
	return URI.file('/');
};

/** Map runner snake_case tool args to the shapes expected by local chat renderers. */
export const normalizeRemoteToolStartParams = (
	name: ToolName,
	args: Record<string, unknown>,
): ToolCallParams<ToolName> => {
	switch (name) {
		case 'Shell':
			return {
				command: String(args.command ?? ''),
				workingDirectory: args.working_directory !== null && args.working_directory !== undefined ? String(args.working_directory) : null,
				blockUntilMs: Number(args.block_until_ms) || 30_000,
				description: args.description !== null && args.description !== undefined ? String(args.description) : null,
				notifyOnOutput: null,
				requestSmartModeApproval: false,
				shellId: typeof args.shell_id === 'string' ? args.shell_id : '',
			} satisfies BuiltinToolCallParams['Shell'];
		case 'AwaitShell':
			return {
				shellId: typeof args.shell_id === 'string' ? args.shell_id : null,
				blockUntilMs: Number(args.block_until_ms) || 0,
				pattern: typeof args.pattern === 'string' ? args.pattern : null,
			} satisfies BuiltinToolCallParams['AwaitShell'];
		case 'Glob':
			return {
				globPattern: String(args.glob_pattern ?? args.globPattern ?? ''),
				targetDirectory: args.target_directory || args.targetDirectory
					? URI.file(String(args.target_directory ?? args.targetDirectory))
					: null,
			} satisfies BuiltinToolCallParams['Glob'];
		case 'Grep':
			return {
				pattern: String(args.pattern ?? ''),
				path: args.path ? URI.file(String(args.path)) : null,
				glob: args.glob ? String(args.glob) : null,
				outputMode: 'content',
				beforeContext: 0,
				afterContext: 0,
				caseInsensitive: false,
				type: null,
				headLimit: null,
				offset: 0,
				multiline: false,
			} satisfies BuiltinToolCallParams['Grep'];
		case 'Read':
			return {
				uri: fileUriFromArgs(args, 'path', 'uri'),
				offset: Number(args.offset) || 1,
				limit: Number(args.limit) || 2000,
			} satisfies BuiltinToolCallParams['Read'];
		case 'Write':
			return {
				path: fileUriFromArgs(args, 'path', 'uri'),
				contents: String(args.contents ?? ''),
			} satisfies BuiltinToolCallParams['Write'];
		case 'StrReplace':
			return {
				path: fileUriFromArgs(args, 'path', 'uri'),
				oldString: String(args.old_string ?? args.oldString ?? ''),
				newString: String(args.new_string ?? args.newString ?? ''),
				replaceAll: args.replace_all === true || args.replaceAll === true,
			} satisfies BuiltinToolCallParams['StrReplace'];
		case 'TodoWrite': {
			const todos = Array.isArray(args.todos) ? args.todos : [];
			return {
				todos: todos.map((todo, index) => {
					const entry = isRecord(todo) ? todo : {};
					return {
						id: String(entry.id ?? `todo-${index}`),
						content: String(entry.content ?? ''),
						status: (entry.status === 'completed' || entry.status === 'in_progress' || entry.status === 'cancelled'
							? entry.status
							: 'pending') as 'pending' | 'in_progress' | 'completed' | 'cancelled',
					};
				}),
				merge: args.merge === true,
			} satisfies BuiltinToolCallParams['TodoWrite'];
		}
		default:
			return args as ToolCallParams<ToolName>;
	}
};

const pathToUri = (path: string): URI => {
	const trimmed = path.trim();
	if (!trimmed || trimmed === '(no matches)') {
		return URI.file('/');
	}
	return URI.file(trimmed.startsWith('/') ? trimmed : `/${trimmed}`);
};

const isGlobStructuredResult = (value: unknown): value is BuiltinToolResultType['Glob'] =>
	isRecord(value) && Array.isArray(value.uris);

const isGrepStructuredResult = (value: unknown): value is BuiltinToolResultType['Grep'] =>
	isRecord(value) && Array.isArray(value.results);

const isReadStructuredResult = (value: unknown): value is BuiltinToolResultType['Read'] =>
	isRecord(value) && typeof value.kind === 'string';

/**
 * Runner Glob tools return newline-separated paths. Local Glob cards expect `{ uris, … }`.
 */
export const remoteGlobResultFromOutput = (
	output: string,
	structured?: unknown,
): BuiltinToolResultType['Glob'] => {
	if (isGlobStructuredResult(structured)) {
		return structured;
	}
	const lines = output
		.split('\n')
		.map(line => line.trim())
		.filter(line => line && line !== '(no matches)');
	const uris = lines.map(pathToUri);
	return {
		uris,
		hasNextPage: false,
		totalMatches: uris.length,
		mtimeSortTruncated: false,
	};
};

/**
 * Runner Grep tools return ripgrep-style `path:line:text` lines. Local Grep cards expect grouped results.
 */
export const remoteGrepResultFromOutput = (
	output: string,
	structured?: unknown,
): BuiltinToolResultType['Grep'] => {
	if (isGrepStructuredResult(structured)) {
		return structured;
	}
	const trimmed = output.trim();
	if (!trimmed || trimmed === '(no matches)') {
		return {
			output: trimmed === '(no matches)' ? trimmed : '',
			results: [],
			totalMatchCount: 0,
			shownMatchCount: 0,
			totalFileCount: 0,
			shownFileCount: 0,
			truncated: false,
			outputMode: 'content',
		};
	}
	const fileMap = new Map<string, GrepFileResult>();
	let totalMatches = 0;
	for (const line of trimmed.split('\n')) {
		if (!line) { continue; }
		const match = line.match(/^(.+?):(\d+):(.*)$/);
		if (!match) { continue; }
		const [, filePath, lineNumber, text] = match;
		const uri = pathToUri(filePath);
		let fileResult = fileMap.get(filePath);
		if (!fileResult) {
			fileResult = { uri, matchCount: 0, lines: [] };
			fileMap.set(filePath, fileResult);
		}
		fileResult.matchCount++;
		fileResult.lines!.push({
			lineNumber: Number(lineNumber),
			text,
			isMatch: true,
		});
		totalMatches++;
	}
	const results = [...fileMap.values()];
	return {
		output: trimmed,
		results,
		totalMatchCount: totalMatches,
		shownMatchCount: totalMatches,
		totalFileCount: results.length,
		shownFileCount: results.length,
		truncated: trimmed.includes('[tool output truncated'),
		outputMode: 'content',
	};
};

/**
 * Runner Read returns plain file text. Local Read cards expect `{ kind:'text', fileContents, … }`.
 * On failure, return a string so the error header path can display it.
 */
export const remoteReadResultFromOutput = (
	output: string,
	params: BuiltinToolCallParams['Read'] | undefined,
	succeeded: boolean,
	error?: string,
): BuiltinToolResultType['Read'] | string => {
	if (!succeeded) {
		return error || output || 'Read failed';
	}
	if (isReadStructuredResult(output as unknown)) {
		return output as unknown as BuiltinToolResultType['Read'];
	}
	const fileContents = output;
	const lines = fileContents.length === 0 ? [] : fileContents.split('\n');
	const firstLineNumber = Math.max(1, Number(params?.offset) || 1);
	return {
		kind: 'text',
		fileContents,
		totalNumLines: firstLineNumber + Math.max(lines.length, 1) - 1,
		firstLineNumber,
	};
};
