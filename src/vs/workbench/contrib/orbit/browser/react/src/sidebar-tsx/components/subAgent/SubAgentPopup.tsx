/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Check, X } from 'lucide-react';
import { ChatMessage } from '../../../../../../common/chatThreadServiceTypes.js';
import { useAccessor, useChatThreadsStreamState, useIsDark, useToolProgressOverlay } from '../../../util/services.js';
import { useConnectedDocument } from '../../contexts/ConnectedWindowContext.js';
import { focusInConnectedWindow } from '../../../util/helpers.js';
import { TextShimmer } from '../../../util/TextShimmer.js';
import { ButtonStop } from '../buttons/ButtonStop.js';
import { ChatBubble } from '../chatComponents/ChatBubble.js';
import { ReadOnlyChatProvider } from '../../contexts/ReadOnlyChatContext.js';
import { SubAgentRunningIcon } from './SubAgentRunningIcon.js';
import {
	computeSubAgentExplorationStats,
	formatExplorationStatsLine,
	formatSubAgentLiveStatus,
} from './subAgentConversationHelpers.js';

export type SubAgentPopupStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type SubAgentPopupProps = {
	toolId: string;
	threadId: string;
	title: string;
	isOpen: boolean;
	isRunning: boolean;
	status: SubAgentPopupStatus;
	fallbackPrompt?: string;
	conversation?: readonly ChatMessage[];
	onClose: () => void;
	onStop?: () => void;
};

const PANEL_WIDTH = 380;
const PANEL_MAX_HEIGHT = 440;

const vscode = {
	panelBg: 'var(--vscode-editor-background, #1e1e1e)',
	headerBg: 'var(--vscode-sideBar-background, #252526)',
	fg: 'var(--vscode-editor-foreground, #cccccc)',
	fgMuted: 'var(--vscode-descriptionForeground, #9d9d9d)',
	border: 'var(--vscode-widget-border, #454545)',
} as const;

const StatusBadge = ({ status }: { status: SubAgentPopupStatus }) => {
	if (status === 'running') {
		return (
			<span className="inline-flex items-center gap-1.5 text-[11px] text-void-fg-3">
				<SubAgentRunningIcon size={12} />
				<span>Running</span>
			</span>
		);
	}
	if (status === 'failed' || status === 'cancelled') {
		return (
			<span className="inline-flex items-center gap-1 text-[11px]" style={{ color: '#E06C75' }}>
				<X size={12} strokeWidth={2.5} />
				<span>{status === 'failed' ? 'Failed' : 'Stopped'}</span>
			</span>
		);
	}
	return (
		<span className="inline-flex items-center gap-1 text-[11px]" style={{ color: '#98C379' }}>
			<Check size={12} strokeWidth={2.5} />
			<span>Done</span>
		</span>
	);
};

const PromptBlock = ({ prompt }: { prompt: string }) => (
	<div
		className="rounded-lg px-3 py-2.5 mb-3"
		style={{
			backgroundColor: 'var(--vscode-input-background, #3c3c3c)',
			border: `1px solid ${vscode.border}`,
		}}
	>
		<div
			className="text-[10px] font-medium uppercase tracking-wide mb-1"
			style={{ color: vscode.fgMuted }}
		>
			Prompt
		</div>
		<div
			className="text-[12px] leading-relaxed whitespace-pre-wrap break-words"
			style={{ color: vscode.fg }}
		>
			{prompt}
		</div>
	</div>
);

