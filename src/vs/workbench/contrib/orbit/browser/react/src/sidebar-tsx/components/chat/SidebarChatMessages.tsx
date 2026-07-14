/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useMemo } from 'react';
import { ChatMessage } from '../../../../../../common/chatThreadServiceTypes.js';
import { isABuiltinToolName } from '../../../../../../common/prompt/prompts.js';
import { useTodoContext } from '../../contexts/TodoContext.js';
import { ChatBubble } from '../chatComponents/ChatBubble.js';
import { ParallelToolGroup } from '../chatComponents/ParallelToolGroup.js';
import { IsRunningType } from '../../../../chatThreadService.js';
import { ChatScrollActions } from '../../utils/scrollUtils.js';

type SidebarChatMessagesProps = {
	previousMessages: ChatMessage[];
	threadId: string;
	currCheckpointIdx: number | undefined;
	isRunning: IsRunningType;
	scrollContainerRef: React.RefObject<HTMLDivElement | null>;
	scrollActions: ChatScrollActions;
	stickyOffset: number;
	stickyMessageIndex: number | null;
	userMessageIndices: number[];
};

export const SidebarChatMessages = ({
	previousMessages,
	threadId,
	currCheckpointIdx,
	isRunning,
	scrollContainerRef,
	scrollActions,
	stickyOffset,
	stickyMessageIndex,
	userMessageIndices,
}: SidebarChatMessagesProps) => {
	const { liveTodos } = useTodoContext();
	const lastUserMessageIndex = userMessageIndices.length > 0
		? userMessageIndices[userMessageIndices.length - 1]
		: null;

	// Heavy pass: build the bubble content for every message. Deliberately excludes the sticky
	// props from its deps — sticky state changes on every scroll tick, and rebuilding each bubble
	// element per tick reconciles the entire thread. The cheap wrapper pass below re-applies
	// sticky styling; bubble element identity is preserved so React bails out of their subtrees.
	const messageItems = useMemo(() => {
		const PARALLEL_TOOLS = ['Read', 'Glob', 'Grep', 'read_lint_errors'] as const;

		const isParallelTool = (msg: ChatMessage): boolean => {
			return msg.role === 'tool'
				&& msg.type !== 'invalid_params'
				&& msg.type !== 'tool_request'
				&& isABuiltinToolName(msg.name)
				&& PARALLEL_TOOLS.includes(msg.name as typeof PARALLEL_TOOLS[number]);
		};

		const groupedMessages: Array<
			| { type: 'single'; message: ChatMessage; index: number }
			| { type: 'parallel'; messages: Array<{ message: ChatMessage; index: number }> }
		> = [];
		let currentParallelGroup: Array<{ message: ChatMessage; index: number }> = [];

		const closeCurrentGroup = () => {
			if (currentParallelGroup.length > 0) {
				groupedMessages.push({ type: 'parallel', messages: [...currentParallelGroup] });
			}
			currentParallelGroup = [];
		};

		let userMessageCount = 0;

		for (let i = 0; i < previousMessages.length; i++) {
			const message = previousMessages[i];

			// Checkpoints are rendered inline above their associated user message
			if (message.role === 'checkpoint') {
				continue;
			}

			if (isParallelTool(message)) {
				currentParallelGroup.push({ message, index: i });
				const nextIndex = i + 1;
				if (nextIndex < previousMessages.length) {
					const nextMsg = previousMessages[nextIndex];
					const shouldCloseGroup = !isParallelTool(nextMsg)
						|| nextMsg.role === 'user'
						|| nextMsg.role === 'assistant'
						|| nextMsg.role === 'checkpoint';
					if (shouldCloseGroup) {
						closeCurrentGroup();
					}
				} else {
					closeCurrentGroup();
				}
			} else {
				closeCurrentGroup();
				groupedMessages.push({ type: 'single', message, index: i });
			}
		}
		closeCurrentGroup();

		return groupedMessages.map((group) => {
			if (group.type === 'single') {
				const i = group.index;
				const previousMessage = i > 0 ? previousMessages[i - 1] : null;
				const previousRole = previousMessage?.role;
				const currentRole = group.message.role;
				const shouldAddGap = (previousRole === 'user' && currentRole === 'assistant')
					|| (previousRole === 'assistant' && currentRole === 'user');
				const isUserMessage = group.message.role === 'user';
				const showTodoOnMessage = isUserMessage
					&& i === lastUserMessageIndex
					&& liveTodos.length > 0;
				const checkpointBeforeIdx = isUserMessage && i > 0 && previousMessages[i - 1]?.role === 'checkpoint'
					? i - 1
					: undefined;
				const isFirstUserMessage = isUserMessage && userMessageCount === 0;
				if (isUserMessage) {
					userMessageCount += 1;
				}

				return {
					key: `msg-${i}-${group.message.role}`,
					index: i as number | undefined,
					role: group.message.role as string | undefined,
					shouldAddGap,
					isUserMessage,
					bubble: (
						<ChatBubble
							currCheckpointIdx={currCheckpointIdx}
							checkpointBeforeIdx={checkpointBeforeIdx}
							isFirstUserMessage={isFirstUserMessage}
							chatMessage={group.message}
							messageIdx={i}
							isCommitted={true}
							chatIsRunning={isRunning}
							threadId={threadId}
							scrollActions={scrollActions}
							threadTodos={showTodoOnMessage ? liveTodos : undefined}
							isAgentRunning={showTodoOnMessage ? !!isRunning : undefined}
						/>
					),
				};
			}

			const groupKey = `parallel-${group.messages.map(m => m.index).join('-')}`;
			return {
				key: groupKey,
				index: undefined as number | undefined,
				role: undefined as string | undefined,
				shouldAddGap: false,
				isUserMessage: false,
				bubble: (
					<ParallelToolGroup
						messages={group.messages}
						previousMessages={previousMessages}
						threadId={threadId}
						currCheckpointIdx={currCheckpointIdx}
						isRunning={isRunning}
						scrollContainerRef={scrollContainerRef}
						scrollActions={scrollActions}
					/>
				),
			};
		});
	}, [
		previousMessages,
		threadId,
		currCheckpointIdx,
		isRunning,
		scrollActions,
		liveTodos,
		lastUserMessageIndex,
		scrollContainerRef,
	]);

	// Cheap pass: only the wrapper divs are recreated when sticky state changes on scroll.
	return <>{messageItems.map(item => {
		const isThisStickyMessage = item.isUserMessage && item.index !== undefined && stickyMessageIndex === item.index;
		return (
			<div
				key={item.key}
				data-message-index={item.index}
				data-role={item.role}
				className={`${item.shouldAddGap ? 'mt-2' : ''}${isThisStickyMessage ? ' sticky' : ''}`}
				style={isThisStickyMessage ? {
					top: `${stickyOffset}px`,
					backgroundColor: 'var(--vscode-editor-background)',
					zIndex: 20,
					boxShadow: '0 2px 8px -2px rgba(0, 0, 0, 0.15)',
				} : undefined}
			>
				{item.bubble}
			</div>
		);
	})}</>;
};
