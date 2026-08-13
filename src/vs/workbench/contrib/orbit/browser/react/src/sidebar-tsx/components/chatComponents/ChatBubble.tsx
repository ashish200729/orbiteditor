/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { ChatMessage, TodoItem } from '../../../../../../common/chatThreadServiceTypes.js';
import { BuiltinToolName } from '../../../../../../common/toolsServiceTypes.js';
import { IsRunningType } from '../../../../../chatThreadService.js';
import { isLLMHiddenBuiltinToolName, resolveBuiltinToolNameLoose } from '../../../../../../common/prompt/prompts.js';
import ErrorBoundary from '../../ErrorBoundary.js';
import { UserMessageComponent } from '../messages/UserMessageComponent.js';
import { AssistantMessageComponent } from '../messages/AssistantMessageComponent.js';
import { InvalidTool } from '../toolResults/InvalidTool.js';
import { CanceledTool } from '../toolResults/CanceledTool.js';
import { PendingToolRequest } from './PendingToolRequest.js';

import { GenericToolWrapper } from '../toolResults/GenericToolWrapper.js';
import { BrowserMcpToolWrapper, isOrbitIdeBrowserTool } from '../toolResults/BrowserMcpToolWrapper.js';
import { RemoteSetupCard, isRemoteSetupTool } from '../runner/RemoteSetupCard.js';
import { builtinToolNameToComponent, LEGACY_TOOL_NAME_MAP } from '../../constants/builtinToolNameToComponent.js';
import { getRemovedDirectoryListingToolRenderer } from '../../constants/legacyRemovedDirectoryToolRenderers.js';
import { getRemovedBrowserToolRenderer } from '../../constants/legacyRemovedBrowserToolRenderers.js';
import { ResultWrapper } from '../../types/toolWrapperTypes.js';
import { ChatScrollActions } from '../../utils/scrollUtils.js';
import { useIsReadOnlyChat } from '../../contexts/ReadOnlyChatContext.js';

export type ChatBubbleProps = {
	chatMessage: ChatMessage,
	messageIdx: number,
	isCommitted: boolean,
	chatIsRunning: IsRunningType,
	threadId: string,
	currCheckpointIdx: number | undefined,
	checkpointBeforeIdx?: number | undefined,
	isFirstUserMessage?: boolean,
	scrollActions: ChatScrollActions | null,
	threadTodos?: TodoItem[],
	isAgentRunning?: boolean,
	/** Flat one-line tool rows inside parallel groups */
	toolRenderCompact?: boolean,
}

export const ChatBubble = (props: ChatBubbleProps) => {
	const selectable = props.chatMessage.role === 'tool';
	const content = <ErrorBoundary><_ChatBubble {...props} /></ErrorBoundary>;
	if (!selectable) return content;
	return <div
		data-orbit-chat-selectable={selectable ? '' : undefined}
		data-orbit-quote-source={selectable ? 'tool' : undefined}
		data-orbit-thread-id={selectable ? props.threadId : undefined}
		data-orbit-message-idx={selectable ? props.messageIdx : undefined}
	>{content}</div>
}

