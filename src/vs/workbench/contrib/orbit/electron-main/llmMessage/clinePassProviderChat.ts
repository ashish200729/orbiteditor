/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type OpenAI from 'openai'
import { getModelCapabilities, getProviderCapabilities, getSendableReasoningInfo } from '../../common/modelCapabilities.js'
import type { SendChatParams_Internal } from './sendLLMMessage.impl.js'
import { extractReasoningWrapper, extractXMLToolsWrapper } from './extractGrammar.js'
import { getClinePassOAuthManager } from '../cline-pass/oauthManager.js'
import { CLINE_PASS_OAUTH_CONFIG } from '../cline-pass/oauthConfig.js'
import { mapClinePassHttpError } from '../cline-pass/tokenManager.js'
import { generateUuid } from '../../../../../base/common/uuid.js'
import { availableTools, InternalToolInfo } from '../../common/prompt/prompts.js'
import type { ChatMode } from '../../common/orbitSettingsTypes.js'
import type { LLMUsage, OnError, OnFinalMessage, RawToolCallObj, ToolPolicy } from '../../common/sendLLMMessageTypes.js'
import { parsePartialToolParams } from './parsePartialToolParams.js'
import { schemaOfToolInfo } from './toolSchema.js'

/** If no stream chunk arrives within this window, abort and surface an error instead of hanging forever. */
const STREAM_IDLE_TIMEOUT_MS = 90_000

const toOpenAICompatibleTool = (toolInfo: InternalToolInfo): OpenAI.Chat.Completions.ChatCompletionTool => ({
	type: 'function',
	function: {
		name: toolInfo.name,
		description: toolInfo.description,
		parameters: schemaOfToolInfo(toolInfo),
	},
})

const openAITools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined, toolPolicy?: ToolPolicy) => {
	const allowedTools = availableTools(chatMode, mcpTools, toolPolicy)
	if (!allowedTools || Object.keys(allowedTools).length === 0) {
		return undefined
	}
	const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = []
	for (const t in allowedTools) {
		tools.push(toOpenAICompatibleTool(allowedTools[t]))
	}
	return tools
}

const rawToolCallObjOfParamsStr = (name: string, toolParamsStr: string, id: string, mcpToolNames?: Iterable<string>): RawToolCallObj | null => {
	if (!name) {
		return null
	}
	const { rawParams, doneParams, isDone } = parsePartialToolParams(toolParamsStr, name, mcpToolNames)
	return { id, name, rawParams, doneParams, isDone }
}

