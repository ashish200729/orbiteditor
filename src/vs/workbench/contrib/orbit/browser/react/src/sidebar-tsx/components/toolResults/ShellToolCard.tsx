/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Terminal, Check, AlertTriangle, Clock, Zap, MoreHorizontal, Square } from 'lucide-react';
import { ToolMessage } from '../../../../../../common/chatThreadServiceTypes.js';
import { useAccessor, useChatThreadsStreamState } from '../../../util/services.js';
import { EditToolCardWrapper } from '../editTool/EditToolCardWrapper.js';
import { TextShimmer } from '../../../util/TextShimmer.js';
import { CopyButton } from '../../../markdown/ApplyBlockHoverButtons.js';
import {
	getShellCardCommandLine,
	getShellCardMetaTags,
	getShellCardOutput,
	getShellCardStatus,
	getShellCardTitle,
	ShellCommandHighlight,
	ShellOutputLine,
	formatShellToolErrorResult,
} from './shellToolCardHelpers.js';
import { useIsReadOnlyChat } from '../../contexts/ReadOnlyChatContext.js';
import { CollapsibleSection } from '../wrappers/CollapsibleSection.js';

type ShellToolCardProps = {
	toolMessage: Exclude<ToolMessage<'Shell' | 'AwaitShell'>, { type: 'invalid_params' }>;
	threadId: string;
};

const StatusIcon = ({ icon, size = 12 }: { icon: NonNullable<ReturnType<typeof getShellCardStatus>>['icon']; size?: number }) => {
	switch (icon) {
		case 'success':
			return <Check size={size} className="text-[#98C379] flex-shrink-0" strokeWidth={2.5} />;
		case 'error':
			return <AlertTriangle size={size} className="text-[#E06C75] flex-shrink-0" strokeWidth={2.5} />;
		case 'background':
			return <Zap size={size} className="text-[#E5C07B] flex-shrink-0" strokeWidth={2.5} />;
		case 'timeout':
		case 'sleep':
			return <Clock size={size} className="text-[#E5C07B] flex-shrink-0" strokeWidth={2.5} />;
		case 'pattern':
			return <Check size={size} className="text-[#61AFEF] flex-shrink-0" strokeWidth={2.5} />;
		case 'running':
		default:
			return null;
	}
};

/** Formats a millisecond count compactly for the header status badge (1234 -> "1.2s"). */
const formatMsCompact = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

/**
 * Reduces a full status line (from getShellCardStatus) to a few characters for the header
 * badge. Purely a display transform — the full text is always still shown via the badge's
 * title tooltip, so this never hides information, just de-emphasizes it inline.
 */
const shortenShellStatus = (text: string): string => {
	let m: RegExpMatchArray | null;
	if ((m = text.match(/^Finished · exit code (\d+)$/))) return m[1] === '0' ? '' : `exit ${m[1]}`;
	if ((m = text.match(/^Still running after (\d+)ms$/))) return formatMsCompact(Number(m[1]));
	if ((m = text.match(/^Still running · (\d+)ms$/))) return formatMsCompact(Number(m[1]));
	if ((m = text.match(/^Running in background(?: · pid (\d+))?$/))) return m[1] ? `pid ${m[1]}` : 'bg';
	if ((m = text.match(/^Released to background · (\d+)ms$/))) return 'bg';
	if ((m = text.match(/^Pattern matched · (\d+)ms$/))) return formatMsCompact(Number(m[1]));
	if ((m = text.match(/^Waited (\d+)ms$/))) return formatMsCompact(Number(m[1]));
	if (text === 'Command failed') return 'Failed';
	if (text === 'Canceled') return 'Canceled';
	return text.length > 14 ? '' : text;
};

