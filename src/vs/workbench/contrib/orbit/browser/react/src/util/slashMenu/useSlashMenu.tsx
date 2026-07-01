/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState, MutableRefObject } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useFloating, autoUpdate, offset, flip, shift, size } from '@floating-ui/react';
import { useAccessor, useSettingsState } from '../services.js';
import { listSkills, onSkillsChanged } from '../../../../../common/skillRegistry.js';
import type { SkillDefinition } from '../../../../../common/orbitSkillTypes.js';
import { listSlashCategories } from './registry.js';
import { isSubsequence, scoreSubsequence } from './fuzzy.js';
import type { SlashCategoryId, SlashMenuItem, SlashProviderContext } from './types.js';

const TOP_PER_CATEGORY = 3;

export type SlashRenderRow =
	| { kind: 'item'; item: SlashMenuItem }
	| { kind: 'showmore'; categoryId: SlashCategoryId; hiddenCount: number };

export type SlashSection = { title?: string; rows: SlashRenderRow[] };

export type UseSlashMenuArgs = {
	accessor: ReturnType<typeof useAccessor>;
	enabled: boolean;
	textAreaRef: MutableRefObject<HTMLTextAreaElement | null>;
	onChangeText?: (newText: string) => void;
	adjustHeight: () => void;
};

export type SlashMenu = ReturnType<typeof useSlashMenu>;

/** A `/` token can start at index 0 or right after whitespace/newline. */
const isTokenBoundary = (value: string, slashIdx: number): boolean =>
	slashIdx === 0 || /\s/.test(value[slashIdx - 1]);

