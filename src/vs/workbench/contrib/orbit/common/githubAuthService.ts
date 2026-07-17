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

export type GitHubAuthState = {
	isAuthenticated: boolean
	isPending: boolean
	email?: string
	login?: string
	avatarUrl?: string
	userId?: string
	plan?: string
}

// getAccessToken deliberately isn't part of this interface: it's registered
// on a renderer-reachable IPC channel (void-channel-github-auth), and every
// real token use lives in the main process (orbitProviderChat/List/Usage,
// via getGitHubOAuthManager() directly) — putting it here would hand a
// live sk_.../session token to any compromised renderer/webview with no
// legitimate caller needing it. Fetch the token main-process-side only.
export interface IGitHubAuthService {
	readonly _serviceBrand: undefined
	getState(): Promise<GitHubAuthState>
	startAuthorizationFlow(): Promise<{ authUrl: string }>
	waitForCallback(): Promise<GitHubAuthState>
	cancelAuthorizationFlow(): Promise<void>
	signOut(): Promise<void>
	readonly onDidChangeState: Event<GitHubAuthState>
}

export const IGitHubAuthService = createDecorator<IGitHubAuthService>('GitHubAuthService')

export class GitHubAuthService extends Disposable implements IGitHubAuthService {
	readonly _serviceBrand: undefined
	private readonly mainService: IGitHubAuthService
	private readonly _onDidChangeState = new Emitter<GitHubAuthState>()
	readonly onDidChangeState = this._onDidChangeState.event
	state: GitHubAuthState = { isAuthenticated: false, isPending: false }

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		super()
		this.mainService = ProxyChannel.toService<IGitHubAuthService>(
			mainProcessService.getChannel('void-channel-github-auth'),
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

registerSingleton(IGitHubAuthService, GitHubAuthService, InstantiationType.Eager)