const ShellStopButton = ({ onClick }: { onClick: () => void }) => (
	<button
		type="button"
		className="flex-shrink-0 w-[22px] h-[22px] rounded-full border border-void-fg-1/20 flex items-center justify-center opacity-70 hover:opacity-100 hover:border-void-fg-1/35 hover:bg-void-fg-1/5 transition-all"
		onClick={(e) => { e.stopPropagation(); onClick(); }}
		title="Stop"
		aria-label="Stop command"
	>
		<Square size={9} className="text-void-fg-2 fill-void-fg-2" strokeWidth={0} />
	</button>
);

const ShellMetaTags = ({ tags }: { tags: string[] }) => {
	if (tags.length === 0) return null;
	return (
		<div className="flex items-center gap-1 flex-shrink-0 overflow-hidden">
			{tags.map((tag, i) => (
				<span
					key={`${tag}-${i}`}
					className="text-[10px] px-1 py-px rounded font-medium whitespace-nowrap text-void-fg-4/65"
					style={{
						background: 'rgba(128, 128, 128, 0.08)',
						border: '1px solid rgba(var(--vscode-void-border-3-rgb, 64, 64, 64), 0.2)',
					}}
				>
					{tag}
				</span>
			))}
		</div>
	);
};

const ShellWaitingFooter = ({
	waitingCount,
	onRunInBackground,
}: {
	waitingCount: number;
	onRunInBackground: () => void;
}) => (
	<div className="flex items-center gap-1.5 mt-1.5 px-0.5 text-[11px] text-void-fg-4/70">
		<span>
			Waiting for {waitingCount} command{waitingCount === 1 ? '' : 's'} to finish
		</span>
		<button
			type="button"
			className="text-void-fg-4/80 hover:text-void-fg-2 transition-colors"
			onClick={onRunInBackground}
		>
			Run in background
		</button>
	</div>
);

