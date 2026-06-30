/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { URI } from '../../../../../../../../base/common/uri.js';
import { BuiltinToolName } from '../../../../../common/toolsServiceTypes.js';

import { useAccessor, useChatThreadsStreamState, useToolProgressOverlay } from '../../util/services.js';
import { getTitle, toolNameToDesc, getToolStatusIconMeta } from './toolHelpers.js';
import { ToolHeaderWrapper, ToolHeaderParams } from '../components/toolHeaders/ToolHeaderWrapper.js';
import { loadingTitleWrapper } from './toolTitles.js';
import { ToolChildrenWrapper } from '../components/toolWrappers/ToolChildrenWrapper.js';
import { TaskToolResult } from '../components/subAgent/TaskToolResult.js';

import { SmallProseWrapper } from '../components/wrappers/SmallProseWrapper.js';
import { ChatMarkdownRender } from '../../markdown/ChatMarkdownRender.js';
import { voidOpenFileFn, getRelative, getBasename } from '../utils/fileUtils.js';
import { EditTool } from '../components/editTool/EditTool.js';
import { ShellToolCard } from '../components/toolResults/ShellToolCard.js';
import { PlanCard } from '../components/toolResults/PlanCard.js';

import { ToolHoverPreview } from '../components/toolWrappers/ToolHoverPreview.js';
import { ResultWrapper } from '../types/toolWrapperTypes.js';
import { TodoToolWithState } from '../components/toolResults/TodoTool.js';
import { AskQuestionToolWithState } from '../components/toolResults/AskQuestion/AskQuestionTool.js';
import { computeTodoListBeforeMessage } from '../components/toolResults/todo/todoState.js';

/** Maps legacy tool names from older chat threads to current builtin tool renderers. */
export const LEGACY_TOOL_NAME_MAP: Record<string, BuiltinToolName> = {
	'edit_file': 'StrReplace',
	'rewrite_file': 'Write',
	'create_file_or_folder': 'Write',
}

export const resolveBuiltinToolComponentName = (toolName: string): BuiltinToolName | undefined => {
	if (toolName in LEGACY_TOOL_NAME_MAP) {
		return LEGACY_TOOL_NAME_MAP[toolName]
	}
	return toolName as BuiltinToolName
}

