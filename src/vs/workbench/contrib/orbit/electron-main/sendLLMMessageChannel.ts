/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// registered in app.ts
// code convention is to make a service responsible for this stuff, and not a channel, but having fewer files is simpler...

import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { EventLLMMessageOnTextParams, EventLLMMessageOnErrorParams, EventLLMMessageOnFinalMessageParams, MainSendLLMMessageParams, AbortRef, SendLLMMessageParams, MainLLMMessageAbortParams, ModelListParams, EventModelListOnSuccessParams, EventModelListOnErrorParams, OllamaModelResponse, OpenaiCompatibleModelResponse, OrbitProviderModelResponse, ClinePassModelResponse, MainModelListParams, MainOrbitProviderListParams, MainClinePassProviderListParams, } from '../common/sendLLMMessageTypes.js';
import { sendLLMMessage } from './llmMessage/sendLLMMessage.js'
import { IMetricsService } from '../common/metricsService.js';
import { sendLLMMessageToProviderImplementation } from './llmMessage/sendLLMMessage.impl.js';

// NODE IMPLEMENTATION - calls actual sendLLMMessage() and returns listeners to it

export class LLMMessageChannel implements IServerChannel {

	// sendLLMMessage
	private readonly llmMessageEmitters = {
		onText: new Emitter<EventLLMMessageOnTextParams>(),
		onFinalMessage: new Emitter<EventLLMMessageOnFinalMessageParams>(),
		onError: new Emitter<EventLLMMessageOnErrorParams>(),
	}

	// aborters for above
	private readonly _infoOfRunningRequest: Record<string, { waitForSend: Promise<void> | undefined, abortRef: AbortRef }> = {}


	// list
	private readonly listEmitters = {
		ollama: {
			success: new Emitter<EventModelListOnSuccessParams<OllamaModelResponse>>(),
			error: new Emitter<EventModelListOnErrorParams<OllamaModelResponse>>(),
		},
		openaiCompat: {
			success: new Emitter<EventModelListOnSuccessParams<OpenaiCompatibleModelResponse>>(),
			error: new Emitter<EventModelListOnErrorParams<OpenaiCompatibleModelResponse>>(),
		},
		orbit: {
			success: new Emitter<EventModelListOnSuccessParams<OrbitProviderModelResponse>>(),
			error: new Emitter<EventModelListOnErrorParams<OrbitProviderModelResponse>>(),
		},
		clinePass: {
			success: new Emitter<EventModelListOnSuccessParams<ClinePassModelResponse>>(),
			error: new Emitter<EventModelListOnErrorParams<ClinePassModelResponse>>(),
		},
	} satisfies {
		[providerName in 'ollama' | 'openaiCompat' | 'orbit' | 'clinePass']: {
			success: Emitter<EventModelListOnSuccessParams<any>>,
			error: Emitter<EventModelListOnErrorParams<any>>,
		}
	}

	// stupidly, channels can't take in @IService
	constructor(
		private readonly metricsService: IMetricsService,
	) { }

	// browser uses this to listen for changes
	listen(_: unknown, event: string): Event<any> {
		// text
		if (event === 'onText_sendLLMMessage') return this.llmMessageEmitters.onText.event;
		else if (event === 'onFinalMessage_sendLLMMessage') return this.llmMessageEmitters.onFinalMessage.event;
		else if (event === 'onError_sendLLMMessage') return this.llmMessageEmitters.onError.event;
		// list
		else if (event === 'onSuccess_list_ollama') return this.listEmitters.ollama.success.event;
		else if (event === 'onError_list_ollama') return this.listEmitters.ollama.error.event;
		else if (event === 'onSuccess_list_openAICompatible') return this.listEmitters.openaiCompat.success.event;
		else if (event === 'onError_list_openAICompatible') return this.listEmitters.openaiCompat.error.event;
		else if (event === 'onSuccess_list_orbit') return this.listEmitters.orbit.success.event;
		else if (event === 'onError_list_orbit') return this.listEmitters.orbit.error.event;
		else if (event === 'onSuccess_list_clinePass') return this.listEmitters.clinePass.success.event;
		else if (event === 'onError_list_clinePass') return this.listEmitters.clinePass.error.event;

		else throw new Error(`Event not found: ${event}`);
	}

	// browser uses this to call (see this.channel.call() in llmMessageService.ts for all usages)
	async call(_: unknown, command: string, params: any): Promise<any> {
		try {
			if (command === 'sendLLMMessage') {
				this._callSendLLMMessage(params)
			}
			else if (command === 'abort') {
				await this._callAbort(params)
			}
			else if (command === 'ollamaList') {
				this._callOllamaList(params)
			}
			else if (command === 'openAICompatibleList') {
				this._callOpenAICompatibleList(params)
			}
			else if (command === 'orbitProviderList') {
				this._callOrbitProviderList(params)
			}
			else if (command === 'clinePassProviderList') {
				this._callClinePassProviderList(params)
			}
			else {
				throw new Error(`Void sendLLM: command "${command}" not recognized.`)
			}
		}
		catch (e) {
			// If a send throws before its own error handling wires up, the renderer's
			// messageIsDonePromise would otherwise hang forever. Surface it as an onError so the
			// turn loop can settle.
			if (command === 'sendLLMMessage' && params?.requestId) {
				this._failRequest(params.requestId, e)
			}
		}
	}

