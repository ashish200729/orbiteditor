import { Disposable } from '../../../../base/common/lifecycle.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ChatMessage } from '../common/chatThreadServiceTypes.js';
import { getIsReasoningEnabledState, getReservedOutputTokenSpace, getModelCapabilities } from '../common/modelCapabilities.js';
import { reParsedToolXMLString, chat_systemMessage, augmentChatMessagesWithHarnessContext } from '../common/prompt/prompts.js';
import { AnthropicLLMChatMessage, AnthropicReasoning, GeminiLLMChatMessage, LLMChatMessage, LLMFIMMessage, OpenAILLMChatMessage, RawToolParamsObj, ToolPolicy } from '../common/sendLLMMessageTypes.js';
import { IVoidSettingsService } from '../common/orbitSettingsService.js';
import { ChatMode, FeatureName, ModelSelection, ProviderName } from '../common/orbitSettingsTypes.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { ITerminalToolService } from './terminalToolService.js';
import { IVoidModelService } from '../common/orbitModelService.js';
import { URI } from '../../../../base/common/uri.js';
import { EndOfLinePreference } from '../../../../editor/common/model.js';
import { ToolName } from '../common/toolsServiceTypes.js';
import { IMCPService } from '../common/mcpService.js';

export const EMPTY_MESSAGE = '(empty message)'

// Shared list of providers that use OpenAI-compatible API format.
// Used to default specialToolFormat to 'openai-style' when the caller doesn't specify one.
const openAICompatibleProviders: ProviderName[] = [
	'openAI', 'openAICodex', 'openRouter', 'openAICompatible', 'deepseek', 'groq', 'xAI', 'mistral',
	'ollama', 'vLLM', 'lmStudio', 'liteLLM'
]


type SimpleLLMMessage = {
	role: 'tool';
	content: string;
	id: string;
	name: ToolName;
	rawParams: RawToolParamsObj;
} | {
	role: 'user';
	content: string;
	images?: string[]; // Array of image URLs (data URIs or URLs)
} | {
	role: 'assistant';
	content: string;
	reasoning?: string; // DeepSeek reasoning_content to pass back
	anthropicReasoning: AnthropicReasoning[] | null;
}



const CHARS_PER_TOKEN = 4 // assume abysmal chars per token
const TRIM_TO_LEN = 120

// Supported image MIME types for Anthropic API
type AnthropicImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

// Helper functions to parse data URIs and extract base64 data
const parseDataURI = (dataUri: string): { mimeType: AnthropicImageMimeType; data: string } | null => {
	// Format: data:image/jpeg;base64,/9j/4AAQSkZJRg...
	const match = dataUri.match(/^data:([^;]+);base64,(.+)$/)
	if (!match) {
		// If it's not a data URI, treat it as a regular URL
		return null
	}

	// Map MIME type to Anthropic-supported types
	const rawMimeType = match[1].toLowerCase()
	let mimeType: AnthropicImageMimeType = 'image/jpeg' // default

	// Map common MIME types to Anthropic-supported types
	if (rawMimeType === 'image/png') mimeType = 'image/png'
	else if (rawMimeType === 'image/jpeg' || rawMimeType === 'image/jpg') mimeType = 'image/jpeg'
	else if (rawMimeType === 'image/gif') mimeType = 'image/gif'
	else if (rawMimeType === 'image/webp') mimeType = 'image/webp'
	// If unsupported, default to jpeg (will be converted if needed)

	return {
		mimeType,
		data: match[2]
	}
}





// convert messages as if about to send to openai
/*
reference - https://platform.openai.com/docs/guides/function-calling#function-calling-steps
openai MESSAGE (role=assistant):
"tool_calls":[{
	"type": "function",
	"id": "call_12345xyz",
	"function": {
	"name": "get_weather",
	"arguments": "{\"latitude\":48.8566,\"longitude\":2.3522}"
}]

openai RESPONSE (role=user):
{   "role": "tool",
	"tool_call_id": tool_call.id,
	"content": str(result)    }

also see
openai on prompting - https://platform.openai.com/docs/guides/reasoning#advice-on-prompting
openai on developer system message - https://cdn.openai.com/spec/model-spec-2024-05-08.html#follow-the-chain-of-command
*/