export const builtinToolNameToComponent: { [T in BuiltinToolName]: { resultWrapper: ResultWrapper<T>, } } = {
	'Read': {
		resultWrapper: ({ toolMessage, compact }) => {
			const accessor = useAccessor()

			const title = getTitle(toolMessage)

			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor, toolMessage.rawParams);
			const statusIconMeta = getToolStatusIconMeta(toolMessage)

			if (toolMessage.type === 'tool_request') return null // do not show past requests

			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { params } = toolMessage
			const componentParams: ToolHeaderParams = {
				title,
				desc1,
				desc1Info,
				isError,
				isRejected,
				icon: statusIconMeta?.icon,
				iconTooltip: statusIconMeta?.tooltip,
			}

			let range: [number, number] | undefined = undefined

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				if (!compact && result.kind === 'image') {
					componentParams.desc2 = `${(result.sizeBytes / 1024).toFixed(1)} KB`
					componentParams.children = <ToolChildrenWrapper>
						<img
							src={`data:${result.mime};base64,${result.base64}`}
							alt={getBasename(params.uri.fsPath)}
							className='max-h-48 max-w-full rounded object-contain bg-void-bg-3'
						/>
					</ToolChildrenWrapper>
				} else if (!compact && result.kind === 'pdf') {
					componentParams.desc2 = result.totalPages > 0 ? `${result.totalPages} page${result.totalPages !== 1 ? 's' : ''}` : 'PDF'
					const preview = result.textContent.slice(0, 2000)
					componentParams.children = <ToolChildrenWrapper allowTextSelection>
						<SmallProseWrapper>
							<ChatMarkdownRender
								string={`\`\`\`\n${preview}${result.textContent.length > preview.length ? '\n…' : ''}\n\`\`\``}
								chatMessageLocation={undefined}
								isApplyEnabled={false}
								isLinkDetectionEnabled={true}
							/>
						</SmallProseWrapper>
					</ToolChildrenWrapper>
				} else {
					const returnedLines = result.fileContents ? result.fileContents.split('\n').length : 0
					if (returnedLines > 0) {
						const endLine = result.firstLineNumber + returnedLines - 1
						range = [result.firstLineNumber, endLine]
						if (endLine < result.totalNumLines) {
							componentParams.desc2 = `lines ${result.firstLineNumber}-${endLine} of ${result.totalNumLines}`
						} else if (result.firstLineNumber > 1) {
							componentParams.desc1 += ` (${result.firstLineNumber}-${endLine})`
						}
					}
				}
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor, range) }
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				componentParams.desc1 = typeof result === 'string' ? result : String(result)
				componentParams.isError = true
			}
			else if (toolMessage.type === 'running_now') {
				componentParams.isRunning = true
			}

			return <ToolHeaderWrapper {...componentParams} compact={compact} />
		},
	},
	'Glob': {
		resultWrapper: ({ toolMessage, compact }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')
			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor, toolMessage.rawParams)
			const statusIconMeta = getToolStatusIconMeta(toolMessage)

			if (toolMessage.type === 'tool_request') return null // do not show past requests

			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = {
				title,
				desc1,
				desc1Info,
				isError,
				isRejected,
				icon: statusIconMeta?.icon,
				iconTooltip: statusIconMeta?.tooltip,
			}

			if (params.includePattern) {
				componentParams.info = `Only search in ${params.includePattern}`
			}

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				componentParams.numResults = result.uris.length
				componentParams.hasNextPage = result.hasNextPage
				if (result.uris.length > 0) {
					componentParams.desc1 = <ToolHoverPreview
						label={desc1}
						items={result.uris.map(uri => ({
							name: getBasename(uri.fsPath),
							onClick: () => { voidOpenFileFn(uri, accessor) },
						}))}
						totalCount={result.uris.length}
						hasMore={result.hasNextPage}
					/>
				}
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				componentParams.desc1 = typeof result === 'string' ? result : String(result)
				componentParams.isError = true
			}
			else if (toolMessage.type === 'running_now') {
				// Show loading state - no additional children needed, icon already shows spinner
				componentParams.isRunning = true
			}

			return <ToolHeaderWrapper {...componentParams} compact={compact} />
		}
	},
	'Grep': {
		resultWrapper: ({ toolMessage, compact }) => {
			const accessor = useAccessor()
			const title = getTitle(toolMessage)
			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor, toolMessage.rawParams)
			const statusIconMeta = getToolStatusIconMeta(toolMessage)

			if (toolMessage.type === 'tool_request') return null

			const componentParams: ToolHeaderParams = {
				title,
				desc1,
				desc1Info,
				isError,
				isRejected,
				icon: statusIconMeta?.icon,
				iconTooltip: statusIconMeta?.tooltip,
			}

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				const fileResults = result.results
				const numResults = result.outputMode === 'content'
					? result.shownMatchCount
					: result.outputMode === 'count'
						? fileResults.reduce((sum, fileResult) => sum + fileResult.matchCount, 0)
						: fileResults.length
				componentParams.numResults = numResults
				componentParams.hasNextPage = result.truncated
				if (result.outputMode === 'files_with_matches') {
					componentParams.info = `${result.totalFileCount}${result.truncated ? '+' : ''} file${result.totalFileCount !== 1 ? 's' : ''}`
				} else {
					componentParams.info = `${result.totalMatchCount}${result.truncated ? '+' : ''} match${result.totalMatchCount !== 1 ? 'es' : ''}`
				}

				if (fileResults.length > 0) {
					const previewItems = result.outputMode === 'content'
						? fileResults.map(fileResult => ({
							name: `${getBasename(fileResult.uri.fsPath)} · ${fileResult.matchCount} match${fileResult.matchCount !== 1 ? 'es' : ''}`,
							onClick: () => { voidOpenFileFn(fileResult.uri, accessor) },
						}))
						: result.outputMode === 'count'
							? fileResults.map(fileResult => ({
								name: <>{getBasename(fileResult.uri.fsPath)} <span className='opacity-60'>{fileResult.matchCount}</span></>,
								onClick: () => { voidOpenFileFn(fileResult.uri, accessor) },
							}))
							: fileResults.map(fileResult => ({
								name: getBasename(fileResult.uri.fsPath),
								onClick: () => { voidOpenFileFn(fileResult.uri, accessor) },
							}))

					componentParams.desc1 = <ToolHoverPreview
						label={desc1}
						items={previewItems}
						totalCount={numResults}
						hasMore={result.truncated}
					/>
				}
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				componentParams.desc1 = typeof result === 'string' ? result : String(result)
				componentParams.isError = true
			}
			else if (toolMessage.type === 'running_now') {
				componentParams.isRunning = true
			}

			return <ToolHeaderWrapper {...componentParams} compact={compact} />
		}
	},

	'read_lint_errors': {
		resultWrapper: ({ toolMessage, compact }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')

			const title = getTitle(toolMessage)

			const { uri } = toolMessage.params ?? {}
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor, toolMessage.rawParams)
			const statusIconMeta = getToolStatusIconMeta(toolMessage)

			if (toolMessage.type === 'tool_request') return null // do not show past requests

			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = {
				title,
				desc1,
				desc1Info,
				isError,
				isRejected,
				icon: statusIconMeta?.icon,
				iconTooltip: statusIconMeta?.tooltip,
			}

			componentParams.info = getRelative(uri, accessor) // full path

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor) }
				if (result.lintErrors && result.lintErrors.length > 0) {
					componentParams.numResults = result.lintErrors.length
					componentParams.desc1 = <ToolHoverPreview
						label={desc1}
						items={result.lintErrors.map(error => ({
							name: <>L{error.startLineNumber}: {error.message}</>,
							onClick: () => { voidOpenFileFn(params.uri, accessor, [error.startLineNumber, error.endLineNumber]) },
						}))}
						totalCount={result.lintErrors.length}
					/>
				}
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				componentParams.desc1 = typeof result === 'string' ? result : String(result)
				componentParams.isError = true
			}
			else if (toolMessage.type === 'running_now') {
				// Show loading state - no additional children needed, icon already shows spinner
				componentParams.isRunning = true
			}

			return <ToolHeaderWrapper {...componentParams} compact={compact} />
		},
	},

	// ---

	'StrReplace': {
		resultWrapper: (params) => {
			return <EditTool {...params} toolMessage={params.toolMessage as any} />
		}
	},
	'Write': {
		resultWrapper: (params) => {
			return <EditTool {...params} toolMessage={params.toolMessage as any} />
		}
	},

	// ---

	'Shell': {
		resultWrapper: (params) => {
			return <ShellToolCard threadId={params.threadId} toolMessage={params.toolMessage as Exclude<typeof params.toolMessage, { type: 'invalid_params' }>} />
		}
	},

	'AwaitShell': {
		resultWrapper: (params) => {
			return <ShellToolCard threadId={params.threadId} toolMessage={params.toolMessage as Exclude<typeof params.toolMessage, { type: 'invalid_params' }>} />
		}
	},

	'AskQuestion': {
		resultWrapper: ({ toolMessage, threadId }) => {
			if (toolMessage.type === 'invalid_params') {
				const accessor = useAccessor()
				const title = getTitle(toolMessage)
				const { desc1 } = toolNameToDesc(toolMessage.name, undefined, accessor, toolMessage.rawParams)
				const statusIconMeta = getToolStatusIconMeta(toolMessage)
				return (
					<ToolHeaderWrapper
						title={title}
						desc1={desc1 || toolMessage.content}
						isError
						icon={statusIconMeta?.icon}
						iconTooltip={statusIconMeta?.tooltip}
					/>
				)
			}
			if (toolMessage.type === 'tool_error' || toolMessage.type === 'rejected') {
				const accessor = useAccessor()
				const title = getTitle(toolMessage)
				const statusIconMeta = getToolStatusIconMeta(toolMessage)
				return (
					<ToolHeaderWrapper
						title={title}
						desc1={toolMessage.type === 'tool_error' ? String(toolMessage.result) : 'Canceled'}
						isError={toolMessage.type === 'tool_error'}
						isRejected={toolMessage.type === 'rejected'}
						icon={statusIconMeta?.icon}
						iconTooltip={statusIconMeta?.tooltip}
					/>
				)
			}
			return (
				<AskQuestionToolWithState
					toolMessage={toolMessage}
					threadId={threadId}
				/>
			)
		},
	},

	'TodoWrite': {
		resultWrapper: ({ toolMessage, threadId, messageIdx }) => {
			if (toolMessage.type === 'tool_request') return null // do not show past requests

			// Handle error and rejected states
			if (toolMessage.type === 'tool_error' || toolMessage.type === 'rejected') {
				const accessor = useAccessor()
				const title = getTitle(toolMessage)
				const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor, toolMessage.rawParams)
				const statusIconMeta = getToolStatusIconMeta(toolMessage)

				const componentParams: ToolHeaderParams = {
					title,
					desc1: toolMessage.type === 'tool_error' ? String(toolMessage.result) : desc1,
					desc1Info,
					isError: toolMessage.type === 'tool_error',
					isRejected: toolMessage.type === 'rejected',
					icon: statusIconMeta?.icon,
					iconTooltip: statusIconMeta?.tooltip,
				}

				return <ToolHeaderWrapper {...componentParams} />
			}

			// For running_now and success, render the TodoToolWithState
			const todos = toolMessage.params?.todos || []
			const merge = toolMessage.params?.merge ?? false
			const isStreaming = toolMessage.type === 'running_now'
			const accessor = useAccessor()
			const messages = accessor.get('IChatThreadService').getCurrentThread().messages
			const previousTodosAtMessage = computeTodoListBeforeMessage(messages, messageIdx)

			return (
				<TodoToolWithState
					todos={todos}
					threadId={threadId}
					toolCallId={toolMessage.id}
					isStreaming={isStreaming}
					previousTodosAtMessage={previousTodosAtMessage}
					merge={merge}
				/>
			)
		},
	},

	// --- Plan Mode Tools ---
	'create_plan': {
		resultWrapper: ({ toolMessage, threadId }) => {
			if (toolMessage.type === 'tool_request') return null

			if (toolMessage.type === 'success') {
				const result = toolMessage.result
				const planName = result?.planName ?? toolMessage.params?.name ?? 'Implementation Plan'
				const overview = result?.overview ?? toolMessage.params?.overview ?? ''
				const todos = result?.todos ?? toolMessage.params?.todos ?? []
				const planPath = result?.planPath || undefined
				const isDraft = result?.isDraft ?? true

				return (
					<PlanCard
						threadId={threadId}
						planName={planName}
						overview={overview}
						todos={todos}
						planPath={planPath}
						isDraft={isDraft}
					/>
				)
			}

			const accessor = useAccessor()
			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor, toolMessage.rawParams)
			const isError = toolMessage.type === 'tool_error'
			const isRejected = toolMessage.type === 'rejected'
			const isRunning = toolMessage.type === 'running_now'
			const statusIconMeta = getToolStatusIconMeta(toolMessage)

			const planName = toolMessage.params?.name || 'Implementation Plan'

			const componentParams: ToolHeaderParams = {
				title,
				desc1: isError ? 'Failed to create plan' : planName,
				desc1Info,
				isError,
				isRejected,
				isRunning,
				icon: statusIconMeta?.icon,
				iconTooltip: statusIconMeta?.tooltip,
			}

			if (isError) {
				componentParams.children = (
					<ToolChildrenWrapper>
						<div className="text-void-fg-4 text-[11px] p-2 bg-void-bg-1/50 rounded mx-3 my-2">
							{typeof toolMessage.result === 'string'
								? toolMessage.result
								: 'An error occurred while creating the plan'}
						</div>
					</ToolChildrenWrapper>
				)
			} else if (isRunning) {
				componentParams.children = (
					<ToolChildrenWrapper>
						<div className="flex items-center gap-2 text-void-fg-4 text-[11px] p-3">
							<div className="animate-spin rounded-full h-3 w-3 border-b-2 border-void-fg-4"></div>
							<span>Creating plan...</span>
						</div>
					</ToolChildrenWrapper>
				)
			}

			return <ToolHeaderWrapper {...componentParams} />
		},
	},
	'read_plan': {
		resultWrapper: ({ toolMessage }) => {
			if (toolMessage.type === 'tool_request') return null

			const accessor = useAccessor()
			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor, toolMessage.rawParams)
			const isError = toolMessage.type === 'tool_error'
			const isRejected = toolMessage.type === 'rejected'
			const statusIconMeta = getToolStatusIconMeta(toolMessage)

			const componentParams: ToolHeaderParams = {
				title,
				desc1,
				desc1Info,
				isError,
				isRejected,
				icon: statusIconMeta?.icon,
				iconTooltip: statusIconMeta?.tooltip,
			}

			if (toolMessage.type === 'success' && !toolMessage.result?.exists) {
				componentParams.desc1 = 'No active plan found'
			}

			return <ToolHeaderWrapper {...componentParams} />
		},
	},
	'update_plan_section': {
		resultWrapper: ({ toolMessage }) => {
			if (toolMessage.type === 'tool_request') return null

			const accessor = useAccessor()
			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor, toolMessage.rawParams)
			const isError = toolMessage.type === 'tool_error'
			const isRejected = toolMessage.type === 'rejected'
			const statusIconMeta = getToolStatusIconMeta(toolMessage)

			const componentParams: ToolHeaderParams = {
				title,
				desc1,
				desc1Info,
				isError,
				isRejected,
				icon: statusIconMeta?.icon,
				iconTooltip: statusIconMeta?.tooltip,
			}

			return <ToolHeaderWrapper {...componentParams} />
		},
	},
	'add_plan_todo': {
		resultWrapper: ({ toolMessage }) => {
			if (toolMessage.type === 'tool_request') return null

			const accessor = useAccessor()
			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor, toolMessage.rawParams)
			const isError = toolMessage.type === 'tool_error'
			const isRejected = toolMessage.type === 'rejected'
			const statusIconMeta = getToolStatusIconMeta(toolMessage)

			const componentParams: ToolHeaderParams = {
				title,
				desc1,
				desc1Info,
				isError,
				isRejected,
				icon: statusIconMeta?.icon,
				iconTooltip: statusIconMeta?.tooltip,
			}

			return <ToolHeaderWrapper {...componentParams} />
		},
	},
	'mark_plan_item_complete': {
		resultWrapper: ({ toolMessage }) => {
			if (toolMessage.type === 'tool_request') return null

			const accessor = useAccessor()
			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor, toolMessage.rawParams)
			const isError = toolMessage.type === 'tool_error'
			const isRejected = toolMessage.type === 'rejected'
			const statusIconMeta = getToolStatusIconMeta(toolMessage)

			const componentParams: ToolHeaderParams = {
				title,
				desc1,
				desc1Info,
				isError,
				isRejected,
				icon: statusIconMeta?.icon,
				iconTooltip: statusIconMeta?.tooltip,
			}

			if (toolMessage.type === 'success' && toolMessage.result?.completedItem) {
				componentParams.desc2 = toolMessage.result.completedItem
			}

			return <ToolHeaderWrapper {...componentParams} />
		},
	},

	'task': {
		resultWrapper: ({ toolMessage, threadId }) => {
			if (toolMessage.type === 'tool_request') return null
			return <TaskToolResult toolMessage={toolMessage} threadId={threadId} />
		},
	},

	'skill': {
		resultWrapper: ({ toolMessage, compact }) => {
			if (toolMessage.type === 'tool_request') return null

			const accessor = useAccessor()
			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor, toolMessage.rawParams)
			const statusIconMeta = getToolStatusIconMeta(toolMessage)

			const componentParams: ToolHeaderParams = {
				title,
				desc1,
				desc1Info,
				isError: toolMessage.type === 'tool_error',
				isRejected: toolMessage.type === 'rejected',
				isRunning: toolMessage.type === 'running_now',
				icon: statusIconMeta?.icon,
				iconTooltip: statusIconMeta?.tooltip,
			}

			if (toolMessage.type === 'tool_error') {
				componentParams.desc1 = typeof toolMessage.result === 'string' ? toolMessage.result : String(toolMessage.result)
			} else if (toolMessage.type === 'success') {
				componentParams.desc1 = toolMessage.result?.skillName ?? desc1
			}

			return <ToolHeaderWrapper {...componentParams} compact={compact} />
		},
	},
} satisfies { [T in BuiltinToolName]: { resultWrapper: ResultWrapper<T> } };
