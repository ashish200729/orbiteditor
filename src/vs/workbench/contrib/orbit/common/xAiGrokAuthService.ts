/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js'
import { Disposable } from '../../../../base/common/lifecycle.js'
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js'
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js'
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js'
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js'

export type XAiGrokAuthState = {
	isAuthenticated: boolean
	isAuthorizing: boolean
	email?: string
}

export type XAiDeviceAuthorization = {
	verificationUri: string
	verificationUriComplete?: string
	userCode: string
}

export type XAiGrokUsage = {
	monthly: {
		limit: number
		used: number
		resetsAt: string
	}
	weekly?: {
		usedPercent: number
		resetsAt: string
	}
	fetchedAt: number
}

export interface IXAiGrokAuthService {
	readonly _serviceBrand: undefined
	getState(): Promise<XAiGrokAuthState>
	startAuthorizationFlow(): Promise<{ authUrl: string }>
	waitForCallback(): Promise<XAiGrokAuthState>
	startDeviceAuthorizationFlow(): Promise<XAiDeviceAuthorization>
	waitForDeviceAuthorization(): Promise<XAiGrokAuthState>
	getUsage(forceRefresh?: boolean): Promise<XAiGrokUsage>
	signOut(): Promise<void>
	readonly onDidChangeState: Event<XAiGrokAuthState>
}

export const IXAiGrokAuthService = createDecorator<IXAiGrokAuthService>('XAiGrokAuthService')

export class XAiGrokAuthService extends Disposable implements IXAiGrokAuthService {
	readonly _serviceBrand: undefined
	private readonly mainService: IXAiGrokAuthService
	private readonly _onDidChangeState = new Emitter<XAiGrokAuthState>()
	readonly onDidChangeState = this._onDidChangeState.event
	state: XAiGrokAuthState = { isAuthenticated: false, isAuthorizing: false }

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		super()
		this.mainService = ProxyChannel.toService<IXAiGrokAuthService>(mainProcessService.getChannel('void-channel-xai-grok-auth'))
		this._register(this.mainService.onDidChangeState((state) => {
			this.state = state
			this._onDidChangeState.fire(state)
		}))
		void this.initialize()
	}

	private async initialize() {
		try {
			this.state = await this.mainService.getState()
			this._onDidChangeState.fire(this.state)
		} catch {
			this.state = { isAuthenticated: false, isAuthorizing: false }
		}
	}

	getState = () => this.mainService.getState()
	startAuthorizationFlow = () => this.mainService.startAuthorizationFlow()
	waitForCallback = () => this.mainService.waitForCallback()
	startDeviceAuthorizationFlow = () => this.mainService.startDeviceAuthorizationFlow()
	waitForDeviceAuthorization = () => this.mainService.waitForDeviceAuthorization()
	getUsage = (forceRefresh?: boolean) => this.mainService.getUsage(forceRefresh)
	signOut = () => this.mainService.signOut()
}

registerSingleton(IXAiGrokAuthService, XAiGrokAuthService, InstantiationType.Eager)
