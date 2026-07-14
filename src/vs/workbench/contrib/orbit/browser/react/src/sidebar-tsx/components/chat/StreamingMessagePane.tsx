/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback } from 'react';
import { useAccessor, useChatThreadsStreamState } from '../../../util/services.js';
import { RawToolCallObj } from '../../../../../../common/sendLLMMessageTypes.js';
import { isRenderableStreamingToolCall } from '../../utils/streamingToolRenderFilter.js';
import ErrorBoundary from '../../ErrorBoundary.js';
import { ChatBubble } from '../chatComponents/ChatBubble.js';
import { StreamingTool } from '../toolResults/StreamingTool.js';
import { AgentStatusLine } from '../wrappers/AgentStatusLine.js';
import { ErrorDisplay } from '../../ErrorDisplay.js';
import { WarningBox } from '../../../orbit-settings-tsx/WarningBox.js';
import { VOID_OPEN_SETTINGS_ACTION_ID } from '../../../../../orbitSettingsPane.js';

type StreamingMessagePaneProps = {
	threadId: string;
	streamingChatIdx: number;
	currCheckpointIdx: number | undefined;
	shouldAddGapForStreaming: boolean;
	mcpToolNameSet: Set<string>;
};

export const StreamingMessagePane = React.memo(({
	threadId,
	streamingChatIdx,
	currCheckpointIdx,
	shouldAddGapForStreaming,
	mcpToolNameSet,
}: StreamingMessagePaneProps) => {
	const accessor = useAccessor();
	const commandService = accessor.get('ICommandService');
	const chatThreadsService = accessor.get('IChatThreadService');

	const currThreadStreamState = useChatThreadsStreamState(threadId);
	const isRunning = currThreadStreamState?.isRunning;
	const latestError = currThreadStreamState?.error;
	const { displayContentSoFar, toolCallSoFar, toolCallsSoFar, reasoningSoFar } = currThreadStreamState?.llmInfo ?? {};

	const isRenderableStreamingTool = useCallback((tool: RawToolCallObj | null | undefined) => {
		return isRenderableStreamingToolCall(tool, { mcpToolNames: mcpToolNameSet });
	}, [mcpToolNameSet]);

	const rawStreamingTools = (toolCallsSoFar && toolCallsSoFar.length > 0)
		? toolCallsSoFar
		: (toolCallSoFar ? [toolCallSoFar] : []);

	const streamingToolsToRender = rawStreamingTools.filter(isRenderableStreamingTool);
	const toolIsGenerating = streamingToolsToRender.some(tool => !tool.isDone);
	const hasVisibleStreamingContent = !!(displayContentSoFar || reasoningSoFar);
	const isAwaitingUserAction = isRunning === 'awaiting_user';
	const isWaitingForAIResponse = !!isRunning && !hasVisibleStreamingContent && !toolIsGenerating && !isAwaitingUserAction;

	const currStreamingMessageHTML = (reasoningSoFar || displayContentSoFar) ?
		<div className={shouldAddGapForStreaming ? 'mt-2' : ''}>
			<ChatBubble
				key={'curr-streaming-msg'}
				currCheckpointIdx={currCheckpointIdx}
				chatMessage={{
					role: 'assistant',
					displayContent: displayContentSoFar ?? '',
					reasoning: reasoningSoFar ?? '',
					anthropicReasoning: null,
				}}
				messageIdx={streamingChatIdx}
				isCommitted={false}
				chatIsRunning={isRunning}
				threadId={threadId}
				scrollActions={null}
			/>
		</div> : null;

	const generatingTools = streamingToolsToRender.map((tool, i) => {
		const toolKey = tool.id
			? `streaming-${tool.id}`
			: (tool.name ? `streaming-${tool.name}-${i}` : `streaming-unknown-${i}`);

		return (
			<ErrorBoundary key={toolKey}>
				<StreamingTool toolCallSoFar={tool} />
			</ErrorBoundary>
		);
	});

	// The "Open settings" link only helps for auth/config problems. Transient network
	// or server errors shouldn't push the user toward settings, so gate the link.
	const isConfigError = (() => {
		if (!latestError) return false;
		const fe = latestError.fullError as { status?: number; statusCode?: number } | null;
		const status = fe?.status ?? fe?.statusCode;
		if (status === 401 || status === 403) return true;
		const text = `${latestError.message ?? ''} ${(latestError.fullError as Error | null)?.message ?? ''}`.toLowerCase();
		return /\bapi key\b|apikey|unauthor|forbidden|invalid api|authenticat|not configured|missing api|credential|no api key|sign in|log in/.test(text);
	})();

	if (!currStreamingMessageHTML && generatingTools.length === 0 && !isWaitingForAIResponse && latestError === undefined) {
		return null;
	}

	return (
		<>
			{currStreamingMessageHTML}
			{generatingTools}
			{isWaitingForAIResponse ? <AgentStatusLine label="Planning next moves" /> : null}
			{latestError === undefined ? null :
				<div className='px-2 my-1.5 min-w-0'>
					<ErrorDisplay
						message={latestError.message}
						fullError={latestError.fullError}
						onDismiss={() => { chatThreadsService.dismissStreamError(threadId) }}
						showDismiss={true}
					/>
					{isConfigError && (
						<WarningBox className='text-sm my-2 mx-4' onClick={() => { commandService.executeCommand(VOID_OPEN_SETTINGS_ACTION_ID) }} text='Open settings' />
					)}
				</div>
			}
		</>
	);
});