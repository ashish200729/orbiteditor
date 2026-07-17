/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type OpenAI from 'openai'
import { getModelCapabilities, getProviderCapabilities, getSendableReasoningInfo } from '../../common/modelCapabilities.js'
import type { SendChatParams_Internal } from './sendLLMMessage.impl.js'
import { extractReasoningWrapper, extractXMLToolsWrapper } from './extractGrammar.js'
import { getGitHubOAuthManager } from '../github/oauthManager.js'
import { getOrbitApiBaseUrl } from './orbitApiUrl.js'
import { getOrbitLlmMainServices } from './orbitLlmMainServices.js'
import { generateUuid } from '../../../../../base/common/uuid.js'
import { availableTools, InternalToolInfo } from '../../common/prompt/prompts.js'
import type { ChatMode } from '../../common/orbitSettingsTypes.js'
import type { LLMUsage, RawToolCallObj, ToolPolicy } from '../../common/sendLLMMessageTypes.js'
import { parsePartialToolParams } from './parsePartialToolParams.js'
import { schemaOfToolInfo } from './toolSchema.js'

/** Orbit gateway rejects output above this (see orbit-backend llmGateway.maxOutputTokens). */
const ORBIT_GATEWAY_MAX_OUTPUT_TOKENS = 8192

const parseOrbitErrorMessage = async (response: Response, fallback: string): Promise<string> => {
	try {
		const json = await response.json() as { error?: { message?: string } }
		if (json.error?.message && json.error.message !== 'Bad Request Exception') {
			return json.error.message
		}
	} catch {
		// fall through
	}
	return fallback
}

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
		return null;
	}
	// Pass the tool name so param normalization (snake_case aliasing) only applies to
	// built-in tools — MCP tools with camelCase schemas must receive params verbatim.
	// mcpToolNames takes precedence over the "read_file"-means-Read builtin synonym, so a
	// real MCP tool literally named read_file is never misrouted through Read's normalization.
	const { rawParams, doneParams, isDone } = parsePartialToolParams(toolParamsStr, name, mcpToolNames);
	return { id, name, rawParams, doneParams, isDone };
}

export const sendOrbitProviderChat = async (params: SendChatParams_Internal) => {
	const { productService, environmentService, metricsService } = getOrbitLlmMainServices()
	const {
		messages,
		onText,
		onFinalMessage,
		onError,
		modelSelectionOptions,
		modelName: modelName_,
		_setAborter,
		providerName,
		chatMode,
		overridesOfModel,
		mcpTools,
		toolPolicy,
	} = params
	// So a real MCP tool named e.g. `read_file` isn't misrouted through builtin-Read param normalization.
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

	// Reasoning + XML tool parsing — same pipeline as other OpenAI-compatible providers
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

	const maxCompletionTokens = Math.min(
		reservedOutputTokenSpace ?? 4096,
		ORBIT_GATEWAY_MAX_OUTPUT_TOKENS,
	)

	const body = {
		model: modelName,
		messages: cleanedMessages,
		stream: true,
		stream_options: { include_usage: true },
		max_completion_tokens: maxCompletionTokens,
		...nativeToolsObj,
		...includeInPayload,
	}

	let oauthManager
	try {
		oauthManager = getGitHubOAuthManager()
	} catch (error) {
		onError({ message: 'Please sign in with GitHub to use Orbit models.', fullError: error instanceof Error ? error : null })
		return
	}

	let accessToken: string
	try {
		accessToken = await oauthManager.getAccessToken()
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Please sign in with GitHub to use Orbit models.'
		onError({ message, fullError: error instanceof Error ? error : null })
		return
	}

	const baseUrl = getOrbitApiBaseUrl(productService, environmentService)
	const controller = new AbortController()
	_setAborter(() => controller.abort())

	let response: Response
	try {
		response = await fetch(`${baseUrl}/api/v1/chat/completions`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${accessToken}`,
				'Content-Type': 'application/json',
				Accept: 'text/event-stream',
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		})
	} catch (fetchError) {
		if (fetchError instanceof Error && fetchError.name === 'AbortError') {
			return
		}
		onError({ message: 'Network error: Unable to connect to Orbit backend.', fullError: fetchError instanceof Error ? fetchError : null })
		return
	}

	if (response.status === 401) {
		await oauthManager.clearCredentials()
		onError({ message: 'Please sign in with GitHub to use Orbit models.', fullError: null })
		return
	}
	if (response.status === 429) {
		let message = 'Orbit rate limit reached.'
		try {
			const json = await response.json() as { error?: { message?: string; code?: string } }
			if (json.error?.code === 'token_limit' || json.error?.code === 'usage_limit_exceeded') {
				message = json.error.message ?? 'Monthly usage limit reached for your plan.'
			} else if (json.error?.message) {
				message = json.error.message
			}
		} catch {
			// keep default message
		}
		onError({ message, fullError: null })
		return
	}
	if (response.status === 402) {
		let message = 'Your Orbit credit balance is exhausted.'
		try {
			const json = await response.json() as { error?: { message?: string } }
			if (json.error?.message) {
				message = json.error.message
			}
		} catch {
			// keep the actionable default
		}
		onError({ message, fullError: null })
		return
	}
	if (response.status >= 500) {
		metricsService.capture('orbitProvider - Error', { status: response.status })
		onError({ message: 'Orbit backend unavailable.', fullError: null })
		return
	}
	if (!response.ok) {
		const fallback = `Orbit request failed (${response.status}).`
		const message = await parseOrbitErrorMessage(response, fallback)
		onError({
			message,
			fullError: message !== fallback ? new Error(message) : null,
		})
		return
	}

	const reader = response.body?.getReader()
	if (!reader) {
		onError({ message: 'Orbit response stream unavailable.', fullError: null })
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
		reasoningFieldNames.add('reasoning_content')
		reasoningFieldNames.add('reasoning')

		for (const fieldName of reasoningFieldNames) {
			const value = (delta as Record<string, unknown>)[fieldName]
			if (typeof value === 'string' && value) {
				fullReasoningSoFar += value
				return
			}
		}
	}

	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) {
				break
			}
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
					throw new Error(parsed.error.message ?? 'Orbit stream failed.')
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
			onError({ message: 'Orbit: Response from model was empty.', fullError: null })
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
		onError({ message: error instanceof Error ? error.message : String(error), fullError: error instanceof Error ? error : null })
	}
}
