/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js'
import { Emitter } from '../../../../../base/common/event.js'
import { ILogService } from '../../../../../platform/log/common/log.js'
import { IEncryptionMainService } from '../../../../../platform/encryption/common/encryptionService.js'
import { IApplicationStorageMainService } from '../../../../../platform/storage/electron-main/storageMainService.js'
import { IClinePassAuthService, ClinePassAuthState } from '../../common/clinePassAuthService.js'
import { initClinePassOAuthManager } from './oauthManager.js'

export class ClinePassAuthMainService extends Disposable implements IClinePassAuthService {
	_serviceBrand: undefined
	private readonly manager

	private readonly _onDidChangeState = new Emitter<ClinePassAuthState>()
	readonly onDidChangeState = this._onDidChangeState.event

	constructor(
		@IApplicationStorageMainService private readonly storageService: IApplicationStorageMainService,
		@IEncryptionMainService private readonly encryptionService: IEncryptionMainService,
		@ILogService private readonly logService: ILogService,
	) {
		super()
		this.manager = initClinePassOAuthManager({
			storageService: this.storageService,
			encryptionService: this.encryptionService,
			logService: this.logService,
		})
		this._register(this.manager.onDidChangeState((state) => {
			this._onDidChangeState.fire(state)
		}))
	}

	async getState(): Promise<ClinePassAuthState> {
		return this.manager.getState()
	}

	async startAuthorizationFlow(): Promise<{ authUrl: string }> {
		const authUrl = await this.manager.startAuthorizationFlow()
		return { authUrl }
	}

	async waitForCallback(): Promise<ClinePassAuthState> {
		return this.manager.waitForCallback()
	}

	async signOut(): Promise<void> {
		await this.manager.clearCredentials()
	}
}
