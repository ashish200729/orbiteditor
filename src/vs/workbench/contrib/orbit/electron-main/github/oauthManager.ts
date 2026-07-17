/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createHash, randomBytes } from 'crypto'
import http from 'http'
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

const FETCH_TIMEOUT_MS = 15_000

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeoutMs)
	try {
		return await fetch(url, { ...init, signal: controller.signal })
	} finally {
		clearTimeout(timer)
	}
}

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

	private useDevLoopbackCallback(): boolean {
		return !this.services.environmentService.isBuilt
	}

	private buildRedirectUri(editorState: string): string {
		if (this.useDevLoopbackCallback()) {
			const redirect = new URL(`http://${GITHUB_OAUTH_CONFIG.devLoopbackHost}:${GITHUB_OAUTH_CONFIG.devLoopbackPort}${GITHUB_OAUTH_CONFIG.devLoopbackPath}`)
			redirect.searchParams.set('editor_state', editorState)
			return redirect.toString()
		}
		const scheme = this.services.productService.urlProtocol ?? GITHUB_OAUTH_CONFIG.callbackScheme
		return `${scheme}://${GITHUB_OAUTH_CONFIG.callbackHost}?editor_state=${encodeURIComponent(editorState)}`
	}

	private async startLoopbackServer(): Promise<http.Server> {
		const server = http.createServer((req, res) => void this.handleLoopbackCallback(req, res))
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error) => reject(error)
				server.once('error', onError)
				server.listen(
					GITHUB_OAUTH_CONFIG.devLoopbackPort,
					GITHUB_OAUTH_CONFIG.devLoopbackHost,
					() => {
						server.removeListener('error', onError)
						server.on('error', error => this.services.logService.warn('[GitHubOAuthManager] OAuth callback server error', error))
						resolve()
					},
				)
			})
		} catch (error) {
			server.close()
			const err = error as NodeJS.ErrnoException
			if (err.code === 'EADDRINUSE') {
				throw new GitHubOAuthError(
					`Port ${GITHUB_OAUTH_CONFIG.devLoopbackPort} is already in use. Close the other app and try again.`,
					'port_in_use',
				)
			}
			throw new GitHubOAuthError(
				`Failed to start the sign-in callback server: ${err.message || String(error)}`,
				'callback_server_error',
			)
		}
		return server
	}

	private handleLoopbackCallback(req: http.IncomingMessage, res: http.ServerResponse): void {
		if (req.method !== 'GET') {
			res.writeHead(405, { Allow: 'GET' })
			res.end('Method not allowed')
			return
		}

		const base = `http://${GITHUB_OAUTH_CONFIG.devLoopbackHost}:${GITHUB_OAUTH_CONFIG.devLoopbackPort}`
		const url = new URL(req.url || '/', base)
		if (url.pathname !== GITHUB_OAUTH_CONFIG.devLoopbackPath) {
			res.writeHead(404, { 'Content-Type': 'text/plain' })
			res.end('Not found')
			return
		}

		if (!this.pendingAuth) {
			this.respondWithHtml(res, false, 'No Orbit sign-in is currently in progress.')
			return
		}

		void this.handleCallbackQuery(url.searchParams, res)
	}

	private async handleCallbackQuery(
		query: URLSearchParams,
		res?: http.ServerResponse,
	): Promise<boolean> {
		if (!this.pendingAuth) {
			return false
		}

		const error = query.get('error')
		if (error) {
			const message = error === 'access_denied'
				? 'Authorization was cancelled.'
				: query.get('error_description') ?? 'Authorization failed.'
			if (res) {
				this.respondWithHtml(res, false, message)
			}
			this.rejectPending(new GitHubOAuthError(message, error === 'access_denied' ? 'cancelled' : error))
			return true
		}

		const editorState = query.get('editor_state')
		if (!editorState || editorState !== this.pendingAuth.state) {
			const message = 'State mismatch detected.'
			if (res) {
				this.respondWithHtml(res, false, message)
			}
			this.rejectPending(new GitHubOAuthError(message, 'state_mismatch'))
			return true
		}

		const code = query.get('code')
		if (!code) {
			const message = 'No authorization code in callback.'
			if (res) {
				this.respondWithHtml(res, false, message)
			}
			this.rejectPending(new GitHubOAuthError(message, 'missing_code'))
			return true
		}

		const pending = this.pendingAuth
		this.pendingAuth = null
		clearTimeout(pending.timeoutId)

		try {
			const creds = await this.exchangeAuthorizationCode(code, pending.codeVerifier)
			if (res) {
				this.respondWithHtml(res, true, 'Signed in to Orbit. You can close this tab and return to the editor.')
			}
			await pending.resolve(creds)
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Failed to complete sign-in.'
			if (res) {
				this.respondWithHtml(res, false, message)
			}
			pending.reject(new GitHubOAuthError(message, 'session_fetch_failed'))
			this.isPending = false
			this._onDidChangeState.fire(this.getState())
		} finally {
			this.closeLoopbackServer(pending)
		}
		return true
	}

	private closeLoopbackServer(pending?: PendingState | null) {
		const server = pending?.loopbackServer
		if (server?.listening) {
			server.close()
		}
	}

	private respondWithHtml(res: http.ServerResponse, success: boolean, rawMessage: string) {
		const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
		const title = success ? 'Signed in to Orbit' : 'Orbit sign-in failed'
		const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0c;color:#f5f5f5;font:16px system-ui,sans-serif}.card{max-width:560px;margin:24px;padding:32px;border:1px solid #333;border-radius:18px;background:#151517}h1{font-size:26px;margin:0 0 12px}p{color:#b8b8bd;line-height:1.6;margin:0}</style></head><body><main class="card"><h1>${title}</h1><p>${escapeHtml(rawMessage)}</p></main><script>setTimeout(()=>window.close(),1800)</script></body></html>`
		res.writeHead(success ? 200 : 400, {
			'Content-Type': 'text/html; charset=utf-8',
			'X-Content-Type-Options': 'nosniff',
			'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
		})
		res.end(html)
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
		const loopbackServer = this.useDevLoopbackCallback() ? await this.startLoopbackServer() : undefined
		const callback = this.buildRedirectUri(editorState)
		const authUrl = new URL(`${baseUrl}${GITHUB_OAUTH_CONFIG.desktopStartPath}`)
		authUrl.searchParams.set('client', 'desktop')
		authUrl.searchParams.set('redirect_uri', callback)
		authUrl.searchParams.set('code_challenge', codeChallenge)
		authUrl.searchParams.set('code_challenge_method', 'S256')

		const timeoutId = setTimeout(() => {
			this.rejectPending(new GitHubOAuthError('Sign-in timed out. Please try again.', 'timeout'))
		}, GITHUB_OAUTH_CONFIG.authTimeoutMs)

		this.pendingAuth = {
			state: editorState,
			codeVerifier,
			startedAt: Date.now(),
			timeoutId,
			loopbackServer,
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
		if (this.useDevLoopbackCallback()) {
			return false
		}
		const scheme = this.services.productService.urlProtocol ?? GITHUB_OAUTH_CONFIG.callbackScheme
		if (uri.scheme !== scheme || uri.authority !== GITHUB_OAUTH_CONFIG.callbackHost) {
			return false
		}
		if (!this.pendingAuth) {
			return false
		}

		return this.handleCallbackQuery(new URLSearchParams(uri.query))
	}

	private async exchangeAuthorizationCode(code: string, codeVerifier: string): Promise<GitHubCredentials> {
		const baseUrl = getOrbitApiBaseUrl(this.services.productService, this.services.environmentService)
		const res = await fetchWithTimeout(`${baseUrl}/api/auth/desktop/exchange`, {
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
				await fetchWithTimeout(`${baseUrl}/api/auth/api-keys/current`, {
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
		const pending = this.pendingAuth
		clearTimeout(pending.timeoutId)
		this.closeLoopbackServer(pending)
		const err = new GitHubOAuthError(message, 'cancelled')
		this.pendingAuth = null
		pending.reject(err)
		this.isPending = false
		this._onDidChangeState.fire(this.getState())
	}

	cancelAuthorizationFlow(): void {
		this.cancelPending('Sign-in was cancelled.')
	}

	private rejectPending(err: Error) {
		if (!this.pendingAuth) {
			return
		}
		const pending = this.pendingAuth
		clearTimeout(pending.timeoutId)
		this.closeLoopbackServer(pending)
		this.pendingAuth = null
		pending.reject(err)
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
