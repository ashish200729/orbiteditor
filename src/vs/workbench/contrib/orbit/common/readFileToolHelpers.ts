/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { RawToolParamsObj } from './sendLLMMessageTypes.js';

/** Default max lines when the model omits `limit`. */
export const READ_FILE_DEFAULT_LIMIT = 2000;

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
	// Phase 2.15 (H20) fix: reject obvious path-traversal attempts. The Read tool
	// is sandboxed to the workspace by the calling site; this is a defense-in-depth
	// check to refuse `..` segments before we hand the path to the file service.
	// We check the fsPath, which is the canonical path representation; any `..`
	// segments here indicate a request that explicitly tries to escape.
	if (uri.fsPath.includes('..')) {
		// Allow a trailing `..` that is part of a real filename (none of the
		// platforms we support have `..` as a valid character in a filename), but
		// reject any segment whose name is exactly `..`.
		const segments = uri.fsPath.split(/[\\/]+/);
		if (segments.some(seg => seg === '..')) {
			throw new Error(
				`Invalid path: contains ".." segment. Refusing to read outside the workspace.`
			);
		}
	}
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

	return {
		contentLines: allLines.slice(startIdx, endIdx),
		startLineIndex: startIdx,
		endLineIndex: endIdx,
		totalNumLines,
	};
};

/** Format lines as `LINE_NUMBER|LINE_CONTENT` (1-indexed line numbers). */
export const formatNumberedFileLines = (lines: string[], firstLineNumber: number): string => {
	return lines
		.map((line, i) => `${firstLineNumber + i}|${line}`)
		.join('\n');
};
