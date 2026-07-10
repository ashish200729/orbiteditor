/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { CornerDownLeft } from 'lucide-react';
import { toolApprovalTheme } from './toolApprovalTheme.js';

/**
 * Shared button primitives for every approval/consent surface in Orbit.
 *
 * Three variants, one compact premium visual language:
 *  - `ApprovalGhostButton`   — borderless text button (Skip / Back). Quiet
 *    descFg text; hover lifts to fg over a faint tonal wash.
 *  - `ApprovalPillButton`    — tinted secondary pill (Always Run / Always
 *    Allow). The secondary surface is blended toward the accent via
 *    `color-mix` so it reads as a distinct tonal step above the card
 *    background (not the flat "one color" the plain secondary token gives).
 *  - `ApprovalPrimaryButton` — solid accent pill (Run / Approve / Continue)
 *    with a subtle two-layer depth shadow and an optional ↵ glyph.
 *
 * All three share one sizing scale, radius, transition timing, and disabled
 * treatment so the generic tool card, the edit-diff card, and the AskQuestion
 * wizard read as a single product surface.
 *
 * States shipped (per 2026 button best practice): enabled, hover, focus,
 * pressed, disabled. Hover is a subtle color/depth shift (never dramatic);
 * focus is a 1px ring + 4px diffuse halo; pressed is scale-[0.98]; disabled
 * is opacity + pointer-events-none.
 *
 * IMPORTANT — scope-tailwind constraint:
 * The React build prefixes Tailwind classes with `void-` by scanning
 * `className="..."` string literals. Classes must be inline in the JSX
 * attribute — do NOT hoist them into module-level constants, or they ship
 * un-prefixed and never match the generated CSS.
 *
 * Hover/focus styles are swapped imperatively because VS Code theme vars are
 * not real CSS custom properties at build time, so Tailwind `:hover` /
 * `:focus-visible` utilities can't resolve the values.
 */

type CommonProps = {
	children: React.ReactNode;
	disabled?: boolean;
	ariaLabel?: string;
	title?: string;
	onClick?: () => void;
	className?: string;
};

/* -------------------------------------------------------------------------- */
/* Ghost — borderless text button (Skip / Back)                               */
/* -------------------------------------------------------------------------- */
export const ApprovalGhostButton = ({
	children,
	disabled = false,
	ariaLabel,
	title,
	onClick,
	className = '',
}: CommonProps) => (
	<button
		type="button"
		disabled={disabled}
		aria-label={ariaLabel}
		aria-disabled={disabled || undefined}
		title={title}
		onClick={onClick}
		className={`inline-flex items-center justify-center gap-1 px-2.5 py-[5px] rounded-md text-[11px] font-medium whitespace-nowrap select-none leading-[16px] transition-[background-color,color,box-shadow,opacity,transform] duration-150 ease-out outline-none border border-transparent ${disabled ? 'opacity-35 cursor-not-allowed pointer-events-none' : 'active:scale-[0.98] cursor-pointer'} ${className}`}
		style={{
			background: 'transparent',
			color: toolApprovalTheme.descFg,
			boxShadow: 'none',
		}}
		onMouseEnter={(e) => {
			if (disabled) return;
			e.currentTarget.style.background = toolApprovalTheme.ghostHoverBg;
			e.currentTarget.style.color = toolApprovalTheme.ghostHoverFg;
		}}
		onMouseLeave={(e) => {
			if (disabled) return;
			e.currentTarget.style.background = 'transparent';
			e.currentTarget.style.color = toolApprovalTheme.descFg;
		}}
		onFocus={(e) => {
			if (disabled) return;
			e.currentTarget.style.boxShadow = `0 0 0 1px ${toolApprovalTheme.focusBorder}, 0 0 0 4px ${toolApprovalTheme.focusRingHalo}`;
		}}
		onBlur={(e) => { e.currentTarget.style.boxShadow = 'none'; }}
	>
		{children}
	</button>
);

