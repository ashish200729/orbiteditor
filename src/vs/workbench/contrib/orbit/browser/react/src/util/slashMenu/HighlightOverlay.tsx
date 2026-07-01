/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, MutableRefObject } from 'react';
import { BUILTIN_COMMANDS } from '../../../../../common/slashCommands/builtinCommands.js';
import { listSkills, onSkillsChanged } from '../../../../../common/skillRegistry.js';
import { buildSlashSegments } from './slashTokenSegments.js';
import { VOID_SLASH_TOKEN_MIRROR, VOID_SLASH_TOKEN_TEXT, VOID_SLASH_TOKEN_TEXT_MUTED } from './cssClasses.js';

/**
 * Computed-style properties copied from the textarea so the mirror wraps/positions identically.
 */
const COPIED_STYLE_PROPS = [
	'boxSizing', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight',
	'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent', 'tabSize', 'textAlign',
	'whiteSpace', 'overflowWrap', 'wordBreak', 'wordWrap', 'direction', 'unicodeBidi',
	'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
	'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
	'width', 'minHeight',
] as const;

/**
 * Paints the chat textarea's visible text (including amber `/tokens`). The textarea glyphs
 * are transparent so this mirror is what the user sees; the textarea still owns input/caret.
 */
export const HighlightOverlay = ({ textareaRef, text, mirrorClassName }: {
	textareaRef: MutableRefObject<HTMLTextAreaElement | null>;
	text: string;
	mirrorClassName?: string;
}) => {
	const overlayRef = useRef<HTMLDivElement | null>(null);

	const [skillNames, setSkillNames] = useState<string[]>(() => listSkills().filter(s => s.enabled).map(s => s.name));
	useEffect(() => onSkillsChanged(() => setSkillNames(listSkills().filter(s => s.enabled).map(s => s.name))), []);
	const validNames = useMemo(
		() => new Set<string>([...BUILTIN_COMMANDS.map(c => c.name), ...skillNames]),
		[skillNames],
	);

	const syncMetrics = () => {
		const ta = textareaRef.current;
		const ov = overlayRef.current;
		if (!ta || !ov) return;
		try {
			const cs = getComputedStyle(ta);
			for (const prop of COPIED_STYLE_PROPS) (ov.style as any)[prop] = cs[prop as any];
			ov.style.height = `${ta.offsetHeight}px`;
		} catch { /* decorative */ }
	};

	const syncScroll = () => {
		const ta = textareaRef.current;
		const ov = overlayRef.current;
		if (ta && ov) {
			ov.scrollTop = ta.scrollTop;
			ov.scrollLeft = ta.scrollLeft;
		}
	};

	useLayoutEffect(() => {
		const ta = textareaRef.current;
		if (!ta) return;

		syncMetrics();
		syncScroll();

		ta.addEventListener('scroll', syncScroll);
		let ro: ResizeObserver | undefined;
		try {
			ro = new ResizeObserver(() => { syncMetrics(); syncScroll(); });
			ro.observe(ta);
		} catch { /* ResizeObserver unavailable */ }

		const fonts = (document as any).fonts;
		const onFonts = () => syncMetrics();
		try { fonts?.addEventListener?.('loadingdone', onFonts); } catch { /* ignore */ }

		return () => {
			ta.removeEventListener('scroll', syncScroll);
			ro?.disconnect();
			try { fonts?.removeEventListener?.('loadingdone', onFonts); } catch { /* ignore */ }
		};
	}, [textareaRef, mirrorClassName]);

	useLayoutEffect(() => {
		syncMetrics();
		syncScroll();
	}, [text, textareaRef]);

	const segments = useMemo(() => buildSlashSegments(text, validNames), [text, validNames]);

	return (
		<div
			ref={overlayRef}
			aria-hidden
			className={`absolute inset-0 z-0 pointer-events-none overflow-hidden ${VOID_SLASH_TOKEN_MIRROR} text-void-fg-1 ${mirrorClassName ?? ''}`}
			style={{ background: 'transparent', borderColor: 'transparent', borderStyle: 'solid' }}
		>
			{segments.map((seg, i) => {
				if (seg.kind === 'plain') return <span key={i}>{seg.text}</span>;
				if (seg.kind === 'valid') return <span key={i} className={VOID_SLASH_TOKEN_TEXT}>{seg.text}</span>;
				return <span key={i} className={`${VOID_SLASH_TOKEN_TEXT} ${VOID_SLASH_TOKEN_TEXT_MUTED}`}>{seg.text}</span>;
			})}
		</div>
	);
};