const prepareMessages_openai_tools = (messages: SimpleLLMMessage[]): AnthropicOrOpenAILLMMessage[] => {

	const newMessages: OpenAILLMChatMessage[] = [];

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i]

		if (currMsg.role === 'user') {
			// If user message has images, format as array with text and image_url
			if (currMsg.images && currMsg.images.length > 0) {
				const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [];

				// Add text content - always add text entry when images are present (even if empty)
				// This ensures OpenAI receives a valid content array format
				const textContent = currMsg.content || '';
				content.push({ type: 'text', text: textContent });

				// Add all images
				for (const imageUrl of currMsg.images) {
					content.push({ type: 'image_url', image_url: { url: imageUrl } });
				}

				newMessages.push({
					role: 'user',
					content: content,
				});
			} else {
				// No images, use string content format
				newMessages.push(currMsg as OpenAILLMChatMessage);
			}
			continue
		}

		if (currMsg.role !== 'tool') {
			if (currMsg.role === 'assistant') {
				const assistantMsg: Record<string, unknown> = {
					role: 'assistant',
					content: currMsg.content,
				}
				if (currMsg.reasoning) {
					assistantMsg.reasoning_content = currMsg.reasoning
				}
				newMessages.push(assistantMsg as OpenAILLMChatMessage)
			} else {
				newMessages.push(currMsg as OpenAILLMChatMessage)
			}
			continue
		}

		// 🚀 FIX: Collect ALL consecutive tool messages FIRST, then add all tool_calls to assistant, then all tool responses
		// This ensures proper ordering and consistency across all providers

		// Collect all consecutive tool messages (with proper type narrowing)
		type ToolMessage = Extract<SimpleLLMMessage, { role: 'tool' }>
		const toolMessages: ToolMessage[] = [];
		let j = i;
		while (j < messages.length && messages[j].role === 'tool') {
			const toolMsg = messages[j];
			if (toolMsg.role === 'tool') { // Type guard
				if (toolMsg.id !== 'dummy') {
					toolMessages.push(toolMsg);
				}
			}
			j++;
		}

		// Defense-in-depth: deduplicate by tool id, keeping the LAST occurrence.
		// The chat thread should already only contain terminal tool states (see
		// _chatMessagesToSimpleMessages), but if a transient `running_now` or
		// `tool_request` slips through with the same id as a `success`/`tool_error`,
		// sending both would produce a duplicate `tool_call_id` and trigger a 400
		// from OpenAI-compatible providers.
		const dedupedToolMessages: ToolMessage[] = []
		const seenToolIds = new Set<string>()
		for (let k = toolMessages.length - 1; k >= 0; k--) {
			const tm = toolMessages[k]
			const tid = (tm.id ?? '').trim()
			if (tid && seenToolIds.has(tid)) continue
			if (tid) seenToolIds.add(tid)
			dedupedToolMessages.unshift(tm)
		}
		const finalToolMessages = dedupedToolMessages

		// Get the last added message (which should be the assistant message)
		const prevMsg = newMessages.length > 0 ? newMessages[newMessages.length - 1] : undefined

		const toolCallIdFor = (toolMsg: ToolMessage, idx: number) => {
			const id = toolMsg.id?.trim()
			return id || `call_orbit_replay_${i}_${idx}`
		}

		// Add ALL tool_calls to the assistant message
		if (prevMsg?.role === 'assistant') {
			// Initialize tool_calls array if not present
			if (!prevMsg.tool_calls) {
				prevMsg.tool_calls = [];
			}
			// Add all tool_calls
			for (let toolIdx = 0; toolIdx < finalToolMessages.length; toolIdx += 1) {
				const toolMsg = finalToolMessages[toolIdx]
				prevMsg.tool_calls.push({
					type: 'function',
					id: toolCallIdFor(toolMsg, toolIdx),
					function: {
						name: toolMsg.name,
						arguments: JSON.stringify(toolMsg.rawParams)
					}
				});
			}
		}
		else if (finalToolMessages.length > 0) {
			// A persisted or trimmed transcript can contain tool results whose
			// assistant tool_calls were no longer retained. OpenAI-compatible
			// providers reject orphan role=tool messages, so replay them as
			// ordinary context instead of sending an invalid API payload.
			newMessages.push({
				role: 'user',
				content: finalToolMessages.map(toolMsg => {
					const name = toolMsg.name || 'tool'
					return `<orphaned_tool_result name="${name}">\n${toolMsg.content}\n</orphaned_tool_result>`
				}).join('\n\n')
			})
			i = j - 1;
			continue
		}

		// Add all tool response messages
		for (let toolIdx = 0; toolIdx < finalToolMessages.length; toolIdx += 1) {
			const toolMsg = finalToolMessages[toolIdx]
			newMessages.push({
				role: 'tool',
				tool_call_id: toolCallIdFor(toolMsg, toolIdx),
				content: toolMsg.content,
			})
		}

		// Skip ahead past the tools we just processed
		i = j - 1; // -1 because the loop will increment i
		continue
	}
	return newMessages

}



// convert messages as if about to send to anthropic
/*
https://docs.anthropic.com/en/docs/build-with-claude/tool-use#tool-use-examples
anthropic MESSAGE (role=assistant):
"content": [{
	"type": "text",
	"text": "<thinking>I need to call the get_weather function, and the user wants SF, which is likely San Francisco, CA.</thinking>"
}, {
	"type": "tool_use",
	"id": "toolu_01A09q90qw90lq917835lq9",
	"name": "get_weather",
	"input": { "location": "San Francisco, CA", "unit": "celsius" }
}]
anthropic RESPONSE (role=user):
"content": [{
	"type": "tool_result",
	"tool_use_id": "toolu_01A09q90qw90lq917835lq9",
	"content": "15 degrees"
}]


Converts:
assistant: ...content
tool: (id, name, params)
->
assistant: ...content, call(name, id, params)
user: ...content, result(id, content)
*/

type AnthropicOrOpenAILLMMessage = AnthropicLLMChatMessage | OpenAILLMChatMessage

