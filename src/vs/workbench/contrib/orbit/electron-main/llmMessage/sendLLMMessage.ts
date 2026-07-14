/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { SendLLMMessageParams, OnText, OnFinalMessage, OnError } from '../../common/sendLLMMessageTypes.js';
import { IMetricsService } from '../../common/metricsService.js';
import { displayInfoOfProviderName } from '../../common/orbitSettingsTypes.js';
import { sendLLMMessageToProviderImplementation } from './sendLLMMessage.impl.js';


export const sendLLMMessage = async ({
	messagesType,
	messages: messages_,
	onText: onText_,
	onFinalMessage: onFinalMessage_,
	onError: onError_,
	abortRef: abortRef_,
	logging: { loggingName, loggingExtras },
	settingsOfProvider,
	modelSelection,
	modelSelectionOptions,
	overridesOfModel,
	chatMode,
	separateSystemMessage,
	mcpTools,
	toolPolicy,
}: SendLLMMessageParams,

	metricsService: IMetricsService
) => {


	const { providerName, modelName } = modelSelection

	// only captures number of messages and message "shape", no actual code, instructions, prompts, etc
	const captureLLMEvent = (eventId: string, extras?: object) => {


		metricsService.capture(eventId, {
			providerName,
			modelName,
			customEndpointURL: settingsOfProvider[providerName]?.endpoint,
			numModelsAtEndpoint: settingsOfProvider[providerName]?.models?.length,
			...messagesType === 'chatMessages' ? {
				numMessages: messages_?.length,
			} : messagesType === 'FIMMessage' ? {
				prefixLength: messages_.prefix.length,
				suffixLength: messages_.suffix.length,
			} : {},
			...loggingExtras,
			...extras,
		})
	}
	const submit_time = new Date()

	let _fullTextSoFar = ''
	let _aborter: (() => void) | null = null
	let _didAbort = false
	// If the user already aborted before the provider registered its aborter (the streaming
	// providers call _setAborter inside an un-awaited .then(), which can resolve after the abort
	// request has already run), invoke the aborter immediately so the in-flight request is
	// actually cancelled instead of leaking/continuing to stream.
	let _setAborter = (fn: () => void) => { _aborter = fn; if (_didAbort) { try { fn() } catch (e) { } } }

	// Coalesce high-frequency streaming chunks before they cross the IPC boundary.
	// Every chunk from the provider carries the FULL accumulated text/reasoning/tool-params
	// (not a delta), so keeping only the most recent pending frame is lossless for display.
	// Without this, a fast provider fires hundreds of IPC messages/sec at the renderer,
	// flooding its event loop and freezing the UI. We deliver at most ~30 frames/sec, which
	// is already finer than the renderer's own 50ms render throttle.
	const STREAM_COALESCE_MS = 33
	let _pendingTextParams: Parameters<OnText>[0] | null = null
	let _streamFlushTimer: ReturnType<typeof setTimeout> | null = null
	let _lastStreamFlushAt = 0

	const _clearStreamTimer = () => {
		if (_streamFlushTimer !== null) {
			clearTimeout(_streamFlushTimer)
			_streamFlushTimer = null
		}
	}
	const _flushPendingText = () => {
		_clearStreamTimer()
		if (_pendingTextParams === null) return
		const params = _pendingTextParams
		_pendingTextParams = null
		_lastStreamFlushAt = Date.now()
		if (_didAbort) return
		onText_(params)
	}
	const _cancelPendingText = () => {
		_clearStreamTimer()
		_pendingTextParams = null
	}

	const onText: OnText = (params) => {
		const { fullText, fullReasoning } = params
		if (_didAbort) return
		_fullTextSoFar = fullText
		_pendingTextParams = params
		// Adaptive coalescing window. Each frame carries the FULL accumulated text+reasoning, so the
		// per-frame IPC serialize/deserialize cost grows as the message grows. For verbose reasoning
		// models this becomes O(n^2) over a turn and shows up as long "deserialize" tasks in the
		// renderer. Widening the window as the payload grows bounds total IPC work (caps at ~4 fps for
		// very large messages) while keeping normal messages snappy at ~30 fps. Still lossless — only
		// the latest frame is ever delivered.
		const payloadLen = (fullText?.length ?? 0) + (fullReasoning?.length ?? 0)
		const interval = Math.min(250, STREAM_COALESCE_MS + Math.floor(payloadLen / 4000))
		const elapsed = Date.now() - _lastStreamFlushAt
		if (elapsed >= interval) {
			// leading edge: deliver immediately so the first token feels instant
			_flushPendingText()
		} else if (_streamFlushTimer === null) {
			// trailing edge: deliver the latest frame at the end of the coalescing window
			_streamFlushTimer = setTimeout(_flushPendingText, interval - elapsed)
		}
	}

	const onFinalMessage: OnFinalMessage = (params) => {
		const { fullText, fullReasoning, toolCall } = params
		if (_didAbort) return
		_flushPendingText() // deliver any buffered streaming frame before the final message
		captureLLMEvent(`${loggingName} - Received Full Message`, { messageLength: fullText.length, reasoningLength: fullReasoning?.length, duration: Date.now() - submit_time.getTime(), toolCallName: toolCall?.name })
		onFinalMessage_(params)
	}

	const onError: OnError = ({ message: errorMessage, fullError }) => {
		if (_didAbort) return
		_cancelPendingText() // drop any buffered streaming frame on error
		console.error('sendLLMMessage onError:', errorMessage)

		// handle failed to fetch errors, which give 0 information by design
		if (errorMessage === 'TypeError: fetch failed')
			errorMessage = `Failed to fetch from ${displayInfoOfProviderName(providerName).title}. This likely means you specified the wrong endpoint in Orbit's Settings, or your local model provider like Ollama is powered off.`

		captureLLMEvent(`${loggingName} - Error`, { error: errorMessage })
		onError_({ message: errorMessage, fullError })
	}

	// we should NEVER call onAbort internally, only from the outside
	const onAbort = () => {
		_cancelPendingText() // drop any buffered streaming frame on abort
		captureLLMEvent(`${loggingName} - Abort`, { messageLengthSoFar: _fullTextSoFar.length })
		// Set _didAbort BEFORE invoking the aborter so that any _setAborter that registers after
		// this point (streaming providers register inside an un-awaited .then()) sees the abort and
		// cancels itself immediately.
		_didAbort = true
		try { _aborter?.() } // aborter sometimes automatically throws an error
		catch (e) { }
	}
	abortRef_.current = onAbort


	if (messagesType === 'chatMessages')
		captureLLMEvent(`${loggingName} - Sending Message`, {})
	else if (messagesType === 'FIMMessage')
		captureLLMEvent(`${loggingName} - Sending FIM`, { prefixLen: messages_?.prefix?.length, suffixLen: messages_?.suffix?.length })


	try {
		const implementation = sendLLMMessageToProviderImplementation[providerName]
		if (!implementation) {
			onError({ message: `Error: Provider "${providerName}" not recognized.`, fullError: null })
			return
		}
		const { sendFIM, sendChat } = implementation
		if (messagesType === 'chatMessages') {
			await sendChat({ messages: messages_, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, overridesOfModel, modelName, _setAborter, providerName, separateSystemMessage, chatMode, mcpTools, toolPolicy })
			return
		}
		if (messagesType === 'FIMMessage') {
			if (sendFIM) {
				await sendFIM({ messages: messages_, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, overridesOfModel, modelName, _setAborter, providerName, separateSystemMessage })
				return
			}
			onError({ message: `Error running Autocomplete with ${providerName} - ${modelName}.`, fullError: null })
			return
		}
		onError({ message: `Error: Message type "${messagesType}" not recognized.`, fullError: null })
		return
	}

	catch (error) {
		if (error instanceof Error) { onError({ message: error + '', fullError: error }) }
		else { onError({ message: `Unexpected Error in sendLLMMessage: ${error}`, fullError: error }); }
		// ; (_aborter as any)?.()
		// _didAbort = true
	}



}
