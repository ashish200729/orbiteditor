/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { toolApprovalTheme } from './toolApprovalTheme.js';

/**
 * Card container for the unified tool approval surface.
 *
 * Three zones — header, body (preview), footer (actions) — wrapped in a
 * bordered card that highlights when `isActive` (i.e. this card's tool is
 * the one currently awaiting the user). Mirrors the visual language of
 * `EditToolCardWrapper` + `AskQuestionCard`.
 */
export type ToolApprovalCardShellProps = {
	/** Header row: icon + title. */
	header: React.ReactNode;
	/** Tool-specific preview body (command, params, etc). */
	children?: React.ReactNode;
	/** Footer: approve/deny actions + auto-approve toggle. */
	footer?: React.ReactNode;
	/** When true, the card shows the active focus border (pending tool matches). */
	isActive?: boolean;
	/** Extra className for the outer wrapper. */
	className?: string;
};

export const ToolApprovalCardShell = React.memo(({
	header,
	children,
	footer,
	isActive = false,
	className = '',
}: ToolApprovalCardShellProps) => {
	return (
		<div
			className={`relative my-1 overflow-hidden transition-all duration-200 ease-out ${className}`}
			style={{
				borderRadius: '8px',
				border: '1px solid',
				borderColor: isActive
					? toolApprovalTheme.panelBorderActive
					: toolApprovalTheme.panelBorder,
				background: toolApprovalTheme.panelBg,
				transition: 'border-color 200ms ease-out, background 200ms ease-out',
			}}
		>
			{header}
			{children && (
				<div
					style={{ borderTop: `1px solid ${toolApprovalTheme.subtleDivider}` }}
				>
					{children}
				</div>
			)}
			{footer && (
				<div
					style={{ borderTop: `1px solid ${toolApprovalTheme.subtleDivider}` }}
				>
					{footer}
				</div>
			)}
		</div>
	);
});