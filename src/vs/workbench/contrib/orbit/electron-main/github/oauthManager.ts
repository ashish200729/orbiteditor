/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createHash, randomBytes } from 'crypto'
import { Emitter, Event } from '../../../../../base/common/event.js'
import { URI } from '../../../../../base/common/uri.js'
import { Disposable } from '../../../../../base/common/lifecycle.js'
import { ILogService } from '../../../../../platform/log/common/log.js'
import { IEncryptionMainService } from '../../../../../platform/encryption/common/encryptionService.js'
import { IApplicationStorageMainService } from '../../../../../platform/storage/electron-main/storageMainService.js'
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js'
import { IURLService } from '../../../../../platform/url/common/url.js'
import { IProductService } from '../../../../../platform/product/common/productService.js'
import { INativeEnvironmentService } from '../../../../../platform/environment/common/environment.js'
import { GITHUB_OAUTH_CONFIG } from './oauthConfig.js'
import type { GitHubCredentials, PendingState } from './oauthTypes.js'
import type { GitHubAuthState } from '../../common/githubAuthService.js'
import { getOrbitApiBaseUrl } from '../llmMessage/orbitApiUrl.js'

export class GitHubOAuthError extends Error {
	readonly code: string
	constructor(message: string, code = 'oauth_error') {
		super(message)
		this.name = 'GitHubOAuthError'
		this.code = code
	}
}

export type GitHubOAuthManagerServices = {
	storageService: IApplicationStorageMainService
	encryptionService: IEncryptionMainService
	urlService: IURLService
	productService: IProductService
	environmentService: INativeEnvironmentService
	logService: ILogService
}

export class GitHubOAuthManager extends Disposable {
	private credentials: GitHubCredentials | null = null
	private pendingAuth: PendingState | null = null
	private isPending: boolean = false
	private readonly _onDidChangeState = new Emitter<GitHubAuthState>()
	readonly onDidChangeState: Event<GitHubAuthState> = this._onDidChangeState.event
	private readonly ready: Promise<void>

	private callbackWaiters: Array<{ resolve: (s: GitHubAuthState) => void; reject: (e: Error) => void }> = []

	constructor(private readonly services: GitHubOAuthManagerServices) {
		super()
		this.ready = this.loadCredentials()
		this._register(services.urlService.registerHandler({
			handleURL: (uri) => this.handleDeepLink(uri),
		}))
	}

	private async loadCredentials() {
		try {
			await this.services.storageService.whenReady
			const encrypted = this.services.storageService.get(
				GITHUB_OAUTH_CONFIG.storageKey,
				StorageScope.APPLICATION,
				undefined,
			)
			if (!encrypted) {
				return
			}
			const decrypted = await this.services.encryptionService.decrypt(encrypted)
			const parsed = JSON.parse(decrypted) as GitHubCredentials
			if (parsed?.accessToken && typeof parsed.expiresAt === 'number' && parsed.user && typeof parsed.user.id === 'string') {
				this.credentials = parsed
			} else {
				this.credentials = null
			}
		} catch (error) {
			this.services.logService.warn('[GitHubOAuthManager] Failed to load credentials', error)
			this.credentials = null
		}
		this._onDidChangeState.fire(this.getState())
	}

	getState(): GitHubAuthState {
		return {
			isAuthenticated: !!this.credentials && !this.isExpired(),
			isPending: this.isPending,
			email: this.credentials?.user.email,
			login: this.credentials?.user.login,
			avatarUrl: this.credentials?.user.avatarUrl,
			userId: this.credentials?.user.id,
			plan: this.credentials?.user.plan,
		}
	}

	private isExpired(): boolean {
		if (!this.credentials) {
			return true
		}
		return Date.now() >= this.credentials.expiresAt - GITHUB_OAUTH_CONFIG.expirySafetyWindowMs
	}