export const sendClinePassProviderChat = async (params: SendChatParams_Internal) => {
	const {
		messages,
		onText,
		onFinalMessage: onFinalMessage_orig,
		onError: onError_orig,
		modelSelectionOptions,
		modelName: modelName_,
		_setAborter,
		providerName,
		chatMode,
		overridesOfModel,
		mcpTools,
		toolPolicy,
	} = params

	let settled = false
	const onError: OnError = (p) => { if (settled) return; settled = true; onError_orig(p) }
	const onFinalMessage: OnFinalMessage = (p) => { if (settled) return; settled = true; onFinalMessage_orig(p) }
	const mcpToolNames = mcpTools?.map(t => t.name)

	const {
		modelName,
		specialToolFormat,
		reasoningCapabilities,
		additionalOpenAIPayload,
		reservedOutputTokenSpace,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	const { providerReasoningIOSettings } = getProviderCapabilities(providerName)
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel)
	const includeInPayload = {
		...providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo),
		...additionalOpenAIPayload,
	}

	let onText_ = onText
	let onFinalMessage_ = onFinalMessage
	const { needsManualParse: needsManualReasoningParse, nameOfFieldInDelta: nameOfReasoningFieldInDelta } = providerReasoningIOSettings?.output ?? {}
	const { canIOReasoning, openSourceThinkTags } = reasoningCapabilities || {}
	const manuallyParseReasoning = needsManualReasoningParse && canIOReasoning && openSourceThinkTags
	if (manuallyParseReasoning) {
		const { newOnText, newOnFinalMessage } = extractReasoningWrapper(onText_, onFinalMessage_, openSourceThinkTags)
		onText_ = newOnText
		onFinalMessage_ = newOnFinalMessage
	}
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText_, onFinalMessage_, chatMode, mcpTools, toolPolicy)
		onText_ = newOnText
		onFinalMessage_ = newOnFinalMessage
	}

	const potentialTools = openAITools(chatMode, mcpTools, toolPolicy)
	const nativeToolsObj = potentialTools && specialToolFormat === 'openai-style'
		? { tools: potentialTools, tool_choice: 'auto' as const }
		: {}

	const cleanedMessages = messages.map(msg => {
		if (msg.role !== 'user' || typeof (msg as { content?: unknown }).content === 'string') {
			return msg
		}
		const content = (msg as { content: Array<{ type: string }> }).content
		const nonImageContent = content.filter((p) => p.type !== 'image_url' && p.type !== 'image')
		if (nonImageContent.length === 0) {
			return { role: 'user', content: '' }
		}
		return { role: 'user', content: nonImageContent }
	})

	const body: Record<string, unknown> = {
		model: modelName,
		messages: cleanedMessages,
		stream: true,
		stream_options: { include_usage: true },
		...nativeToolsObj,
		...includeInPayload,
	}
	if (typeof reservedOutputTokenSpace === 'number' && reservedOutputTokenSpace > 0) {
		body.max_tokens = reservedOutputTokenSpace
	}

	let oauthManager
	try {
		oauthManager = getClinePassOAuthManager()
	} catch (error) {
		onError({ message: 'Please sign in to ClinePass to continue.', fullError: error instanceof Error ? error : null })
		return
	}

	let accessToken: string
	try {
		accessToken = await oauthManager.getAccessToken()
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Please sign in to ClinePass to continue.'
		onError({ message, fullError: error instanceof Error ? error : null })
		return
	}

	const controller = new AbortController()
	_setAborter(() => controller.abort())

	let response: Response
	try {
		response = await fetch(`${CLINE_PASS_OAUTH_CONFIG.apiBaseUrl}${CLINE_PASS_OAUTH_CONFIG.chatCompletionsPath}`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${accessToken}`,
				'Content-Type': 'application/json',
				Accept: 'text/event-stream',
				'HTTP-Referer': CLINE_PASS_OAUTH_CONFIG.httpReferer,
				'X-Title': CLINE_PASS_OAUTH_CONFIG.xTitle,
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		})
	} catch (fetchError) {
		if (fetchError instanceof Error && fetchError.name === 'AbortError') {
			return
		}
		onError({ message: 'Unable to connect to Cline API.', fullError: fetchError instanceof Error ? fetchError : null })
		return
	}

	if (!response.ok) {
		const mapped = await mapClinePassHttpError(response)
		if (mapped.clearCredentials) {
			await oauthManager.clearCredentials()
		}
		const message = mapped.dashboardUrl && !mapped.message.includes('app.cline.bot')
			? `${mapped.message} Manage subscription: ${mapped.dashboardUrl}`
			: mapped.message
		onError({ message, fullError: null })
		return
	}

	const reader = response.body?.getReader()
	if (!reader) {
		onError({ message: 'ClinePass response stream unavailable.', fullError: null })
		return
	}

	const decoder = new TextDecoder()
	let buffer = ''
	let fullTextSoFar = ''
	let fullReasoningSoFar = ''
	let usageSoFar: LLMUsage | undefined
	const toolsByIndex = new Map<number, { name: string; id: string; paramsStr: string }>()
	const allTools: { name: string; id: string; paramsStr: string }[] = []

	const emitUpdate = () => {
		const toolCalls = allTools
			.map((tool) => rawToolCallObjOfParamsStr(tool.name, tool.paramsStr, tool.id, mcpToolNames))
			.filter((tc): tc is RawToolCallObj => tc !== null)
		onText_({
			fullText: fullTextSoFar,
			fullReasoning: fullReasoningSoFar,
			toolCall: toolCalls[0],
			toolCalls: toolCalls.length ? toolCalls : undefined,
		})
	}

	const appendReasoningFromDelta = (delta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta) => {
		const reasoningFieldNames = new Set<string>()
		if (nameOfReasoningFieldInDelta) {
			reasoningFieldNames.add(nameOfReasoningFieldInDelta)
		}
		reasoningFieldNames.add('reasoning')
		reasoningFieldNames.add('reasoning_content')

		for (const fieldName of reasoningFieldNames) {
			const value = (delta as Record<string, unknown>)[fieldName]
			if (typeof value === 'string' && value) {
				fullReasoningSoFar += value
				return
			}
		}
	}

	let idleTimer: ReturnType<typeof setTimeout> | undefined
	const resetIdleTimer = () => {
		if (idleTimer) {
			clearTimeout(idleTimer)
		}
		idleTimer = setTimeout(() => {
			try { controller.abort() } catch { /* ignore */ }
			onError({ message: 'ClinePass: stream stalled — no response received in time.', fullError: null })
		}, STREAM_IDLE_TIMEOUT_MS)
	}
	const stopIdleTimer = () => {
		if (idleTimer) {
			clearTimeout(idleTimer)
			idleTimer = undefined
		}
	}

	try {
		resetIdleTimer()
		while (true) {
			const { done, value } = await reader.read()
			if (done) {
				break
			}
			resetIdleTimer()
			buffer += decoder.decode(value, { stream: true })
			const lines = buffer.split('\n')
			buffer = lines.pop() ?? ''
			for (const line of lines) {
				const trimmed = line.trim()
				if (!trimmed.startsWith('data:')) {
					continue
				}
				const data = trimmed.slice(5).trim()
				if (data === '[DONE]') {
					continue
				}
				let parsed: OpenAI.Chat.Completions.ChatCompletionChunk | { error?: { message?: string } }
				try {
					parsed = JSON.parse(data)
				} catch {
					continue
				}
				if ('error' in parsed && parsed.error) {
					throw new Error(parsed.error.message ?? 'ClinePass stream failed.')
				}
				const chunk = parsed as OpenAI.Chat.Completions.ChatCompletionChunk
				if (chunk.usage) {
					usageSoFar = {
						promptTokens: chunk.usage.prompt_tokens,
						completionTokens: chunk.usage.completion_tokens,
						totalTokens: chunk.usage.total_tokens,
						cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
					}
				}
				const delta = chunk.choices?.[0]?.delta
				if (!delta) {
					continue
				}
				if (delta.content) {
					fullTextSoFar += delta.content
				}
				appendReasoningFromDelta(delta)
				for (const tool of delta.tool_calls ?? []) {
					const index = tool.index ?? 0
					let toolData = toolsByIndex.get(index)
					if (!toolData) {
						toolData = { name: tool.function?.name ?? '', id: tool.id ?? `call_${generateUuid()}`, paramsStr: '' }
						toolsByIndex.set(index, toolData)
						allTools.push(toolData)
					}
					if (tool.function?.name) {
						toolData.name = tool.function.name
					}
					if (tool.id) {
						toolData.id = tool.id
					}
					if (tool.function?.arguments) {
						toolData.paramsStr += tool.function.arguments
					}
				}
				emitUpdate()
			}
		}

		const allToolCalls = allTools
			.map((tool) => rawToolCallObjOfParamsStr(tool.name, tool.paramsStr, tool.id, mcpToolNames))
			.filter((tc): tc is RawToolCallObj => tc !== null)

		if (!fullTextSoFar && !fullReasoningSoFar && allToolCalls.length === 0) {
			onError({ message: 'ClinePass: Response from model was empty.', fullError: null })
			return
		}
		onFinalMessage_({
			fullText: fullTextSoFar,
			fullReasoning: fullReasoningSoFar,
			anthropicReasoning: null,
			usage: usageSoFar,
			toolCall: allToolCalls[0],
			toolCalls: allToolCalls.length ? allToolCalls : undefined,
		})
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			return
		}
		onError({ message: error instanceof Error ? error.message : String(error), fullError: error instanceof Error ? error : null })
	} finally {
		stopIdleTimer()
	}
}
