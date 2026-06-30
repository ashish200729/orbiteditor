/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { CirclePlus, AlertTriangle, X } from 'lucide-react';
import { URI } from '../../../../../../../../base/common/uri.js';
import { ChatMessage } from '../../../../../common/chatThreadServiceTypes.js';
import { BuiltinToolName, BuiltinToolCallParams } from '../../../../../common/toolsServiceTypes.js';
import { builtinToolNames, isLLMHiddenBuiltinToolName, resolveBuiltinToolNameLoose } from '../../../../../common/prompt/prompts.js';
import { RawToolParamsObj } from '../../../../../common/sendLLMMessageTypes.js';
import { rejectBorder } from '../../../../../common/helpers/colors.js';
import { useAccessor } from '../../util/services.js';
import { getBasename, getRelative, getFolderName, pathStringToUri } from '../utils/fileUtils.js';
import { titleOfBuiltinToolName, titleOfRemovedDirectoryListingToolName, titleOfRemovedBrowserToolName, loadingTitleWrapper, TOOL_STATUS_ICON_SIZE } from './toolTitles.js';
import { isRemovedDirectoryListingToolName } from './legacyRemovedDirectoryToolRenderers.js';
import { isRemovedBrowserToolName } from './legacyRemovedBrowserToolRenderers.js';
import { LEGACY_TOOL_NAME_MAP } from './builtinToolNameToComponent.js';
import { removeMCPToolNamePrefix } from '../../../../../common/mcpServiceTypes.js';

export type ToolStatusIconMeta = {
	icon: React.ReactNode;
	tooltip: string;
}

export const getToolStatusIconMeta = (toolMessage: Pick<ChatMessage & { role: 'tool' }, 'name' | 'type' | 'mcpServerName'>): ToolStatusIconMeta | null => {
	switch (toolMessage.type) {
		case 'running_now':
			// No icon needed - shimmer effect on title is sufficient
			return null
		case 'tool_request':
			return {
				icon: <CirclePlus size={TOOL_STATUS_ICON_SIZE} className='text-void-fg-4 flex-shrink-0' />,
				tooltip: 'Waiting for approval',
			}
		case 'success':
			return null
		case 'tool_error':
		case 'invalid_params':
			return {
				icon: <AlertTriangle size={TOOL_STATUS_ICON_SIZE} className='text-void-fg-4 flex-shrink-0' />,
				tooltip: 'Error running tool',
			}
		case 'rejected':
			return {
				icon: <X size={TOOL_STATUS_ICON_SIZE} style={{ color: rejectBorder }} className='flex-shrink-0' />,
				tooltip: 'Canceled',
			}
		default:
			return null
	}
}


