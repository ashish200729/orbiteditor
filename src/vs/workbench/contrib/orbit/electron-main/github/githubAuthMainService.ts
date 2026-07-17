/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js'
import { Emitter } from '../../../../../base/common/event.js'
import { ILogService } from '../../../../../platform/log/common/log.js'
import { IEncryptionMainService } from '../../../../../platform/encryption/common/encryptionService.js'
import { IApplicationStorageMainService } from '../../../../../platform/storage/electron-main/storageMainService.js'
import { IURLService } from '../../../../../platform/url/common/url.js'
import { IProductService } from '../../../../../platform/product/common/productService.js'
import { INativeEnvironmentService } from '../../../../../platform/environment/common/environment.js'
import type { IGitHubAuthService, GitHubAuthState } from '../../common/githubAuthService.js'
import { initGitHubOAuthManager } from './oauthManager.js'

export class GitHubAuthMainService extends Disposable implements IGitHubAuthService {
	_serviceBrand: undefined
	private readonly manager
	private readonly _onDidChangeState = new Emitter<GitHubAuthState>()
	readonly onDidChangeState = this._onDidChangeState.event

	constructor(
		@IApplicationStorageMainService storageService: IApplicationStorageMainService,
		@IEncryptionMainService encryptionService: IEncryptionMainService,
		@IURLService urlService: IURLService,
		@IProductService productService: IProductService,
		@INativeEnvironmentService environmentService: INativeEnvironmentService,
		@ILogService logService: ILogService,
	) {
		super()
		this.manager = initGitHubOAuthManager({
			storageService,
			encryptionService,
			urlService,
			productService,
			environmentService,
			logService,
		})
		this._register(this.manager.onDidChangeState((s) => this._onDidChangeState.fire(s)))
	}

	getState = async () => this.manager.getState()

	startAuthorizationFlow = async () => ({ authUrl: await this.manager.startAuthorizationFlow() })

	waitForCallback = () => this.manager.waitForCallback()

	signOut = () => this.manager.clearCredentials()
}
