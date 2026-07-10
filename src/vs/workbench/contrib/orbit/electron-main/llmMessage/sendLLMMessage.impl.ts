/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// disable foreign import complaints
/* eslint-disable */
import Anthropic from '@anthropic-ai/sdk';
import { Ollama } from 'ollama';
import OpenAI, { ClientOptions, AzureOpenAI } from 'openai';
import { MistralCore } from '@mistralai/mistralai/core.js';
import { fimComplete } from '@mistralai/mistralai/funcs/fimComplete.js';
import { Tool as GeminiTool, FunctionDeclaration, GoogleGenAI, ThinkingConfig, Schema, Type } from '@google/genai';
import { GoogleAuth } from 'google-auth-library'
/* eslint-enable */

import { AnthropicLLMChatMessage, GeminiLLMChatMessage, JsonToolSchema, LLMChatMessage, LLMFIMMessage, ModelListParams, OllamaModelResponse, OnError, OnFinalMessage, OnText, OpenAILLMChatMessage, RawToolCallObj, RawToolParamsObj, ToolPolicy } from '../../common/sendLLMMessageTypes.js';
import { ChatMode, displayInfoOfProviderName, ModelSelectionOptions, OverridesOfModel, ProviderName, SettingsOfProvider } from '../../common/orbitSettingsTypes.js';
import { getSendableReasoningInfo, getModelCapabilities, getProviderCapabilities, defaultProviderSettings, getReservedOutputTokenSpace } from '../../common/modelCapabilities.js';
import { extractReasoningWrapper, extractXMLToolsWrapper } from './extractGrammar.js';
import { normalizeToolParams, parsePartialToolParams } from './parsePartialToolParams.js';
import { availableTools, InternalToolInfo } from '../../common/prompt/prompts.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { getOpenAiCodexOAuthManager } from '../openai-codex/oauthManager.js';
import { OPENAI_CODEX_OAUTH_CONFIG } from '../openai-codex/oauthConfig.js';
import { sendOrbitProviderChat } from './orbitProviderChat.js';
import { orbitProviderList } from './orbitProviderList.js';

const getGoogleApiKey = async () => {
	// module‑level singleton
	const auth = new GoogleAuth({ scopes: `https://www.googleapis.com/auth/cloud-platform` });
	const key = await auth.getAccessToken()
	if (!key) throw new Error(`Google API failed to generate a key.`)
	return key
}




type InternalCommonMessageParams = {
	onText: OnText;
	onFinalMessage: OnFinalMessage;
	onError: OnError;
	providerName: ProviderName;
	settingsOfProvider: SettingsOfProvider;
	modelSelectionOptions: ModelSelectionOptions | undefined;
	overridesOfModel: OverridesOfModel | undefined;
	modelName: string;
	_setAborter: (aborter: () => void) => void;
}

type SendChatParams_Internal = InternalCommonMessageParams & {
	messages: LLMChatMessage[];
	separateSystemMessage: string | undefined;
	chatMode: ChatMode | null;
	mcpTools: InternalToolInfo[] | undefined;
	toolPolicy?: ToolPolicy;
}

export type { SendChatParams_Internal }
type SendFIMParams_Internal = InternalCommonMessageParams & { messages: LLMFIMMessage; separateSystemMessage: string | undefined; }
export type ListParams_Internal<ModelResponse> = ModelListParams<ModelResponse>


const invalidApiKeyMessage = (providerName: ProviderName) => `Invalid ${displayInfoOfProviderName(providerName).title} API key.`

// ------------ OPENAI-COMPATIBLE (HELPERS) ------------



const parseHeadersJSON = (s: string | undefined): Record<string, string | null | undefined> | undefined => {
	if (!s) return undefined
	try {
		return JSON.parse(s)
	} catch (e) {
		throw new Error(`Error parsing OpenAI-Compatible headers: ${s} is not a valid JSON.`)
	}
}

const newOpenAICompatibleSDK = async ({ settingsOfProvider, providerName, includeInPayload }: { settingsOfProvider: SettingsOfProvider, providerName: ProviderName, includeInPayload?: { [s: string]: any } }) => {
	const commonPayloadOpts: ClientOptions = {
		dangerouslyAllowBrowser: true,
		...includeInPayload,
	}
	if (providerName === 'openAI') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'ollama') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'vLLM') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'liteLLM') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'lmStudio') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'openRouter') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({
			baseURL: 'https://openrouter.ai/api/v1',
			apiKey: thisConfig.apiKey,
			defaultHeaders: {
				'HTTP-Referer': 'https://github.com/ashish200729/orbiteditor', // Optional, for including your app on openrouter.ai rankings.
				'X-Title': 'Orbit', // Optional. Shows in rankings on openrouter.ai.
			},
			...commonPayloadOpts,
		})
	}
	else if (providerName === 'googleVertex') {
		// https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-vertex-using-openai-library
		const thisConfig = settingsOfProvider[providerName]
		const baseURL = `https://${thisConfig.region}-aiplatform.googleapis.com/v1/projects/${thisConfig.project}/locations/${thisConfig.region}/endpoints/${'openapi'}`
		const apiKey = await getGoogleApiKey()
		return new OpenAI({ baseURL: baseURL, apiKey: apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'microsoftAzure') {
		// https://learn.microsoft.com/en-us/rest/api/aifoundry/model-inference/get-chat-completions/get-chat-completions?view=rest-aifoundry-model-inference-2024-05-01-preview&tabs=HTTP
		//  https://github.com/openai/openai-node?tab=readme-ov-file#microsoft-azure-openai
		const thisConfig = settingsOfProvider[providerName]
		const endpoint = `https://${thisConfig.project}.openai.azure.com/`;
		const apiVersion = thisConfig.azureApiVersion ?? '2024-04-01-preview';
		const options = { endpoint, apiKey: thisConfig.apiKey, apiVersion };
		return new AzureOpenAI({ ...options, ...commonPayloadOpts });
	}
	else if (providerName === 'awsBedrock') {
		/**
		  * We treat Bedrock as *OpenAI-compatible only through a proxy*:
		  *   • LiteLLM default → http://localhost:4000/v1
		  *   • Bedrock-Access-Gateway → https://<api-id>.execute-api.<region>.amazonaws.com/openai/
		  *
		  * The native Bedrock runtime endpoint
		  *   https://bedrock-runtime.<region>.amazonaws.com
		  * is **NOT** OpenAI-compatible, so we do *not* fall back to it here.
		  */
		const { endpoint, apiKey } = settingsOfProvider.awsBedrock

		// ① use the user-supplied proxy if present
		// ② otherwise default to local LiteLLM
		let baseURL = endpoint || 'http://localhost:4000/v1'

		// Normalize: make sure we end with “/v1”
		if (!baseURL.endsWith('/v1'))
			baseURL = baseURL.replace(/\/+$/, '') + '/v1'

		return new OpenAI({ baseURL, apiKey, ...commonPayloadOpts })
	}


	else if (providerName === 'deepseek') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.deepseek.com/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'openAICompatible') {
		const thisConfig = settingsOfProvider[providerName]
		const headers = parseHeadersJSON(thisConfig.headersJSON)
		return new OpenAI({ baseURL: thisConfig.endpoint, apiKey: thisConfig.apiKey, defaultHeaders: headers, ...commonPayloadOpts })
	}
	else if (providerName === 'groq') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.groq.com/openai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'xAI') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.x.ai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'mistral') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.mistral.ai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}

	else throw new Error(`Orbit providerName was invalid: ${providerName}.`)
}


