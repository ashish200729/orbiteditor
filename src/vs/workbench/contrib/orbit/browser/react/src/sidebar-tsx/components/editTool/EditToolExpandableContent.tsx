/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { editToolStrings } from './editToolStrings.js';
import { EDIT_TOOL_HEIGHTS, EDIT_TOOL_MIN_VIEWPORT_PX, EDIT_TOOL_VIEWPORT_MAX_PX, EDIT_TOOL_STREAMING_VIEWPORT_MAX_PX, EDIT_TOOL_STREAMING_VIEWPORT_MIN_PX } from './editToolSizing.js';

export type EditToolExpandState = 'collapsed' | 'expanded';

// Returns a canceller so callers can abort the pending frames on cleanup — otherwise a mid-stream
// unmount leaves rAF callbacks firing against a detached node (one leaked pair per chunk).
const scrollContentToBottom = (el: HTMLDivElement): (() => void) => {
	let inner = 0;
	const outer = requestAnimationFrame(() => {
		el.scrollTop = el.scrollHeight;
		inner = requestAnimationFrame(() => {
			el.scrollTop = el.scrollHeight;
		});
	});
	return () => {
		cancelAnimationFrame(outer);
		if (inner) { cancelAnimationFrame(inner); }
	};
};

export const EditToolExpandableContent = ({
	children,
	dependencyKey,
	defaultExpandState = 'expanded',
	isStreaming = false,
	hideControls = false,
	fixedViewport = false,
}: {
	children: (maxHeight: number | undefined, reportOverflow: (overflow: boolean) => void) => React.ReactNode;
	dependencyKey: string;
	defaultExpandState?: EditToolExpandState;
	isStreaming?: boolean;
	hideControls?: boolean;
	/** Pin viewport height — EDIT_TOOL_STREAMING_VIEWPORT_MAX_PX while streaming, EDIT_TOOL_VIEWPORT_MAX_PX while executing */
	fixedViewport?: boolean;
}) => {
	const [expandState, setExpandState] = useState<EditToolExpandState>(defaultExpandState);
	const contentRef = useRef<HTMLDivElement>(null);
	const [domOverflow, setDomOverflow] = useState(false);
	const [childOverflow, setChildOverflow] = useState(false);
	const reportOverflow = useCallback((overflow: boolean) => setChildOverflow(overflow), []);
	const needsShowMore = domOverflow || childOverflow;

	const maxHeight = fixedViewport
		? (isStreaming ? EDIT_TOOL_STREAMING_VIEWPORT_MAX_PX : EDIT_TOOL_VIEWPORT_MAX_PX)
		: isStreaming
			? EDIT_TOOL_HEIGHTS.streaming
			: expandState === 'expanded'
				? EDIT_TOOL_HEIGHTS.expanded
				: EDIT_TOOL_HEIGHTS.collapsed;

	const shouldAutoScroll = isStreaming || fixedViewport;

	const checkHeight = useCallback(() => {
		if (!contentRef.current) {
			return;
		}
		const scrollHeight = contentRef.current.scrollHeight;
		const clientHeight = contentRef.current.clientHeight;
		setDomOverflow(scrollHeight > clientHeight + 8);
	}, []);

	useEffect(() => {
		setChildOverflow(false);
	}, [dependencyKey]);

	useEffect(() => {
		let rafId: number | undefined;
		let earlyTimeoutId: NodeJS.Timeout | undefined;
		let lateTimeoutId: NodeJS.Timeout | undefined;

		rafId = requestAnimationFrame(() => {
			checkHeight();
			earlyTimeoutId = setTimeout(checkHeight, 150);
			lateTimeoutId = setTimeout(checkHeight, 400);
		});

		return () => {
			if (rafId !== undefined) {
				cancelAnimationFrame(rafId);
			}
			if (earlyTimeoutId !== undefined) {
				clearTimeout(earlyTimeoutId);
			}
			if (lateTimeoutId !== undefined) {
				clearTimeout(lateTimeoutId);
			}
		};
	}, [dependencyKey, expandState, isStreaming, checkHeight]);

	// Follow streaming content as it grows. Cheap per-chunk scroll — kept separate
	// from the ResizeObserver below so a new chunk doesn't tear down and rebuild
	// the observer (and re-walk all children) on every keystroke of output.
	useEffect(() => {
		if (!shouldAutoScroll || !contentRef.current) {
			return;
		}
		const cancel = scrollContentToBottom(contentRef.current);
		return cancel;
	}, [dependencyKey, shouldAutoScroll]);

	// Follow async layout changes (Monaco mount, viewport opening) that aren't
	// captured by dependencyKey. Created once per streaming session, not rebuilt
	// per chunk.
	useEffect(() => {
		if (!shouldAutoScroll || !contentRef.current) {
			return;
		}
		const el = contentRef.current;
		let cancelScroll: (() => void) | null = null;
		const resizeObserver = new ResizeObserver(() => {
			cancelScroll?.();
			cancelScroll = scrollContentToBottom(el);
		});
		resizeObserver.observe(el);
		for (const child of Array.from(el.children)) {
			resizeObserver.observe(child);
		}
		return () => { cancelScroll?.(); resizeObserver.disconnect(); };
	}, [shouldAutoScroll]);

	const showControls = needsShowMore && !isStreaming;
	const showStreamingFade = isStreaming && needsShowMore;
	const showCompactFade = showControls && expandState === 'collapsed';

	return (
		<>
			<div
				ref={contentRef}
				className={`
					edit-tool-expandable-content relative overflow-y-auto overflow-x-hidden
					${fixedViewport ? 'edit-tool-active-viewport' : ''}
					${isStreaming ? 'edit-tool-expandable-streaming pointer-events-none select-none' : ''}
				`}
				style={{
					maxHeight: `${maxHeight}px`,
					minHeight: fixedViewport
						? (isStreaming ? `${EDIT_TOOL_STREAMING_VIEWPORT_MIN_PX}px` : `${maxHeight}px`)
						: `${EDIT_TOOL_MIN_VIEWPORT_PX}px`,
					height: (fixedViewport && !isStreaming) ? `${maxHeight}px` : undefined,
					transition: (isStreaming || fixedViewport) ? undefined : 'max-height 250ms cubic-bezier(0.4, 0, 0.2, 1)',
					scrollbarWidth: 'thin',
					scrollbarColor: 'rgba(var(--vscode-void-fg-4-rgb, 128, 128, 128), 0.25) transparent',
				}}
			>
				{children(maxHeight, reportOverflow)}
				{(showCompactFade || showStreamingFade) && (
					<div
						className="edit-tool-expandable-fade pointer-events-none absolute inset-x-0 bottom-0 h-6"
						aria-hidden="true"
					/>
				)}
			</div>

			{!hideControls && showControls && (
				<div
					className="edit-tool-expandable-controls flex items-center justify-center gap-2 py-0.5 px-2"
					style={{
						borderTop: '1px solid rgba(var(--vscode-void-border-3-rgb, 64, 64, 64), 0.12)',
						background: 'rgba(var(--vscode-void-bg-2-rgb, 16, 16, 16), 0.15)',
					}}
				>
					{expandState === 'collapsed' ? (
						<button
							type="button"
							onClick={() => setExpandState('expanded')}
							aria-expanded={false}
							className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-void-fg-4/55 hover:text-void-fg-4/80 transition-all duration-150 rounded active:scale-[0.97]"
						>
							<ChevronDown size={10} strokeWidth={2.5} />
							<span className="font-medium">{editToolStrings.showAll}</span>
						</button>
					) : (
						<button
							type="button"
							onClick={() => setExpandState('collapsed')}
							aria-expanded={true}
							className="px-2 py-0.5 text-[10px] text-void-fg-4/45 hover:text-void-fg-4/70 transition-all duration-150 rounded active:scale-[0.97] font-medium"
						>
							{editToolStrings.collapse}
						</button>
					)}
				</div>
			)}
		</>
	);
};
