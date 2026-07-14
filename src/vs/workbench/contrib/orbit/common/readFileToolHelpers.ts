/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { RawToolParamsObj } from './sendLLMMessageTypes.js';

/** Default max lines when the model omits `limit`. */
export const READ_FILE_DEFAULT_LIMIT = 2000;

/**
 * Refuse to read a whole file larger than this. A 20MB single-line minified
 * file would otherwise be split by line only and dumped entirely into context.
 */
export const READ_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Refuse to base64 an image larger than this straight into context. */
export const READ_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Refuse to extract text from a PDF larger than this. */
export const READ_PDF_MAX_BYTES = 20 * 1024 * 1024;

/** Truncate any single line longer than this many characters. */
export const READ_FILE_MAX_LINE_LENGTH = 2000;

/** Cap on total characters returned from a single Read call. */
export const READ_FILE_MAX_TOTAL_CHARS = 100_000;

/** Number of leading bytes sniffed for NUL bytes to detect binary files. */
const BINARY_SNIFF_BYTES = 8192;

/**
 * Detect binary content by sniffing the leading bytes for a NUL byte. Text
 * files (including UTF-8/UTF-16 with a BOM) do not contain NUL in normal
 * content, whereas .wasm/.node/.so/.bin/.ico do — reading those as text
 * produces garbage.
 */
export const looksLikeBinary = (bytes: Uint8Array): boolean => {
	const end = Math.min(bytes.length, BINARY_SNIFF_BYTES);
	for (let i = 0; i < end; i++) {
		if (bytes[i] === 0) {
			return true;
		}
	}
	return false;
};

export const READ_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

export type ReadImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export const imageMimeFromExtension = (ext: string): ReadImageMime | undefined => {
	switch (ext) {
		case 'jpg':
		case 'jpeg':
			return 'image/jpeg';
		case 'png':
			return 'image/png';
		case 'gif':
			return 'image/gif';
		case 'webp':
			return 'image/webp';
		default:
			return undefined;
	}
};

export const fileExtensionFromUri = (uri: URI): string => {
	const match = uri.path.toLowerCase().match(/\.([a-z0-9]+)$/);
	return match?.[1] ?? '';
};

export type ReadToolValidatedParams = {
	uri: URI;
	offset: number;
	limit: number;
};

const isFalsy = (value: unknown) => !value || value === 'null' || value === 'undefined';

const parseInteger = (value: unknown, defaultValue: number): number => {
	if (typeof value === 'number' && Number.isInteger(value)) {
		return value;
	}
	if (isFalsy(value)) {
		return defaultValue;
	}
	if (typeof value === 'string') {
		const parsed = Number.parseInt(value, 10);
		if (Number.isInteger(parsed)) {
			return parsed;
		}
	}
	return defaultValue;
};

/**
 * Defense-in-depth against path-traversal: reject any URI whose fsPath contains
 * a `..` segment. The calling site is sandboxed to the workspace, but this
 * refuses an explicit escape attempt before we hand the path to the file
 * service. A `..` that is merely a literal substring of a real filename (e.g.
 * `version..1.txt`) is allowed — only a segment whose name is exactly `..` is
 * rejected. Shared by the Read, Write and StrReplace validators.
 */
export const assertNoParentTraversal = (uri: URI): void => {
	if (!uri.fsPath.includes('..')) {
		return;
	}
	const segments = uri.fsPath.split(/[\\/]+/);
	if (segments.some(seg => seg === '..')) {
		throw new Error(
			`Invalid path: contains ".." segment. Refusing to access outside the workspace.`
		);
	}
};

export const validateReadToolParams = (params: RawToolParamsObj): ReadToolValidatedParams => {
	const pathRaw = params.path ?? params.uri;
	if (pathRaw === null || pathRaw === undefined || pathRaw === '') {
		const receivedKeys = Object.keys(params).filter(k => params[k] !== undefined && params[k] !== null);
		throw new Error(`Invalid LLM output: path was null or missing. Received params: {${receivedKeys.join(', ')}}. The "path" parameter is required and must be an absolute file path string.`);
	}
	if (typeof pathRaw !== 'string') {
		throw new Error(`Invalid LLM output format: path must be a string, but its type is "${typeof pathRaw}". Full value: ${JSON.stringify(pathRaw)}.`);
	}

	const uri = URI.file(pathRaw);
	assertNoParentTraversal(uri);
	const offset = parseInteger(params.offset, 0);
	const limitRaw = params.limit;
	const limit = isFalsy(limitRaw) ? READ_FILE_DEFAULT_LIMIT : parseInteger(limitRaw, READ_FILE_DEFAULT_LIMIT);

	if (!Number.isInteger(limit) || limit < 1) {
		throw new Error(`Invalid 'limit': must be a positive integer`);
	}

	return { uri, offset, limit };
};

export type SliceFileLinesResult = {
	contentLines: string[];
	startLineIndex: number;
	endLineIndex: number;
	totalNumLines: number;
};

/**
 * Slice file lines using Read-tool offset/limit semantics.
 * - offset 0 (or omitted) → start at line 1
 * - positive offset → 1-indexed start line
 * - negative offset → count backwards from end (-1 = last line)
 */
export const sliceFileLines = (rawContent: string, offset: number, limit: number): SliceFileLinesResult => {
	if (rawContent.length === 0) {
		return { contentLines: [], startLineIndex: 0, endLineIndex: 0, totalNumLines: 0 };
	}

	const allLines = rawContent.split('\n');
	const totalNumLines = allLines.length;

	const startIdx = offset < 0
		? Math.max(0, totalNumLines + offset)
		: Math.max(0, offset === 0 ? 0 : offset - 1);
	const endIdx = Math.min(totalNumLines, startIdx + limit);

	// Cap per-line length and total returned characters so a minified or
	// pathological file cannot dump megabytes into the model context even when
	// the line count is within `limit`.
	const contentLines: string[] = [];
	let totalChars = 0;
	let lastIncludedIdx = startIdx;
	for (let i = startIdx; i < endIdx; i++) {
		let line = allLines[i];
		if (line.length > READ_FILE_MAX_LINE_LENGTH) {
			line = `${line.slice(0, READ_FILE_MAX_LINE_LENGTH)}… [line truncated: ${line.length} chars total]`;
		}
		// Always include at least the first line so we never return an empty
		// slice for a single over-long line.
		if (contentLines.length > 0 && totalChars + line.length > READ_FILE_MAX_TOTAL_CHARS) {
			break;
		}
		contentLines.push(line);
		totalChars += line.length + 1;
		lastIncludedIdx = i + 1;
	}

	return {
		contentLines,
		startLineIndex: startIdx,
		endLineIndex: lastIncludedIdx,
		totalNumLines,
	};
};

/** Format lines as `LINE_NUMBER|LINE_CONTENT` (1-indexed line numbers). */
export const formatNumberedFileLines = (lines: string[], firstLineNumber: number): string => {
	return lines
		.map((line, i) => `${firstLineNumber + i}|${line}`)
		.join('\n');
};
