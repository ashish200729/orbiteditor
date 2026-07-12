/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, MutableRefObject } from 'react';
import { BUILTIN_COMMANDS } from '../../../../../common/slashCommands/builtinCommands.js';
import { listSkills, onSkillsChanged } from '../../../../../common/skillRegistry.js';
import { buildSlashSegments, SlashSegment } from './slashTokenSegments.js';
import { getConnectedDocument, getConnectedWindow } from '../helpers.js';
import {
	VOID_SLASH_TOKEN_MIRROR,
	VOID_SLASH_TOKEN_MIRROR_SELECTION,
	VOID_SLASH_TOKEN_TEXT,
	VOID_SLASH_TOKEN_TEXT_MUTED,
} from './cssClasses.js';

/**
 * Font/layout properties copied from the textarea so the mirror wraps identically.
 * Width/height are set separately from clientWidth/clientHeight (scrollbar-aware).
 */
const COPIED_STYLE_PROPS = [
	'boxSizing', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight',
	'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent', 'tabSize', 'textAlign',
	'whiteSpace', 'overflowWrap', 'wordBreak', 'wordWrap', 'direction', 'unicodeBidi',
	'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
	'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
] as const;

type SelRange = { start: number; end: number };

type MirrorPiece = {
	text: string;
	kind: SlashSegment['kind'];
	selected: boolean;
};

/** Split slash segments across the current selection so each piece can be styled independently. */
const buildMirrorPieces = (segments: SlashSegment[], sel: SelRange | null): MirrorPiece[] => {
	if (!sel || sel.start === sel.end) {
		return segments.map(s => ({ text: s.text, kind: s.kind, selected: false }));
	}

	const selStart = Math.min(sel.start, sel.end);
	const selEnd = Math.max(sel.start, sel.end);
	const out: MirrorPiece[] = [];
	let offset = 0;

	for (const seg of segments) {
		const segStart = offset;
		const segEnd = offset + seg.text.length;
		offset = segEnd;

		if (segEnd <= selStart || segStart >= selEnd) {
			out.push({ text: seg.text, kind: seg.kind, selected: false });
			continue;
		}

		if (segStart < selStart) {
			out.push({ text: seg.text.slice(0, selStart - segStart), kind: seg.kind, selected: false });
		}
		out.push({
			text: seg.text.slice(Math.max(0, selStart - segStart), Math.min(seg.text.length, selEnd - segStart)),
			kind: seg.kind,
			selected: true,
		});
		if (segEnd > selEnd) {
			out.push({ text: seg.text.slice(selEnd - segStart), kind: seg.kind, selected: false });
		}
	}

	return out;
};

const tokenClassName = (kind: SlashSegment['kind']): string | undefined => {
	if (kind === 'valid') return VOID_SLASH_TOKEN_TEXT;
	if (kind === 'unknown') return `${VOID_SLASH_TOKEN_TEXT} ${VOID_SLASH_TOKEN_TEXT_MUTED}`;
	return undefined;
};

/**
 * Paints the chat textarea's visible text (including amber `/tokens` and selection).
 * The textarea glyphs stay fully transparent — including native ::selection — so Chromium
 * never double-paints or mis-shapes selection bars on transparent fill. The textarea still
 * owns input, caret, and scroll; this mirror is paint-only.
 */