const _sendOpenAICompatibleFIM = async ({ messages: { prefix, suffix, stopTokens }, onFinalMessage, onError, settingsOfProvider, modelName: modelName_, _setAborter, providerName, overridesOfModel }: SendFIMParams_Internal) => {

	const {
		modelName,
		supportsFIM,
		additionalOpenAIPayload,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	if (!supportsFIM) {
		if (modelName === modelName_)
			onError({ message: `Model ${modelName} does not support FIM.`, fullError: null })
		else
			onError({ message: `Model ${modelName_} (${modelName}) does not support FIM.`, fullError: null })
		return
	}

	const openai = await newOpenAICompatibleSDK({ providerName, settingsOfProvider, includeInPayload: additionalOpenAIPayload })
	openai.completions
		.create({
			model: modelName,
			prompt: prefix,
			suffix: suffix,
			stop: stopTokens,
			max_tokens: 300,
		})
		.then(async response => {
			const fullText = response.choices[0]?.text ?? ''
			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null });
		})
		.catch(error => {
			if (error instanceof OpenAI.APIError && error.status === 401) { onError({ message: invalidApiKeyMessage(providerName), fullError: error }); }
			else { onError({ message: error + '', fullError: error }); }
		})
}


const schemaOfToolInfo = (toolInfo: InternalToolInfo): JsonToolSchema => {
	if (toolInfo.inputSchema) return toolInfo.inputSchema as JsonToolSchema
	const paramsWithType: { [s: string]: { description: string; type: 'string' } } = {}
	for (const key in toolInfo.params) { paramsWithType[key] = { ...toolInfo.params[key], type: 'string' } }
	return {
		type: 'object',
		properties: paramsWithType,
		// required: Object.keys(toolInfo.params), // in strict mode, all params are required and additionalProperties is false
	}
}

const jsonSchemaToGeminiSchema = (schema: JsonToolSchema): Schema => {
	const type = schema.type === 'number' || schema.type === 'integer' ? Type.NUMBER
		: schema.type === 'boolean' ? Type.BOOLEAN
			: schema.type === 'array' ? Type.ARRAY
				: schema.type === 'object' ? Type.OBJECT
					: Type.STRING

	const converted: Schema = {
		type,
		description: schema.description,
		enum: schema.enum,
	} as Schema

	if (schema.properties) {
		converted.properties = Object.entries(schema.properties).reduce((acc, [key, value]) => {
			acc[key] = jsonSchemaToGeminiSchema(value)
			return acc
		}, {} as Record<string, Schema>)
	}
	if (schema.required) {
		converted.required = schema.required
	}
	if (schema.minimum !== undefined) {
		converted.minimum = schema.minimum
	}
	return converted
}

const toOpenAICompatibleTool = (toolInfo: InternalToolInfo) => {
	const { name, description } = toolInfo

	return {
		type: 'function',
		function: {
			name: name,
			// strict: true, // strict mode - https://platform.openai.com/docs/guides/function-calling?api-mode=chat
			description: description,
			parameters: schemaOfToolInfo(toolInfo),
		}
	} satisfies OpenAI.Chat.Completions.ChatCompletionTool
}

const openAITools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined, toolPolicy?: ToolPolicy) => {
	const allowedTools = availableTools(chatMode, mcpTools, toolPolicy)
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null

	const openAITools: OpenAI.Chat.Completions.ChatCompletionTool[] = []
	for (const t in allowedTools ?? {}) {
		openAITools.push(toOpenAICompatibleTool(allowedTools[t]))
	}
	return openAITools
}

type OpenAiCodexTool = {
	type: 'function';
	name: string;
	description?: string;
	parameters: Record<string, unknown>;
}

const openAiCodexTools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined, toolPolicy?: ToolPolicy): OpenAiCodexTool[] | null => {
	const allowedTools = availableTools(chatMode, mcpTools, toolPolicy)
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null

	const codexTools: OpenAiCodexTool[] = []
	for (const t in allowedTools ?? {}) {
		const tool = allowedTools[t]
		if (!tool?.name) continue
		codexTools.push({
			type: 'function',
			name: tool.name,
			description: tool.description,
			parameters: schemaOfToolInfo(tool),
		})
	}
	return codexTools
}


// convert LLM tool call to our tool format
// convert LLM tool call to our tool format
const rawToolCallObjOfParamsStr = (name: string, toolParamsStr: string, id: string): RawToolCallObj | null => {
	if (!name) {
		return null;
	}
	const { rawParams, doneParams, isDone } = parsePartialToolParams(toolParamsStr);
	return { id, name, rawParams, doneParams, isDone };
}


const rawToolCallObjOfAnthropicParams = (toolBlock: Anthropic.Messages.ToolUseBlock): RawToolCallObj | null => {
	const { id, name, input } = toolBlock

	if (input === null) return null
	if (typeof input !== 'object') return null

	const rawParams: RawToolParamsObj = normalizeToolParams(input as Record<string, unknown>)
	return { id, name, rawParams, doneParams: Object.keys(rawParams), isDone: true }
}


// ------------ OPENAI-COMPATIBLE ------------