const SubAgentConversationBody = ({
	messages,
	threadId,
	isRunning,
	liveActivity,
	fallbackPrompt,
}: {
	messages: readonly ChatMessage[];
	threadId: string;
	isRunning: boolean;
	liveActivity?: string;
	fallbackPrompt?: string;
}) => {
	const accessor = useAccessor();

	const stats = useMemo(() => computeSubAgentExplorationStats(messages), [messages]);
	const statsLine = formatExplorationStatsLine(stats);

	const lastAssistantIdx = useMemo(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === 'assistant') return i;
		}
		return -1;
	}, [messages]);

	const promptText = useMemo(() => {
		const userMsg = messages.find((m): m is ChatMessage & { role: 'user' } => m.role === 'user');
		return userMsg?.displayContent || userMsg?.content || fallbackPrompt || '';
	}, [messages, fallbackPrompt]);

	const renderedMessages = useMemo(() => {
		const elements: React.ReactNode[] = [];
		let userPromptRendered = false;
		let messageIdx = 0;

		if (promptText && messages.length === 0) {
			elements.push(<PromptBlock key="fallback-prompt" prompt={promptText} />);
		}

		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			if (msg.role === 'user') {
				if (!userPromptRendered) {
					userPromptRendered = true;
					elements.push(
						<PromptBlock key={`prompt-${i}`} prompt={msg.displayContent || msg.content} />
					);
				}
				continue;
			}
			if (msg.role === 'assistant') {
				elements.push(
					<div key={`assistant-${i}`} className="mb-2">
						<ChatBubble
							chatMessage={msg}
							messageIdx={messageIdx++}
							isCommitted={!isRunning || i !== lastAssistantIdx}
							chatIsRunning={isRunning && i === lastAssistantIdx ? 'LLM' : undefined}
							threadId={threadId}
							currCheckpointIdx={undefined}
							scrollActions={null}
						/>
					</div>
				);
				continue;
			}
			if (msg.role === 'tool') {
				if (msg.name === 'task') continue;
				elements.push(
					<div key={`tool-${msg.id}-${i}`} className="mb-1">
						<ChatBubble
							chatMessage={msg}
							messageIdx={messageIdx++}
							isCommitted={msg.type !== 'running_now'}
							chatIsRunning={msg.type === 'running_now' ? 'tool' : undefined}
							threadId={threadId}
							currCheckpointIdx={undefined}
							scrollActions={null}
						/>
					</div>
				);
			}
		}

		if (!userPromptRendered && fallbackPrompt) {
			elements.unshift(<PromptBlock key="fallback-prompt-late" prompt={fallbackPrompt} />);
		}

		return elements;
	}, [messages, threadId, isRunning, lastAssistantIdx, fallbackPrompt, promptText]);

	const liveStatus = formatSubAgentLiveStatus({
		liveActivity,
		conversation: messages,
		accessor,
		isRunning,
	});

	return (
		<div className="flex flex-col">
			{renderedMessages}

			{statsLine && !isRunning && (
				<div className="text-[11px] pt-2 mt-1" style={{ color: vscode.fgMuted }}>
					{statsLine}
				</div>
			)}

			{isRunning && liveStatus && (
				<div
					className="flex items-center gap-2 mt-3 pt-2.5"
					style={{ borderTop: `1px solid ${vscode.border}` }}
				>
					<SubAgentRunningIcon size={12} />
					<TextShimmer duration={2.2} spread={2} className="text-[11px] text-void-fg-3">
						{liveStatus}
					</TextShimmer>
				</div>
			)}
		</div>
	);
};

