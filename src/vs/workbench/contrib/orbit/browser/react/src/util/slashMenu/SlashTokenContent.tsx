/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useMemo, useState } from 'react';
import { BUILTIN_COMMANDS } from '../../../../../common/slashCommands/builtinCommands.js';
import { listSkills, onSkillsChanged } from '../../../../../common/skillRegistry.js';
import { buildSlashSegments } from './slashTokenSegments.js';
import { VOID_SLASH_TOKEN_TEXT, VOID_SLASH_TOKEN_TEXT_MUTED } from './cssClasses.js';

/** Renders chat message text with amber `/token` coloring (user message bubbles). */
export const SlashTokenContent = ({ text, className }: { text: string; className?: string }) => {
	const [skillNames, setSkillNames] = useState<string[]>(() => listSkills().filter(s => s.enabled).map(s => s.name));
	useEffect(() => onSkillsChanged(() => setSkillNames(listSkills().filter(s => s.enabled).map(s => s.name))), []);

	const validNames = useMemo(
		() => new Set<string>([...BUILTIN_COMMANDS.map(c => c.name), ...skillNames]),
		[skillNames],
	);

	const segments = useMemo(() => buildSlashSegments(text, validNames), [text, validNames]);

	return (
		<span className={className}>
			{segments.map((seg, i) => {
				if (seg.kind === 'plain') return <span key={i}>{seg.text}</span>;
				if (seg.kind === 'valid') return <span key={i} className={VOID_SLASH_TOKEN_TEXT}>{seg.text}</span>;
				return <span key={i} className={`${VOID_SLASH_TOKEN_TEXT} ${VOID_SLASH_TOKEN_TEXT_MUTED}`}>{seg.text}</span>;
			})}
		</span>
	);
};