const _sendOpenAICompatibleChat = async ({ messages, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, modelName: modelName_, _setAborter, providerName, chatMode, separateSystemMessage, overridesOfModel, mcpTools, toolPolicy }: SendChatParams_Internal) => {
	const {
		modelName,
		specialToolFormat,
		reasoningCapabilities,
		additionalOpenAIPayload,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	const { canIOReasoning, openSourceThinkTags } = reasoningCapabilities || {}
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel) // user's modelName_ here

	const includeInPayload = {
		...providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo),
		...additionalOpenAIPayload
	}

	// tools
	const potentialTools = openAITools(chatMode, mcpTools, toolPolicy)
	const nativeToolsObj = potentialTools && specialToolFormat === 'openai-style' ?
		{ tools: potentialTools } as const
		: {}

	// instance
	const openai: OpenAI = await newOpenAICompatibleSDK({ providerName, settingsOfProvider, includeInPayload })
	if (providerName === 'microsoftAzure') {
		// Required to select the model
		(openai as AzureOpenAI).deploymentName = modelName;
	}
	// Strip image blocks — many models don't support image input and
	// return confusing errors like "Cannot read clipboard (this model
	// does not support image input)."
	const cleanedMessages = messages.map(msg => {
		if (msg.role !== 'user' || typeof (msg as any).content === 'string') return msg
		const content = (msg as any).content as Array<{ type: string }>
		const nonImageContent = content.filter((p: { type: string }) => p.type !== 'image_url' && p.type !== 'image')
		if (nonImageContent.length === 0) return { role: 'user', content: '' }
		if (nonImageContent.length === 1 && nonImageContent[0].type === 'text') {
			return { role: 'user', content: (nonImageContent[0] as { type: 'text'; text: string }).text }
		}
		return { role: 'user', content: nonImageContent }
	})

	const options: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model: modelName,
		messages: cleanedMessages as any,
		stream: true,
		...nativeToolsObj,
		...additionalOpenAIPayload
		// max_completion_tokens: maxTokens,
	}

	// open source models - manually parse think tokens
	const { needsManualParse: needsManualReasoningParse, nameOfFieldInDelta: nameOfReasoningFieldInDelta } = providerReasoningIOSettings?.output ?? {}
	const manuallyParseReasoning = needsManualReasoningParse && canIOReasoning && openSourceThinkTags
	if (manuallyParseReasoning) {
		const { newOnText, newOnFinalMessage } = extractReasoningWrapper(onText, onFinalMessage, openSourceThinkTags)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools, toolPolicy)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	let fullReasoningSoFar = ''
	let fullTextSoFar = ''

	// 🚀 FIX: Track multiple tools by index for parallel tool calling support
	const toolsByIndex = new Map<number, { name: string; id: string; paramsStr: string }>()
	const allTools: { name: string; id: string; paramsStr: string }[] = []

	openai.chat.completions
		.create(options)
		.then(async response => {
			_setAborter(() => response.controller.abort())
			// when receive text
			for await (const chunk of response) {
				// message
				const newText = chunk.choices[0]?.delta?.content ?? ''
				fullTextSoFar += newText

				// tool call - handle ALL tool indices for parallel execution
				for (const tool of chunk.choices[0]?.delta?.tool_calls ?? []) {
					const index = tool.index ?? 0

					let toolData = toolsByIndex.get(index)

				// Detect NEW tool on same index (sequential tool calling or collision).
				// The OpenAI streaming spec sends tool calls as incremental deltas keyed by
				// `index`; the `type` field is NOT a reliable "new tool" signal because many
				// OpenAI-compatible providers (GLM/zhipu, and others) include `type: 'function'`
				// on EVERY delta chunk, not just the first one. Treating that as a split would
				// fragment a single tool call into many entries (one per chunk), losing the
				// arguments and producing "path was null" / "unexpected argument" errors.
				//
				// A tool call is only treated as NEW when:
				// 1. There is no existing tool at this index, OR
				// 2. The id explicitly mismatches the accumulated id (strongest signal), OR
				// 3. A non-empty name update arrives that differs from the accumulated name AND
				//    we already have arguments for the current tool (genuine sequential call).
				const hasArgs = toolData && toolData.paramsStr.length > 0

				const isIdMismatch = toolData && tool.id && toolData.id && !toolData.id.startsWith(tool.id) && !tool.id.startsWith(toolData.id)

				const incomingName = tool.function?.name ?? ''
				const isNameUpdate = !!incomingName
				// A name update indicates a NEW tool only if it differs from what we already
				// accumulated. This lets "Rea" + "d" (name split across chunks) accumulate
				// correctly while "Read" + "Read" (a second tool call) splits.
				const isConflictingName = isNameUpdate && !!toolData?.name && !toolData.name.startsWith(incomingName) && !incomingName.startsWith(toolData.name)

				const shouldSplit = !toolData
					|| isIdMismatch
					|| (hasArgs && isNameUpdate && isConflictingName)

					if (shouldSplit) {
						toolData = { name: '', id: '', paramsStr: '' }
						toolsByIndex.set(index, toolData)
						allTools.push(toolData)
					}

					if (!toolData) {
						// Should not happen as we set it above, but for TS checks
						toolData = { name: '', id: '', paramsStr: '' }
						toolsByIndex.set(index, toolData)
						allTools.push(toolData)
					}

				toolData.name += tool.function?.name ?? ''
				toolData.paramsStr += tool.function?.arguments ?? ''
				// Only set the id once. Many OpenAI-compatible providers (GLM/zhipu, etc.)
				// repeat the same id on every delta chunk; concatenating would produce
				// "call_1call_1call_1..." and break tool_call_id matching on replay.
				if (!toolData.id && tool.id) {
					toolData.id = tool.id
				}
			}

				// reasoning
				let newReasoning = ''
				if (nameOfReasoningFieldInDelta) {
					// @ts-ignore
					newReasoning = (chunk.choices[0]?.delta?.[nameOfReasoningFieldInDelta] || '') + ''
					fullReasoningSoFar += newReasoning
				}

				// For streaming, show first tool (if any) for backward compatibility
				const firstTool = allTools[0]
				const streamingToolCall = firstTool && firstTool.name ?
					(rawToolCallObjOfParamsStr(firstTool.name, firstTool.paramsStr, firstTool.id) ?? { name: firstTool.name, rawParams: {}, isDone: false, doneParams: [], id: firstTool.id }) : undefined

				// 🚀 FIX: Pass ALL streaming tools (using allTools to preserve order and history)
				const streamingToolCalls = allTools
					.map(t => rawToolCallObjOfParamsStr(t.name, t.paramsStr, t.id) ?? { name: t.name, rawParams: {}, isDone: false, doneParams: [], id: t.id })

				// call onText
				onText({
					fullText: fullTextSoFar,
					fullReasoning: fullReasoningSoFar,
					toolCall: streamingToolCall,
					toolCalls: streamingToolCalls.length > 0 ? streamingToolCalls : undefined,
				})

			}
			// on final - extract ALL completed tools
			const allToolCalls = allTools
				.map(toolData => rawToolCallObjOfParamsStr(toolData.name, toolData.paramsStr, toolData.id))
				.filter((tc): tc is RawToolCallObj => tc !== null)

			const toolCall = allToolCalls[0] // First tool for backward compatibility
			const toolCalls = allToolCalls.length > 0 ? allToolCalls : undefined

			const toolCallObj: { toolCall?: RawToolCallObj; toolCalls?: RawToolCallObj[] } = {}
			if (toolCall) toolCallObj.toolCall = toolCall
			if (toolCalls) toolCallObj.toolCalls = toolCalls

			console.log(`[OpenAI SDK] Extracted ${allToolCalls.length} tool(s) from stream:`, allToolCalls.map(t => t.name).join(', '))

			if (!fullTextSoFar && !fullReasoningSoFar && allToolCalls.length === 0) {
				onError({ message: 'Orbit: Response from model was empty.', fullError: null })
			}
			else {
				onFinalMessage({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, anthropicReasoning: null, ...toolCallObj });
			}
		})
		// when error/fail - this catches errors of both .create() and .then(for await)
		.catch(error => {
			if (error instanceof OpenAI.APIError && error.status === 401) { onError({ message: invalidApiKeyMessage(providerName), fullError: error }); }
			else {
				const errMsg = error?.message ?? ''
				if (typeof errMsg === 'string' && (
					errMsg.includes('does not support image') ||
					errMsg.includes('clipboard') ||
					(errMsg.includes('image') && errMsg.includes('support'))
				)) {
					onError({
						message: `This model (${modelName}) does not support image input. Please use a vision-capable model.`,
						fullError: error
					});
					return;
				}
				onError({ message: error + '', fullError: error });
			}
		})
}



type OpenAiCodexInputContent = {
	type: 'input_text' | 'output_text';
	text: string;
} | {
	type: 'input_image';
	image_url: { url: string };
}

type OpenAiCodexInputItem = {
	role: 'user' | 'assistant' | 'system' | 'developer';
	content: OpenAiCodexInputContent[];
} | {
	type: 'function_call';
	name: string;
	arguments: string;
	call_id: string;
} | {
	type: 'function_call_output';
	call_id: string;
	output: string;
}

