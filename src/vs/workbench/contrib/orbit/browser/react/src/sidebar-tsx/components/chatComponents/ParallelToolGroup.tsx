/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useState, useEffect, useMemo } from 'react';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import { ChatMessage } from '../../../../../../common/chatThreadServiceTypes.js';
import { IsRunningType } from '../../../../../chatThreadService.js';
import { ChatScrollActions } from '../../utils/scrollUtils.js';
import { ChatBubble } from './ChatBubble.js';
import { CollapsibleSection } from '../wrappers/CollapsibleSection.js';

type ParallelToolGroupProps = {
	messages: Array<{ message: ChatMessage, index: number }>,
	previousMessages: ChatMessage[],
	threadId: string,
	currCheckpointIdx: number | undefined,
	isRunning: IsRunningType,
	scrollContainerRef: React.MutableRefObject<HTMLDivElement | null>,
	scrollActions: ChatScrollActions,
}

export const ParallelToolGroup = React.memo(({
	messages,
	previousMessages,
	threadId,
	currCheckpointIdx,
	isRunning,
	scrollActions,
}: ParallelToolGroupProps) => {
	const [isExpanded, setIsExpanded] = useState(true);

	const allToolsCompleted = messages.every(({ index }) => {
		const msg = previousMessages[index];
		// Guard: `index` can go stale after the message list mutates (streaming/branching), leaving
		// `previousMessages[index]` undefined — accessing `.role` unguarded would crash the render.
		if (msg?.role !== 'tool') return false;
		return msg.type === 'success' || msg.type === 'tool_error' || msg.type === 'rejected' || msg.type === 'invalid_params';
	});

	const hasErrors = messages.some(({ index }) => {
		const msg = previousMessages[index];
		return msg?.role === 'tool' && (msg.type === 'tool_error' || msg.type === 'invalid_params');
	});

	const toolStats = messages.reduce((acc, { index }) => {
		const msg = previousMessages[index];
		if (msg?.role === 'tool') {
			if (msg.type === 'success') acc.success++;
			else if (msg.type === 'tool_error') acc.error++;
			else if (msg.type === 'rejected') acc.rejected++;
			else if (msg.type === 'invalid_params') acc.invalid++;
		}
		return acc;
	}, { success: 0, error: 0, rejected: 0, invalid: 0 });

	const [hasCollapsed, setHasCollapsed] = useState(false);
	useEffect(() => {
		if (allToolsCompleted && !hasCollapsed) {
			setIsExpanded(false);
			setHasCollapsed(true);
		}
	}, [allToolsCompleted, hasCollapsed]);

	const generateSummary = (): string => {
		const toolCounts: Record<string, number> = {};

		messages.forEach(({ index }) => {
			const msg = previousMessages[index];
			if (msg?.role === 'tool' && msg.type === 'success') {
				const toolName = (msg as any).name;
				toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;
			}
		});

		const summaryParts: string[] = [];

		const toolNameMap: Record<string, (count: number) => string> = {
			'Read': (count) => `Read ${count} file${count !== 1 ? 's' : ''}`,
			'Glob': (count) => `Globbed ${count} time${count !== 1 ? 's' : ''}`,
			'Grep': (count) => `Grepped ${count} time${count !== 1 ? 's' : ''}`,
			'read_lint_errors': (count) => `Read errors from ${count} file${count !== 1 ? 's' : ''}`,
		};

		Object.entries(toolCounts).forEach(([toolName, count]) => {
			if (toolNameMap[toolName]) {
				summaryParts.push(toolNameMap[toolName](count));
			} else {
				summaryParts.push(`${toolName} (${count})`);
			}
		});

		let summary = summaryParts.length > 0 ? summaryParts.join(', ') : `${messages.length} tool${messages.length !== 1 ? 's' : ''}`;

		const statusParts: string[] = [];
		if (toolStats.error > 0) statusParts.push(`${toolStats.error} failed`);
		if (toolStats.rejected > 0) statusParts.push(`${toolStats.rejected} canceled`);
		if (toolStats.invalid > 0) statusParts.push(`${toolStats.invalid} invalid`);

		if (statusParts.length > 0) {
			summary += ` (${statusParts.join(', ')})`;
		}

		return summary;
	};

	const summary = allToolsCompleted ? generateSummary() : '';
	const showSummaryHeader = allToolsCompleted && messages.length > 0;
	const statsTooltip = `${toolStats.success} succeeded${toolStats.error > 0 ? `, ${toolStats.error} failed` : ''}${toolStats.rejected > 0 ? `, ${toolStats.rejected} canceled` : ''}${toolStats.invalid > 0 ? `, ${toolStats.invalid} invalid` : ''}`;

	const toolList = useMemo(() => (
		<div className="flex flex-col gap-0 min-w-0 w-full">
			{messages.map(({ index, message }) => {
				const messageKey = `tool-${index}-${message.role}-${(message as any).name || 'unknown'}`;

				return (
					<div key={messageKey} className="min-w-0 w-full">
						<ChatBubble
							currCheckpointIdx={currCheckpointIdx}
							chatMessage={previousMessages[index]}
							messageIdx={index}
							isCommitted={true}
							chatIsRunning={isRunning}
							threadId={threadId}
							scrollActions={scrollActions}
							toolRenderCompact={true}
						/>
					</div>
				);
			})}
		</div>
	), [messages, previousMessages, currCheckpointIdx, isRunning, threadId, scrollActions]);

	return (
		<div className="flex flex-col my-0.5 min-w-0 w-full">
			{showSummaryHeader && (
				<button
					type="button"
					className="
						group flex items-center gap-1.5 w-full min-w-0
						text-[12px] font-medium cursor-pointer select-none
						text-void-fg-4 opacity-70 hover:opacity-100
						transition-opacity duration-150 ease-out
						bg-transparent border-none p-0 py-0.5 text-left
					"
					onClick={() => setIsExpanded(v => !v)}
					data-tooltip-id='void-tooltip'
					data-tooltip-content={statsTooltip}
					data-tooltip-place='top'
				>
					<ChevronRight
						size={10}
						strokeWidth={2.5}
						className={`
							flex-shrink-0 text-void-fg-4/40
							transition-transform duration-200 ease-out
							${isExpanded ? 'rotate-90 text-void-fg-4/60' : 'group-hover:opacity-100'}
						`}
						aria-hidden="true"
					/>
					<span className="truncate flex items-center gap-1.5 min-w-0 flex-1">
						{hasErrors && <AlertTriangle size={11} className="flex-shrink-0 opacity-80" />}
						<span className="truncate">{summary}</span>
					</span>
				</button>
			)}

			{allToolsCompleted ? (
				<CollapsibleSection isOpen={isExpanded} className="min-w-0 w-full">
					{toolList}
				</CollapsibleSection>
			) : (
				<div className="min-w-0 w-full">
					{toolList}
				</div>
			)}
		</div>
	);
});