export const getTitle = (toolMessage: Pick<ChatMessage & { role: 'tool' }, 'name' | 'type' | 'mcpServerName'>): React.ReactNode => {
	const t = toolMessage
	const isBlockedHiddenBuiltinError = !t.mcpServerName && t.type === 'tool_error' && isLLMHiddenBuiltinToolName(t.name)
	const legacyMappedName = t.mcpServerName ? undefined : LEGACY_TOOL_NAME_MAP[t.name]
	const resolvedBuiltinName = t.mcpServerName || isBlockedHiddenBuiltinError ? undefined : (legacyMappedName ?? resolveBuiltinToolNameLoose(t.name))

	// Removed directory tools (historical threads only)
	if (!t.mcpServerName && isRemovedDirectoryListingToolName(t.name)) {
		const toolTitleInfo = titleOfRemovedDirectoryListingToolName[t.name]
		if (t.type === 'success') return toolTitleInfo.done
		if (t.type === 'running_now') return toolTitleInfo.running
		return toolTitleInfo.proposed
	}

	// Removed browser automation tools (historical threads only)
	if (!t.mcpServerName && isRemovedBrowserToolName(t.name)) {
		const toolTitleInfo = titleOfRemovedBrowserToolName[t.name]
		if (t.type === 'success') return toolTitleInfo.done
		if (t.type === 'running_now') return toolTitleInfo.running
		return toolTitleInfo.proposed
	}

	// Built-in tools - use predefined titles
	if (!isBlockedHiddenBuiltinError && (resolvedBuiltinName || builtinToolNames.includes(t.name as BuiltinToolName))) {
		const toolName = (resolvedBuiltinName ?? legacyMappedName ?? t.name) as BuiltinToolName
		const toolTitleInfo = (titleOfBuiltinToolName as any)[toolName] as typeof titleOfBuiltinToolName[BuiltinToolName] | undefined
		if (toolTitleInfo) {
			if (t.type === 'success') return toolTitleInfo.done
			if (t.type === 'running_now') return toolTitleInfo.running
			return toolTitleInfo.proposed
		}
		// Fallback for builtin tools without title info
		if (t.type === 'running_now') return loadingTitleWrapper(toolName)
		return toolName
	}

	// Non-built-in tools (MCP, etc.) - simple, clean titles
	const cleanToolName = removeMCPToolNamePrefix(t.name) || t.name

	// State-based action verb
	const verb =
		t.type === 'success' ? 'Called'
			: t.type === 'running_now' ? 'Calling'
				: t.type === 'tool_request' ? 'Call'
					: t.type === 'rejected' ? 'Cancelled'
						: t.type === 'invalid_params' ? 'Invalid'
							: t.type === 'tool_error' ? 'Error'
								: 'Call'

	const title = `${verb} ${cleanToolName}`
	if (t.type === 'running_now' || t.type === 'tool_request') {
		return loadingTitleWrapper(title)
	}
	return title
}


