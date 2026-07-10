/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { ApprovalGhostButton } from '../../toolApproval/ApprovalButton.js';

/** VS Code–aligned tokens for AskQuestion surfaces */
export const askQuestionTheme = {
	panelBg: 'var(--vscode-sideBar-background, var(--vscode-editor-background))',
	panelBorder: 'var(--vscode-panel-border)',
	descFg: 'var(--vscode-descriptionForeground)',
	fg: 'var(--vscode-foreground)',
	hoverBg: 'var(--vscode-list-hoverBackground)',
	selectedBg: 'var(--vscode-list-activeSelectionBackground)',
	selectedFg: 'var(--vscode-list-activeSelectionForeground)',
	focusBorder: 'var(--vscode-focusBorder)',
	buttonBg: 'var(--vscode-button-background)',
	buttonFg: 'var(--vscode-button-foreground)',
	buttonHover: 'var(--vscode-button-hoverBackground)',
	inputBg: 'var(--vscode-input-background)',
	inputBorder: 'var(--vscode-input-border, var(--vscode-panel-border))',
	toolbarHover: 'var(--vscode-toolbar-hoverBackground)',
	subtleDivider: 'rgba(var(--vscode-void-border-3-rgb, 64, 64, 64), 0.2)',
} as const;

export const KbdHint = ({ children }: { children: React.ReactNode }) => (
	<kbd
		className="inline-flex items-center justify-center min-w-[1.25rem] px-1 py-px rounded text-[10px] font-sans leading-none"
		style={{
			color: askQuestionTheme.descFg,
			background: 'rgba(128, 128, 128, 0.12)',
			border: `1px solid ${askQuestionTheme.subtleDivider}`,
		}}
	>
		{children}
	</kbd>
);

export const AskQuestionProgress = ({
	activeIndex,
	total,
	onStepClick,
	isInteractive = true,
}: {
	activeIndex: number;
	total: number;
	/** Jump to a previous step (index must be < activeIndex). */
	onStepClick?: (index: number) => void;
	isInteractive?: boolean;
}) => {
	if (total <= 1) {
		return null;
	}
	return (
		<div className="flex items-center gap-2 flex-shrink-0" aria-label={`Question ${activeIndex + 1} of ${total}`}>
			<div className="flex items-center gap-1">
				{Array.from({ length: total }, (_, i) => {
					const isCurrent = i === activeIndex;
					const isPast = i < activeIndex;
					const canJump = isInteractive && isPast && !!onStepClick;
					const DotTag = canJump ? 'button' : 'span';
					return (
						<DotTag
							key={i}
							type={canJump ? 'button' : undefined}
							disabled={canJump ? false : undefined}
							title={canJump ? `Go back to question ${i + 1}` : undefined}
							aria-label={canJump ? `Go back to question ${i + 1}` : isCurrent ? `Question ${i + 1} (current)` : `Question ${i + 1}`}
							onClick={canJump ? () => onStepClick!(i) : undefined}
							className={`rounded-full transition-all duration-200 ${canJump ? 'cursor-pointer hover:opacity-100' : ''}`}
							style={{
								width: isCurrent ? 14 : 5,
								height: 5,
								padding: 0,
								border: 'none',
								background: isCurrent
									? askQuestionTheme.focusBorder
									: isPast
										? 'rgba(128, 128, 128, 0.35)'
										: 'rgba(128, 128, 128, 0.15)',
								opacity: i <= activeIndex ? (canJump ? 0.85 : 1) : 0.7,
							}}
							onMouseEnter={canJump ? (e) => {
								(e.currentTarget as HTMLElement).style.background = askQuestionTheme.focusBorder;
								(e.currentTarget as HTMLElement).style.opacity = '1';
							} : undefined}
							onMouseLeave={canJump ? (e) => {
								(e.currentTarget as HTMLElement).style.background = 'rgba(128, 128, 128, 0.35)';
								(e.currentTarget as HTMLElement).style.opacity = '0.85';
							} : undefined}
						/>
					);
				})}
			</div>
			<span
				className="text-[11px] tabular-nums"
				style={{ color: askQuestionTheme.descFg }}
			>
				{activeIndex + 1} / {total}
			</span>
		</div>
	);
};