const toOpenAiCodexInputContent = (role: LLMChatMessage['role'], content: OpenAILLMChatMessage['content']): OpenAiCodexInputContent[] => {
	if (typeof content === 'string') {
		const type = role === 'assistant' ? 'output_text' : 'input_text'
		return content ? [{ type, text: content }] : []
	}
	if (!Array.isArray(content)) return []

	const items: OpenAiCodexInputContent[] = []
	for (const part of content) {
		if (typeof part === 'object' && part && 'text' in part && typeof part.text === 'string') {
			if (part.text) {
				const type = role === 'assistant' ? 'output_text' : 'input_text'
				items.push({ type, text: part.text })
			}
			continue
		}
		if (typeof part === 'object' && part && part.type === 'image_url' && part.image_url?.url) {
			items.push({ type: 'input_image', image_url: { url: part.image_url.url } })
		}
	}
	return items
}

const buildOpenAiCodexInput = (
	messages: LLMChatMessage[],
	separateSystemMessage: string | undefined,
	includeToolCalls: boolean,
) => {
	const instructions: string[] = []
	if (separateSystemMessage) {
		instructions.push(separateSystemMessage)
	}

	const input: OpenAiCodexInputItem[] = []
	const emittedToolCallIds = new Set<string>()
	const pendingToolOutputs: Array<{ callId: string; output: string }> = []

	const flushPendingOutputs = (allowedIds: Set<string>) => {
		if (pendingToolOutputs.length === 0) return
		const remaining: Array<{ callId: string; output: string }> = []
		for (const pending of pendingToolOutputs) {
			if (allowedIds.has(pending.callId)) {
				input.push({
					type: 'function_call_output',
					call_id: pending.callId,
					output: pending.output,
				})
			} else {
				remaining.push(pending)
			}
		}
		pendingToolOutputs.length = 0
		pendingToolOutputs.push(...remaining)
	}

	for (const message of messages as OpenAILLMChatMessage[]) {
		if (message.role === 'system' || message.role === 'developer') {
			const contentItems = toOpenAiCodexInputContent(message.role, message.content)
			const text = contentItems.map(item => item.type === 'input_text' ? item.text : '').join('\n').trim()
			if (text) instructions.push(text)
			continue
		}

		if (message.role === 'tool') {
			if (!includeToolCalls) continue
			const output = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')
			if (message.tool_call_id && emittedToolCallIds.has(message.tool_call_id)) {
				input.push({
					type: 'function_call_output',
					call_id: message.tool_call_id,
					output,
				})
			} else if (message.tool_call_id) {
				pendingToolOutputs.push({ callId: message.tool_call_id, output })
			}
			continue
		}

		if (message.role === 'assistant' && message.tool_calls?.length) {
			if (!includeToolCalls) continue
			const newlyEmitted = new Set<string>()
			for (const toolCall of message.tool_calls) {
				if (!toolCall.function?.name) continue
				const callId = toolCall.id ?? generateUuid()
				emittedToolCallIds.add(callId)
				newlyEmitted.add(callId)
				input.push({
					type: 'function_call',
					name: toolCall.function.name,
					arguments: toolCall.function.arguments ?? '',
					call_id: callId,
				})
			}
			flushPendingOutputs(newlyEmitted)
		}

		const contentItems = toOpenAiCodexInputContent(message.role, message.content)
		if (contentItems.length > 0) {
			input.push({
				role: message.role,
				content: contentItems,
			})
		}
	}

	return {
		input,
		instructions: instructions.length > 0 ? instructions.join('\n\n') : undefined,
	}
}

