/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { IVoidSettingsService } from './orbitSettingsService.js';
import { ILLMMessageService } from './sendLLMMessageService.js';
import { IOrbitProviderAuthService } from './orbitProviderAuthService.js';
import { IClinePassAuthService } from './clinePassAuthService.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { RefreshableProviderName, refreshableProviderNames, SettingsOfProvider } from './orbitSettingsTypes.js';
import { OllamaModelResponse, OpenaiCompatibleModelResponse } from './sendLLMMessageTypes.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';




type RefreshableState = ({
	state: 'init',
	timeoutId: null,
} | {
	state: 'refreshing',
	timeoutId: NodeJS.Timeout | null, // the timeoutId of the most recent call to refreshModels
} | {
	state: 'finished',
	timeoutId: null,
} | {
	state: 'error',
	timeoutId: null,
})


/*

user click -> error -> fire(error)
		   \> success -> fire(success)
	finally: keep polling

poll -> do not fire

*/
export type RefreshModelStateOfProvider = Record<RefreshableProviderName, RefreshableState>



const refreshBasedOn: { [k in RefreshableProviderName]: (keyof SettingsOfProvider[k])[] } = {
	ollama: ['_didFillInProviderSettings', 'endpoint'],
	vLLM: ['_didFillInProviderSettings', 'endpoint'],
	lmStudio: ['_didFillInProviderSettings', 'endpoint'],
	// openAICompatible: ['_didFillInProviderSettings', 'endpoint', 'apiKey'],
}
const REFRESH_INTERVAL = 5_000
// const COOLDOWN_TIMEOUT = 300

const autoOptions = { enableProviderOnSuccess: true, doNotFire: true }

// element-wise equals
function eq<T>(a: T[], b: T[]): boolean {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false
	}
	return true
}
export interface IRefreshModelService {
	readonly _serviceBrand: undefined;
	startRefreshingModels: (providerName: RefreshableProviderName, options: { enableProviderOnSuccess: boolean, doNotFire: boolean }) => void;
	refreshOrbitProviderModels(): void;
	refreshClinePassProviderModels(): void;
	onDidChangeState: Event<RefreshableProviderName>;
	state: RefreshModelStateOfProvider;
}

export const IRefreshModelService = createDecorator<IRefreshModelService>('RefreshModelService');

export class RefreshModelService extends Disposable implements IRefreshModelService {

	readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = new Emitter<RefreshableProviderName>();
	readonly onDidChangeState: Event<RefreshableProviderName> = this._onDidChangeState.event; // this is primarily for use in react, so react can listen + update on state changes

	private readonly _pollDisposables = new Set<IDisposable>()


