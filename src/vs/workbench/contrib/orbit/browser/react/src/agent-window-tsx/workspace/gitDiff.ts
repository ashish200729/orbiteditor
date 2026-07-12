/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Minimal unified-diff parser for the Changes panel's inline diff view.
 *
 * We request diffs with full context (`--unified=<big>`), so a hunk usually
 * spans the whole file. The renderer then collapses long runs of unchanged
 * lines into expandable "N unmodified lines" bands — matching the main-window
 * SCM diff. The parser also preserves each hunk's raw text + the file header so
 * a single hunk can be re-emitted as a valid patch for `git apply` (stage/
 * unstage/discard hunk).
 */

export type DiffRowType = 'context' | 'add' | 'del';

export interface DiffRow {
	type: DiffRowType;
	/** 1-based line number in the old file (undefined for pure additions). */
	oldLine?: number;
	/** 1-based line number in the new file (undefined for pure deletions). */
	newLine?: number;
	/** Row text without the leading +/-/space marker. */
	content: string;
}

export interface DiffHunk {
	/** Raw hunk text: the `@@ … @@` line plus its body lines. */
	rawLines: string[];
	rows: DiffRow[];
	oldStart: number;
	newStart: number;
}

export interface ParsedDiff {
	/** Raw header lines up to the first hunk (`diff --git`, `---`, `+++`, …). */
	header: string[];
	hunks: DiffHunk[];
	isBinary: boolean;
	/** True when the diff text was empty (no changes for this scope). */
	isEmpty: boolean;
}

const parseHunkHeader = (line: string): { oldStart: number; newStart: number } | null => {
	// @@ -oldStart,oldCount +newStart,newCount @@ optional section
	const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
	if (!m) { return null; }
	return { oldStart: parseInt(m[1], 10), newStart: parseInt(m[2], 10) };
};

export const parseUnifiedDiff = (diff: string): ParsedDiff => {
	const result: ParsedDiff = { header: [], hunks: [], isBinary: false, isEmpty: false };
	if (!diff || diff.trim().length === 0) {
		result.isEmpty = true;
		return result;
	}
	const lines = diff.split('\n');
	// Drop a trailing empty line produced by the final newline.
	if (lines.length && lines[lines.length - 1] === '') { lines.pop(); }

	let i = 0;
	// Header: everything before the first @@.
	for (; i < lines.length; i++) {
		if (lines[i].startsWith('@@')) { break; }
		if (lines[i].startsWith('Binary files') || lines[i].startsWith('GIT binary patch')) {
			result.isBinary = true;
		}
		result.header.push(lines[i]);
	}

	let current: DiffHunk | null = null;
	let oldLine = 0;
	let newLine = 0;
	for (; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith('@@')) {
			const parsed = parseHunkHeader(line);
			if (!parsed) { continue; }
			current = { rawLines: [line], rows: [], oldStart: parsed.oldStart, newStart: parsed.newStart };
			result.hunks.push(current);
			oldLine = parsed.oldStart;
			newLine = parsed.newStart;
			continue;
		}
		if (!current) { continue; }
		current.rawLines.push(line);

		if (line.startsWith('\\')) {
			// "\ No newline at end of file" — metadata, not a row.
			continue;
		}
		const marker = line[0];
		const content = line.slice(1);
		if (marker === '+') {
			current.rows.push({ type: 'add', newLine: newLine++, content });
		} else if (marker === '-') {
			current.rows.push({ type: 'del', oldLine: oldLine++, content });
		} else {
			// context (leading space) or empty line
			current.rows.push({ type: 'context', oldLine: oldLine++, newLine: newLine++, content });
		}
	}

	if (result.hunks.length === 0 && !result.isBinary) {
		result.isEmpty = true;
	}
	return result;
};

/** Rebuild a standalone patch for one hunk so `git apply` can stage/discard it. */
export const buildHunkPatch = (parsed: ParsedDiff, hunk: DiffHunk): string => {
	const header = parsed.header.filter(l =>
		l.startsWith('diff --git') ||
		l.startsWith('index ') ||
		l.startsWith('--- ') ||
		l.startsWith('+++ ') ||
		l.startsWith('old mode') ||
		l.startsWith('new mode') ||
		l.startsWith('new file mode') ||
		l.startsWith('deleted file mode') ||
		l.startsWith('rename ') ||
		l.startsWith('copy ')
	);
	return [...header, ...hunk.rawLines].join('\n') + '\n';
};

/** Total added / removed line counts across all hunks. */
export const diffStats = (parsed: ParsedDiff): { added: number; removed: number } => {
	let added = 0;
	let removed = 0;
	for (const h of parsed.hunks) {
		for (const r of h.rows) {
			if (r.type === 'add') { added++; }
			else if (r.type === 'del') { removed++; }
		}
	}
	return { added, removed };
};