const prepareMessages_anthropic_tools = (messages: SimpleLLMMessage[], supportsAnthropicReasoning: boolean): AnthropicOrOpenAILLMMessage[] => {
	const newMessages: AnthropicLLMChatMessage[] = [];

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i]

		// add anthropic reasoning
		if (currMsg.role === 'assistant') {
			if (currMsg.anthropicReasoning && supportsAnthropicReasoning) {
				const content = currMsg.content
				newMessages.push({
					role: 'assistant',
					content: content ? [...currMsg.anthropicReasoning, { type: 'text' as const, text: content }] : currMsg.anthropicReasoning
				})
			}
			else {
				newMessages.push({
					role: 'assistant',
					content: currMsg.content,
					// strip away anthropicReasoning
				})
			}
			continue
		}

		if (currMsg.role === 'user') {
			// If user message has images, format as array with text and image
			if (currMsg.images && currMsg.images.length > 0) {
				const content: Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: AnthropicImageMimeType; data: string } }> = [];

				// Add text content if it exists
				if (currMsg.content) {
					content.push({ type: 'text', text: currMsg.content });
				}

				// Add all images in Anthropic format: { type: 'image', source: { type: 'base64', media_type: string, data: string } }
				for (const imageUrl of currMsg.images) {
					const parsed = parseDataURI(imageUrl)
					if (parsed) {
						content.push({
							type: 'image',
							source: {
								type: 'base64',
								media_type: parsed.mimeType,
								data: parsed.data
							}
						});
					} else {
						// Anthropic only accepts base64 image blocks — a remote URL can't be inlined.
						// Leave a text breadcrumb instead of silently dropping it so the model knows an
						// image was present but couldn't be sent.
						content.push({ type: 'text', text: '[image omitted: remote image URLs are not supported for this provider]' })
						console.warn('Anthropic API requires base64-encoded images. URL images are not supported.')
					}
				}

				newMessages.push({
					role: 'user',
					content: content,
				});
			} else {
				// No images, use string or array format
				newMessages.push({
					role: 'user',
					content: currMsg.content,
				})
			}
			continue
		}

		if (currMsg.role === 'tool') {
			// 🚀 FIX: Collect ALL consecutive tool messages FIRST, then add all tool_use blocks to assistant, then all tool_results to user
			// This ensures every tool_result has a corresponding tool_use in the previous assistant message

			// Collect all consecutive tool messages (with proper type narrowing)
			type ToolMessage = Extract<SimpleLLMMessage, { role: 'tool' }>
			const toolMessages: ToolMessage[] = [];
			let j = i;
			while (j < messages.length && messages[j].role === 'tool') {
				const toolMsg = messages[j];
				if (toolMsg.role === 'tool') { // Type guard
					if (toolMsg.id !== 'dummy') {
						toolMessages.push(toolMsg);
					}
				}
				j++;
			}

			// Defense-in-depth: deduplicate by tool id, keeping the LAST occurrence.
			// See prepareMessages_openai_tools for rationale.
			const dedupedToolMessages: ToolMessage[] = []
			const seenToolIds = new Set<string>()
			for (let k = toolMessages.length - 1; k >= 0; k--) {
				const tm = toolMessages[k]
				const tid = (tm.id ?? '').trim()
				if (tid && seenToolIds.has(tid)) continue
				if (tid) seenToolIds.add(tid)
				dedupedToolMessages.unshift(tm)
			}
			const finalToolMessages = dedupedToolMessages

			// Get the last added message (which should be the assistant message)
			const prevMsg = newMessages.length > 0 ? newMessages[newMessages.length - 1] : undefined

			// Add ALL tool_use blocks to the assistant message
			if (prevMsg?.role === 'assistant') {
				if (typeof prevMsg.content === 'string') prevMsg.content = [{ type: 'text', text: prevMsg.content }]

				// Add all tool_use blocks
				for (const toolMsg of finalToolMessages) {
					prevMsg.content.push({
						type: 'tool_use',
						id: toolMsg.id,
						name: toolMsg.name,
						input: toolMsg.rawParams
					})
				}
			}
			else if (finalToolMessages.length > 0) {
				// A persisted or trimmed transcript can contain tool results whose
				// assistant tool_use blocks were no longer retained. Anthropic rejects
				// any tool_result without a matching tool_use in the prior assistant
				// turn, so replay them as ordinary user context instead of sending an
				// invalid API payload.
				newMessages.push({
					role: 'user',
					content: finalToolMessages.map(toolMsg => {
						const name = toolMsg.name || 'tool'
						return `<orphaned_tool_result name="${name}">\n${toolMsg.content}\n</orphaned_tool_result>`
					}).join('\n\n')
				})
				i = j - 1;
				continue
			}

			// Collect all tool results corresponding to the tool_use blocks we just added
			const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];
			for (const toolMsg of finalToolMessages) {
				toolResults.push({
					type: 'tool_result',
					tool_use_id: toolMsg.id,
					content: toolMsg.content
				});
			}

			// Skip pushing an empty user message when every collected tool was 'dummy'
			if (toolResults.length > 0) {
				// Add ONE user message with all tool results
				newMessages.push({
					role: 'user',
					content: toolResults
				});
			}

			// Skip ahead past the tools we just processed
			i = j - 1; // -1 because the loop will increment i
			continue
		}

	}

	// All tool messages have been converted to user messages
	return newMessages
}