	/** Fire onError for a request and clear its tracking so a failed send can't hang the renderer. */
	private _failRequest(requestId: string, e: unknown) {
		const message = e instanceof Error ? e.message : `${e}`
		try {
			this.llmMessageEmitters.onError.fire({ requestId, message, fullError: e instanceof Error ? e : null })
		} finally {
			delete this._infoOfRunningRequest[requestId]
		}
	}

	// the only place sendLLMMessage is actually called
	private _callSendLLMMessage(params: MainSendLLMMessageParams) {
		const { requestId } = params;

		if (!(requestId in this._infoOfRunningRequest))
			this._infoOfRunningRequest[requestId] = { waitForSend: undefined, abortRef: { current: null } }

		const suppressStreamingEvents = !!params.suppressStreamingEvents
		const mainThreadParams: SendLLMMessageParams = {
			...params,
			onText: (p) => {
				if (suppressStreamingEvents) return
				this.llmMessageEmitters.onText.fire({ requestId, ...p });
			},
			onFinalMessage: (p) => {
				this.llmMessageEmitters.onFinalMessage.fire({ requestId, ...p });
				// request is done — drop its abort/tracking entry so the map doesn't grow unbounded
				delete this._infoOfRunningRequest[requestId];
			},
			onError: (p) => {
				this.llmMessageEmitters.onError.fire({ requestId, ...p });
				// request errored out — drop its tracking entry to avoid a slow leak across a long session
				delete this._infoOfRunningRequest[requestId];
			},
			abortRef: this._infoOfRunningRequest[requestId].abortRef,
		}
		const p = sendLLMMessage(mainThreadParams, this.metricsService);
		// If the send rejects without having fired onError/onFinalMessage, settle the renderer.
		Promise.resolve(p).catch(e => {
			if (requestId in this._infoOfRunningRequest) this._failRequest(requestId, e)
		})
		this._infoOfRunningRequest[requestId].waitForSend = p
	}

	private async _callAbort(params: MainLLMMessageAbortParams) {
		const { requestId } = params;
		if (!(requestId in this._infoOfRunningRequest)) return
		const { waitForSend, abortRef } = this._infoOfRunningRequest[requestId]
		await waitForSend // wait for the send to finish so we know abortRef was set
		abortRef?.current?.()
		delete this._infoOfRunningRequest[requestId]
	}





	_callOllamaList = (params: MainModelListParams<OllamaModelResponse>) => {
		const { requestId } = params
		const emitters = this.listEmitters.ollama
		const mainThreadParams: ModelListParams<OllamaModelResponse> = {
			...params,
			onSuccess: (p) => { emitters.success.fire({ requestId, ...p }); },
			onError: (p) => { emitters.error.fire({ requestId, ...p }); },
		}
		sendLLMMessageToProviderImplementation.ollama.list(mainThreadParams)
	}

	_callOpenAICompatibleList = (params: MainModelListParams<OpenaiCompatibleModelResponse>) => {
		const { requestId, providerName } = params
		const emitters = this.listEmitters.openaiCompat
		const mainThreadParams: ModelListParams<OpenaiCompatibleModelResponse> = {
			...params,
			onSuccess: (p) => { emitters.success.fire({ requestId, ...p }); },
			onError: (p) => { emitters.error.fire({ requestId, ...p }); },
		}
		sendLLMMessageToProviderImplementation[providerName].list(mainThreadParams)
	}

	_callOrbitProviderList = (params: MainOrbitProviderListParams<OrbitProviderModelResponse>) => {
		const { requestId } = params
		const emitters = this.listEmitters.orbit
		const mainThreadParams: ModelListParams<OrbitProviderModelResponse> = {
			...params,
			onSuccess: (p) => { emitters.success.fire({ requestId, ...p }); },
			onError: (p) => { emitters.error.fire({ requestId, ...p }); },
		}
		sendLLMMessageToProviderImplementation.orbit.list!(mainThreadParams)
	}

	_callClinePassProviderList = (params: MainClinePassProviderListParams<ClinePassModelResponse>) => {
		const { requestId } = params
		const emitters = this.listEmitters.clinePass
		const mainThreadParams: ModelListParams<ClinePassModelResponse> = {
			...params,
			onSuccess: (p) => { emitters.success.fire({ requestId, ...p }); },
			onError: (p) => { emitters.error.fire({ requestId, ...p }); },
		}
		sendLLMMessageToProviderImplementation.clinePass.list!(mainThreadParams)
	}

}
