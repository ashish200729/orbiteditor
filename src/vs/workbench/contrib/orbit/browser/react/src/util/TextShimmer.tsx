/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React from 'react';

interface TextShimmerProps {
	children: string;
	as?: React.ElementType;
	className?: string;
	duration?: number;
	spread?: number;
}

export function TextShimmer({
	children,
	as: Component = 'span',
	className = '',
	duration = 1.20, // Fast but visible (0.2 is too fast)
	spread = 2,
}: TextShimmerProps) {
	// Fixed beam width for consistent "searchlight" effect
	const shimmerWidth = 36;

	// Opaque theme-aware stops (no washed-out rgba white overlays on muted bases).
	const beamPeak = 'color-mix(in srgb, currentColor 6%, var(--void-fg-1) 94%)';
	const beamMid = 'color-mix(in srgb, currentColor 36%, var(--void-fg-2) 64%)';
	const beamEdge = 'color-mix(in srgb, currentColor 76%, var(--void-fg-2) 24%)';

	// NOTE: this used to use framer-motion's `motion()` to animate `backgroundPosition`, which runs a
	// JS rAF loop on the main thread for every instance. TextShimmer is rendered in ~14 places that are
	// all on-screen during an agent run (tool headers, streaming tools, status line, reasoning, todo &
	// sub-agent cards), so dozens animated at once. We now use a pure CSS animation (keyframes
	// `orbit-text-shimmer` in styles.css) with identical visuals, but the browser drives it natively.
	// The `orbit-shimmer` class is gated under prefers-reduced-motion in styles.css.
	const style: React.CSSProperties = {
		display: 'inline-block',
		color: 'inherit',
		// Composite background: theme-aware shimmer beam on top, solid currentColor base below
		backgroundImage: `linear-gradient(
			100deg,
			transparent 0%,
			transparent calc(50% - ${shimmerWidth}px),
			${beamEdge} calc(50% - ${shimmerWidth * 0.85}px),
			${beamMid} calc(50% - ${shimmerWidth * 0.45}px),
			${beamPeak} calc(50% - ${shimmerWidth * 0.12}px),
			${beamPeak} calc(50% + ${shimmerWidth * 0.12}px),
			${beamMid} calc(50% + ${shimmerWidth * 0.45}px),
			${beamEdge} calc(50% + ${shimmerWidth * 0.85}px),
			transparent calc(50% + ${shimmerWidth}px),
			transparent 100%
		), linear-gradient(currentColor, currentColor)`,
		backgroundSize: '200px 100%, 100% 100%',
		backgroundRepeat: 'repeat-x, no-repeat',
		backgroundPosition: '-200px 0, 0 0',
		backgroundClip: 'text',
		WebkitBackgroundClip: 'text',

		// Make the text itself transparent so the background shows through
		WebkitTextFillColor: 'transparent',

		// Ensure layout properties are safe
		position: 'relative',
		whiteSpace: 'nowrap',
		verticalAlign: 'middle',
		maxWidth: '100%',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		transform: 'translateZ(0)',

		// CSS-driven shimmer (replaces framer-motion)
		animationName: 'orbit-text-shimmer',
		animationDuration: `${duration}s`,
		animationTimingFunction: 'linear',
		animationIterationCount: 'infinite',
	};

	return React.createElement(Component, { className: `orbit-shimmer ${className}`, style }, children);
}