const prepareMessages_XML_tools = (messages: SimpleLLMMessage[], supportsAnthropicReasoning: boolean): AnthropicOrOpenAILLMMessage[] => {

	const llmChatMessages: AnthropicOrOpenAILLMMessage[] = [];
	for (let i = 0; i < messages.length; i += 1) {

		const c = messages[i]

		if (c.role === 'assistant') {
			// if called tool(s) (message(s) after it), re-add their XML to the message
			// Support multiple consecutive tool calls (parallel execution)
			let content: AnthropicOrOpenAILLMMessage['content'] = c.content

			// Collect all consecutive tool calls after this assistant message
			const toolXMLs: string[] = [];
			let j = i + 1;
			while (j < messages.length && messages[j].role === 'tool') {
				const toolMsg = messages[j];
				if (toolMsg.role === 'tool') { // Type guard
					if (toolMsg.id !== 'dummy') {
						toolXMLs.push(reParsedToolXMLString(toolMsg.name, toolMsg.rawParams));
					}
				}
				j++;
			}

			if (toolXMLs.length > 0) {
				content = `${content}\n\n${toolXMLs.join('\n')}`;
			}

			// anthropic reasoning
			if (c.anthropicReasoning && supportsAnthropicReasoning) {
				content = content ? [...c.anthropicReasoning, { type: 'text' as const, text: content }] : c.anthropicReasoning
			}
			llmChatMessages.push({
				role: 'assistant',
				content
			})
		}
		// add user or tool to the previous user message
		else if (c.role === 'user' || c.role === 'tool') {
			if (c.role === 'tool' && c.id === 'dummy') {
				continue
			}
			if (c.role === 'tool')
				c.content = `<${c.name}_result>\n${c.content}\n</${c.name}_result>`

			// Handle user messages with images - XML format doesn't support native images, so we'll encode them
			// For providers using XML format, images might not be supported, but we'll format them appropriately
			if (c.role === 'user' && c.images && c.images.length > 0) {
				// For XML format, we can't easily embed images in the message structure
				// This would require provider-specific handling
				// For now, we'll create an array content format similar to Anthropic if possible
				const content: Array<{ type: 'text'; text: string } | { type: 'tool_result'; tool_use_id: string; content: string } | { type: 'image'; source: { type: 'base64'; media_type: AnthropicImageMimeType; data: string } }> = [];

				if (c.content) {
					content.push({ type: 'text', text: c.content });
				}

				// Add images in Anthropic-compatible format (works for providers that support arrays)
				for (const imageUrl of c.images) {
					const parsed = parseDataURI(imageUrl)
					if (parsed) {
						content.push({
							type: 'image',
							source: {
								type: 'base64',
								media_type: parsed.mimeType,
								data: parsed.data
							}
						});
					}
				}

				const userMessageWithImages: AnthropicLLMChatMessage = {
					role: 'user',
					content: content as Extract<AnthropicLLMChatMessage, { role: 'user' }>['content']
				}

				if (llmChatMessages.length === 0 || llmChatMessages[llmChatMessages.length - 1].role !== 'user') {
					llmChatMessages.push(userMessageWithImages)
				} else {
					// If previous message is user with array content, merge
					const prevMsg = llmChatMessages[llmChatMessages.length - 1]
					if (prevMsg.role === 'user') {
						// Only merge if both are user messages
						// Convert to proper user content type
						if (Array.isArray(prevMsg.content)) {
							// Check if it's already user content (not assistant content)
							const isUserContent = prevMsg.content.every(c =>
								c.type === 'text' ||
								c.type === 'tool_result' ||
								c.type === 'image'
							)
							if (isUserContent) {
								// Merge arrays - both are user content
								const userContent = prevMsg.content as Extract<AnthropicLLMChatMessage, { role: 'user' }>['content']
								prevMsg.content = [...userContent, ...content] as Extract<AnthropicLLMChatMessage, { role: 'user' }>['content']
							} else {
								// Previous content is assistant content, don't merge
								llmChatMessages.push(userMessageWithImages)
							}
						} else if (typeof prevMsg.content === 'string') {
							// Convert string to array and merge
							prevMsg.content = [{ type: 'text', text: prevMsg.content }, ...content] as Extract<AnthropicLLMChatMessage, { role: 'user' }>['content']
						}
					} else {
						llmChatMessages.push(userMessageWithImages)
					}
				}
			} else {
				// No images, use string format
				if (llmChatMessages.length === 0 || llmChatMessages[llmChatMessages.length - 1].role !== 'user')
					llmChatMessages.push({
						role: 'user',
						content: c.content
					})
				else {
					const prevMsg = llmChatMessages[llmChatMessages.length - 1]
					if (typeof prevMsg.content === 'string')
						prevMsg.content += '\n\n' + c.content
					else
						prevMsg.content = [...prevMsg.content, { type: 'text', text: c.content }] as typeof prevMsg.content
				}
			}
		}
	}
	return llmChatMessages
}


// --- CHAT ---