	constructor(
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
		@IOrbitProviderAuthService private readonly orbitProviderAuthService: IOrbitProviderAuthService,
		@IClinePassAuthService private readonly clinePassAuthService: IClinePassAuthService,
	) {
		super()

		const refreshOrbitWhenReady = () => {
			void this.voidSettingsService.waitForInitState.then(() => {
				this.refreshOrbitProviderModels()
			})
		}

		this._register(this.orbitProviderAuthService.onDidChangeState((state) => {
			if (state.isAuthenticated) {
				refreshOrbitWhenReady()
			}
		}))

		const refreshClinePassWhenReady = () => {
			void this.voidSettingsService.waitForInitState.then(() => {
				this.refreshClinePassProviderModels()
			})
		}

		this._register(this.clinePassAuthService.onDidChangeState((state) => {
			if (state.isAuthenticated) {
				refreshClinePassWhenReady()
			}
		}))

		void Promise.all([
			this.voidSettingsService.waitForInitState,
			this.orbitProviderAuthService.getState(),
			this.clinePassAuthService.getState(),
		]).then(([, orbitState, clinePassState]) => {
			if (orbitState.isAuthenticated) {
				this.refreshOrbitProviderModels()
			}
			if (clinePassState.isAuthenticated) {
				this.refreshClinePassProviderModels()
			}
		})

		const initializeAutoPollingAndOnChange = () => {
			this._clearAllTimeouts()
			this._pollDisposables.forEach(d => d.dispose())
			this._pollDisposables.clear()

			if (!voidSettingsService.state.globalSettings.autoRefreshModels) return

			for (const providerName of refreshableProviderNames) {

				// const { '_didFillInProviderSettings': enabled } = this.voidSettingsService.state.settingsOfProvider[providerName]
				this.startRefreshingModels(providerName, autoOptions)

				// every time providerName.enabled changes, refresh models too, like a useEffect
				let relevantVals = () => refreshBasedOn[providerName].map(settingName => voidSettingsService.state.settingsOfProvider[providerName][settingName])
				let prevVals = relevantVals() // each iteration of a for loop has its own context and vars, so this is ok
				this._pollDisposables.add(
					voidSettingsService.onDidChangeState(() => { // we might want to debounce this
						const newVals = relevantVals()
						if (!eq(prevVals, newVals)) {

							const prevEnabled = prevVals[0] as boolean
							const enabled = newVals[0] as boolean

							// if it was just enabled, or there was a change and it wasn't to the enabled state, refresh
							if ((enabled && !prevEnabled) || (!enabled && !prevEnabled)) {
								// if user just clicked enable, refresh
								this.startRefreshingModels(providerName, autoOptions)
							}
							else {
								// else if user just clicked disable, don't refresh

								// //give cooldown before re-enabling (or at least re-fetching)
								// const timeoutId = setTimeout(() => this.refreshModels(providerName, !enabled), COOLDOWN_TIMEOUT)
								// this._setTimeoutId(providerName, timeoutId)
							}
							prevVals = newVals
						}
					})
				)
			}
		}

		// on mount (when get init settings state), and if a relevant feature flag changes, start refreshing models
		voidSettingsService.waitForInitState.then(() => {
			initializeAutoPollingAndOnChange()
			this._register(
				voidSettingsService.onDidChangeState((type) => { if (typeof type === 'object' && type[1] === 'autoRefreshModels') initializeAutoPollingAndOnChange() })
			)
		})

	}

	state: RefreshModelStateOfProvider = {
		ollama: { state: 'init', timeoutId: null },
		vLLM: { state: 'init', timeoutId: null },
		lmStudio: { state: 'init', timeoutId: null },
	}


