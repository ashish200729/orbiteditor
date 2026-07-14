/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { diffLines } from '../../../../out/diff/index.js';

export type UnifiedDiffLineType = 'context' | 'added' | 'removed';

export interface UnifiedDiffLine {
	type: UnifiedDiffLineType;
	content: string;
}

const splitDiffValueIntoLines = (value: string): string[] => {
	const rawLines = value.split('\n');
	if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
		rawLines.pop();
	}
	return rawLines;
};

export const computeUnifiedDiffLines = (oldStr: string, newStr: string): UnifiedDiffLine[] => {
	const changes = diffLines(oldStr, newStr);
	const result: UnifiedDiffLine[] = [];

	for (const change of changes) {
		const type: UnifiedDiffLineType = change.added ? 'added' : change.removed ? 'removed' : 'context';
		for (const line of splitDiffValueIntoLines(change.value)) {
			result.push({ type, content: line });
		}
	}

	return result;
};

/** Cheap streaming view of a str-replace/rewrite: the old block as removed lines followed by the
 * (growing) new block as added lines. Running the real LCS `diffLines` on every streamed chunk is
 * O(n²) across the stream; this is a single linear split per chunk, and the real diff runs once
 * when the edit completes. */
export const computeStreamingDiffLines = (oldStr: string, newStr: string): UnifiedDiffLine[] => {
	const result: UnifiedDiffLine[] = [];
	if (oldStr.length > 0) {
		for (const line of splitDiffValueIntoLines(oldStr)) {
			result.push({ type: 'removed', content: line });
		}
	}
	if (newStr.length > 0) {
		for (const line of splitDiffValueIntoLines(newStr)) {
			result.push({ type: 'added', content: line });
		}
	}
	return result;
};

/** Upper-bound +/- counts without running the LCS diff — used while an edit is still streaming.
 * Converges to the exact `computeDiffStats` result when the edit completes. */
export const estimateDiffStats = (oldStr: string, newStr: string): { additions: number; deletions: number } => {
	const countLines = (s: string): number => s.length === 0 ? 0 : splitDiffValueIntoLines(s).length;
	return { additions: countLines(newStr), deletions: countLines(oldStr) };
};

export const computeDiffStats = (oldStr: string, newStr: string): { additions: number; deletions: number } => {
	const changes = diffLines(oldStr, newStr);
	let additions = 0;
	let deletions = 0;

	for (const change of changes) {
		const count = change.count ?? splitDiffValueIntoLines(change.value).length;
		if (change.added) {
			additions += count;
		}
		if (change.removed) {
			deletions += count;
		}
	}

	return { additions, deletions };
};

export const buildDiffModelContent = (lines: UnifiedDiffLine[]): string => {
	return lines.map(line => line.content).join('\n');
};