const prepareOpenAIOrAnthropicMessages = ({
	messages: messages_,
	systemMessage,
	aiInstructions,
	supportsSystemMessage,
	specialToolFormat,
	supportsAnthropicReasoning,
	contextWindow,
	reservedOutputTokenSpace,
}: {
	messages: SimpleLLMMessage[],
	systemMessage: string,
	aiInstructions: string,
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated',
	specialToolFormat: 'openai-style' | 'anthropic-style' | undefined,
	supportsAnthropicReasoning: boolean,
	contextWindow: number,
	reservedOutputTokenSpace: number | null | undefined,
}): { messages: AnthropicOrOpenAILLMMessage[], separateSystemMessage: string | undefined } => {

	// Reserve room for the model's output, but never more than 1/4 of the window (the previous
	// code reserved 1/2 — the comment said 1/4 — which needlessly discarded ~half of usable
	// input context). Clamp so tiny-window models keep a sane, non-negative input budget.
	{
		const reserveCap = Math.max(1_024, Math.floor(contextWindow / 4))
		const desiredReserve = Math.max(reservedOutputTokenSpace ?? 4_096, 1_024)
		reservedOutputTokenSpace = Math.min(desiredReserve, reserveCap)
	}
	let messages: (SimpleLLMMessage | { role: 'system', content: string })[] = deepClone(messages_)

	// ================ system message ================
	// A COMPLETE HACK: last message is system message for context purposes

	const sysMsgParts: string[] = []
	if (aiInstructions) sysMsgParts.push(`GUIDELINES (from the user's .orbitrules file):\n${aiInstructions}`)
	if (systemMessage) sysMsgParts.push(systemMessage)
	const combinedSystemMessage = sysMsgParts.join('\n\n')

	messages.unshift({ role: 'system', content: combinedSystemMessage })

	// ================ trim ================
	messages = messages.map(m => ({ ...m, content: m.role !== 'tool' ? m.content.trim() : m.content }))

	type MesType = (typeof messages)[0]

	// ================ fit into context ================

	// the higher the weight, the higher the desire to truncate - TRIM HIGHEST WEIGHT MESSAGES
	const alreadyTrimmedIdxes = new Set<number>()
	const weight = (message: MesType, messages: MesType[], idx: number) => {
		const base = message.content.length

		let multiplier: number
		multiplier = 1 + (messages.length - 1 - idx) / messages.length // slow rampdown from 2 to 1 as index increases
		if (message.role === 'user') {
			multiplier *= 1
		}
		else if (message.role === 'system') {
			multiplier *= .01 // very low weight
		}
		else {
			multiplier *= 10 // llm tokens are far less valuable than user tokens
		}

		// any already modified message should not be trimmed again
		if (alreadyTrimmedIdxes.has(idx)) {
			multiplier = 0
		}
		// 1st and last messages should be very low weight
		if (idx <= 1 || idx >= messages.length - 1 - 3) {
			multiplier *= .05
		}
		return base * multiplier
	}

	// Iterate the array we're actually trimming (not a stale copy). Returns the highest-weight
	// (least valuable) message to trim next, plus its weight so callers can stop when nothing
	// worthwhile remains.
	const _findLargestByWeight = (msgs: MesType[]) => {
		let largestIndex = -1
		let largestWeight = -Infinity
		for (let i = 0; i < msgs.length; i += 1) {
			const w = weight(msgs[i], msgs, i)
			if (w > largestWeight) {
				largestWeight = w
				largestIndex = i
			}
		}
		return { largestIndex, largestWeight }
	}

	const totalContentLen = () => messages.reduce((sum, m) => sum + m.content.length, 0)

	// Input budget in characters. Never let this collapse below a small floor so a huge reserve
	// on a tiny window can't force total truncation.
	const inputCharBudget = Math.max(
		(contextWindow - reservedOutputTokenSpace) * CHARS_PER_TOKEN,
		5_000
	)

	// Phase A: trim the highest-weight messages down to TRIM_TO_LEN until we're under budget or
	// there's nothing left worth trimming. Unlike the old code, this loops until it actually fits
	// (bounded by a generous iteration guard) instead of giving up after 100 iterations and then
	// shipping an over-window payload that the provider rejects with a 400.
	{
		let guard = 0
		const maxIters = messages.length * 3 + 20
		while (totalContentLen() > inputCharBudget && guard < maxIters) {
			guard += 1
			const { largestIndex, largestWeight } = _findLargestByWeight(messages)
			if (largestIndex < 0 || largestWeight <= 0) break // nothing left worth trimming
			const m = messages[largestIndex]
			if (m.content.length <= TRIM_TO_LEN) { alreadyTrimmedIdxes.add(largestIndex); continue }
			m.content = m.content.substring(0, TRIM_TO_LEN - '...'.length) + '...'
			alreadyTrimmedIdxes.add(largestIndex)
		}
	}

	// Phase B (hard guarantee): if a thread has so many messages that even trimming every body to
	// TRIM_TO_LEN still exceeds the window, hard-trim non-protected bodies to a tiny floor,
	// oldest-first, until we fit. We never DROP messages (that would orphan tool_result/tool_use
	// pairs and cause its own provider 400) — we only shrink bodies. The system message (idx 0),
	// the first user message, and the last two messages are left intact as essential context.
	if (totalContentLen() > inputCharBudget) {
		const firstUserIdx = messages.findIndex(m => m.role === 'user')
		const HARD_FLOOR = 24
		for (let idx = 1; idx < messages.length - 2 && totalContentLen() > inputCharBudget; idx += 1) {
			if (idx === firstUserIdx) continue
			const m = messages[idx]
			if (m.content.length > HARD_FLOOR) {
				m.content = m.content.substring(0, HARD_FLOOR - 1) + '…'
			}
		}
	}

	// ================ system message hack ================
	const newSysMsg = messages.shift()!.content


	// ================ tools and anthropicReasoning ================
	// SYSTEM MESSAGE HACK: we shifted (removed) the system message role, so now SimpleLLMMessage[] is valid

	let llmChatMessages: AnthropicOrOpenAILLMMessage[] = []
	if (!specialToolFormat) { // XML tool behavior
		llmChatMessages = prepareMessages_XML_tools(messages as SimpleLLMMessage[], supportsAnthropicReasoning)
	}
	else if (specialToolFormat === 'anthropic-style') {
		llmChatMessages = prepareMessages_anthropic_tools(messages as SimpleLLMMessage[], supportsAnthropicReasoning)
	}
	else if (specialToolFormat === 'openai-style') {
		llmChatMessages = prepareMessages_openai_tools(messages as SimpleLLMMessage[])
	}
	const llmMessages = llmChatMessages


	// ================ system message add as first llmMessage ================

	let separateSystemMessageStr: string | undefined = undefined

	// if supports system message
	if (supportsSystemMessage) {
		if (supportsSystemMessage === 'separated')
			separateSystemMessageStr = newSysMsg
		else if (supportsSystemMessage === 'system-role')
			llmMessages.unshift({ role: 'system', content: newSysMsg }) // add new first message
		else if (supportsSystemMessage === 'developer-role')
			llmMessages.unshift({ role: 'developer', content: newSysMsg }) // add new first message
	}
	// if does not support system message
	else {
		if (llmMessages.length === 0) {
			llmMessages.unshift({ role: 'user', content: `<SYSTEM_MESSAGE>\n${newSysMsg}\n</SYSTEM_MESSAGE>` })
		} else {
			const first = llmMessages[0]
			if (typeof first.content === 'string') {
				const newFirstMessage = {
					role: 'user',
					content: `<SYSTEM_MESSAGE>\n${newSysMsg}\n</SYSTEM_MESSAGE>\n${first.content}`
				} as const
				llmMessages.splice(0, 1) // delete first message
				llmMessages.unshift(newFirstMessage) // add new first message
			} else {
				// first message has array content (e.g. images); prepend system text as a leading text part instead of stringifying the array
				first.role = 'user'
				;(first.content as any[]).unshift({ type: 'text', text: `<SYSTEM_MESSAGE>\n${newSysMsg}\n</SYSTEM_MESSAGE>` })
			}
		}
	}


	// ================ no empty message ================
	for (let i = 0; i < llmMessages.length; i += 1) {
		const currMsg: AnthropicOrOpenAILLMMessage = llmMessages[i]
		const nextMsg: AnthropicOrOpenAILLMMessage | undefined = llmMessages[i + 1]

		if (currMsg.role === 'tool') continue

		// if content is a string, replace string with empty msg
		if (typeof currMsg.content === 'string') {
			currMsg.content = currMsg.content || EMPTY_MESSAGE
		}
		else {
			// allowed to be empty if has a tool in it or following it
			if (currMsg.content.find(c => c.type === 'tool_result' || c.type === 'tool_use')) {
				currMsg.content = currMsg.content.filter(c => !(c.type === 'text' && !c.text)) as any
				continue
			}
			if (nextMsg?.role === 'tool') continue

			// Check if message has images - if so, don't require text
			// Support both Anthropic format ('image') and OpenAI format ('image_url')
			const hasImages = currMsg.content.some(c => c.type === 'image' || c.type === 'image_url')

			// replace any empty text entries with empty msg, and make sure there's at least 1 entry
			// For messages with images, allow empty text strings (OpenAI supports this)
			for (const c of currMsg.content) {
				if (c.type === 'text') {
					// If message has images, keep empty strings as-is (OpenAI allows empty text with images)
					// Otherwise, replace empty strings with EMPTY_MESSAGE
					if (!hasImages) {
						c.text = c.text || EMPTY_MESSAGE
					}
				}
			}
			// If no content and no images, add empty message
			if (currMsg.content.length === 0 && !hasImages) {
				currMsg.content = [{ type: 'text', text: EMPTY_MESSAGE }]
			}
			// If has images but no text, add empty text entry (required by some providers)
			// Note: OpenAI allows image-only messages, but some providers may require at least empty text
			// However, prepareMessages_openai_tools already adds text when images are present, so this is mainly for other formats
			if (hasImages && !currMsg.content.some(c => c.type === 'text')) {
				currMsg.content.unshift({ type: 'text', text: '' })
			}
		}
	}

	return {
		messages: llmMessages,
		separateSystemMessage: separateSystemMessageStr,
	} as const
}




