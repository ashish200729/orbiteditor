/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef } from 'react';

/**
 * Hook to measure and set CSS variable for sticky todo positioning
 * Measures the height of user message area and sets --todo-sticky-offset
 */
export const useStickyOffset = (scrollContainerRef: React.RefObject<HTMLDivElement>) => {
	const measurementTimerRef = useRef<number | null>(null);
	// The element we currently have listeners attached to. `scrollContainerRef.current` is not a
	// valid effect dependency (the ref object is stable), so an effect keyed on it runs only once and
	// keeps its listeners bound to the ORIGINAL element. When the scroll container remounts (e.g. a
	// thread switch changes its React key) `.current` swaps but the listeners don't — the CSS var
	// freezes. We instead run every render and rebind only when the underlying element actually
	// changes.
	const attachedElRef = useRef<HTMLDivElement | null>(null);
	const cleanupRef = useRef<(() => void) | null>(null);

	useEffect(() => {
		const el = scrollContainerRef.current;
		if (el === attachedElRef.current) return; // still attached to the same element — nothing to do

		// Detach from the previous element.
		cleanupRef.current?.();
		cleanupRef.current = null;
		attachedElRef.current = el;
		if (!el) return;

		const measureAndSetOffset = () => {
			const userMessages = el.querySelectorAll('[data-role="user"]');
			if (userMessages.length === 0) {
				el.style.setProperty('--todo-sticky-offset', '8px');
				return;
			}
			const firstUserMessage = userMessages[0] as HTMLElement;
			const rect = firstUserMessage.getBoundingClientRect();
			const containerRect = el.getBoundingClientRect();
			const offset = rect.bottom - containerRect.top + 8;
			el.style.setProperty('--todo-sticky-offset', `${Math.max(0, offset)}px`);
		};

		measureAndSetOffset();

		const handleScroll = () => {
			if (measurementTimerRef.current !== null) {
				window.cancelAnimationFrame(measurementTimerRef.current);
			}
			measurementTimerRef.current = window.requestAnimationFrame(measureAndSetOffset);
		};
		const resizeObserver = new ResizeObserver(() => { measureAndSetOffset(); });
		el.addEventListener('scroll', handleScroll);
		resizeObserver.observe(el);

		cleanupRef.current = () => {
			if (measurementTimerRef.current !== null) {
				window.cancelAnimationFrame(measurementTimerRef.current);
				measurementTimerRef.current = null;
			}
			el.removeEventListener('scroll', handleScroll);
			resizeObserver.disconnect();
		};
	});

	// Final cleanup on unmount.
	useEffect(() => () => { cleanupRef.current?.(); }, []);
};
