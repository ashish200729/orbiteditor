/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js'
import { Emitter, Event } from '../../../../base/common/event.js'
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js'
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js'
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js'
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js'

export type ClinePassAuthState = {
	isAuthenticated: boolean
	email?: string
	userId?: string
	displayName?: string
}

export interface IClinePassAuthService {
	readonly _serviceBrand: undefined
	getState(): Promise<ClinePassAuthState>
	startAuthorizationFlow(): Promise<{ authUrl: string }>
	waitForCallback(): Promise<ClinePassAuthState>
	signOut(): Promise<void>
	readonly onDidChangeState: Event<ClinePassAuthState>
}

export const IClinePassAuthService = createDecorator<IClinePassAuthService>('ClinePassAuthService')

export class ClinePassAuthService extends Disposable implements IClinePassAuthService {
	readonly _serviceBrand: undefined
	private readonly mainService: IClinePassAuthService
	private readonly _onDidChangeState = new Emitter<ClinePassAuthState>()
	readonly onDidChangeState = this._onDidChangeState.event
	state: ClinePassAuthState = { isAuthenticated: false }

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		super()
		this.mainService = ProxyChannel.toService<IClinePassAuthService>(mainProcessService.getChannel('void-channel-cline-pass-auth'))
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
		}
		catch {
			this.state = { isAuthenticated: false }
		}
	}

	getState = async (): Promise<ClinePassAuthState> => {
		return this.mainService.getState()
	}

	startAuthorizationFlow = async (): Promise<{ authUrl: string }> => {
		return this.mainService.startAuthorizationFlow()
	}

	waitForCallback = async (): Promise<ClinePassAuthState> => {
		const state = await this.mainService.waitForCallback()
		this.state = state
		this._onDidChangeState.fire(state)
		return state
	}

	signOut = async (): Promise<void> => {
		await this.mainService.signOut()
	}
}

registerSingleton(IClinePassAuthService, ClinePassAuthService, InstantiationType.Eager)