export const toolNameToDesc = (toolName: string, _toolParams: BuiltinToolCallParams[BuiltinToolName] | undefined, accessor: ReturnType<typeof useAccessor>, rawParams?: RawToolParamsObj): {
	desc1: React.ReactNode,
	desc1Info?: string,
} => {

	if (isRemovedDirectoryListingToolName(toolName)) {
		const uri = (_toolParams && typeof _toolParams === 'object' && 'uri' in _toolParams && _toolParams.uri instanceof URI)
			? _toolParams.uri as URI
			: (() => {
				const uriStr = rawParams?.uri as string | undefined
				if (!uriStr) return undefined
				try { return URI.parse(uriStr) } catch { return undefined }
			})()
		if (uri) {
			return {
				desc1: getFolderName(uri.fsPath),
				desc1Info: getRelative(uri, accessor),
			}
		}
		return { desc1: '' }
	}

	if (isRemovedBrowserToolName(toolName)) {
		if (rawParams?.url) return { desc1: String(rawParams.url) }
		if (rawParams?.selector) return { desc1: String(rawParams.selector) }
		if (rawParams?.script) {
			const script = String(rawParams.script).replace(/\s+/g, ' ').trim()
			return { desc1: script.length > 80 ? `${script.slice(0, 80)}...` : script }
		}
		return { desc1: '' }
	}

	if (!_toolParams || (typeof _toolParams === 'object' && _toolParams !== null && !(_toolParams instanceof URI) && Object.keys(_toolParams).length === 0)) {
		// If params is empty, try to extract basic info from rawParams for display
		if (rawParams) {
			const x = {
				'Read': () => {
					const pathStr = (rawParams.path ?? rawParams.uri) as string | undefined
					if (pathStr) {
						try {
							const uri = pathStringToUri(pathStr)
							return {
								desc1: getBasename(uri.fsPath),
								desc1Info: getRelative(uri, accessor),
							};
						} catch {
							return { desc1: pathStr }
						}
					}
					return { desc1: '' }
				},
			'Glob': () => {
				const globPattern = rawParams.glob_pattern as string | undefined
				return { desc1: globPattern ? `"${globPattern}"` : '' }
			},
			'Grep': () => {
					const pattern = rawParams.pattern as string | undefined
					const pathStr = rawParams.path as string | undefined
					const glob = rawParams.glob as string | undefined
					const outputMode = rawParams.output_mode as string | undefined
					const type = rawParams.type as string | undefined
					const caseInsensitive = rawParams['-i'] as boolean | undefined
					const multiline = rawParams.multiline as boolean | undefined
					const beforeContext = rawParams['-B'] as number | undefined
					const afterContext = rawParams['-A'] as number | undefined
					const context = rawParams['-C'] as number | undefined
					const infoParts: string[] = []
					if (pathStr) {
						try {
							const uri = URI.parse(pathStr)
							infoParts.push(getRelative(uri, accessor))
						} catch {
							infoParts.push(pathStr)
						}
					} else {
						infoParts.push('workspace')
					}
					if (glob) infoParts.push(`glob: ${glob}`)
					if (type) infoParts.push(`type: ${type}`)
					if (outputMode && outputMode !== 'content') infoParts.push(`mode: ${outputMode}`)
					if (caseInsensitive) infoParts.push('case-insensitive')
					if (multiline) infoParts.push('multiline')
					if (context !== undefined && context !== null && context !== '') {
						infoParts.push(`±${context} context`)
					} else if (beforeContext || afterContext) {
						infoParts.push(`-${beforeContext ?? 0}/+${afterContext ?? 0} context`)
					}
					return { desc1: pattern ? `"${pattern}"` : '', desc1Info: infoParts.join(' · ') }
				},
			'StrReplace': () => {
					const pathStr = (rawParams.path ?? rawParams.uri) as string | undefined
					if (pathStr) {
						try {
							const uri = pathStringToUri(pathStr)
							return {
								desc1: getBasename(uri.fsPath),
								desc1Info: getRelative(uri, accessor),
							}
						} catch {
							return { desc1: pathStr }
						}
					}
					return { desc1: '' }
				},
				'Write': () => {
					const pathStr = (rawParams.path ?? rawParams.uri ?? rawParams.file_or_folder) as string | undefined
					if (pathStr) {
						try {
							const uri = pathStringToUri(pathStr)
							return {
								desc1: getBasename(uri.fsPath),
								desc1Info: getRelative(uri, accessor),
							}
						} catch {
							return { desc1: pathStr }
						}
					}
					return { desc1: '' }
				},
				'Shell': () => {
					const command = rawParams.command as string | undefined
					return { desc1: command ? `"${command}"` : '' }
				},
				'AwaitShell': () => {
					const shellId = rawParams.shell_id as string | undefined
					return { desc1: shellId || '(sleep)' }
				},
				'read_lint_errors': () => {
					const uriStr = rawParams.uri as string | undefined
					if (uriStr) {
						try {
							const uri = URI.parse(uriStr)
							return {
								desc1: getBasename(uri.fsPath),
								desc1Info: getRelative(uri, accessor),
							}
						} catch {
							return { desc1: uriStr }
						}
					}
					return { desc1: '' }
				},
					'TodoWrite': () => {
						const todosStr = rawParams.todos as string | undefined
						if (todosStr) {
							try {
								const parsed = JSON.parse(todosStr)
								if (Array.isArray(parsed)) {
									return { desc1: `${parsed.length} items` }
								}
							} catch {
								// Fall through to the structured params path or an empty description.
							}
						}
						return { desc1: '' }
					},
					'AskQuestion': () => {
						const questionsStr = rawParams.questions as string | undefined
						if (questionsStr) {
							try {
								const parsed = JSON.parse(questionsStr)
								if (Array.isArray(parsed)) {
									return { desc1: `${parsed.length} question${parsed.length !== 1 ? 's' : ''}` }
								}
							} catch { /* ignore */ }
						}
						return { desc1: 'questions' }
					},

				// Plan tools
				'create_plan': () => {
					const planName = rawParams.plan_name as string | undefined
					return { desc1: planName || 'New plan' }
				},
				'read_plan': () => {
					return { desc1: 'current plan' }
				},
				'update_plan_section': () => {
					const sectionName = rawParams.section_name as string | undefined
					return { desc1: sectionName || '' }
				},
				'add_plan_todo': () => {
					const todoText = rawParams.todo_text as string | undefined
					return { desc1: todoText ? (todoText.length > 40 ? todoText.slice(0, 40) + '...' : todoText) : '' }
				},
				'mark_plan_item_complete': () => {
					const itemIndex = rawParams.item_index as number | undefined
					return { desc1: itemIndex ? `item #${itemIndex}` : '' }
				},
				'task': () => {
					const description = rawParams.description as string | undefined
					const subagent_type = rawParams.subagent_type as string | undefined
					return { desc1: description || subagent_type || '' }
				},
				'skill': () => {
					const name = rawParams.name as string | undefined
					return { desc1: name || '' }
				},
			}
			try {
				return x[toolName]?.() || { desc1: '' }
			} catch {
				return { desc1: '' }
			}
		}
		return { desc1: '', };
	}

	const x = {
		'Read': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['Read']
			return {
				desc1: getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			};
		},
		'Glob': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['Glob']
			return {
				desc1: `"${toolParams.globPattern}"`,
			}
		},
		'Grep': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['Grep']
			const infoParts: string[] = []
			infoParts.push(toolParams.path ? getRelative(toolParams.path, accessor) : 'workspace')
			if (toolParams.glob) infoParts.push(`glob: ${toolParams.glob}`)
			if (toolParams.type) infoParts.push(`type: ${toolParams.type}`)
			if (toolParams.outputMode !== 'content') infoParts.push(`mode: ${toolParams.outputMode}`)
			if (toolParams.caseInsensitive) infoParts.push('case-insensitive')
			if (toolParams.multiline) infoParts.push('multiline')
			if (toolParams.beforeContext === toolParams.afterContext && toolParams.beforeContext > 0) {
				infoParts.push(`±${toolParams.beforeContext} context`)
			} else if (toolParams.beforeContext || toolParams.afterContext) {
				infoParts.push(`-${toolParams.beforeContext}/+${toolParams.afterContext} context`)
			}
			return {
				desc1: `"${toolParams.pattern}"`,
				desc1Info: infoParts.join(' · '),
			}
		},
		'StrReplace': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['StrReplace'] & { uri?: URI }
			const filePath = toolParams.path ?? toolParams.uri
			if (!filePath) return { desc1: '' }
			return {
				desc1: getBasename(filePath.fsPath),
				desc1Info: getRelative(filePath, accessor),
			}
		},
		'Write': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['Write'] & { uri?: URI }
			const filePath = toolParams.path ?? toolParams.uri
			if (!filePath) return { desc1: '' }
			return {
				desc1: getBasename(filePath.fsPath),
				desc1Info: getRelative(filePath, accessor),
			}
		},
		'Shell': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['Shell']
			return {
				desc1: `"${toolParams.command}"`,
			}
		},
		'AwaitShell': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['AwaitShell']
			return { desc1: toolParams.shellId ?? '(sleep)' }
		},
		'read_lint_errors': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['read_lint_errors']
			return {
				desc1: getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			}
		},
		'TodoWrite': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['TodoWrite']
			return {
				desc1: `(${toolParams.todos.length} items)`,
			}
		},
		'AskQuestion': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['AskQuestion']
			const n = toolParams.questions.length
			return {
				desc1: toolParams.title || `${n} question${n !== 1 ? 's' : ''}`,
			}
		},
		// Plan tools
		'create_plan': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['create_plan']
			return {
				desc1: toolParams.name || 'New plan',
			}
		},
		'read_plan': () => {
			return { desc1: 'current plan' }
		},
		'update_plan_section': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['update_plan_section']
			return {
				desc1: toolParams.sectionName,
			}
		},
		'add_plan_todo': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['add_plan_todo']
			const text = toolParams.todoText
			return {
				desc1: text.length > 40 ? text.slice(0, 40) + '...' : text,
			}
		},
		'mark_plan_item_complete': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['mark_plan_item_complete']
			return {
				desc1: `item #${toolParams.itemIndex}`,
			}
		},
		'task': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['task']
			return {
				desc1: toolParams.description || toolParams.subagent_type,
			}
		},
		'skill': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['skill']
			return {
				desc1: toolParams.name,
			}
		},
	}

	try {
		return x[toolName]?.() || { desc1: '' }
	}
	catch {
		return { desc1: '' }
	}
}
