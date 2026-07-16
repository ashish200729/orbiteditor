/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../../base/common/event.js'
import { Disposable } from '../../../../../base/common/lifecycle.js'
import { IEncryptionMainService } from '../../../../../platform/encryption/common/encryptionService.js'
import { ILogService } from '../../../../../platform/log/common/log.js'
import { IApplicationStorageMainService } from '../../../../../platform/storage/electron-main/storageMainService.js'
import { IXAiGrokAuthService, XAiDeviceAuthorization, XAiGrokAuthState, XAiGrokUsage } from '../../common/xAiGrokAuthService.js'
import { fetchXAiGrokUsage } from './billing.js'
import { initXAiGrokOAuthManager } from './oauthManager.js'

export class XAiGrokAuthMainService extends Disposable implements IXAiGrokAuthService {
	readonly _serviceBrand: undefined
	private readonly manager
	private readonly _onDidChangeState = new Emitter<XAiGrokAuthState>()
	readonly onDidChangeState = this._onDidChangeState.event
	private usageCache: { value: XAiGrokUsage; expiresAt: number } | undefined

	constructor(
		@IApplicationStorageMainService storageService: IApplicationStorageMainService,
		@IEncryptionMainService encryptionService: IEncryptionMainService,
		@ILogService logService: ILogService,
	) {
		super()
		this.manager = initXAiGrokOAuthManager({ storageService, encryptionService, logService })
		this._register(this.manager.onDidChangeState(state => this._onDidChangeState.fire(state)))
	}

	async getState() { return this.manager.getState() }
	async startAuthorizationFlow() { return { authUrl: await this.manager.startAuthorizationFlow() } }
	async waitForCallback() { return this.manager.waitForCallback() }
	async startDeviceAuthorizationFlow(): Promise<XAiDeviceAuthorization> { return this.manager.startDeviceAuthorizationFlow() }
	async waitForDeviceAuthorization() { return this.manager.waitForDeviceAuthorization() }
	async getUsage(forceRefresh = false) {
		if (!forceRefresh && this.usageCache && this.usageCache.expiresAt > Date.now()) return this.usageCache.value
		let accessToken = await this.manager.getAccessToken()
		let usage: XAiGrokUsage
		try {
			usage = await fetchXAiGrokUsage(accessToken)
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes('(401)')) throw error
			accessToken = await this.manager.forceRefreshAccessToken()
			usage = await fetchXAiGrokUsage(accessToken)
		}
		this.usageCache = { value: usage, expiresAt: Date.now() + 60_000 }
		return usage
	}
	async signOut() {
		this.usageCache = undefined
		await this.manager.clearCredentials()
	}
}