export const ShellToolCard = ({ toolMessage, threadId }: ShellToolCardProps) => {
	const accessor = useAccessor();
	const isReadOnlyChat = useIsReadOnlyChat();
	const terminalToolsService = accessor.get('ITerminalToolService');
	const toolsService = accessor.get('IToolsService');
	const chatThreadsService = accessor.get('IChatThreadService');

	const streamState = useChatThreadsStreamState(threadId);
	const outputRef = useRef<HTMLDivElement>(null);

	const toolName = toolMessage.name as 'Shell' | 'AwaitShell';
	const params = toolMessage.params;

	const isRunning = toolMessage.type === 'running_now';
	const isError = toolMessage.type === 'tool_error';
	const isRejected = toolMessage.type === 'rejected';
	const isSuccess = toolMessage.type === 'success';

	const shellId = useMemo(() => {
		if (toolName === 'Shell') {
			const shellParams = params as ToolMessage<'Shell'>['params'];
			if (toolMessage.type === 'success') {
				const result = toolMessage.result;
				return result.shellId ?? shellParams.shellId;
			}
			return shellParams.shellId;
		}
		return (params as ToolMessage<'AwaitShell'>['params']).shellId;
	}, [toolMessage, params, toolName]);

	const [liveOutput, setLiveOutput] = useState('');
	// Expand by default while the command is RUNNING (so the command line + live
	// streaming output are visible during execution, Cursor-style) and when it has
	// finished (success/error). A collapsed running card shows only a thin header
	// with no command/output, which reads as "nothing rendered" while streaming.
	const [isExpanded, setIsExpanded] = useState(() => isRunning || isSuccess || isError);

	const title = useMemo(() => getShellCardTitle(toolName, params), [toolName, params]);
	const metaTags = useMemo(() => getShellCardMetaTags(toolName, params), [toolName, params]);
	const commandLine = useMemo(() => getShellCardCommandLine(toolName, params), [toolName, params]);

	const resultString = useMemo(() => {
		if (toolMessage.type !== 'success') return '';
		return toolsService.stringOfResult[toolName](params as any, toolMessage.result as any);
	}, [toolMessage, params, toolName, toolsService]);

	const outputText = useMemo(() => {
		if (toolMessage.type === 'tool_request') return '';
		return getShellCardOutput(toolMessage, liveOutput, resultString);
	}, [toolMessage, liveOutput, resultString]);

	const statusLine = useMemo(() => {
		if (toolMessage.type === 'tool_request') return null;
		return getShellCardStatus(toolName, toolMessage);
	}, [toolMessage, toolName]);

	const shortStatus = useMemo(() => (statusLine ? shortenShellStatus(statusLine.text) : ''), [statusLine]);

	const isBlockingAgent = useMemo(() => {
		if (!isRunning || streamState?.isRunning !== 'tool') return false;
		return streamState.toolInfo?.id === toolMessage.id
			&& (streamState.toolInfo?.toolName === 'Shell' || streamState.toolInfo?.toolName === 'AwaitShell');
	}, [isRunning, streamState, toolMessage.id]);

	const showWaitingFooter = isBlockingAgent && !isReadOnlyChat;
	const hasExpandableContent = !!(commandLine || outputText.trim() || isRunning);
	const showBody = isExpanded && hasExpandableContent;

	useEffect(() => {
		if (isSuccess && outputText.trim()) setIsExpanded(true);
	}, [isSuccess, outputText]);

	// Auto-expand the moment the command starts running (fires once on the
	// transition into running; the user can still collapse it afterwards).
	useEffect(() => {
		if (isRunning) setIsExpanded(true);
	}, [isRunning]);

	// Live output polling only while expanded and running (local terminal path).
	// Remote/read-only turns never set streamState isRunning === 'tool' — skip poll.
	useEffect(() => {
		if (isReadOnlyChat) return;
		if (!isRunning || !isExpanded || !shellId) return;
		if (streamState?.isRunning !== 'tool') return;

		let cancelled = false;
		const poll = async () => {
			try {
				const text = await terminalToolsService.readShell(shellId);
				if (!cancelled) setLiveOutput(text);
			} catch {
				// shell may not be ready yet
			}
		};

		void poll();
		const interval = setInterval(() => { void poll(); }, 450);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [isRunning, isExpanded, shellId, streamState?.isRunning, terminalToolsService, isReadOnlyChat]);

	useEffect(() => {
		if (!isRunning || !isExpanded || !outputRef.current) return;
		outputRef.current.scrollTop = outputRef.current.scrollHeight;
	}, [outputText, isRunning, isExpanded]);

	const focusShell = useCallback(() => {
		if (shellId) void terminalToolsService.focusShell(shellId);
	}, [shellId, terminalToolsService]);

	const stopCommand = useCallback(async () => {
		await chatThreadsService.abortRunning(threadId);
	}, [chatThreadsService, threadId]);

	const runInBackground = useCallback(() => {
		chatThreadsService.releaseRunningShellToBackground(threadId);
	}, [chatThreadsService, threadId]);

	if (toolMessage.type === 'tool_request') return null;

	const errorText = isError ? formatShellToolErrorResult(toolMessage.result) : '';
	// For tool_error, getShellCardOutput already returns the error string as
	// outputText, so prefer errorText (and avoid duplicating it) when present.
	const copyText = [commandLine ? `$ ${commandLine}` : '', errorText || outputText].filter(Boolean).join('\n\n');

	const headerTitle = isRunning ? (
		<TextShimmer duration={1.5} className="text-[12px] font-medium truncate text-void-fg-4/90 min-w-0">
			{title}
		</TextShimmer>
	) : (
		<span className={`text-[12px] font-medium text-void-fg-2/90 truncate min-w-0 ${isRejected ? 'line-through opacity-70' : ''}`}>
			{title}
		</span>
	);

	const toggleExpanded = hasExpandableContent ? () => setIsExpanded(v => !v) : undefined;

	return (
		<div className="orbit-card-enter w-full">
			<EditToolCardWrapper
				isRunning={isRunning}
				className={isRejected ? 'opacity-70' : ''}
			>
				<div
					className={`edit-tool-card-header flex items-center justify-between gap-2 px-3 py-2 select-none group ${hasExpandableContent ? 'cursor-pointer' : ''}`}
					onClick={toggleExpanded}
					style={{
						borderBottom: showBody
							? '1px solid rgba(var(--vscode-void-border-3-rgb, 64, 64, 64), 0.15)'
							: 'none',
						minHeight: '32px',
					}}
				>
					<div className="edit-tool-card-header-main flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
						{hasExpandableContent && (
							<ChevronRight
								size={10}
								strokeWidth={2.5}
								className={`text-void-fg-4/40 flex-shrink-0 transition-all duration-200 ease-out ${showBody ? 'rotate-90 text-void-fg-4/60' : 'opacity-0 group-hover:opacity-100'}`}
							/>
						)}
						<Terminal size={14} className="text-void-fg-4/55 flex-shrink-0" strokeWidth={2} />
						{headerTitle}
						<ShellMetaTags tags={metaTags} />
					</div>

					<div className="flex items-center gap-1 flex-shrink-0 ml-auto">
						{!isRunning && statusLine && (
							<span
								className="flex items-center gap-1 flex-shrink-0 text-[10px] font-mono text-void-fg-4/70"
								title={statusLine.text}
							>
								<StatusIcon icon={statusLine.icon} />
								{shortStatus && <span>{shortStatus}</span>}
							</span>
						)}
						{copyText && !isRunning && (
							<div className="opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
								<CopyButton codeStr={copyText} toolTipName="Copy output" />
							</div>
						)}
						{shellId && (
							<button
								type="button"
								className="p-0.5 rounded opacity-40 hover:opacity-100 hover:bg-void-fg-1/5 transition-all"
								onClick={(e) => { e.stopPropagation(); focusShell(); }}
								title="Focus terminal"
							>
								<MoreHorizontal size={14} className="text-void-fg-4" />
							</button>
						)}
						{isRunning && isBlockingAgent && !isReadOnlyChat && (
							<ShellStopButton onClick={stopCommand} />
						)}
					</div>
				</div>

				{/* Window-agnostic expand/collapse. Framer's `height: 'auto'` measures via
				    the bundle's main-window getComputedStyle, so it collapses to height 0
				    inside the standalone Agents pop-out (aux window) and hides the output.
				    CollapsibleSection uses a grid-rows transition with zero JS measurement. */}
				<CollapsibleSection isOpen={showBody} duration={0.2}>
					<div
						ref={outputRef}
						className="font-mono text-[11px] leading-[1.5] px-3 py-2 max-h-[140px] overflow-y-auto overflow-x-auto void-custom-scrollable"
						style={{
							background: 'rgba(var(--vscode-void-bg-2-rgb, 16, 16, 16), 0.35)',
						}}
					>
						{commandLine && (
							<div className={`text-[11.5px] whitespace-pre ${(outputText.trim() || errorText) ? 'mb-1.5' : ''}`}>
								<span className="text-void-fg-4/70 select-none">$ </span>
								<ShellCommandHighlight command={commandLine} />
							</div>
						)}

						{(!errorText && isRunning && isExpanded && !outputText.trim()) && (
							<div className="text-void-fg-4/55 italic">Running command…</div>
						)}

						{(!errorText && ((outputText.trim() && !isRunning) || (isRunning && isExpanded && outputText.trim()))) &&
							outputText.split('\n').map((line, idx) => (
								<ShellOutputLine key={idx} line={line} />
							))}

						{errorText && (
							<div className="text-[#E06C75]/90 whitespace-pre-wrap break-words">
								{errorText}
							</div>
						)}
					</div>
				</CollapsibleSection>
			</EditToolCardWrapper>

			{showWaitingFooter && (
				<ShellWaitingFooter waitingCount={1} onRunInBackground={runInBackground} />
			)}
		</div>
	);
};