type GeminiUserPart = (GeminiLLMChatMessage & { role: 'user' })['parts'][0]
type GeminiModelPart = (GeminiLLMChatMessage & { role: 'model' })['parts'][0]
const prepareGeminiMessages = (messages: AnthropicLLMChatMessage[]) => {
	let latestToolName: ToolName | undefined = undefined
	const toolNamesById = new Map<string, ToolName>()
	const messages2: GeminiLLMChatMessage[] = messages.map((m): GeminiLLMChatMessage | null => {
		if (m.role === 'assistant') {
			if (typeof m.content === 'string') {
				return { role: 'model', parts: [{ text: m.content }] }
			}
			else {
				const parts: GeminiModelPart[] = m.content.map((c): GeminiModelPart | null => {
					if (c.type === 'text') {
						return { text: c.text }
					}
					else if (c.type === 'tool_use') {
						latestToolName = c.name
						toolNamesById.set(c.id, c.name)
						return { functionCall: { id: c.id, name: c.name, args: c.input } }
					}
					else return null
				}).filter(m => !!m)
				return { role: 'model', parts, }
			}
		}
		else if (m.role === 'user') {
			if (typeof m.content === 'string') {
				return { role: 'user', parts: [{ text: m.content }] } satisfies GeminiLLMChatMessage
			}
			else {
				const parts: GeminiUserPart[] = m.content.map((c): GeminiUserPart | null => {
					if (c.type === 'text') {
						return { text: c.text }
					}
					else if (c.type === 'tool_result') {
						const resolvedName = toolNamesById.get(c.tool_use_id) ?? latestToolName
						if (!resolvedName) return null
						return { functionResponse: { id: c.tool_use_id, name: resolvedName, response: { output: c.content } } }
					}
					else if (c.type === 'image') {
						// Convert Anthropic image format to Gemini inlineData format
						// Anthropic: { type: 'image', source: { type: 'base64', media_type: string, data: string } }
						// Gemini: { inlineData: { mimeType: string, data: string } }
						return {
							inlineData: {
								mimeType: c.source.media_type,
								data: c.source.data
							}
						}
					}
					else return null
				}).filter(m => !!m)
				return { role: 'user', parts, }
			}

		}
		else return null
	}).filter(m => !!m)

	return messages2
}


const prepareMessages = (params: {
	messages: SimpleLLMMessage[],
	systemMessage: string,
	aiInstructions: string,
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated',
	specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined,
	supportsAnthropicReasoning: boolean,
	contextWindow: number,
	reservedOutputTokenSpace: number | null | undefined,
	providerName: ProviderName
}): { messages: LLMChatMessage[], separateSystemMessage: string | undefined } => {

	let specialFormat = params.specialToolFormat // this is just for ts stupidness

	// For OpenAI-compatible providers, default to 'openai-style' when specialToolFormat is undefined
	// This ensures images and other features work correctly with OpenAI-compatible APIs
	if (!specialFormat && openAICompatibleProviders.includes(params.providerName)) {
		specialFormat = 'openai-style'
	}

	// if need to convert to gemini style of messaes, do that (treat as anthropic style, then convert to gemini style)
	if (params.providerName === 'gemini' || specialFormat === 'gemini-style') {
		const res = prepareOpenAIOrAnthropicMessages({ ...params, specialToolFormat: specialFormat === 'gemini-style' ? 'anthropic-style' : undefined })
		const messages = res.messages as AnthropicLLMChatMessage[]
		const messages2 = prepareGeminiMessages(messages)
		return { messages: messages2, separateSystemMessage: res.separateSystemMessage }
	}

	return prepareOpenAIOrAnthropicMessages({ ...params, specialToolFormat: specialFormat })
}