export const useSlashMenu = ({ accessor, enabled, textAreaRef, onChangeText, adjustHeight }: UseSlashMenuArgs) => {
	const settingsState = useSettingsState();

	const [isOpen, setIsOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [activeIdx, setActiveIdx] = useState(0);
	const [expanded, setExpanded] = useState<Set<SlashCategoryId>>(new Set());

	// triggerIdx = index of the `/` that opened the menu (lives in the textarea text).
	const triggerIdxRef = useRef<number>(-1);

	// Live skills snapshot (enabled flags + add/remove), same pattern as Settings.tsx.
	const [skills, setSkills] = useState<SkillDefinition[]>(() => listSkills());
	useEffect(() => onSkillsChanged(() => setSkills(listSkills())), []);

	const [menuWidth, setMenuWidth] = useState<number | undefined>(undefined);

	const { x, y, strategy, refs } = useFloating({
		open: isOpen,
		onOpenChange: setIsOpen,
		placement: 'bottom',
		middleware: [
			offset({ mainAxis: 2, crossAxis: 2 }),
			flip({ boundary: document.body, padding: 8 }),
			shift({ boundary: document.body, padding: 8 }),
			size({
				apply({ elements, rects }) {
					const refW = rects.reference.width;
					const w = Math.min(300, Math.max(248, refW * 0.82));
					Object.assign(elements.floating.style, { width: `${w}px` });
					setMenuWidth(w);
				},
				padding: 8,
				boundary: document.body,
			}),
		],
		whileElementsMounted: autoUpdate,
		strategy: 'fixed',
	});

	const ctx: SlashProviderContext = useMemo(() => ({ accessor, settingsState, skills }), [accessor, settingsState, skills]);

	// Only compute the (potentially expensive) item lists while the menu is actually open —
	// VoidInputBox2 mounts this hook in every input box, most of which never open the menu.
	const allItems = useMemo(() => isOpen ? listSlashCategories().flatMap(p => p.getItems(ctx)) : [], [ctx, isOpen]);

	const isEmptyQuery = query.trim() === '';

	// Build the render sections + the flat selectable row list (for keyboard nav).
	const { sections, selectable } = useMemo(() => {
		const sections: SlashSection[] = [];
		const selectable: SlashRenderRow[] = [];

		if (!isOpen) return { sections, selectable };

		if (isEmptyQuery) {
			for (const provider of listSlashCategories()) {
				const items = provider.getItems(ctx);
				if (items.length === 0) continue;
				const isExpanded = expanded.has(provider.id);
				const shown = isExpanded ? items : items.slice(0, TOP_PER_CATEGORY);
				const rows: SlashRenderRow[] = shown.map(item => ({ kind: 'item', item }));
				const hiddenCount = items.length - shown.length;
				if (hiddenCount > 0) rows.push({ kind: 'showmore', categoryId: provider.id, hiddenCount });
				sections.push({ title: provider.title, rows });
				selectable.push(...rows);
			}
		} else {
			const filtered = allItems
				.filter(it => isSubsequence(it.name, query)
					|| (it.searchKeys?.some(k => isSubsequence(k, query)) ?? false))
				.sort((a, b) => scoreSubsequence(b.name, query) - scoreSubsequence(a.name, query));
			const rows: SlashRenderRow[] = filtered.map(item => ({ kind: 'item', item }));
			sections.push({ rows });
			selectable.push(...rows);
		}

		return { sections, selectable };
	}, [isOpen, isEmptyQuery, query, allItems, ctx, expanded]);

	// Keep activeIdx in range whenever the selectable set changes.
	useEffect(() => {
		if (activeIdx > selectable.length - 1) setActiveIdx(selectable.length > 0 ? selectable.length - 1 : 0);
	}, [selectable.length, activeIdx]);

	const close = useCallback(() => {
		setIsOpen(false);
		triggerIdxRef.current = -1;
		setQuery('');
		setActiveIdx(0);
		setExpanded(new Set());
	}, []);

	const open = useCallback((triggerIdx: number) => {
		if (!enabled) return;
		triggerIdxRef.current = triggerIdx;
		setQuery('');
		setActiveIdx(0);
		setExpanded(new Set());
		setIsOpen(true);
	}, [enabled]);

	/** Whether typing `/` at `caret` (1 past the `/`) is a valid command trigger. */
	const canTriggerAtCaret = useCallback((value: string, caret: number): boolean => {
		const slashIdx = caret - 1;
		return slashIdx >= 0 && value[slashIdx] === '/' && isTokenBoundary(value, slashIdx);
	}, []);

	/** Recompute the query from the textarea caret; close if the slug is no longer valid. */
	const syncFromTextarea = useCallback(() => {
		if (!isOpen) return;
		const ta = textAreaRef.current;
		if (!ta) { close(); return; }
		const triggerIdx = triggerIdxRef.current;
		const caret = ta.selectionStart ?? ta.value.length;
		if (triggerIdx < 0 || caret <= triggerIdx || ta.value[triggerIdx] !== '/') { close(); return; }
		const slug = ta.value.slice(triggerIdx + 1, caret);
		if (/\s/.test(slug)) { close(); return; } // whitespace ends the token
		setQuery(prev => (prev === slug ? prev : slug));
	}, [isOpen, textAreaRef, close]);

	/** Replace the whole `/token` (from triggerIdx to the end of its name run) with `replacement`. */
	const replaceSlug = useCallback((replacement: string) => {
		const ta = textAreaRef.current;
		const triggerIdx = triggerIdxRef.current;
		if (!ta || triggerIdx < 0) { close(); return; }
		const val = ta.value;
		// End at the last contiguous token char after the `/`, NOT the caret — so accepting
		// after moving the caret left (e.g. `/exp|lain`) doesn't leave a trailing suffix.
		let end = triggerIdx + 1;
		while (end < val.length && /[a-z0-9_-]/i.test(val[end])) end++;
		end = Math.max(end, ta.selectionStart ?? end);
		const before = val.slice(0, triggerIdx);
		const after = val.slice(end);
		ta.value = before + replacement + after;
		const newPos = (before + replacement).length;
		ta.focus();
		ta.setSelectionRange(newPos, newPos);
		onChangeText?.(ta.value);
		adjustHeight();
		close();
	}, [textAreaRef, onChangeText, adjustHeight, close]);

	const selectAt = useCallback((idx: number) => {
		const row = selectable[idx];
		if (!row) return;
		if (row.kind === 'showmore') {
			setExpanded(prev => { const next = new Set(prev); next.add(row.categoryId); return next; });
			return; // keep menu open
		}
		const item = row.item;
		if (item.insertsToken) {
			// Record the explicit selection so the prompt builder injects ONLY menu-inserted
			// tokens (never a literal /word the user typed in prose).
			try { accessor.get('IChatThreadService').addStagedSlashToken(item.name); } catch { /* non-fatal */ }
			replaceSlug(`${item.insertsToken.token} `);
		} else {
			// Mode/Model: run the side effect and remove the `/slug` (no token left behind).
			item.onSelect?.({ accessor });
			replaceSlug('');
		}
	}, [selectable, replaceSlug, accessor]);

	/** Returns true if the key was consumed by the menu. */
	const onMenuKeyDown = useCallback((e: ReactKeyboardEvent): boolean => {
		if (!isOpen) return false;
		const n = selectable.length;
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault(); e.stopPropagation();
				if (n > 0) setActiveIdx(i => (i + 1) % n);
				return true;
			case 'ArrowUp':
				e.preventDefault(); e.stopPropagation();
				if (n > 0) setActiveIdx(i => (i - 1 + n) % n);
				return true;
			case 'Enter':
			case 'Tab':
				// Always consume Enter while the menu is open so it can't fall through and
				// submit the message; with no matches, just close.
				e.preventDefault(); e.stopPropagation();
				if (n === 0) { close(); return true; }
				selectAt(activeIdx);
				return true;
			case 'Escape':
				e.preventDefault(); e.stopPropagation();
				close();
				return true;
			default:
				return false; // let letters/backspace fall through to the textarea
		}
	}, [isOpen, selectable.length, activeIdx, selectAt, close]);

	// Close on click outside (mirrors the "@" menu).
	useEffect(() => {
		if (!isOpen) return;
		const handle = (event: MouseEvent) => {
			const target = event.target as Node;
			const floating = refs.floating.current;
			const reference = refs.reference.current as HTMLElement | null;
			if (floating && (!reference || !reference.contains(target)) && !floating.contains(target)) {
				close();
			}
		};
		document.addEventListener('mousedown', handle);
		return () => document.removeEventListener('mousedown', handle);
	}, [isOpen, refs.floating, refs.reference, close]);

	// Memoize the returned object so the consumer's useCallbacks (onInput/onChange/onKeyDown
	// in VoidInputBox2 depend on this object) stay stable when nothing here changed — which is
	// every render in the common closed/disabled case.
	return useMemo(() => ({
		enabled,
		isOpen,
		open,
		close,
		syncFromTextarea,
		canTriggerAtCaret,
		onMenuKeyDown,
		floating: { refs, x, y, strategy, menuWidth },
		// render data:
		query,
		isEmptyQuery,
		sections,
		activeIdx,
		setActiveIdx,
		selectAt,
	}), [enabled, isOpen, open, close, syncFromTextarea, canTriggerAtCaret, onMenuKeyDown, refs, x, y, strategy, menuWidth, query, isEmptyQuery, sections, activeIdx, setActiveIdx, selectAt]);
};
