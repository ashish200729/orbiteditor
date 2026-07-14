/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Pure helpers for Cursor-style context compaction. Kept free of workbench/DI dependencies so
// the boundary math (the easy-to-get-wrong part) is unit-testable in isolation.

/** Minimal per-message projection the boundary selector needs. */
export interface CompactionMsgInfo {
	/** Number of characters this message contributes to the LLM payload. */
	sendChars: number;
	/** True for 'user' messages — the only safe points to start the kept tail (no orphaned tool_result). */
	isUserBoundary: boolean;
}

export interface CompactionBoundaryParams {
	messages: CompactionMsgInfo[];
	/** Index to start summarizing from (exclusive of anything kept as the verbatim task head). */
	startIdx: number;
	/** Target size (in chars) of the recent transcript to keep verbatim. */
	targetTailChars: number;
	/** Minimum number of messages that must be summarized for compaction to be worthwhile. */
	minRange: number;
}

/**
 * Choose the index in `messages` where the kept (verbatim) tail begins. Everything in
 * [startIdx, boundary) gets summarized; [boundary, end) is kept as-is.
 *
 * The boundary is always a user message (or null when none qualifies) so the kept tail never
 * begins with an orphaned tool_result whose tool_use was summarized away.
 *
 * Returns null when compaction isn't worthwhile (no user boundary in the recent region, or the
 * range to summarize is smaller than `minRange`).
 */
export function selectCompactionBoundary({ messages, startIdx, targetTailChars, minRange }: CompactionBoundaryParams): number | null {
	const n = messages.length
	if (startIdx < 0 || startIdx >= n) return null

	// Walk backward from the end accumulating chars until we've covered ~targetTailChars.
	let acc = 0
	let boundary = n
	for (let i = n - 1; i > startIdx; i--) {
		acc += messages[i].sendChars
		if (acc >= targetTailChars) { boundary = i; break }
	}

	// Snap the boundary forward to the next user message so the kept tail starts cleanly.
	while (boundary < n && !messages[boundary].isUserBoundary) boundary++

	if (boundary >= n) return null            // no user boundary in the recent region
	if (boundary - startIdx < minRange) return null // not enough to summarize
	return boundary
}