export interface IConvertToLLMMessageService {
	readonly _serviceBrand: undefined;
	prepareLLMSimpleMessages: (opts: { simpleMessages: SimpleLLMMessage[], systemMessage: string, modelSelection: ModelSelection | null, featureName: FeatureName }) => { messages: LLMChatMessage[], separateSystemMessage: string | undefined }
	prepareLLMChatMessages: (opts: { chatMessages: ChatMessage[], chatMode: ChatMode, modelSelection: ModelSelection | null, toolPolicy?: ToolPolicy }) => Promise<{ messages: LLMChatMessage[], separateSystemMessage: string | undefined }>
	prepareFIMMessage(opts: { messages: LLMFIMMessage, metadata?: { fileName?: string, languageId?: string, enclosingContext?: string, importsContext?: string } }): { prefix: string, suffix: string, stopTokens: string[] }
}

export const IConvertToLLMMessageService = createDecorator<IConvertToLLMMessageService>('ConvertToLLMMessageService');


class ConvertToLLMMessageService extends Disposable implements IConvertToLLMMessageService {
	_serviceBrand: undefined;

	constructor(
		@IModelService private readonly modelService: IModelService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IVoidModelService private readonly voidModelService: IVoidModelService,
		@IMCPService private readonly mcpService: IMCPService,
	) {
		super()
	}

	// Read .orbitrules files from workspace folders
	private _getOrbitRulesFileContents(): string {
		try {
			const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
			let orbitRules = '';
			for (const folder of workspaceFolders) {
				const uri = URI.joinPath(folder.uri, '.orbitrules')
				const { model } = this.voidModelService.getModel(uri)
				if (!model) continue
				orbitRules += model.getValue(EndOfLinePreference.LF) + '\n\n';
			}
			return orbitRules.trim();
		}
		catch (e) {
			return ''
		}
	}

	// Get combined AI instructions from settings and .orbitrules files
	private _getCombinedAIInstructions(): string {
		const globalAIInstructions = this.voidSettingsService.state.globalSettings.aiInstructions;
		const orbitRulesFileContent = this._getOrbitRulesFileContents();

		const ans: string[] = []
		if (globalAIInstructions) ans.push(globalAIInstructions)
		if (orbitRulesFileContent) ans.push(orbitRulesFileContent)
		return ans.join('\n\n')
	}


	// system message
	private _generateChatMessagesSystemMessage = async (chatMode: ChatMode, specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined, modelInfo?: { providerName: string, modelName: string }, toolPolicy?: ToolPolicy) => {
		const workspaceFolders = this.workspaceContextService.getWorkspace().folders.map(f => f.uri.fsPath)

		const openedURIs = this.modelService.getModels().filter(m => m.isAttachedToEditor()).map(m => m.uri.fsPath) || [];
		const activeURI = this.editorService.activeEditor?.resource?.fsPath;

		const directoryStr = await this.directoryStrService.getAllDirectoriesStr({
			cutOffMessage: chatMode === 'agent' || chatMode === 'plan' ?
				`...Directories string cut off, use tools to read more...`
				: `...Directories string cut off, ask user for more if necessary...`
		})

		const includeXMLToolDefinitions = !specialToolFormat

		const mcpTools = this.mcpService.getMCPTools()

		const shellIds = this.terminalToolService.listShellIds()
		const systemMessage = chat_systemMessage({ workspaceFolders, openedURIs, directoryStr, activeURI, shellIds, chatMode, mcpTools, includeXMLToolDefinitions, modelInfo, toolPolicy })

		// Debug logging (can be disabled in production)
		// console.log('=== SYSTEM MESSAGE (first 3000 chars) ===\n', systemMessage.substring(0, 3000))
		// console.log('=== SYSTEM MESSAGE (last 1000 chars) ===\n', systemMessage.substring(systemMessage.length - 1000))
		// console.log('=== includeXMLToolDefinitions ===', includeXMLToolDefinitions)
		// console.log('=== chatMode ===', chatMode)

		return systemMessage
	}




	// --- LLM Chat messages ---