const _ChatBubble = React.memo(({ threadId, chatMessage, currCheckpointIdx, checkpointBeforeIdx, isFirstUserMessage, isCommitted, messageIdx, chatIsRunning, scrollActions, threadTodos, isAgentRunning, toolRenderCompact }: ChatBubbleProps) => {
	const role = chatMessage.role
	const isReadOnlyChat = useIsReadOnlyChat()

	const isCheckpointGhost = messageIdx > (currCheckpointIdx ?? Infinity) && !chatIsRunning

	if (role === 'user') {
		if (isReadOnlyChat) {
			// Match local UserMessageComponent display chrome (radius/border/padding).
			return <div data-role='user' data-message-source='self-hosted-runner' className='relative break-words w-full'>
				<div className='text-left rounded-xl max-w-full relative p-2 flex flex-col bg-vscode-input-bg text-void-fg-1 overflow-x-auto border border-void-border-2 shadow-sm'>
					<div className='px-0.5 whitespace-pre-wrap leading-relaxed' style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
						{chatMessage.displayContent || chatMessage.content || ''}
					</div>
				</div>
			</div>
		}
		return <UserMessageComponent
			chatMessage={chatMessage}
			isCheckpointGhost={isCheckpointGhost}
			currCheckpointIdx={currCheckpointIdx}
			checkpointBeforeIdx={checkpointBeforeIdx}
			isFirstUserMessage={isFirstUserMessage ?? false}
			threadId={threadId}
			messageIdx={messageIdx}
			scrollActions={scrollActions}
			threadTodos={threadTodos}
			isAgentRunning={isAgentRunning}
		/>
	}
	else if (role === 'assistant') {
		return <AssistantMessageComponent
			chatMessage={chatMessage}
			isCheckpointGhost={isCheckpointGhost}
			messageIdx={messageIdx}
			isCommitted={isCommitted}
			threadId={threadId}
		/>
	}
	else if (role === 'tool') {
		// Handle invalid params case first
		if (chatMessage.type === 'invalid_params') {
			return <div className={`${isCheckpointGhost ? 'opacity-50' : ''}`}>
				<InvalidTool toolName={chatMessage.name} message={chatMessage.content} mcpServerName={chatMessage.mcpServerName} />
			</div>
		}

		// Self-hosted runner approvals are owned by RemoteTaskInlineCard — hide local
		// PendingToolRequest / EditTool approve chrome so tools don't flash a second UI.
		if (isReadOnlyChat && chatMessage.type === 'tool_request' && !isRemoteSetupTool(chatMessage)) {
			return null
		}

		// Apply-patch UX lives on RemoteTaskInlineCard — suppress the raw GenericTool dump.
		if (isReadOnlyChat && !chatMessage.mcpServerName && chatMessage.name === 'RemotePatch') {
			return null
		}

		// Determine tool type and get appropriate wrapper
		const toolName = chatMessage.name
		
		// Check if this is a builtin tool (by resolved name or direct match)
		const isBlockedHiddenBuiltinError = !chatMessage.mcpServerName && chatMessage.type === 'tool_error' && isLLMHiddenBuiltinToolName(toolName)
		const legacyMappedName = !chatMessage.mcpServerName ? LEGACY_TOOL_NAME_MAP[toolName] : undefined
		const resolvedBuiltinName = !chatMessage.mcpServerName && !isBlockedHiddenBuiltinError ? (legacyMappedName ?? resolveBuiltinToolNameLoose(toolName)) : undefined
		const componentToolName = resolvedBuiltinName
		const effectiveToolName = componentToolName ?? toolName
		const isBuiltInTool = !!componentToolName
		
		// Prepare tool message for rendering (normalize name if it's a builtin)
		const toolMessageForRender = chatMessage

		// Get the appropriate wrapper component
		let ToolResultWrapper: ResultWrapper<string> | undefined
		
		const removedDirectoryRenderer = !chatMessage.mcpServerName
			? getRemovedDirectoryListingToolRenderer(toolName)
			: undefined
		const removedBrowserRenderer = !chatMessage.mcpServerName
			? getRemovedBrowserToolRenderer(toolName)
			: undefined

		if (removedDirectoryRenderer) {
			ToolResultWrapper = removedDirectoryRenderer
		} else if (removedBrowserRenderer) {
			ToolResultWrapper = removedBrowserRenderer
		} else if (isRemoteSetupTool(chatMessage)) {
			// Self-hosted provisioning / clone status — same card while live and after materialize.
			ToolResultWrapper = RemoteSetupCard as ResultWrapper<string>
		} else if (isBuiltInTool) {
			// Use the same specialized cards/headers as local agents during live remote turns.
			// ReadOnlyChatProvider still disables apply/approve/abort actions.
			const toolComponent = builtinToolNameToComponent[componentToolName as BuiltinToolName]
			ToolResultWrapper = toolComponent?.resultWrapper as ResultWrapper<string> | undefined
		} else if (isOrbitIdeBrowserTool(chatMessage)) {
			ToolResultWrapper = BrowserMcpToolWrapper as ResultWrapper<string>
		} else {
			ToolResultWrapper = GenericToolWrapper as ResultWrapper<string>
		}

		// Render tool with error boundary
		if (!ToolResultWrapper) {
			console.warn(`No tool wrapper found for tool: ${toolName}, falling back to generic`)
			ToolResultWrapper = GenericToolWrapper as ResultWrapper<string>
		}

		// StrReplace/Write (and legacy edit tools) use card design for tool_request
		const useCardDesignForToolRequest =
			componentToolName === 'StrReplace'
			|| componentToolName === 'Write'
			|| componentToolName === 'AskQuestion'

		return (
			<div className={`transition-opacity duration-300 ease-in-out ${isCheckpointGhost ? 'opacity-50' : 'opacity-100'}`}>
				<ErrorBoundary>
					{chatMessage.type === 'tool_request' && !useCardDesignForToolRequest
						? <PendingToolRequest toolMessage={toolMessageForRender} threadId={threadId} />
						: <ToolResultWrapper
							toolMessage={toolMessageForRender}
							messageIdx={messageIdx}
							threadId={threadId}
							compact={toolRenderCompact}
						/>
					}
				</ErrorBoundary>
			</div>
		)
	}

	else if (role === 'interrupted_streaming_tool') {
		return <div className={`${isCheckpointGhost ? 'opacity-50' : ''}`}>
			<CanceledTool toolName={chatMessage.name} mcpServerName={chatMessage.mcpServerName} />
		</div>
	}

	return null;

});