	// start listening for models (and don't stop)
	startRefreshingModels: IRefreshModelService['startRefreshingModels'] = (providerName, options) => {

		this._clearProviderTimeout(providerName)

		this._setRefreshState(providerName, 'refreshing', options)

		// Phase 2.10 (H14) fix: bound auto-refresh polling with consecutive-error
		// backoff. After several consecutive errors, pause until the user manually
		// triggers a refresh; this prevents an infinite chain of setTimeout calls
		// when the endpoint is permanently down.
		const errorCountKey = `${providerName}_consecutiveErrors` as const;
		const currentErrors = (this as unknown as Record<string, number>)[errorCountKey] ?? 0;
		const maxConsecutiveErrorsBeforePause = 10;
		const backoffStartAfter = 3;
		const baseIntervalMs = REFRESH_INTERVAL;
		const maxBackoffMs = 60_000;

		const autoPoll = () => {
			if (!this.voidSettingsService.state.globalSettings.autoRefreshModels) {
				return;
			}
			// Reset error count on a successful cycle.
			(this as unknown as Record<string, number>)[errorCountKey] = 0;
			const timeoutId = setTimeout(() => this.startRefreshingModels(providerName, autoOptions), baseIntervalMs);
			this._setTimeoutId(providerName, timeoutId);
		}

		const autoPollOnError = () => {
			if (!this.voidSettingsService.state.globalSettings.autoRefreshModels) {
				return;
			}
			const nextErrors = currentErrors + 1;
			(this as unknown as Record<string, number>)[errorCountKey] = nextErrors;
			if (nextErrors >= maxConsecutiveErrorsBeforePause) {
				console.warn(
					`[RefreshModels] Pausing auto-refresh for ${providerName} after ${nextErrors} consecutive errors. ` +
					`Trigger a manual refresh to resume.`
				);
				// Do not schedule the next poll.
				return;
			}
			// Exponential backoff once we have a few errors.
			const backoff = nextErrors > backoffStartAfter
				? Math.min(maxBackoffMs, baseIntervalMs * Math.pow(2, nextErrors - backoffStartAfter))
				: baseIntervalMs;
			const timeoutId = setTimeout(() => this.startRefreshingModels(providerName, autoOptions), backoff);
			this._setTimeoutId(providerName, timeoutId);
		}
		const listFn = providerName === 'ollama' ? this.llmMessageService.ollamaList
			: this.llmMessageService.openAICompatibleList

		listFn({
			providerName,
			onSuccess: ({ models }) => {
				// set the models to the detected models
				this.voidSettingsService.setAutodetectedModels(
					providerName,
					models.map(model => {
						if (providerName === 'ollama') return (model as OllamaModelResponse).name;
						else if (providerName === 'vLLM') return (model as OpenaiCompatibleModelResponse).id;
						else if (providerName === 'lmStudio') return (model as OpenaiCompatibleModelResponse).id;
						else throw new Error('refreshMode fn: unknown provider', providerName);
					}),
					{ enableProviderOnSuccess: options.enableProviderOnSuccess, hideRefresh: options.doNotFire }
				)

				if (options.enableProviderOnSuccess) this.voidSettingsService.setSettingOfProvider(providerName, '_didFillInProviderSettings', true)

				this._setRefreshState(providerName, 'finished', options)
				autoPoll()
			},
			onError: ({ error }) => {
				this._setRefreshState(providerName, 'error', options)
				autoPollOnError()
			}
		})


	}

	refreshOrbitProviderModels(): void {
		this.llmMessageService.orbitProviderList({
			onSuccess: ({ models }) => {
				this.voidSettingsService.setOrbitProviderModels(
					models,
					{ source: 'auth_refresh' },
				)
			},
			onError: ({ error }) => {
				console.warn('[Orbit Provider] Model list refresh failed:', error)
			},
		})
	}

	refreshClinePassProviderModels(): void {
		this.llmMessageService.clinePassProviderList({
			onSuccess: ({ models }) => {
				this.voidSettingsService.setClinePassProviderModels(
					models,
					{ source: 'auth_refresh' },
				)
			},
			onError: ({ error }) => {
				console.warn('[ClinePass Provider] Model list refresh failed:', error)
			},
		})
	}

	_clearAllTimeouts() {
		for (const providerName of refreshableProviderNames) {
			this._clearProviderTimeout(providerName)
		}
	}

	_clearProviderTimeout(providerName: RefreshableProviderName) {
		// cancel any existing poll
		if (this.state[providerName].timeoutId) {
			clearTimeout(this.state[providerName].timeoutId)
			this._setTimeoutId(providerName, null)
		}
	}

	private _setTimeoutId(providerName: RefreshableProviderName, timeoutId: NodeJS.Timeout | null) {
		this.state[providerName].timeoutId = timeoutId
	}

	private _setRefreshState(providerName: RefreshableProviderName, state: RefreshableState['state'], options?: { doNotFire: boolean }) {
		if (options?.doNotFire) return
		this.state[providerName].state = state
		this._onDidChangeState.fire(providerName)
	}

	override dispose() {
		this._clearAllTimeouts()
		for (const d of this._pollDisposables) d.dispose()
		this._pollDisposables.clear()
		super.dispose()
	}
}

registerSingleton(IRefreshModelService, RefreshModelService, InstantiationType.Eager);

