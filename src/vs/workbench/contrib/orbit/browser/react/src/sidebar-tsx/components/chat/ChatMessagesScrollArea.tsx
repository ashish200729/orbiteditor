/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useMemo } from 'react';
import { ChatMessage } from '../../../../../../common/chatThreadServiceTypes.js';
import { IsRunningType } from '../../../../../chatThreadService.js';
import { useChatThreadsStreamState } from '../../../util/services.js';
import { ChatScrollActions, ChatScrollPolicy } from '../../utils/scrollUtils.js';
import { ChatScrollContainer } from './ChatScrollContainer.js';
import { SidebarChatMessages } from './SidebarChatMessages.js';
import { StreamingMessagePane } from './StreamingMessagePane.js';
import { TurnAnchorSpacer } from './TurnAnchorSpacer.js';
import { AgentStatusLine } from '../wrappers/AgentStatusLine.js';

export type ChatScrollAreaConfig = {
	containerRef: React.RefObject<HTMLDivElement | null>;
	policy: ChatScrollPolicy;
	actions: ChatScrollActions;
};

type ChatMessagesScrollAreaProps = {
	threadId: string;
	previousMessages: ChatMessage[];
	currCheckpointIdx: number | undefined;
	isRunning: IsRunningType;
	scroll: ChatScrollAreaConfig;
	stickyOffset: number;
	stickyMessageIndex: number | null;
	userMessageIndices: number[];
	streamingChatIdx: number;
	shouldAddGapForStreaming: boolean;
	mcpToolNameSet: Set<string>;
	className: string;
	readOnlyMessageIndices?: ReadonlySet<number>;
	threadMessageIndices?: ReadonlyMap<number, number>;
	remoteTaskFooters?: ReadonlyMap<number, string>;
	workspaceRoot?: string | null;
	/** When set, an AgentStatusLine is rendered for a running remote task that
	 * has no local stream pane (remote tasks don't populate stream state). */
	remoteStatusLineLabel?: string | null;
};

export const ChatMessagesScrollArea = React.memo(({
	threadId,
	previousMessages,
	currCheckpointIdx,
	isRunning,
	scroll,
	stickyOffset,
	stickyMessageIndex,
	userMessageIndices,
	streamingChatIdx,
	shouldAddGapForStreaming,
	mcpToolNameSet,
	className,
	readOnlyMessageIndices,
	threadMessageIndices,
	remoteTaskFooters,
	workspaceRoot,
	remoteStatusLineLabel,
}: ChatMessagesScrollAreaProps) => {
	const streamState = useChatThreadsStreamState(threadId);
	// This length only drives scroll generation (auto-follow while streaming), so it just
	// needs to grow as content arrives. Previously it called JSON.stringify on every tool's rawParams/
	// doneParams on every render (~20x/sec) — for a streaming file write that serialized the entire
	// growing file buffer each time (megabytes/sec of throwaway work), a major freeze source. Instead we
	// sum string-value lengths directly: O(number of params) and zero allocation, while still tracking growth.
	// Keyed on `streamState` so it only recomputes when the stream actually advances — not on
	// unrelated parent re-renders (sticky/scroll ticks) that leave streamState identity intact.
	const streamContentLength = useMemo(() => (streamState?.llmInfo?.displayContentSoFar?.length ?? 0)
		+ (streamState?.llmInfo?.reasoningSoFar?.length ?? 0)
		+ (streamState?.llmInfo?.toolCallsSoFar?.reduce((sum, tool) => {
			let toolLen = (tool.name?.length ?? 0) + (tool.doneParams?.length ?? 0)
			const raw = tool.rawParams as Record<string, unknown> | undefined | null
			if (raw) {
				for (const key in raw) {
					const value = raw[key]
					toolLen += typeof value === 'string' ? value.length : (value == null ? 0 : 1)
				}
			}
			return sum + toolLen
		}, 0) ?? 0), [streamState]);
	const committedContentLength = useMemo(() => previousMessages.reduce((sum, message) => {
		if (message.role === 'user' || message.role === 'assistant') {
			return sum + message.displayContent.length + (message.role === 'assistant' ? message.reasoning.length : 0);
		}
		if (message.role === 'tool') return sum + (message.content?.length ?? 0);
		return sum;
	}, 0), [previousMessages]);

	const scrollGeneration = useMemo(
		() => previousMessages.length + committedContentLength + streamContentLength + (streamState?.isRunning ? 1 : 0),
		[previousMessages.length, committedContentLength, streamContentLength, streamState?.isRunning],
	);

	const hasStreamPane = !!streamState?.isRunning
		|| !!streamState?.error
		|| !!(streamState?.llmInfo?.displayContentSoFar || streamState?.llmInfo?.reasoningSoFar);

	const isHidden = previousMessages.length === 0 && !hasStreamPane

	return (
		<ChatScrollContainer
			scrollContainerRef={scroll.containerRef}
			scrollGeneration={scrollGeneration}
			policy={scroll.policy}
			className={`${className}${isHidden ? ' hidden' : ''}`}
		>
			<SidebarChatMessages
				previousMessages={previousMessages}
				threadId={threadId}
				currCheckpointIdx={currCheckpointIdx}
				isRunning={isRunning}
				scrollContainerRef={scroll.containerRef}
				scrollActions={scroll.actions}
				stickyOffset={stickyOffset}
				stickyMessageIndex={stickyMessageIndex}
				userMessageIndices={userMessageIndices}
				readOnlyMessageIndices={readOnlyMessageIndices}
				threadMessageIndices={threadMessageIndices}
				remoteTaskFooters={remoteTaskFooters}
				workspaceRoot={workspaceRoot}
			/>
		{hasStreamPane ? (
			<StreamingMessagePane
				threadId={threadId}
				streamingChatIdx={streamingChatIdx}
				currCheckpointIdx={currCheckpointIdx}
				shouldAddGapForStreaming={shouldAddGapForStreaming}
				mcpToolNameSet={mcpToolNameSet}
			/>
		) : null}
		{/* Remote task activity indicator — remote runs don't populate local
		 * stream state, so the StreamingMessagePane status line never lights up.
		 * Render a parallel AgentStatusLine so the in-stream "Planning next moves"
		 * shimmer parity holds for Self-hosted Runner runs. */}
		{/* Parent scroll area already applies px-4 — only add vertical rhythm here. */}
		{!hasStreamPane && remoteStatusLineLabel ? (
			<AgentStatusLine label={remoteStatusLineLabel} className='pt-1' />
		) : null}
			{scroll.policy.mode === 'turn-anchor'
				|| (scroll.policy.mode === 'preserve' && scroll.policy.anchorIndex !== null) ? (
				<TurnAnchorSpacer />
			) : null}
		</ChatScrollContainer>
	);
});