/* -------------------------------------------------------------------------- */
/* Pill — tinted secondary (Always Run / Always Allow)                        */
/* -------------------------------------------------------------------------- */
export const ApprovalPillButton = ({
	children,
	disabled = false,
	ariaLabel,
	title,
	onClick,
	className = '',
}: CommonProps) => (
	<button
		type="button"
		disabled={disabled}
		aria-label={ariaLabel}
		aria-disabled={disabled || undefined}
		title={title}
		onClick={onClick}
		className={`inline-flex items-center justify-center gap-1 px-2.5 py-[5px] rounded-md text-[11px] font-medium whitespace-nowrap select-none leading-[16px] transition-[background-color,border-color,box-shadow,opacity,transform] duration-150 ease-out outline-none ${disabled ? 'opacity-35 cursor-not-allowed pointer-events-none' : 'active:scale-[0.98] cursor-pointer'} ${className}`}
		style={{
			background: toolApprovalTheme.pillBg,
			color: toolApprovalTheme.pillFg,
			border: `1px solid ${toolApprovalTheme.pillBorder}`,
			boxShadow: 'none',
		}}
		onMouseEnter={(e) => {
			if (disabled) return;
			e.currentTarget.style.background = toolApprovalTheme.pillBgHover;
			e.currentTarget.style.borderColor = toolApprovalTheme.pillBorderHover;
		}}
		onMouseLeave={(e) => {
			if (disabled) return;
			e.currentTarget.style.background = toolApprovalTheme.pillBg;
			e.currentTarget.style.borderColor = toolApprovalTheme.pillBorder;
		}}
		onFocus={(e) => {
			if (disabled) return;
			e.currentTarget.style.boxShadow = `0 0 0 1px ${toolApprovalTheme.focusBorder}, 0 0 0 4px ${toolApprovalTheme.focusRingHalo}`;
		}}
		onBlur={(e) => { e.currentTarget.style.boxShadow = 'none'; }}
	>
		{children}
	</button>
);

/* -------------------------------------------------------------------------- */
/* Primary — solid accent pill (Run / Approve / Continue) + optional ↵ glyph  */
/* -------------------------------------------------------------------------- */
export const ApprovalPrimaryButton = ({
	children,
	disabled = false,
	ariaLabel,
	title,
	onClick,
	/** Show the trailing enter-key hint (lucide CornerDownLeft). */
	showEnterHint = false,
	className = '',
}: CommonProps & { showEnterHint?: boolean }) => (
	<button
		type="button"
		disabled={disabled}
		aria-label={ariaLabel}
		aria-disabled={disabled || undefined}
		title={title}
		onClick={onClick}
		className={`inline-flex items-center justify-center gap-1 px-3 py-[5px] rounded-md text-[11px] font-semibold whitespace-nowrap select-none leading-[16px] transition-[background-color,box-shadow,opacity,transform] duration-150 ease-out outline-none ${disabled ? 'opacity-35 cursor-not-allowed pointer-events-none' : 'active:scale-[0.98] cursor-pointer'} ${className}`}
		style={{
			background: toolApprovalTheme.buttonBg,
			color: toolApprovalTheme.buttonFg,
			border: '1px solid transparent',
			boxShadow: toolApprovalTheme.primaryShadow,
		}}
		onMouseEnter={(e) => {
			if (disabled) return;
			e.currentTarget.style.background = toolApprovalTheme.buttonHover;
			e.currentTarget.style.boxShadow = toolApprovalTheme.primaryShadowHover;
		}}
		onMouseLeave={(e) => {
			if (disabled) return;
			e.currentTarget.style.background = toolApprovalTheme.buttonBg;
			e.currentTarget.style.boxShadow = toolApprovalTheme.primaryShadow;
		}}
		onFocus={(e) => {
			if (disabled) return;
			e.currentTarget.style.boxShadow = `0 0 0 1px ${toolApprovalTheme.focusBorder}, 0 0 0 4px ${toolApprovalTheme.focusRingHalo}`;
		}}
		onBlur={(e) => {
			e.currentTarget.style.boxShadow = toolApprovalTheme.primaryShadow;
		}}
	>
		{children}
		{showEnterHint && (
			<CornerDownLeft
				size={10.5}
				strokeWidth={2.5}
				className="ml-0.5 flex-shrink-0 opacity-60"
				aria-hidden="true"
			/>
		)}
	</button>
);
