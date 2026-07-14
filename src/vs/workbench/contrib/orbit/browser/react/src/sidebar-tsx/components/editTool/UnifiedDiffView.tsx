/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useMemo, useRef } from 'react';
import { URI } from '../../../../../../../../../base/common/uri.js';
import { computeStreamingDiffLines, computeUnifiedDiffLines, UnifiedDiffLine } from './unifiedDiffUtils.js';
import { EDIT_TOOL_MIN_VIEWPORT_PX } from './editToolSizing.js';
import { editToolStrings } from './editToolStrings.js';

/**
 * Pure-React unified diff renderer.
 *
 * This intentionally does NOT use Monaco (CodeEditorWidget): a per-card editor
 * instance is expensive to mount, flickers, and — most importantly — bootstraps
 * into a 0px container when the card mounts at the very bottom of the chat
 * viewport, which produced the "card shows only the header" bug. Rendering the
 * already-computed diff lines as plain DOM is deterministic, cheap, and never
 * collapses.
 *
 * Height/scrolling is owned by the parent (EditToolExpandableContent), which
 * caps the viewport and scrolls. This component just renders its natural height
 * and lets that container clip/scroll — so there is exactly one scroll owner.
 */

const DIFF_GUTTER_WIDTH_PX = 20;

const DiffRow = React.memo(({ type, content, wrap }: { type: UnifiedDiffLine['type']; content: string; wrap: boolean }) => {
	const rowClass = type === 'added'
		? 'unified-diff-line-added'
		: type === 'removed'
			? 'unified-diff-line-removed'
			: '';
	const marker = type === 'added' ? '+' : type === 'removed' ? '-' : '';
	const markerColor = type === 'added'
		? 'rgba(34, 197, 94, 0.75)'
		: type === 'removed'
			? 'rgba(239, 68, 68, 0.75)'
			: 'rgba(var(--vscode-void-fg-4-rgb, 128, 128, 128), 0.3)';

	return (
		<div className={`flex items-start ${rowClass}`}>
			<span
				className="select-none flex-shrink-0 text-center font-semibold"
				style={{ width: `${DIFF_GUTTER_WIDTH_PX}px`, color: markerColor }}
				aria-hidden="true"
			>
				{marker}
			</span>
			<span className={`pr-3 flex-1 ${wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`}>{content === '' ? ' ' : content}</span>
		</div>
	);
});

export const UnifiedDiffView = ({
	oldString,
	newString,
	maxHeight,
	onOverflowChange,
	isComplete,
}: {
	uri?: URI;
	oldString: string;
	newString: string;
	language?: string;
	maxHeight?: number;
	onOverflowChange?: (overflow: boolean) => void;
	/** When the edit has finished but produced no diff, show "No changes" instead of a perpetual "Preparing preview…". */
	isComplete?: boolean;
}) => {
	// While streaming (isComplete === false) the LCS diff would re-run on every chunk over the
	// whole growing string — quadratic across the stream. Render the cheap removed/added shape
	// instead; the exact diff is computed once when the edit completes.
	const diffLines = useMemo(
		() => isComplete === false
			? computeStreamingDiffLines(oldString, newString)
			: computeUnifiedDiffLines(oldString, newString),
		[oldString, newString, isComplete],
	);
	const hasDiffContent = diffLines.length > 0;

	const innerRef = useRef<HTMLDivElement | null>(null);
	const onOverflowChangeRef = useRef(onOverflowChange);
	onOverflowChangeRef.current = onOverflowChange;

	// Report whether the rendered content exceeds the provided cap so the parent
	// can offer a "show more" affordance. The parent also measures its own scroll
	// overflow, so this is best-effort and never required for correctness.
	useEffect(() => {
		const cb = onOverflowChangeRef.current;
		if (!cb) {
			return;
		}
		const el = innerRef.current;
		if (!el || maxHeight === undefined) {
			cb(false);
			return;
		}
		const measure = () => cb(el.scrollHeight > maxHeight + 1);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [maxHeight, diffLines]);

	if (!hasDiffContent) {
		return (
			<div
				className="edit-tool-diff-view px-2.5 py-2 text-void-fg-4/50 text-[10px] flex items-center"
				style={{
					minHeight: `${EDIT_TOOL_MIN_VIEWPORT_PX}px`,
					background: 'var(--vscode-editor-background)',
				}}
			>
				{isComplete ? editToolStrings.noChanges : editToolStrings.preparingPreview}
			</div>
		);
	}

	return (
		<div
			className="edit-tool-diff-view font-mono text-[10px] leading-[1.5]"
			style={{
				color: 'var(--vscode-editor-foreground)',
				fontFamily: 'var(--vscode-editor-font-family, var(--monaco-monospace-font, monospace))',
				background: 'var(--vscode-editor-background)',
			}}
		>
			<div ref={innerRef} className="py-0.5">
				{diffLines.map((line, index) => (
					<DiffRow key={index} type={line.type} content={line.content} wrap={!isComplete} />
				))}
			</div>
		</div>
	);
};
