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
import type { GitHubAuthState } from './githubAuthService.js'
import type { OrbitProviderUsage } from './orbitProviderUsage.js'

export type OrbitProviderAuthState = GitHubAuthState

// getAccessToken deliberately isn't part of this interface — see the
// identical note on IGitHubAuthService in githubAuthService.ts. This
// interface is registered on the renderer-reachable void-channel-orbit-
// provider-auth IPC channel; every real token use lives in the main
// process, which fetches it main-process-side only.
export interface IOrbitProviderAuthService {
	readonly _serviceBrand: undefined
	getState(): Promise<OrbitProviderAuthState>
	getUsage(): Promise<OrbitProviderUsage>
	startAuthorizationFlow(): Promise<{ authUrl: string }>
	waitForCallback(): Promise<OrbitProviderAuthState>
	cancelAuthorizationFlow(): Promise<void>
	signOut(): Promise<void>
	readonly onDidChangeState: Event<OrbitProviderAuthState>
}

export const IOrbitProviderAuthService = createDecorator<IOrbitProviderAuthService>('OrbitProviderAuthService')

export class OrbitProviderAuthService extends Disposable implements IOrbitProviderAuthService {
	readonly _serviceBrand: undefined
	private readonly mainService: IOrbitProviderAuthService
	private readonly _onDidChangeState = new Emitter<OrbitProviderAuthState>()
	readonly onDidChangeState = this._onDidChangeState.event
	state: OrbitProviderAuthState = { isAuthenticated: false, isPending: false }

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		super()
		this.mainService = ProxyChannel.toService<IOrbitProviderAuthService>(
			mainProcessService.getChannel('void-channel-orbit-provider-auth'),
		)
		this._register(this.mainService.onDidChangeState((s) => {
			this.state = s
			this._onDidChangeState.fire(s)
		}))
		void this.initialize()
	}

	private async initialize() {
		try {
			this.state = await this.mainService.getState()
			this._onDidChangeState.fire(this.state)
		} catch {
			this.state = { isAuthenticated: false, isPending: false }
		}
	}

	getState = () => this.mainService.getState()

	getUsage = () => this.mainService.getUsage()

	startAuthorizationFlow = () => this.mainService.startAuthorizationFlow()

	waitForCallback = async () => {
		const s = await this.mainService.waitForCallback()
		this.state = s
		this._onDidChangeState.fire(s)
		return s
	}

	cancelAuthorizationFlow = () => this.mainService.cancelAuthorizationFlow()

	signOut = () => this.mainService.signOut()
}

registerSingleton(IOrbitProviderAuthService, OrbitProviderAuthService, InstantiationType.Eager)