export const AskQuestionBackButton = ({
	disabled,
	onClick,
	label,
}: {
	disabled: boolean;
	onClick: () => void;
	label: string;
}) => (
	<ApprovalGhostButton
		disabled={disabled}
		onClick={onClick}
		ariaLabel="Go back to previous question"
	>
		<ChevronLeft size={13} strokeWidth={2.25} className="flex-shrink-0 opacity-80" />
		<span>{label}</span>
		<KbdHint>←</KbdHint>
	</ApprovalGhostButton>
);

type OptionRowProps = {
	letter: string;
	label: string;
	isSelected: boolean;
	isInteractive: boolean;
	isOther?: boolean;
	onClick: () => void;
};

export const AskQuestionOptionRow = ({
	letter,
	label,
	isSelected,
	isInteractive,
	isOther = false,
	onClick,
}: OptionRowProps) => {
	const [isHovered, setIsHovered] = useState(false);

	const showHover = isInteractive && isHovered && !isSelected;
	const rowBg = isSelected
		? askQuestionTheme.selectedBg
		: showHover
			? askQuestionTheme.hoverBg
			: 'transparent';
	const rowColor = isSelected ? askQuestionTheme.selectedFg : askQuestionTheme.fg;
	const badgeBg = isSelected
		? askQuestionTheme.focusBorder
		: showHover
			? 'rgba(128, 128, 128, 0.14)'
			: 'rgba(128, 128, 128, 0.08)';
	const badgeColor = isSelected ? askQuestionTheme.buttonFg : askQuestionTheme.descFg;
	const borderColor = isSelected
		? askQuestionTheme.focusBorder
		: showHover
			? 'rgba(128, 128, 128, 0.22)'
			: 'transparent';

	return (
		<button
			type="button"
			disabled={!isInteractive}
			onClick={onClick}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
			className="w-full flex items-center gap-2.5 py-2 px-2.5 rounded-md text-left transition-[background-color,border-color,box-shadow] duration-150 ease-out"
			style={{
				background: rowBg,
				color: rowColor,
				border: `1px solid ${borderColor}`,
				boxShadow: isSelected ? '0 0 0 1px rgba(0,0,0,0.04)' : undefined,
				cursor: isInteractive ? 'pointer' : 'default',
				opacity: isInteractive ? 1 : 0.55,
			}}
		>
			<span
				className="flex-shrink-0 w-[22px] h-[22px] flex items-center justify-center text-[10.5px] font-semibold rounded-md transition-colors duration-150"
				style={{
					background: badgeBg,
					color: badgeColor,
				}}
			>
				{letter}
			</span>
			<span
				className={`flex-1 min-w-0 leading-snug text-[12.5px] ${isOther && !isSelected ? 'opacity-80' : ''}`}
			>
				{label}
			</span>
		</button>
	);
};

export const AskQuestionOtherInput = ({
	value,
	disabled,
	placeholder,
	onChange,
	onEnter,
	onBack,
}: {
	value: string;
	disabled: boolean;
	placeholder: string;
	onChange: (v: string) => void;
	onEnter: () => void;
	onBack?: () => void;
}) => (
	<input
		autoFocus
		type="text"
		placeholder={placeholder}
		value={value}
		disabled={disabled}
		onChange={(e) => onChange(e.target.value)}
		onKeyDown={(e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				onEnter();
			} else if (e.key === 'ArrowLeft' && !value.trim() && onBack) {
				e.preventDefault();
				onBack();
			}
		}}
		className="w-full rounded-md px-2.5 py-2 text-[12.5px] outline-none transition-[border-color,box-shadow] duration-150"
		style={{
			marginLeft: '1.875rem',
			maxWidth: 'calc(100% - 1.875rem)',
			color: askQuestionTheme.fg,
			background: askQuestionTheme.inputBg,
			border: `1px solid ${askQuestionTheme.inputBorder}`,
		}}
		onFocus={(e) => {
			e.currentTarget.style.borderColor = askQuestionTheme.focusBorder;
			e.currentTarget.style.boxShadow = `0 0 0 1px ${askQuestionTheme.focusBorder}`;
		}}
		onBlur={(e) => {
			e.currentTarget.style.borderColor = askQuestionTheme.inputBorder;
			e.currentTarget.style.boxShadow = 'none';
		}}
	/>
);