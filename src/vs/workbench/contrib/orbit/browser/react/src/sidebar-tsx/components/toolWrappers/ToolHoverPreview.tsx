/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getConnectedDocument, getConnectedWindow } from '../../contexts/ConnectedWindowContext.js';

export type ToolHoverPreviewItem = {
	name: React.ReactNode;
	onClick?: () => void;
};

type ToolHoverPreviewProps = {
	label: React.ReactNode;
	items: ToolHoverPreviewItem[];
	totalCount?: number;
	hasMore?: boolean;
	maxPreview?: number;
	className?: string;
};

const PREVIEW_MAX = 6;
const POPUP_WIDTH = 280;
const POPUP_MAX_HEIGHT = 200;

export const ToolHoverPreview = ({
	label,
	items,
	totalCount,
	hasMore = false,
	maxPreview = PREVIEW_MAX,
	className = '',
}: ToolHoverPreviewProps) => {
	const [isOpen, setIsOpen] = useState(false);
	const [position, setPosition] = useState({ top: 0, left: 0, showAbove: false });
	const anchorRef = useRef<HTMLSpanElement>(null);
	const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const count = totalCount ?? items.length;
	const previewItems = items.slice(0, maxPreview);
	const remaining = Math.max(0, count - previewItems.length);

	const updatePosition = useCallback(() => {
		const el = anchorRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		// Resolve the window this anchor is actually painted in (the pop-out when hosted there),
		// so viewport clamping uses the correct dimensions.
		const win = getConnectedWindow(el);

		let left = Math.max(8, rect.left);
		if (left + POPUP_WIDTH > win.innerWidth - 8) {
			left = Math.max(8, win.innerWidth - POPUP_WIDTH - 8);
		}

		const spaceBelow = win.innerHeight - rect.bottom;
		const showAbove = spaceBelow < POPUP_MAX_HEIGHT && rect.top > POPUP_MAX_HEIGHT;
		const top = showAbove ? rect.top - 4 : rect.bottom + 4;

		setPosition({ top, left, showAbove });
	}, []);

	const open = useCallback(() => {
		if (closeTimerRef.current) {
			clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
		updatePosition();
		setIsOpen(true);
	}, [updatePosition]);

	const scheduleClose = useCallback(() => {
		if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
		closeTimerRef.current = setTimeout(() => setIsOpen(false), 150);
	}, []);

	useEffect(() => {
		if (!isOpen) return;
		const win = getConnectedWindow(anchorRef.current);
		const onScroll = () => updatePosition();
		win.addEventListener('scroll', onScroll, true);
		win.addEventListener('resize', onScroll);
		return () => {
			win.removeEventListener('scroll', onScroll, true);
			win.removeEventListener('resize', onScroll);
		};
	}, [isOpen, updatePosition]);

	useEffect(() => () => {
		if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
	}, []);

	if (previewItems.length === 0 && count === 0) {
		return <span className={`text-void-fg-4 opacity-50 truncate text-[12px] ${className}`}>{label}</span>;
	}

	const popup = isOpen ? createPortal(
		<div
			className="fixed z-[99999] pointer-events-auto"
			style={{
				top: position.top,
				left: position.left,
				maxWidth: POPUP_WIDTH,
				transform: position.showAbove ? 'translateY(-100%)' : undefined,
			}}
			onMouseEnter={open}
			onMouseLeave={scheduleClose}
		>
			<div
				className="
					rounded-md border border-void-border-3/40
					bg-[var(--vscode-editor-background)]
					shadow-lg shadow-black/25
					py-1.5 px-0 min-w-[180px] max-w-[280px]
				"
			>
				<div className="px-2.5 pb-1 text-[10px] font-medium text-void-fg-4/60 uppercase tracking-wide">
					{count}{hasMore ? '+' : ''} result{count !== 1 ? 's' : ''}
				</div>
				<div className="flex flex-col gap-0 max-h-[160px] overflow-y-auto void-custom-scrollable">
					{previewItems.map((item, i) => (
						<button
							key={i}
							type="button"
							className="
								w-full text-left px-2.5 py-1 text-[11px] text-void-fg-3
								hover:bg-void-bg-2-alt/50 transition-colors truncate
								bg-transparent border-none cursor-pointer
							"
							onClick={(e) => {
								e.stopPropagation();
								item.onClick?.();
							}}
						>
							{item.name}
						</button>
					))}
				</div>
				{(remaining > 0 || hasMore) && (
					<div className="px-2.5 pt-1 pb-0.5 text-[10px] text-void-fg-4/50 italic border-t border-void-border-3/20 mt-1">
						{remaining > 0 ? `+ ${remaining} more` : ''}{remaining > 0 && hasMore ? ' · ' : ''}{hasMore ? 'truncated' : ''}
					</div>
				)}
			</div>
		</div>,
		getConnectedDocument(anchorRef.current).body,
	) : null;

	return (
		<>
			<span
				ref={anchorRef}
				className={`
					inline max-w-full truncate text-void-fg-4 opacity-60 truncate text-[12px]
					cursor-default hover:opacity-90 transition-opacity duration-150
					border-b border-dotted border-void-fg-4/30
					${className}
				`}
				onMouseEnter={open}
				onMouseLeave={scheduleClose}
				onClick={(e) => e.stopPropagation()}
			>
				{label}
			</span>
			{popup}
		</>
	);
};