	async startAuthorizationFlow(): Promise<string> {
		await this.ready
		if (this.pendingAuth) {
			this.cancelPending('Authorization cancelled.')
		}

		const baseUrl = getOrbitApiBaseUrl(this.services.productService, this.services.environmentService)
		const editorState = randomBytes(GITHUB_OAUTH_CONFIG.stateParamLength / 2).toString('hex')
		const codeVerifier = randomBytes(GITHUB_OAUTH_CONFIG.pkceVerifierLength).toString('base64url')
		const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
		const callback = `${this.services.productService.urlProtocol ?? GITHUB_OAUTH_CONFIG.callbackScheme}://${GITHUB_OAUTH_CONFIG.callbackHost}?editor_state=${encodeURIComponent(editorState)}`
		const authUrl = new URL(`${baseUrl}${GITHUB_OAUTH_CONFIG.desktopStartPath}`)
		authUrl.searchParams.set('client', 'desktop')
		authUrl.searchParams.set('redirect_uri', callback)
		authUrl.searchParams.set('code_challenge', codeChallenge)

		const timeoutId = setTimeout(() => {
			this.rejectPending(new GitHubOAuthError('Sign-in timed out. Please try again.', 'timeout'))
		}, GITHUB_OAUTH_CONFIG.authTimeoutMs)

		this.pendingAuth = {
			state: editorState,
			codeVerifier,
			startedAt: Date.now(),
			timeoutId,
			resolve: async (creds) => {
				await this.persistCredentials(creds)
				const authState = this.getState()
				for (const waiter of this.callbackWaiters.splice(0)) {
					waiter.resolve(authState)
				}
			},
			reject: (err) => {
				for (const waiter of this.callbackWaiters.splice(0)) {
					waiter.reject(err)
				}
			},
		}

		this.isPending = true
		this._onDidChangeState.fire(this.getState())

		return authUrl.toString()
	}

	async waitForCallback(): Promise<GitHubAuthState> {
		await this.ready
		if (!this.pendingAuth) {
			if (this.credentials && !this.isExpired()) {
				return this.getState()
			}
			throw new GitHubOAuthError('No authorization in progress.', 'no_pending')
		}
		return new Promise<GitHubAuthState>((resolve, reject) => {
			this.callbackWaiters.push({ resolve, reject })
		})
	}

	async handleDeepLink(uri: URI): Promise<boolean> {
		const scheme = this.services.productService.urlProtocol ?? GITHUB_OAUTH_CONFIG.callbackScheme
		if (uri.scheme !== scheme || uri.authority !== GITHUB_OAUTH_CONFIG.callbackHost) {
			return false
		}
		if (!this.pendingAuth) {
			return false
		}

		const query = new URLSearchParams(uri.query)
		const error = query.get('error')
		if (error) {
			const message = error === 'access_denied'
				? 'Authorization was cancelled.'
				: query.get('error_description') ?? 'Authorization failed.'
			this.rejectPending(new GitHubOAuthError(message, error === 'access_denied' ? 'cancelled' : error))
			return true
		}

		const editorState = query.get('editor_state')
		if (!editorState || editorState !== this.pendingAuth.state) {
			this.rejectPending(new GitHubOAuthError('State mismatch detected.', 'state_mismatch'))
			return true
		}

		const code = query.get('code')
		if (!code) {
			this.rejectPending(new GitHubOAuthError('No authorization code in callback.', 'missing_code'))
			return true
		}

		try {
			const creds = await this.exchangeAuthorizationCode(code, this.pendingAuth.codeVerifier)
			const resolve = this.pendingAuth.resolve
			clearTimeout(this.pendingAuth.timeoutId)
			this.pendingAuth = null
			await resolve(creds)
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Failed to complete sign-in.'
			if (this.pendingAuth) {
				this.rejectPending(new GitHubOAuthError(message, 'session_fetch_failed'))
			} else {
				const error = new GitHubOAuthError(message, 'session_fetch_failed')
				for (const waiter of this.callbackWaiters.splice(0)) {
					waiter.reject(error)
				}
				this.isPending = false
				this._onDidChangeState.fire(this.getState())
			}
		}
		return true
	}

