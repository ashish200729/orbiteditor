/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { slashTokenRegex } from '../../../../../common/slashCommands/slashTokens.js';

export type SlashSegmentKind = 'plain' | 'valid' | 'unknown';

export type SlashSegment = { text: string; kind: SlashSegmentKind };

/**
 * Split `text` into plain runs and `/token` spans. Tokens matching `validNames` are `valid`;
 * tokens matching the slash pattern but not in the set are `unknown`.
 */
export const buildSlashSegments = (text: string, validNames: Set<string>): SlashSegment[] => {
	const re = slashTokenRegex();
	const out: SlashSegment[] = [];
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const lead = m[1] ?? '';
		const name = m[2];
		const tokenStart = m.index + lead.length;
		const tokenEnd = tokenStart + 1 + name.length;
		if (tokenStart > last) out.push({ text: text.slice(last, tokenStart), kind: 'plain' });
		out.push({
			text: text.slice(tokenStart, tokenEnd),
			kind: validNames.has(name) ? 'valid' : 'unknown',
		});
		last = tokenEnd;
	}
	if (last < text.length) out.push({ text: text.slice(last), kind: 'plain' });
	return out;
};