export const HighlightOverlay = ({ textareaRef, text, mirrorClassName }: {
	textareaRef: MutableRefObject<HTMLTextAreaElement | null>;
	text: string;
	mirrorClassName?: string;
}) => {
	const overlayRef = useRef<HTMLDivElement | null>(null);
	const scrollRafRef = useRef(0);
	const selectingRef = useRef(false);

	const [skillNames, setSkillNames] = useState<string[]>(() => listSkills().filter(s => s.enabled).map(s => s.name));
	const [sel, setSel] = useState<SelRange>({ start: 0, end: 0 });

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
			const cs = getConnectedWindow(ta).getComputedStyle(ta);
			for (const prop of COPIED_STYLE_PROPS) {
				(ov.style as any)[prop] = cs[prop as any];
			}
			// clientWidth/Height exclude the scrollbar so wrap + scrollport match the textarea.
			ov.style.width = `${ta.clientWidth}px`;
			ov.style.height = `${ta.clientHeight}px`;
			ov.style.borderStyle = 'solid';
			ov.style.borderColor = 'transparent';
			ov.style.background = 'transparent';
		} catch { /* decorative */ }
	};

	const syncScroll = () => {
		const ta = textareaRef.current;
		const ov = overlayRef.current;
		if (!ta || !ov) return;
		if (ov.scrollTop !== ta.scrollTop) ov.scrollTop = ta.scrollTop;
		if (ov.scrollLeft !== ta.scrollLeft) ov.scrollLeft = ta.scrollLeft;
	};

	const scheduleScrollSync = () => {
		if (scrollRafRef.current) return;
		scrollRafRef.current = requestAnimationFrame(() => {
			scrollRafRef.current = 0;
			syncScroll();
		});
	};

	const readSelection = () => {
		const ta = textareaRef.current;
		if (!ta) return;
		const start = ta.selectionStart ?? 0;
		const end = ta.selectionEnd ?? 0;
		setSel(prev => (prev.start === start && prev.end === end ? prev : { start, end }));
	};

	useLayoutEffect(() => {
		const ta = textareaRef.current;
		if (!ta) return;
		// Document the textarea is painted in (pop-out-safe): selectionchange/mouse listeners
		// and activeElement must be read from it, not the global (main-window) document.
		const doc = getConnectedDocument(ta);

		syncMetrics();
		syncScroll();
		readSelection();

		const onScroll = () => scheduleScrollSync();
		const onSelect = () => readSelection();
		const onSelectionChange = () => {
			if (doc.activeElement === ta || selectingRef.current) readSelection();
		};
		const onMouseDown = () => { selectingRef.current = true; };
		const onMouseUp = () => {
			selectingRef.current = false;
			readSelection();
			scheduleScrollSync();
		};
		const onKeyUp = () => readSelection();
		const onInput = () => {
			readSelection();
			// Height may change; remeasure before next paint.
			syncMetrics();
			scheduleScrollSync();
		};

		ta.addEventListener('scroll', onScroll, { passive: true });
		ta.addEventListener('select', onSelect);
		ta.addEventListener('keyup', onKeyUp);
		ta.addEventListener('input', onInput);
		ta.addEventListener('mousedown', onMouseDown);
		doc.addEventListener('mouseup', onMouseUp);
		doc.addEventListener('selectionchange', onSelectionChange);

		// While dragging a selection, keep the highlight in sync even if selectionchange is sparse.
		const onMouseMove = () => {
			if (selectingRef.current) readSelection();
		};
		doc.addEventListener('mousemove', onMouseMove);

		let ro: ResizeObserver | undefined;
		try {
			ro = new ResizeObserver(() => {
				syncMetrics();
				syncScroll();
			});
			ro.observe(ta);
		} catch { /* ResizeObserver unavailable */ }

		const fonts = (doc as any).fonts;
		const onFonts = () => { syncMetrics(); syncScroll(); };
		try { fonts?.addEventListener?.('loadingdone', onFonts); } catch { /* ignore */ }

		return () => {
			ta.removeEventListener('scroll', onScroll);
			ta.removeEventListener('select', onSelect);
			ta.removeEventListener('keyup', onKeyUp);
			ta.removeEventListener('input', onInput);
			ta.removeEventListener('mousedown', onMouseDown);
			doc.removeEventListener('mouseup', onMouseUp);
			doc.removeEventListener('selectionchange', onSelectionChange);
			doc.removeEventListener('mousemove', onMouseMove);
			ro?.disconnect();
			try { fonts?.removeEventListener?.('loadingdone', onFonts); } catch { /* ignore */ }
			if (scrollRafRef.current) {
				cancelAnimationFrame(scrollRafRef.current);
				scrollRafRef.current = 0;
			}
		};
	}, [textareaRef, mirrorClassName]);

	useLayoutEffect(() => {
		syncMetrics();
		syncScroll();
		readSelection();
	}, [text, textareaRef]);

	// After selection highlight DOM updates, re-apply scroll (layout can shift).
	useLayoutEffect(() => {
		syncScroll();
	}, [sel.start, sel.end, text]);

	const segments = useMemo(() => buildSlashSegments(text, validNames), [text, validNames]);
	const pieces = useMemo(() => buildMirrorPieces(segments, sel), [segments, sel]);

	return (
		<div
			ref={overlayRef}
			aria-hidden
			className={`absolute top-0 left-0 z-0 pointer-events-none overflow-hidden ${VOID_SLASH_TOKEN_MIRROR} text-void-fg-1 ${mirrorClassName ?? ''}`}
			style={{
				background: 'transparent',
				borderColor: 'transparent',
				borderStyle: 'solid',
				userSelect: 'none',
				WebkitUserSelect: 'none',
			}}
		>
			{pieces.map((piece, i) => {
				if (!piece.text) return null;
				const tokenCls = tokenClassName(piece.kind);
				const cls = [
					tokenCls,
					piece.selected ? VOID_SLASH_TOKEN_MIRROR_SELECTION : undefined,
				].filter(Boolean).join(' ') || undefined;

				return (
					<span key={i} className={cls}>
						{piece.text}
					</span>
				);
			})}
			{/* Trailing newline matches textarea's extra line box for a final '\n'. */}
			{'\n'}
		</div>
	);
};
