/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useMemo, useRef } from 'react';
import { ChatMessage } from '../../../../../../common/chatThreadServiceTypes.js';
import { isABuiltinToolName } from '../../../../../../common/prompt/prompts.js';
import { useTodoContext } from '../../contexts/TodoContext.js';
import { ChatBubble } from '../chatComponents/ChatBubble.js';
import { ParallelToolGroup } from '../chatComponents/ParallelToolGroup.js';
import { IsRunningType } from '../../../../chatThreadService.js';
import { ChatScrollActions } from '../../utils/scrollUtils.js';
import { ReadOnlyChatProvider } from '../../contexts/ReadOnlyChatContext.js';
import { RemoteTaskInlineCard } from '../runner/RemoteTaskInlineCard.js';

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
	readOnlyMessageIndices?: ReadonlySet<number>;
	threadMessageIndices?: ReadonlyMap<number, number>;
	remoteTaskFooters?: ReadonlyMap<number, string>;
	workspaceRoot?: string | null;
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
	readOnlyMessageIndices,
	threadMessageIndices,
	remoteTaskFooters,
	workspaceRoot,
}: SidebarChatMessagesProps) => {
	const { liveTodos } = useTodoContext();
	const lastUserMessageIndex = [...userMessageIndices].reverse()
		.find(index => !readOnlyMessageIndices?.has(index)) ?? null;

	// Only entrance-animate messages appended after a thread is first opened — reopening/switching
	// to a thread with existing history should render it instantly, not replay every past message.
	const newMessageBaselineRef = useRef(previousMessages.length);
	const baselineThreadIdRef = useRef(threadId);
	if (baselineThreadIdRef.current !== threadId) {
		baselineThreadIdRef.current = threadId;
		newMessageBaselineRef.current = previousMessages.length;
	}

	// Heavy pass: build the bubble content for every message. Deliberately excludes the sticky
	// props from its deps — sticky state changes on every scroll tick, and rebuilding each bubble
	// element per tick reconciles the entire thread. The cheap wrapper pass below re-applies
	// sticky styling; bubble element identity is preserved so React bails out of their subtrees.
	const messageItems = useMemo(() => {
		const PARALLEL_TOOLS = ['Read', 'Glob', 'Grep', 'read_lint_errors'] as const;

		const isParallelTool = (msg: ChatMessage, _index: number): boolean => {
			return msg.role === 'tool'
				&& msg.name !== 'RemoteSetup'
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

			if (isParallelTool(message, i)) {
				currentParallelGroup.push({ message, index: i });
				const nextIndex = i + 1;
				if (nextIndex < previousMessages.length) {
					const nextMsg = previousMessages[nextIndex];
					const shouldCloseGroup = !isParallelTool(nextMsg, nextIndex)
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
				const threadMessageIdx = threadMessageIndices?.get(i) ?? i;
				const previousMessage = i > 0 ? previousMessages[i - 1] : null;
				const previousRole = previousMessage?.role;
				const currentRole = group.message.role;
				const shouldAddGap = (previousRole === 'user' && currentRole === 'assistant')
					|| (previousRole === 'assistant' && currentRole === 'user');
				const isUserMessage = group.message.role === 'user';
				const showTodoOnMessage = isUserMessage
					&& i === lastUserMessageIndex
					&& liveTodos.length > 0;
				const previousThreadIdx = i > 0 ? threadMessageIndices?.get(i - 1) : undefined;
				const checkpointBeforeIdx = isUserMessage && i > 0 && previousMessages[i - 1]?.role === 'checkpoint' && previousThreadIdx === threadMessageIdx - 1
					? threadMessageIdx - 1
					: undefined;
				const isLocalUserMessage = isUserMessage && !readOnlyMessageIndices?.has(i);
				const isFirstUserMessage = isLocalUserMessage && userMessageCount === 0;
				if (isLocalUserMessage) {
					userMessageCount += 1;
				}

				const bubble = <ChatBubble
					currCheckpointIdx={readOnlyMessageIndices?.has(i) ? undefined : currCheckpointIdx}
					checkpointBeforeIdx={readOnlyMessageIndices?.has(i) ? undefined : checkpointBeforeIdx}
					isFirstUserMessage={readOnlyMessageIndices?.has(i) ? false : isFirstUserMessage}
					chatMessage={group.message}
					messageIdx={threadMessageIdx}
					isCommitted={true}
					chatIsRunning={readOnlyMessageIndices?.has(i) ? undefined : isRunning}
					threadId={threadId}
					scrollActions={readOnlyMessageIndices?.has(i) ? null : scrollActions}
					threadTodos={readOnlyMessageIndices?.has(i) ? undefined : (showTodoOnMessage ? liveTodos : undefined)}
					isAgentRunning={readOnlyMessageIndices?.has(i) ? undefined : (showTodoOnMessage ? !!isRunning : undefined)}
				/>;

				return {
					key: `msg-${i}-${group.message.role}-${group.message.role === 'tool' ? group.message.id : ''}`,
					index: i as number | undefined,
					firstIndex: i,
					role: group.message.role as string | undefined,
					shouldAddGap,
					isUserMessage,
					bubble: readOnlyMessageIndices?.has(i)
						? <ReadOnlyChatProvider>{bubble}</ReadOnlyChatProvider>
						: bubble,
				};
			}

			const groupKey = `parallel-${group.messages.map(m => m.message.role === 'tool' ? m.message.id : m.index).join('-')}`;
			const groupIsReadOnly = group.messages.some(item => readOnlyMessageIndices?.has(item.index));
			const parallelBubble = (
				<ParallelToolGroup
					messages={group.messages.map(item => ({
						...item,
						threadIndex: threadMessageIndices?.get(item.index) ?? item.index,
					}))}
					threadId={threadId}
					currCheckpointIdx={groupIsReadOnly ? undefined : currCheckpointIdx}
					isRunning={groupIsReadOnly ? undefined : isRunning}
					scrollContainerRef={scrollContainerRef}
					scrollActions={scrollActions}
					animateEntrance={group.messages[0].index >= newMessageBaselineRef.current}
				/>
			);
			return {
				key: groupKey,
				index: undefined as number | undefined,
				firstIndex: group.messages[0].index,
				role: undefined as string | undefined,
				shouldAddGap: false,
				isUserMessage: false,
				bubble: groupIsReadOnly
					? <ReadOnlyChatProvider>{parallelBubble}</ReadOnlyChatProvider>
					: parallelBubble,
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
		readOnlyMessageIndices,
		threadMessageIndices,
	]);

	// Cheap pass: only the wrapper divs are recreated when sticky state changes on scroll.
	return <>{messageItems.map(item => {
		const isThisStickyMessage = item.isUserMessage && item.index !== undefined && stickyMessageIndex === item.index;
		const isNewSinceOpen = item.firstIndex >= newMessageBaselineRef.current;
		const footerTaskId = item.index !== undefined ? remoteTaskFooters?.get(item.index) : undefined;
		return (
			<div
				key={item.key}
				data-message-index={item.index}
				data-role={item.role}
				className={`${item.shouldAddGap ? 'mt-2' : ''}${isThisStickyMessage ? ' sticky' : ''}${isNewSinceOpen ? ' orbit-card-enter' : ''}`}
				style={isThisStickyMessage ? {
					top: `${stickyOffset}px`,
					zIndex: 20,
				} : undefined}
			>
				{item.bubble}
				{footerTaskId && (
					<RemoteTaskInlineCard taskId={footerTaskId} workspaceRoot={workspaceRoot ?? null} />
				)}
			</div>
		);
	})}</>;
};