const sendOpenAICodexChat = async ({ messages, onText, onFinalMessage, onError, modelSelectionOptions, modelName: modelName_, _setAborter, providerName, chatMode, separateSystemMessage, overridesOfModel, mcpTools, toolPolicy }: SendChatParams_Internal) => {
	const {
		modelName,
		specialToolFormat,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel)
	const tools = openAiCodexTools(chatMode, mcpTools, toolPolicy)
	const toolPayload = tools && specialToolFormat === 'openai-style'
		? { tools, tool_choice: 'auto', parallel_tool_calls: false }
		: {}
	const toolNameSet = new Set<string>(tools?.map(tool => tool.name) ?? [])

	const { input, instructions } = buildOpenAiCodexInput(messages, separateSystemMessage, true)

	const payload: Record<string, unknown> = {
		model: modelName,
		input,
		stream: true,
		store: false,
		...toolPayload,
	}

	if (instructions) {
		payload.instructions = instructions
	}

	if (reasoningInfo?.isReasoningEnabled) {
		if (reasoningInfo.type === 'effort_slider_value') {
			payload.reasoning = { effort: reasoningInfo.reasoningEffort, summary: 'auto' }
		}
		if (reasoningInfo.type === 'budget_slider_value') {
			payload.reasoning = { max_tokens: reasoningInfo.reasoningBudget, summary: 'auto' }
		}
		payload.include = ['reasoning.encrypted_content']
	}

	let oauthManager: ReturnType<typeof getOpenAiCodexOAuthManager>
	try {
		oauthManager = getOpenAiCodexOAuthManager()
	} catch (error) {
		const message = error instanceof Error ? error.message : `Authentication failed: ${error}`
		onError({ message, fullError: error instanceof Error ? error : null })
		return
	}

	let accessToken: string
	try {
		accessToken = await oauthManager.getAccessToken()
	} catch (error) {
		const message = error instanceof Error ? error.message : `Authentication failed: ${error}`
		onError({ message, fullError: error instanceof Error ? error : null })
		return
	}

	let accountId = oauthManager.getAccountId()

	const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

	const readErrorPayload = async (response: Response): Promise<string | undefined> => {
		try {
			const text = await response.text()
			if (!text) return undefined
			try {
				const parsed = JSON.parse(text)
				if (typeof parsed?.detail === 'string') return parsed.detail
				if (typeof parsed?.error?.message === 'string') return parsed.error.message
				return text
			} catch {
				return text
			}
		} catch {
			return undefined
		}
	}

	const parseRetryAfterMs = (response: Response): number | null => {
		const retryAfter = response.headers.get('retry-after')
		if (!retryAfter) return null
		const asNumber = Number(retryAfter)
		if (!Number.isNaN(asNumber)) {
			return Math.max(0, Math.floor(asNumber * 1000))
		}
		const asDate = Date.parse(retryAfter)
		if (!Number.isNaN(asDate)) {
			return Math.max(0, asDate - Date.now())
		}
		return null
	}

	const sendRequest = async (allowRefresh: boolean, retryCount = 0): Promise<void> => {
		const controller = new AbortController()
		_setAborter(() => controller.abort())

		let response: Response
		try {
			response = await fetch('https://chatgpt.com/backend-api/codex/responses', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${accessToken}`,
					'Content-Type': 'application/json',
					Accept: 'text/event-stream',
					originator: OPENAI_CODEX_OAUTH_CONFIG.originatorHeader,
					session_id: generateUuid(),
					...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
					'User-Agent': 'orbit-editor',
				},
				body: JSON.stringify(payload),
				signal: controller.signal,
			})
		} catch (fetchError) {
			if (fetchError instanceof Error && fetchError.name === 'AbortError') {
				throw new Error('Request was cancelled')
			}
			if (fetchError instanceof TypeError && fetchError.message.includes('fetch')) {
				throw new Error('Network error: Unable to connect to OpenAI Codex. Please check your internet connection.')
			}
			throw new Error(`Request failed: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`)
		}

		if (response.status === 401) {
			if (allowRefresh) {
				try {
					accessToken = await oauthManager.forceRefreshAccessToken()
					accountId = oauthManager.getAccountId()
					return sendRequest(false)
				} catch (refreshError) {
					await oauthManager.clearCredentials()
					throw refreshError
				}
			}
			await oauthManager.clearCredentials()
			throw new Error('OpenAI Codex authentication expired. Sign in again.')
		}

		if (response.status === 402 || response.status === 403) {
			const detail = await readErrorPayload(response)
			if (detail && detail.toLowerCase().includes('not included in your plan')) {
				throw new Error('OpenAI Codex usage is not enabled for this workspace or plan. Select a workspace with Codex access or upgrade your plan.')
			}
			throw new Error(`OpenAI Codex access is unavailable for this account.${detail ? ` ${detail}` : ''}`.trim())
		}

		if (response.status === 429) {
			const retryAfterMs = parseRetryAfterMs(response)
			const detail = await readErrorPayload(response)
			if (detail && detail.toLowerCase().includes('not included in your plan')) {
				throw new Error('OpenAI Codex usage is not enabled for this workspace or plan. Select a workspace with Codex access or upgrade your plan.')
			}
			if (retryAfterMs !== null && retryAfterMs <= 10_000 && retryCount < 1) {
				await delay(retryAfterMs)
				return sendRequest(allowRefresh, retryCount + 1)
			}
			const suffix = retryAfterMs !== null ? ` Retry after ${Math.ceil(retryAfterMs / 1000)}s.` : ''
			throw new Error(`OpenAI Codex rate limit reached.${suffix}${detail ? ` ${detail}` : ''}`.trim())
		}

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(`OpenAI Codex request failed (${response.status}). ${errorText}`.trim())
		}

		const reader = response.body?.getReader()
		if (!reader) {
			throw new Error('OpenAI Codex response stream unavailable.')
		}

		const decoder = new TextDecoder()
		let buffer = ''
		let fullTextSoFar = ''
		let fullReasoningSoFar = ''
		const toolCallsById = new Map<string, { id: string; name: string; args: string }>()
		const toolCallOrder: string[] = []
		let lastToolCallId: string | null = null

		const ensureToolCall = (id: string, name?: string) => {
			if (!toolCallsById.has(id)) {
				toolCallsById.set(id, { id, name: name ?? '', args: '' })
				toolCallOrder.push(id)
			} else if (name) {
				const existing = toolCallsById.get(id)
				if (existing) existing.name = name
			}
			lastToolCallId = id
		}

		const appendToolArgs = (id: string, delta: string) => {
			if (!delta) return
			ensureToolCall(id)
			const existing = toolCallsById.get(id)
			if (existing) existing.args += delta
		}

		const setToolArgs = (id: string, value: string) => {
			ensureToolCall(id)
			const existing = toolCallsById.get(id)
			if (existing) existing.args = value
		}

		const emitUpdate = () => {
			const toolCalls = toolCallOrder
				.map(id => toolCallsById.get(id))
				.filter((tool): tool is { id: string; name: string; args: string } => !!tool)
				.map(tool => rawToolCallObjOfParamsStr(tool.name, tool.args, tool.id))
				.filter((toolCall): toolCall is RawToolCallObj => toolCall !== null)

			onText({
				fullText: fullTextSoFar,
				fullReasoning: fullReasoningSoFar,
				toolCall: toolCalls[0],
				toolCalls: toolCalls.length ? toolCalls : undefined,
			})
		}

		const resolveToolCallId = (event: any) => {
			const id = event.call_id ?? event.tool_call_id ?? event.item_id ?? event.id ?? event.item?.id ?? event.item?.call_id
			if (id) return String(id)
			if (lastToolCallId) return lastToolCallId
			return `call_${generateUuid()}`
		}

		const normalizeToolName = (name?: string) => {
			if (!name) return undefined
			const trimmed = name.trim()
			if (!trimmed) return undefined
			if (toolNameSet.has(trimmed)) return trimmed
			const normalized = trimmed.replace(/\s+/g, '_').replace(/-+/g, '_')
			if (toolNameSet.has(normalized)) return normalized
			return trimmed
		}

		const resolveToolName = (event: any) => {
			const name = event.name ?? event.item?.name ?? event.item?.function?.name ?? event.item?.tool?.name
			return typeof name === 'string' ? normalizeToolName(name) : undefined
		}

		const appendOutputFromResponse = (responsePayload: any) => {
			const outputItems = responsePayload?.output
			if (!Array.isArray(outputItems)) return
			for (const item of outputItems) {
				if (item?.type === 'message' && Array.isArray(item.content)) {
					for (const content of item.content) {
						if (content?.type === 'output_text' || content?.type === 'text') {
							if (typeof content.text === 'string') {
								fullTextSoFar += content.text
							}
						}
					}
				}
				if (item?.type === 'text' && typeof item.text === 'string') {
					fullTextSoFar += item.text
				}
			}
		}

		const handleEvent = (event: any) => {
			if (!event || typeof event !== 'object') return
			switch (event.type) {
				case 'response.text.delta':
				case 'response.output_text.delta':
					if (typeof event.delta === 'string') {
						fullTextSoFar += event.delta
						emitUpdate()
					}
					break
				case 'response.refusal.delta':
					if (typeof event.delta === 'string') {
						fullTextSoFar += event.delta
						emitUpdate()
					}
					break
				case 'response.reasoning.delta':
				case 'response.reasoning_text.delta':
				case 'response.reasoning_summary.delta':
				case 'response.reasoning_summary_text.delta':
					if (typeof event.delta === 'string') {
						fullReasoningSoFar += event.delta
						emitUpdate()
					}
					break
				case 'response.output_item.added':
				case 'response.output_item.done': {
					const item = event.item
					if (item?.type === 'function_call' || item?.type === 'tool_call') {
						const callId = String(item.call_id ?? item.id ?? resolveToolCallId(event))
						ensureToolCall(callId, item.name)
						if (typeof item.arguments === 'string') {
							setToolArgs(callId, item.arguments)
							emitUpdate()
						}
					}
					break
				}
				case 'response.function_call_arguments.delta':
				case 'response.tool_call_arguments.delta': {
					const callId = resolveToolCallId(event)
					const name = resolveToolName(event)
					ensureToolCall(callId, name)
					if (typeof event.delta === 'string') {
						appendToolArgs(callId, event.delta)
						emitUpdate()
					}
					break
				}
				case 'response.function_call_arguments.done':
				case 'response.tool_call_arguments.done': {
					const callId = resolveToolCallId(event)
					const name = resolveToolName(event)
					ensureToolCall(callId, name)
					if (typeof event.arguments === 'string') {
						// done provides the full arguments; replace to avoid duplicating delta content
						setToolArgs(callId, event.arguments)
						emitUpdate()
					}
					break
				}
				case 'response.done':
				case 'response.completed':
					if (!fullTextSoFar && event.response) {
						appendOutputFromResponse(event.response)
					}
					break
			}
		}

		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			buffer += decoder.decode(value, { stream: true })
			const lines = buffer.split(/\r?\n/)
			buffer = lines.pop() ?? ''

			for (const line of lines) {
				const trimmed = line.trim()
				if (!trimmed.startsWith('data:')) continue
				const data = trimmed.slice(5).trim()
				if (!data || data === '[DONE]') continue
				try {
					const event = JSON.parse(data)
					handleEvent(event)
				} catch {
					continue
				}
			}
		}

		const toolCalls = toolCallOrder
			.map(id => toolCallsById.get(id))
			.filter((tool): tool is { id: string; name: string; args: string } => !!tool)
			.map(tool => rawToolCallObjOfParamsStr(tool.name, tool.args, tool.id))
			.filter((toolCall): toolCall is RawToolCallObj => toolCall !== null)

		if (!fullTextSoFar && !fullReasoningSoFar && toolCalls.length === 0) {
			onError({ message: 'Orbit: Response from model was empty.', fullError: null })
			return
		}

		onFinalMessage({
			fullText: fullTextSoFar,
			fullReasoning: fullReasoningSoFar,
			anthropicReasoning: null,
			toolCall: toolCalls[0],
			toolCalls: toolCalls.length ? toolCalls : undefined,
		})
	}

	try {
		await sendRequest(true)
	} catch (error) {
		const message = error instanceof Error ? error.message : `${error}`
		onError({ message, fullError: error instanceof Error ? error : null })
	}
}


type OpenAIModel = {
	id: string;
	created: number;
	object: 'model';
	owned_by: string;
}
const _openaiCompatibleList = async ({ onSuccess: onSuccess_, onError: onError_, settingsOfProvider, providerName }: ListParams_Internal<OpenAIModel>) => {
	const onSuccess = ({ models }: { models: OpenAIModel[] }) => {
		onSuccess_({ models })
	}
	const onError = ({ error }: { error: string }) => {
		onError_({ error })
	}
	try {
		const openai = await newOpenAICompatibleSDK({ providerName, settingsOfProvider })
		openai.models.list()
			.then(async (response) => {
				const models: OpenAIModel[] = []
				models.push(...response.data)
				while (response.hasNextPage()) {
					models.push(...(await response.getNextPage()).data)
				}
				onSuccess({ models })
			})
			.catch((error) => {
				onError({ error: error + '' })
			})
	}
	catch (error) {
		onError({ error: error + '' })
	}
}




// ------------ ANTHROPIC (HELPERS) ------------
const toAnthropicTool = (toolInfo: InternalToolInfo) => {
	const { name, description } = toolInfo
	return {
		name: name,
		description: description,
		input_schema: schemaOfToolInfo(toolInfo) as Anthropic.Messages.Tool['input_schema'],
	} satisfies Anthropic.Messages.Tool
}

const anthropicTools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined, toolPolicy?: ToolPolicy) => {
	const allowedTools = availableTools(chatMode, mcpTools, toolPolicy)
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null

	const anthropicTools: Anthropic.Messages.ToolUnion[] = []
	for (const t in allowedTools ?? {}) {
		anthropicTools.push(toAnthropicTool(allowedTools[t]))
	}
	return anthropicTools
}



// ------------ ANTHROPIC ------------
const sendAnthropicChat = async ({ messages, providerName, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, overridesOfModel, modelName: modelName_, _setAborter, separateSystemMessage, chatMode, mcpTools, toolPolicy }: SendChatParams_Internal) => {
	const {
		modelName,
		specialToolFormat,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	const thisConfig = settingsOfProvider.anthropic
	const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel) // user's modelName_ here
	const includeInPayload = providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo) || {}

	// anthropic-specific - max tokens
	const maxTokens = getReservedOutputTokenSpace(providerName, modelName_, { isReasoningEnabled: !!reasoningInfo?.isReasoningEnabled, overridesOfModel })

	// tools
	const potentialTools = anthropicTools(chatMode, mcpTools, toolPolicy)
	const nativeToolsObj = potentialTools && specialToolFormat === 'anthropic-style' ?
		{ tools: potentialTools, tool_choice: { type: 'auto' } } as const
		: {}


	// instance
	const anthropic = new Anthropic({
		apiKey: thisConfig.apiKey,
		dangerouslyAllowBrowser: true
	});

	const stream = anthropic.messages.stream({
		system: separateSystemMessage ?? undefined,
		messages: messages as AnthropicLLMChatMessage[],
		model: modelName,
		max_tokens: maxTokens ?? 4_096, // anthropic requires this
		...includeInPayload,
		...nativeToolsObj,

	})

	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools, toolPolicy)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// when receive text
	let fullText = ''
	let fullReasoning = ''

	// Track ALL tool calls
	const allToolCalls: { name: string; paramsStr: string; id: string }[] = []

	const runOnText = () => {
		const streamingToolCalls = allToolCalls.map(t => rawToolCallObjOfParamsStr(t.name, t.paramsStr, t.id) ?? {
			name: t.name,
			rawParams: {},
			isDone: false,
			doneParams: [],
			id: t.id
		})

		const firstTool = allToolCalls[0]
		const toolCall = firstTool ? (rawToolCallObjOfParamsStr(firstTool.name, firstTool.paramsStr, firstTool.id) ?? { name: firstTool.name, rawParams: {}, isDone: false, doneParams: [], id: firstTool.id }) : undefined

		onText({
			fullText,
			fullReasoning,
			toolCall,
			toolCalls: streamingToolCalls.length > 0 ? streamingToolCalls : undefined,
		})
	}
	// there are no events for tool_use, it comes in at the end
	stream.on('streamEvent', e => {
		// start block
		if (e.type === 'content_block_start') {
			if (e.content_block.type === 'text') {
				if (fullText) fullText += '\n\n' // starting a 2nd text block
				fullText += e.content_block.text
				runOnText()
			}
			else if (e.content_block.type === 'thinking') {
				if (fullReasoning) fullReasoning += '\n\n' // starting a 2nd reasoning block
				fullReasoning += e.content_block.thinking
				runOnText()
			}
			else if (e.content_block.type === 'redacted_thinking') {
				console.log('delta', e.content_block.type)
				if (fullReasoning) fullReasoning += '\n\n' // starting a 2nd reasoning block
				fullReasoning += '[redacted_thinking]'
				runOnText()
			}
			else if (e.content_block.type === 'tool_use') {
				// Start a NEW tool call
				allToolCalls.push({
					name: e.content_block.name,
					paramsStr: '',
					id: e.content_block.id
				})
				runOnText()
			}
		}

		// delta
		else if (e.type === 'content_block_delta') {
			if (e.delta.type === 'text_delta') {
				fullText += e.delta.text
				runOnText()
			}
			else if (e.delta.type === 'thinking_delta') {
				fullReasoning += e.delta.thinking
				runOnText()
			}
			else if (e.delta.type === 'input_json_delta') { // tool use
				// Append to the LAST tool call
				const lastTool = allToolCalls[allToolCalls.length - 1]
				if (lastTool) {
					lastTool.paramsStr += e.delta.partial_json ?? ''
				}
				runOnText()
			}
		}
	})

	// on done - (or when error/fail) - this is called AFTER last streamEvent
	stream.on('finalMessage', (response) => {
		const anthropicReasoning = response.content.filter(c => c.type === 'thinking' || c.type === 'redacted_thinking')
		const tools = response.content.filter(c => c.type === 'tool_use')

		// Use the authoritative tools from the final response
		const finalToolCalls = tools.map(tool => rawToolCallObjOfAnthropicParams(tool)).filter((tc): tc is RawToolCallObj => tc !== null)

		const toolCall = finalToolCalls[0] // First tool for backward compatibility
		const toolCalls = finalToolCalls.length > 0 ? finalToolCalls : undefined
		// console.log('TOOLS!!!!!!', JSON.stringify(tools, null, 2))
		// console.log('TOOLS!!!!!!', JSON.stringify(response, null, 2))

		const toolCallObj: { toolCall?: RawToolCallObj; toolCalls?: RawToolCallObj[] } = {}
		if (toolCall) toolCallObj.toolCall = toolCall
		if (toolCalls) toolCallObj.toolCalls = toolCalls

		console.log(`[Anthropic SDK] Extracted ${finalToolCalls.length} tool(s) from finalMessage:`, finalToolCalls.map(t => t.name).join(', '))

		onFinalMessage({ fullText, fullReasoning, anthropicReasoning, ...toolCallObj })
	})
	// on error
	stream.on('error', (error) => {
		if (error instanceof Anthropic.APIError && error.status === 401) { onError({ message: invalidApiKeyMessage(providerName), fullError: error }) }
		else { onError({ message: error + '', fullError: error }) }
	})
	_setAborter(() => stream.controller.abort())
}



// ------------ MISTRAL ------------
// https://docs.mistral.ai/api/#tag/fim
const sendMistralFIM = ({ messages, onFinalMessage, onError, settingsOfProvider, overridesOfModel, modelName: modelName_, _setAborter, providerName }: SendFIMParams_Internal) => {
	const { modelName, supportsFIM } = getModelCapabilities(providerName, modelName_, overridesOfModel)
	if (!supportsFIM) {
		if (modelName === modelName_)
			onError({ message: `Model ${modelName} does not support FIM.`, fullError: null })
		else
			onError({ message: `Model ${modelName_} (${modelName}) does not support FIM.`, fullError: null })
		return
	}

	const mistral = new MistralCore({ apiKey: settingsOfProvider.mistral.apiKey })
	fimComplete(mistral,
		{
			model: modelName,
			prompt: messages.prefix,
			suffix: messages.suffix,
			stream: false,
			maxTokens: 300,
			stop: messages.stopTokens,
		})
		.then(async response => {

			// unfortunately, _setAborter() does not exist
			let content = response?.ok ? response.value.choices?.[0]?.message?.content ?? '' : '';
			const fullText = typeof content === 'string' ? content
				: content.map(chunk => (chunk.type === 'text' ? chunk.text : '')).join('')

			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null });
		})
		.catch(error => {
			onError({ message: error + '', fullError: error });
		})
}


// ------------ OLLAMA ------------
const newOllamaSDK = ({ endpoint }: { endpoint: string }) => {
	// if endpoint is empty, normally ollama will send to 11434, but we want it to fail - the user should type it in
	if (!endpoint) throw new Error(`Ollama Endpoint was empty (please enter ${defaultProviderSettings.ollama.endpoint} in Void if you want the default url).`)
	const ollama = new Ollama({ host: endpoint })
	return ollama
}

const ollamaList = async ({ onSuccess: onSuccess_, onError: onError_, settingsOfProvider }: ListParams_Internal<OllamaModelResponse>) => {
	const onSuccess = ({ models }: { models: OllamaModelResponse[] }) => {
		onSuccess_({ models })
	}
	const onError = ({ error }: { error: string }) => {
		onError_({ error })
	}
	try {
		const thisConfig = settingsOfProvider.ollama
		const ollama = newOllamaSDK({ endpoint: thisConfig.endpoint })
		ollama.list()
			.then((response) => {
				const { models } = response
				onSuccess({ models })
			})
			.catch((error) => {
				onError({ error: error + '' })
			})
	}
	catch (error) {
		onError({ error: error + '' })
	}
}

const sendOllamaFIM = ({ messages, onFinalMessage, onError, settingsOfProvider, modelName, _setAborter }: SendFIMParams_Internal) => {
	const thisConfig = settingsOfProvider.ollama
	const ollama = newOllamaSDK({ endpoint: thisConfig.endpoint })

	let fullText = ''
	ollama.generate({
		model: modelName,
		prompt: messages.prefix,
		suffix: messages.suffix,
		options: {
			stop: messages.stopTokens,
			num_predict: 300, // max tokens
			// repeat_penalty: 1,
		},
		raw: true,
		stream: true, // stream is not necessary but lets us expose the
	})
		.then(async stream => {
			_setAborter(() => stream.abort())
			for await (const chunk of stream) {
				const newText = chunk.response
				fullText += newText
			}
			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null })
		})
		// when error/fail
		.catch((error) => {
			onError({ message: error + '', fullError: error })
		})
}

// ---------------- GEMINI NATIVE IMPLEMENTATION ----------------

const toGeminiFunctionDecl = (toolInfo: InternalToolInfo) => {
	const { name, description, params } = toolInfo
	const inputSchema = toolInfo.inputSchema as JsonToolSchema | undefined
	return {
		name,
		description,
		parameters: inputSchema ? jsonSchemaToGeminiSchema(inputSchema) : {
			type: Type.OBJECT,
			properties: Object.entries(params).reduce((acc, [key, value]) => {
				acc[key] = {
					type: Type.STRING,
					description: value.description
				};
				return acc;
			}, {} as Record<string, Schema>)
		}
	} satisfies FunctionDeclaration
}

const geminiTools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined, toolPolicy?: ToolPolicy): GeminiTool[] | null => {
	const allowedTools = availableTools(chatMode, mcpTools, toolPolicy)
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null
	const functionDecls: FunctionDeclaration[] = []
	for (const t in allowedTools ?? {}) {
		functionDecls.push(toGeminiFunctionDecl(allowedTools[t]))
	}
	const tools: GeminiTool = { functionDeclarations: functionDecls, }
	return [tools]
}



// Implementation for Gemini using Google's native API
const sendGeminiChat = async ({
	messages,
	separateSystemMessage,
	onText,
	onFinalMessage,
	onError,
	settingsOfProvider,
	overridesOfModel,
	modelName: modelName_,
	_setAborter,
	providerName,
	modelSelectionOptions,
	chatMode,
	mcpTools,
	toolPolicy,
}: SendChatParams_Internal) => {

	if (providerName !== 'gemini') throw new Error(`Sending Gemini chat, but provider was ${providerName}`)

	const thisConfig = settingsOfProvider[providerName]

	const {
		modelName,
		specialToolFormat,
		// reasoningCapabilities,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	// const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	// const { canIOReasoning, openSourceThinkTags, } = reasoningCapabilities || {}
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel) // user's modelName_ here
	// const includeInPayload = providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo) || {}

	const thinkingConfig: ThinkingConfig | undefined = !reasoningInfo?.isReasoningEnabled ? undefined
		: reasoningInfo.type === 'budget_slider_value' ?
			{ thinkingBudget: reasoningInfo.reasoningBudget }
			: undefined

	// tools
	const potentialTools = geminiTools(chatMode, mcpTools, toolPolicy)
	const toolConfig = potentialTools && specialToolFormat === 'gemini-style' ?
		potentialTools
		: undefined

	// instance
	const genAI = new GoogleGenAI({ apiKey: thisConfig.apiKey });


	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools, toolPolicy)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// when receive text
	let fullReasoningSoFar = ''
	let fullTextSoFar = ''

	// 🚀 FIX: Track multiple tools by ID for parallel tool calling support
	const toolsById = new Map<string, { name: string; paramsStr: string }>()

	genAI.models.generateContentStream({
		model: modelName,
		config: {
			systemInstruction: separateSystemMessage,
			thinkingConfig: thinkingConfig,
			tools: toolConfig,
		},
		contents: messages as GeminiLLMChatMessage[],
	})
		.then(async (stream) => {
			_setAborter(() => { stream.return(fullTextSoFar)?.catch(() => {}); });

			// Process the stream
			for await (const chunk of stream) {
				// message
				const newText = chunk.text ?? ''
				fullTextSoFar += newText

				// tool call - handle ALL function calls for parallel execution
				const functionCalls = chunk.functionCalls
				if (functionCalls && functionCalls.length > 0) {
					for (const functionCall of functionCalls) {
						const toolId = functionCall.id ?? ''
						if (!toolId) continue

						// Initialize tool tracking for this ID if not exists
						if (!toolsById.has(toolId)) {
							toolsById.set(toolId, { name: '', paramsStr: '' })
						}

						const toolData = toolsById.get(toolId)!
						toolData.name = functionCall.name ?? toolData.name
						// Accumulate params if they come in chunks, otherwise use the full args
						if (functionCall.args) {
							toolData.paramsStr = JSON.stringify(functionCall.args)
						}
					}
				}

				// (do not handle reasoning yet)

				// For streaming, show first tool (if any) for backward compatibility
				const firstTool = Array.from(toolsById.entries())[0]
				const streamingToolCall = firstTool && firstTool[1].name ?
					(rawToolCallObjOfParamsStr(firstTool[1].name, firstTool[1].paramsStr, firstTool[0]) ?? { name: firstTool[1].name, rawParams: {}, isDone: false, doneParams: [], id: firstTool[0] }) : undefined

				// call onText
				onText({
					fullText: fullTextSoFar,
					fullReasoning: fullReasoningSoFar,
					toolCall: streamingToolCall,
				})
			}

			// on final - extract ALL completed tools
			const allToolCalls = Array.from(toolsById.entries())
				.map(([toolId, toolData]) => {
					// Generate ID if missing (Gemini sometimes doesn't provide IDs)
					const finalId = toolId || generateUuid()
					return rawToolCallObjOfParamsStr(toolData.name, toolData.paramsStr, finalId)
				})
				.filter((tc): tc is RawToolCallObj => tc !== null)

			const toolCall = allToolCalls[0] // First tool for backward compatibility
			const toolCalls = allToolCalls.length > 0 ? allToolCalls : undefined

			const toolCallObj: { toolCall?: RawToolCallObj; toolCalls?: RawToolCallObj[] } = {}
			if (toolCall) toolCallObj.toolCall = toolCall
			if (toolCalls) toolCallObj.toolCalls = toolCalls

			console.log(`[Gemini SDK] Extracted ${allToolCalls.length} tool(s) from stream:`, allToolCalls.map(t => t.name).join(', '))

			if (!fullTextSoFar && !fullReasoningSoFar && allToolCalls.length === 0) {
				onError({ message: 'Orbit: Response from model was empty.', fullError: null })
			} else {
				onFinalMessage({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, anthropicReasoning: null, ...toolCallObj });
			}
		})
		.catch(error => {
			const message = error?.message
			if (typeof message === 'string') {

				// Check for image-related errors (model doesn't support images)
				if (error.message?.includes('image') || error.message?.includes('vision') || error.message?.includes('404') || error.message?.includes('clipboard')) {
					// Check specifically if it's about image support
					if (error.message?.includes('No endpoints found that support image input') ||
						error.message?.includes('does not support image') ||
						error.message?.includes('clipboard') ||
						(error.status === 404 && error.message?.includes('image'))) {
						onError({
							message: `This model (${modelName}) does not support image input. Please use a vision-capable model.)`,
							fullError: error
						});
						return;
					}
				}

				if (error.message?.includes('API key')) {
					onError({ message: invalidApiKeyMessage(providerName), fullError: error });
				}
				else if (error?.message?.includes('429')) {
					onError({ message: 'Rate limit reached. ' + error, fullError: error });
				}
				else
					onError({ message: error + '', fullError: error });
			}
			else {
				onError({ message: error + '', fullError: error });
			}
		})
};



type CallFnOfProvider = {
	[providerName in ProviderName]: {
		sendChat: (params: SendChatParams_Internal) => Promise<void>;
		sendFIM: ((params: SendFIMParams_Internal) => void) | null;
		list: ((params: ListParams_Internal<any>) => void) | null;
	}
}

export const sendLLMMessageToProviderImplementation = {
	anthropic: {
		sendChat: sendAnthropicChat,
		sendFIM: null,
		list: null,
	},
	openAI: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	openAICodex: {
		sendChat: (params) => sendOpenAICodexChat(params),
		sendFIM: null,
		list: null,
	},
	orbit: {
		sendChat: (params) => sendOrbitProviderChat(params),
		sendFIM: null,
		list: orbitProviderList,
	},
	xAI: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	gemini: {
		sendChat: (params) => sendGeminiChat(params),
		sendFIM: null,
		list: null,
	},
	mistral: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => sendMistralFIM(params),
		list: null,
	},
	ollama: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: sendOllamaFIM,
		list: ollamaList,
	},
	openAICompatible: {
		sendChat: (params) => _sendOpenAICompatibleChat(params), // using openai's SDK is not ideal (your implementation might not do tools, reasoning, FIM etc correctly), talk to us for a custom integration
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	openRouter: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	vLLM: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: (params) => _openaiCompatibleList(params),
	},
	deepseek: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	groq: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},

	lmStudio: {
		// lmStudio has no suffix parameter in /completions, so sendFIM might not work
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: (params) => _openaiCompatibleList(params),
	},
	liteLLM: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	googleVertex: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	microsoftAzure: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	awsBedrock: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},

} satisfies CallFnOfProvider




/*
FIM info (this may be useful in the future with vLLM, but in most cases the only way to use FIM is if the provider explicitly supports it):

qwen2.5-coder https://ollama.com/library/qwen2.5-coder/blobs/e94a8ecb9327
<|fim_prefix|>{{ .Prompt }}<|fim_suffix|>{{ .Suffix }}<|fim_middle|>

codestral https://ollama.com/library/codestral/blobs/51707752a87c
[SUFFIX]{{ .Suffix }}[PREFIX] {{ .Prompt }}

deepseek-coder-v2 https://ollama.com/library/deepseek-coder-v2/blobs/22091531faf0
<｜fim▁begin｜>{{ .Prompt }}<｜fim▁hole｜>{{ .Suffix }}<｜fim▁end｜>

starcoder2 https://ollama.com/library/starcoder2/blobs/3b190e68fefe
<file_sep>
<fim_prefix>
{{ .Prompt }}<fim_suffix>{{ .Suffix }}<fim_middle>
<|end_of_text|>

codegemma https://ollama.com/library/codegemma:2b/blobs/48d9a8140749
<|fim_prefix|>{{ .Prompt }}<|fim_suffix|>{{ .Suffix }}<|fim_middle|>

*/
