/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';

type CollapsibleSectionProps = {
	isOpen: boolean;
	children: React.ReactNode;
	className?: string;
	contentClassName?: string;
	duration?: number;
};

/**
 * Expand/collapse wrapper using a CSS `grid-template-rows: 0fr → 1fr` transition.
 *
 * This intentionally avoids framer-motion's `height: 'auto'` animation. That path
 * resolves the pixel target by calling the bundle's module-global `window.getComputedStyle(el)`,
 * where `window` is the MAIN renderer window. When this component renders inside the
 * standalone Agents auxiliary window, `el` lives in the AUX document, so the main window's
 * `getComputedStyle` returns empty padding values → the measured height becomes `NaN` and the
 * `overflow-hidden` wrapper stays clamped at height 0, hiding the expanded content entirely
 * (reasoning "Thought" blocks, tool dropdowns, parallel tool groups).
 *
 * The grid-rows approach needs zero JS measurement, so it is window-agnostic and produces the
 * same visual expand/collapse in both the main window and the aux window. Children remain mounted
 * only through the closing transition, then unmount as they did in the original implementation.
 */
export const CollapsibleSection = ({
	isOpen,
	children,
	className = '',
	contentClassName = '',
	duration = 0.2,
}: CollapsibleSectionProps) => {
	// Keep children mounted only for the closing transition. The previous first
	// pass kept every collapsed tool subtree alive forever, which changed the
	// main sidebar's performance and left hidden controls keyboard-focusable.
	const [renderChildren, setRenderChildren] = React.useState(isOpen);
	React.useEffect(() => {
		if (isOpen) {
			setRenderChildren(true);
			return;
		}
		if (!renderChildren) {
			return;
		}
		const timer = globalThis.setTimeout(() => setRenderChildren(false), Math.max(0, duration * 1000));
		return () => globalThis.clearTimeout(timer);
	}, [duration, isOpen, renderChildren]);

	return (
		<div
			className={className}
			aria-hidden={!isOpen}
			style={{
				display: 'grid',
				gridTemplateRows: isOpen ? '1fr' : '0fr',
				opacity: isOpen ? 1 : 0,
				transition: `grid-template-rows ${duration}s ease-out, opacity ${duration}s ease-out`,
				pointerEvents: isOpen ? undefined : 'none',
			}}
		>
			{/* min-h-0 lets the grid row collapse fully to 0; overflow-hidden clips during the transition */}
			<div className="overflow-hidden min-h-0" inert={!isOpen}>
				<div className={contentClassName}>
					{(isOpen || renderChildren) ? children : null}
				</div>
			</div>
		</div>
	);
};