export const SubAgentPopup = ({
	toolId,
	threadId,
	title,
	isOpen,
	isRunning,
	status,
	fallbackPrompt,
	conversation,
	onClose,
	onStop,
}: SubAgentPopupProps) => {
	const isDark = useIsDark();
	// The document this popup is painted in (pop-out when hosted there). Portal, global listeners
	// and activeElement checks must use this rather than the global (main-window) document.
	const doc = useConnectedDocument();
	const streamState = useChatThreadsStreamState(threadId);
	const toolProgressOverlay = useToolProgressOverlay(threadId);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const dialogRef = useRef<HTMLDivElement | null>(null);
	const closeButtonRef = useRef<HTMLButtonElement | null>(null);

	const liveActivity = streamState?.toolProgressById?.[toolId] ?? toolProgressOverlay?.[toolId];
	const messages = conversation ?? [];

	const handleKeyDown = useCallback((e: KeyboardEvent) => {
		if (e.key === 'Escape') onClose();
	}, [onClose]);

	useEffect(() => {
		if (!isOpen) return;
		doc.addEventListener('keydown', handleKeyDown);
		return () => doc.removeEventListener('keydown', handleKeyDown);
	}, [isOpen, handleKeyDown, doc]);

	useEffect(() => {
		if (!isOpen) return;
		// focusInConnectedWindow keeps the pop-out frontmost (a bare .focus() would raise the
		// main IDE window, since these nodes report ownerDocument === main).
		focusInConnectedWindow(closeButtonRef.current);
	}, [isOpen]);

	useEffect(() => {
		if (!isOpen) return;
		const trapFocus = (e: KeyboardEvent) => {
			if (e.key !== 'Tab' || !dialogRef.current) return;
			const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
				'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
			);
			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (e.shiftKey && doc.activeElement === first) {
				e.preventDefault();
				focusInConnectedWindow(last);
			} else if (!e.shiftKey && doc.activeElement === last) {
				e.preventDefault();
				focusInConnectedWindow(first);
			}
		};
		doc.addEventListener('keydown', trapFocus);
		return () => doc.removeEventListener('keydown', trapFocus);
	}, [isOpen, doc]);

	useEffect(() => {
		if (!isOpen || !contentRef.current) return;
		contentRef.current.scrollTop = contentRef.current.scrollHeight;
	}, [isOpen, messages.length, liveActivity]);

	if (!isOpen) return null;

	const panel = (
		<div className={`@@void-scope ${isDark ? 'dark' : ''}`}>
			<div
				className="fixed inset-0"
				style={{
					zIndex: 100000,
					backgroundColor: 'rgba(0, 0, 0, 0.6)',
					backdropFilter: 'blur(3px)',
				}}
				onClick={onClose}
				aria-hidden="true"
			/>

			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-label={title}
				className="fixed flex flex-col rounded-xl overflow-hidden"
				style={{
					zIndex: 100001,
					left: '50%',
					top: '50%',
					transform: 'translate(-50%, -50%)',
					width: `min(${PANEL_WIDTH}px, calc(100vw - 40px))`,
					maxHeight: `min(${PANEL_MAX_HEIGHT}px, calc(100vh - 64px))`,
					backgroundColor: vscode.panelBg,
					border: `1px solid ${vscode.border}`,
					boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)',
					color: vscode.fg,
				}}
				onClick={(e) => e.stopPropagation()}
			>
				<div
					className="flex items-center gap-2 px-3.5 py-2.5 flex-shrink-0"
					style={{
						backgroundColor: vscode.headerBg,
						borderBottom: `1px solid ${vscode.border}`,
					}}
				>
					<div className="flex-1 min-w-0">
						<div className="text-[13px] font-medium truncate" style={{ color: vscode.fg }}>
							{title}
						</div>
						<div className="mt-0.5">
							<StatusBadge status={status} />
						</div>
					</div>
					<div className="flex items-center gap-1.5 flex-shrink-0">
						{isRunning && onStop && (
							<ButtonStop onClick={onStop} />
						)}
						<button
							ref={closeButtonRef}
							type="button"
							className="flex-shrink-0 p-1 rounded-md transition-colors hover:bg-white/[0.06]"
							style={{ color: vscode.fgMuted }}
							onClick={onClose}
							title="Close"
							aria-label="Close"
						>
							<X size={15} strokeWidth={2} />
						</button>
					</div>
				</div>

				<div
					ref={contentRef}
					className="flex-1 min-h-0 overflow-y-auto void-custom-scrollable px-3.5 py-3"
					style={{ backgroundColor: vscode.panelBg }}
				>
					<ReadOnlyChatProvider>
						{messages.length > 0 || fallbackPrompt ? (
							<SubAgentConversationBody
								messages={messages}
								threadId={threadId}
								isRunning={isRunning}
								liveActivity={liveActivity}
								fallbackPrompt={fallbackPrompt}
							/>
						) : (
							<div className="text-[12px] py-6 text-center" style={{ color: vscode.fgMuted }}>
								{isRunning ? (
									<span className="inline-flex items-center gap-2">
										<SubAgentRunningIcon size={12} />
										<TextShimmer duration={2.2} spread={2}>Starting sub-agent…</TextShimmer>
									</span>
								) : (
									'No conversation recorded for this sub-agent.'
								)}
							</div>
						)}
					</ReadOnlyChatProvider>
				</div>
			</div>
		</div>
	);

	return createPortal(panel, doc.body);
};
