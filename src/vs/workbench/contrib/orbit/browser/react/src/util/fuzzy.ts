/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

// Leaf module (no React / component imports) for the subsequence matcher + scorer shared by
// the chat input's "@" menu and the "/" slash menu. Kept standalone so neither menu's module
// graph drags in the other (avoids an import cycle through inputs.tsx).

export const isSubsequence = (text: string, pattern: string): boolean => {

	text = text.toLowerCase()
	pattern = pattern.toLowerCase()

	if (pattern === '') return true;
	if (text === '') return false;
	if (pattern.length > text.length) return false;

	const seq: boolean[][] = Array(pattern.length + 1)
		.fill(null)
		.map(() => Array(text.length + 1).fill(false));

	for (let j = 0; j <= text.length; j++) {
		seq[0][j] = true;
	}

	for (let i = 1; i <= pattern.length; i++) {
		for (let j = 1; j <= text.length; j++) {
			if (pattern[i - 1] === text[j - 1]) {
				seq[i][j] = seq[i - 1][j - 1];
			} else {
				seq[i][j] = seq[i][j - 1];
			}
		}
	}
	return seq[pattern.length][text.length];
};


export const scoreSubsequence = (text: string, pattern: string): number => {
	if (pattern === '') return 0;

	text = text.toLowerCase();
	pattern = pattern.toLowerCase();

	const n = text.length;
	const m = pattern.length;

	let maxConsecutive = 0;

	for (let i = 0; i < n; i++) {
		let consecutiveCount = 0;
		for (let j = 0; j < m; j++) {
			if (i + j < n && text[i + j] === pattern[j]) {
				consecutiveCount++;
			} else {
				break;
			}
		}
		maxConsecutive = Math.max(maxConsecutive, consecutiveCount);
	}

	return maxConsecutive;
}