	private _chatMessagesToSimpleMessages(chatMessages: ChatMessage[]): SimpleLLMMessage[] {
		const simpleLLMMessages: SimpleLLMMessage[] = []

		for (const m of chatMessages) {
			if (m.role === 'checkpoint') continue
			if (m.role === 'interrupted_streaming_tool') continue
			if (m.role === 'assistant') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.displayContent,
					reasoning: m.reasoning,
					anthropicReasoning: m.anthropicReasoning,
				})
			}
			else if (m.role === 'tool') {
				// Only terminal tool states carry a real result. Non-terminal states (still awaiting
				// approval, or mid-execution) hold placeholder content like "(Loading...)" — never
				// forward that to the model as a result; send a neutral interrupted marker instead.
				const isTerminalToolState = m.type === 'success' || m.type === 'tool_error' || m.type === 'rejected' || m.type === 'invalid_params'
				simpleLLMMessages.push({
					role: m.role,
					content: isTerminalToolState ? m.content : '(interrupted)',
					name: m.name,
					id: m.id,
					rawParams: m.rawParams,
				})
			}
			else if (m.role === 'user') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.content,
					images: m.images,
				})
			}
		}
		return simpleLLMMessages
	}

	prepareLLMSimpleMessages: IConvertToLLMMessageService['prepareLLMSimpleMessages'] = ({ simpleMessages, systemMessage, modelSelection, featureName }) => {
		if (modelSelection === null) return { messages: [], separateSystemMessage: undefined }

		const { overridesOfModel } = this.voidSettingsService.state

		const { providerName, modelName } = modelSelection
		const {
			specialToolFormat,
			contextWindow,
			supportsSystemMessage,
		} = getModelCapabilities(providerName, modelName, overridesOfModel)

		const modelSelectionOptions = this.voidSettingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]

		// Get combined AI instructions
		const aiInstructions = this._getCombinedAIInstructions();

		const isReasoningEnabled = getIsReasoningEnabledState(featureName, providerName, modelName, modelSelectionOptions, overridesOfModel)
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })

		const { messages, separateSystemMessage } = prepareMessages({
			messages: simpleMessages,
			systemMessage,
			aiInstructions,
			supportsSystemMessage,
			specialToolFormat,
			supportsAnthropicReasoning: providerName === 'anthropic',
			contextWindow,
			reservedOutputTokenSpace,
			providerName,
		})
		return { messages, separateSystemMessage };
	}
	prepareLLMChatMessages: IConvertToLLMMessageService['prepareLLMChatMessages'] = async ({ chatMessages, chatMode, modelSelection, toolPolicy }) => {
		if (modelSelection === null) return { messages: [], separateSystemMessage: undefined }

		const { overridesOfModel } = this.voidSettingsService.state

		const { providerName, modelName } = modelSelection
		const {
			specialToolFormat: rawSpecialToolFormat,
			contextWindow,
			supportsSystemMessage,
		} = getModelCapabilities(providerName, modelName, overridesOfModel)

		// Resolve effective specialToolFormat, accounting for the OpenAI-compat provider override
		// (same logic as prepareMessages — must be in sync so system message matches actual tool format used)
		const specialToolFormat = (!rawSpecialToolFormat && openAICompatibleProviders.includes(providerName))
			? 'openai-style'
			: rawSpecialToolFormat

		const { disableSystemMessage } = this.voidSettingsService.state.globalSettings;
		const fullSystemMessage = await this._generateChatMessagesSystemMessage(chatMode, specialToolFormat, { providerName, modelName }, toolPolicy)
		const systemMessage = disableSystemMessage ? '' : fullSystemMessage;

		const modelSelectionOptions = this.voidSettingsService.state.optionsOfModelSelection['Chat'][modelSelection.providerName]?.[modelSelection.modelName]

		// Get combined AI instructions
		const aiInstructions = this._getCombinedAIInstructions();
		const isReasoningEnabled = getIsReasoningEnabledState('Chat', providerName, modelName, modelSelectionOptions, overridesOfModel)
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })
		// Per-turn harness context (mode reminder + timestamp + <user_query> wrap) on the latest
		// user message — applied at LLM-prepare time only, never stored in chat history.
		const llmMessages = augmentChatMessagesWithHarnessContext(this._chatMessagesToSimpleMessages(chatMessages), chatMode)

		const { messages, separateSystemMessage } = prepareMessages({
			messages: llmMessages,
			systemMessage,
			aiInstructions,
			supportsSystemMessage,
			specialToolFormat,
			supportsAnthropicReasoning: providerName === 'anthropic',
			contextWindow,
			reservedOutputTokenSpace,
			providerName,
		})
		return { messages, separateSystemMessage };
	}


	// --- FIM ---

	prepareFIMMessage: IConvertToLLMMessageService['prepareFIMMessage'] = ({ messages, metadata }) => {
		// Enhanced FIM prompt following best practices from GitHub Copilot and Cursor
		// Key insight: Keep instructions minimal and use natural code context
		// The model should "fill in the blank" naturally, not follow complex instructions

		// Prepend imports context if available (critical for understanding available modules/types)
		const importsSection = metadata?.importsContext ? `${metadata.importsContext}\n\n` : '';

		// Simple, effective prompt structure:
		// 1. Show imports (what's available)
		// 2. Show code before cursor
		// 3. Model completes naturally
		// 4. Show code after cursor

		let prefix = messages.prefix;
		let suffix = messages.suffix;

		// Only add metadata as comments if it's a complex file (more than just simple completion)
		if (metadata?.fileName && metadata?.enclosingContext) {
			const fileComment = `# ${metadata.fileName}` // Single line comment
			const contextComment = metadata.enclosingContext ? `# ${metadata.enclosingContext}` : '';

			// Add minimal context header only if we have enclosing context
			prefix = `${fileComment}\n${contextComment ? contextComment + '\n' : ''}${importsSection}${prefix}`;
		} else if (importsSection) {
			// Just add imports if no complex context
			prefix = `${importsSection}${prefix}`;
		}

		const stopTokens = messages.stopTokens;
		return { prefix, suffix, stopTokens }
	}


}


registerSingleton(IConvertToLLMMessageService, ConvertToLLMMessageService, InstantiationType.Eager);








/*
Gemini has this, but they're openai-compat so we don't need to implement this
gemini request:
{   "role": "assistant",
	"content": null,
	"function_call": {
		"name": "get_weather",
		"arguments": {
			"latitude": 48.8566,
			"longitude": 2.3522
		}
	}
}

gemini response:
{   "role": "assistant",
	"function_response": {
		"name": "get_weather",
			"response": {
			"temperature": "15°C",
				"condition": "Cloudy"
		}
	}
}
*/