	private async exchangeAuthorizationCode(code: string, codeVerifier: string): Promise<GitHubCredentials> {
		const baseUrl = getOrbitApiBaseUrl(this.services.productService, this.services.environmentService)
		const res = await fetch(`${baseUrl}/api/auth/desktop/exchange`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ code, codeVerifier }),
		})
		if (!res.ok) {
			throw new Error(`Failed to fetch session (${res.status})`)
		}
		const json = await res.json() as {
			token?: string
			session?: { expiresAt?: string }
			user?: { id?: string; email?: string; name?: string; image?: string; githubLogin?: string; plan?: string }
		}
		const user = json.user
		if (!json.token || !user?.id) {
			throw new Error('Invalid session response')
		}
		// Backend is expected to always send expiresAt. If it's ever missing, fall back to a
		// bounded 30-day expiry rather than treating the credential as never expiring.
		const expiresAt = json.session?.expiresAt
			? Date.parse(json.session.expiresAt)
			: Date.now() + 30 * 24 * 60 * 60 * 1000
		return {
			accessToken: json.token,
			expiresAt,
			user: {
				id: user.id,
				email: user.email,
				login: user.githubLogin ?? user.name,
				avatarUrl: user.image,
				plan: user.plan,
			},
		}
	}

	async getAccessToken(): Promise<string> {
		await this.ready
		if (!this.credentials || this.isExpired()) {
			await this.clearCredentials()
			throw new GitHubOAuthError('Please sign in with GitHub.', 'not_authenticated')
		}
		return this.credentials.accessToken
	}

	async clearCredentials(): Promise<void> {
		const token = this.credentials?.accessToken
		if (token?.startsWith('sk_')) {
			try {
				const baseUrl = getOrbitApiBaseUrl(this.services.productService, this.services.environmentService)
				await fetch(`${baseUrl}/api/auth/api-keys/current`, {
					method: 'DELETE',
					headers: { authorization: `Bearer ${token}` },
				})
			} catch (error) {
				// Local sign-out must still complete while offline. The website's
				// account page can revoke any orphaned device key later.
				this.services.logService.warn('[GitHubOAuthManager] Failed to revoke API key during sign-out', error)
			}
		}
		this.credentials = null
		this.cancelPending('Authorization cancelled.')
		await this.services.storageService.whenReady
		this.services.storageService.remove(GITHUB_OAUTH_CONFIG.storageKey, StorageScope.APPLICATION)
		this._onDidChangeState.fire(this.getState())
	}

	private async persistCredentials(credentials: GitHubCredentials) {
		this.credentials = credentials
		const encrypted = await this.services.encryptionService.encrypt(JSON.stringify(credentials))
		await this.services.storageService.whenReady
		this.services.storageService.store(
			GITHUB_OAUTH_CONFIG.storageKey,
			encrypted,
			StorageScope.APPLICATION,
			StorageTarget.MACHINE,
		)
		this.isPending = false
		this._onDidChangeState.fire(this.getState())
	}

	private cancelPending(message: string) {
		if (!this.pendingAuth) {
			return
		}
		clearTimeout(this.pendingAuth.timeoutId)
		const err = new GitHubOAuthError(message, 'cancelled')
		this.pendingAuth.reject(err)
		this.pendingAuth = null
		this.isPending = false
		this._onDidChangeState.fire(this.getState())
	}

	private rejectPending(err: Error) {
		if (!this.pendingAuth) {
			return
		}
		clearTimeout(this.pendingAuth.timeoutId)
		this.pendingAuth.reject(err)
		this.pendingAuth = null
		this.isPending = false
		this._onDidChangeState.fire(this.getState())
	}
}

let _manager: GitHubOAuthManager | null = null

export const initGitHubOAuthManager = (services: GitHubOAuthManagerServices): GitHubOAuthManager => {
	if (!_manager) {
		_manager = new GitHubOAuthManager(services)
	}
	return _manager
}

export const getGitHubOAuthManager = (): GitHubOAuthManager => {
	if (!_manager) {
		throw new Error('GitHubOAuthManager not initialized')
	}
	return _manager
}
