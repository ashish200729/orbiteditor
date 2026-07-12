/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { useState, useEffect, useCallback, useRef, RefObject } from 'react';
import { getConnectedWindow } from '../../util/connectedWindow.js';

/**
 * Hook for sticky user messages.
 *
 * Tracks scroll position and determines which user message should be sticky.
 * Only ONE user message should be sticky at any time - the most recently
 * scrolled-past message.
 *
 * Z-index hierarchy for sticky elements:
 * - User messages: z-index 20 (highest, always visible on top)
 * - TodoTool card: z-index 15 (below user messages, above regular content)
 *
 * Styling includes:
 * - Consistent 8px offset from top
 * - 4px padding for visual breathing room
 * - Subtle box-shadow for depth
 * - Background color to prevent content bleeding through
 */

export const STICKY_OFFSET = 0;

export const useStickyUserMessages = (
	scrollContainerRef: RefObject<HTMLDivElement | null>,
	userMessageIndices: number[]
): {
	stickyOffset: number;
	stickyMessageIndex: number | null;
} => {
	const [stickyMessageIndex, setStickyMessageIndex] = useState<number | null>(null);

	const updateStickyMessage = useCallback(() => {
		const container = scrollContainerRef.current;
		if (!container || userMessageIndices.length === 0) {
			setStickyMessageIndex(null);
			return;
		}

		const containerRect = container.getBoundingClientRect();
		const stickyThreshold = STICKY_OFFSET + 20; // A bit past the sticky offset

		// Find all user message elements and determine which one should be sticky
		let lastStickyCandidate: number | null = null;

		for (const messageIndex of userMessageIndices) {
			const messageElement = container.querySelector(`[data-message-index="${messageIndex}"]`) as HTMLElement | null;
			if (!messageElement) continue;

			// Get the element's position relative to the container's scroll area
			const messageRect = messageElement.getBoundingClientRect();
			const relativeTop = messageRect.top - containerRect.top;

			// If this message has scrolled past the sticky threshold, it's a candidate
			// The message should become sticky when its top goes above the threshold
			if (relativeTop <= stickyThreshold) {
				lastStickyCandidate = messageIndex;
			}
		}

		setStickyMessageIndex(lastStickyCandidate);
	}, [scrollContainerRef, userMessageIndices.join(',')]);

	const updateStickyMessageRef = useRef(updateStickyMessage);
	updateStickyMessageRef.current = updateStickyMessage;

	// Stable, rAF-throttled handler. updateStickyMessage() runs a getBoundingClientRect() loop over
	// every user message (a synchronous reflow); coalescing to once per frame removes scroll jank.
	const rafIdRef = useRef<number | null>(null);
	const handler = useCallback(() => {
		if (rafIdRef.current !== null) return;
		rafIdRef.current = requestAnimationFrame(() => {
			rafIdRef.current = null;
			updateStickyMessageRef.current();
		});
	}, []);

	// Re-attach the scroll listener whenever the container ELEMENT changes — not just on mount. The
	// scroll <div> remounts on every thread switch (key={'messages'+threadId}); keying the effect on
	// the stable ref object alone left the listener bound to the old, unmounted div whenever the new
	// thread had the same user-message indices, freezing the sticky header. This reconciles on every
	// render but only does work when the element actually changed.
	//
	// IMPORTANT: this effect intentionally has NO dependency array — it must run on every render to
	// detect when scrollContainerRef.current swaps to a new element. Do NOT add `[scrollContainerRef]`
	// (or any deps): the ref object is stable, so the effect would run once and the listener would be
	// left bound to the old, unmounted div after a thread switch, re-freezing the sticky header.
	const attachedElRef = useRef<HTMLElement | null>(null);
	const resizeObserverRef = useRef<ResizeObserver | null>(null);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(() => {
		const container = scrollContainerRef.current;
		if (container === attachedElRef.current) {
			return;
		}

		const prev = attachedElRef.current;
		if (prev) {
			prev.removeEventListener('scroll', handler);
		}
		if (resizeObserverRef.current) {
			resizeObserverRef.current.disconnect();
			resizeObserverRef.current = null;
		}

		attachedElRef.current = container;
		if (!container) {
			return;
		}

		container.addEventListener('scroll', handler, { passive: true });
		if (typeof ResizeObserver !== 'undefined') {
			// Recompute when the container (viewport) or its content size changes — e.g. the panel is
			// resized, or content grows/collapses while not scrolling.
			resizeObserverRef.current = new ResizeObserver(handler);
			resizeObserverRef.current.observe(container);
		}
		updateStickyMessageRef.current();
	});

	// Window resize + unmount cleanup. Bind to the window the scroll container is painted in
	// (the pop-out when hosted there) so a pop-out resize recomputes sticky offsets.
	useEffect(() => {
		const win = getConnectedWindow(attachedElRef.current);
		win.addEventListener('resize', handler, { passive: true });
		return () => {
			win.removeEventListener('resize', handler);
			if (rafIdRef.current !== null) {
				cancelAnimationFrame(rafIdRef.current);
			}
			const el = attachedElRef.current;
			if (el) {
				el.removeEventListener('scroll', handler);
			}
			if (resizeObserverRef.current) {
				resizeObserverRef.current.disconnect();
				resizeObserverRef.current = null;
			}
		};
	}, [handler]);

	// Also recompute when message indices change (new turn, edit, thread content swap).
	useEffect(() => {
		updateStickyMessage();
	}, [updateStickyMessage]);

	return {
		stickyOffset: STICKY_OFFSET,
		stickyMessageIndex,
	};
};
