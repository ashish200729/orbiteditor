/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import http from 'http'
import { URL } from 'url'
import { Emitter, Event } from '../../../../../base/common/event.js'
import { IEncryptionMainService } from '../../../../../platform/encryption/common/encryptionService.js'
import { ILogService } from '../../../../../platform/log/common/log.js'
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js'
import { IApplicationStorageMainService } from '../../../../../platform/storage/electron-main/storageMainService.js'
import type { XAiDeviceAuthorization, XAiGrokAuthState } from '../../common/xAiGrokAuthService.js'
import { generateCodeChallenge, generateCodeVerifier, generateState } from '../openai-codex/pkce.js'
import { buildXAiGrokAuthorizeUrl, XAI_GROK_OAUTH_CONFIG, XAI_GROK_REDIRECT_URI } from './oauthConfig.js'
import type { PendingBrowserAuth, PendingDeviceAuth, XAiGrokCredentials } from './oauthTypes.js'
import { exchangeCodeForTokens, isTokenExpired, pollDeviceCodeToken, refreshAccessToken, requestDeviceCode, XAiGrokOAuthTokenError } from './tokenManager.js'

const CORS_ALLOWED_ORIGINS = new Set(['https://accounts.x.ai', 'https://auth.x.ai'])

export class XAiGrokOAuthError extends Error {
	constructor(message: string, readonly code = 'oauth_error') {
		super(message)
		this.name = 'XAiGrokOAuthError'
	}
}

export type XAiGrokOAuthManagerServices = {
	storageService: IApplicationStorageMainService
	encryptionService: IEncryptionMainService
	logService: ILogService
}

export class XAiGrokOAuthManager {
	private credentials: XAiGrokCredentials | null = null
	private pendingBrowser: PendingBrowserAuth | null = null
	private pendingDevice: PendingDeviceAuth | null = null
	private refreshPromise: Promise<XAiGrokCredentials> | null = null
	private readonly ready: Promise<void>
	private readonly _onDidChangeState = new Emitter<XAiGrokAuthState>()
	readonly onDidChangeState: Event<XAiGrokAuthState> = this._onDidChangeState.event

	constructor(
		private readonly storageService: IApplicationStorageMainService,
		private readonly encryptionService: IEncryptionMainService,
		private readonly logService: ILogService,
	) {
		this.ready = this.loadCredentials()
	}

	private async loadCredentials() {
		try {
			await this.storageService.whenReady
			const encrypted = this.storageService.get(XAI_GROK_OAUTH_CONFIG.storageKey, StorageScope.APPLICATION, undefined)
			if (!encrypted) return
			const parsed = JSON.parse(await this.encryptionService.decrypt(encrypted)) as XAiGrokCredentials
			if (parsed && typeof parsed.accessToken === 'string' && parsed.accessToken.length > 0 && Number.isFinite(parsed.expiresAt)) {
				this.credentials = parsed
			} else {
				this.logService.warn('[XAiGrokOAuthManager] Invalid stored credentials; clearing them')
				this.storageService.remove(XAI_GROK_OAUTH_CONFIG.storageKey, StorageScope.APPLICATION)
			}
		} catch (error) {
			this.logService.warn('[XAiGrokOAuthManager] Failed to load credentials', error)
			this.credentials = null
		}
		this.fireState()
	}

	getState(): XAiGrokAuthState {
		return {
			isAuthenticated: !!this.credentials,
			isAuthorizing: !!this.pendingBrowser || !!this.pendingDevice,
			email: this.credentials?.email,
		}
	}

	private fireState() {
		this._onDidChangeState.fire(this.getState())
	}

	async startAuthorizationFlow(): Promise<string> {
		await this.ready
		this.cancelPending('Superseded by a newer xAI sign-in attempt.')

		const codeVerifier = generateCodeVerifier()
		const state = generateState()
		const nonce = generateState()
		const codeChallenge = generateCodeChallenge(codeVerifier)
		const server = http.createServer((req, res) => void this.handleBrowserCallback(req, res))

		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error) => reject(error)
				server.once('error', onError)
				server.listen(XAI_GROK_OAUTH_CONFIG.callbackPort, XAI_GROK_OAUTH_CONFIG.callbackHost, () => {
					server.removeListener('error', onError)
					server.on('error', error => this.logService.warn('[XAiGrokOAuthManager] OAuth callback server error', error))
					resolve()
				})
			})
		} catch (error) {
			server.close()
			const err = error as NodeJS.ErrnoException
			if (err.code === 'EADDRINUSE') {
				throw new XAiGrokOAuthError(`Port ${XAI_GROK_OAUTH_CONFIG.callbackPort} is already in use. Use device-code sign-in or close the other app and try again.`, 'port_in_use')
			}
			throw new XAiGrokOAuthError(`Failed to start the xAI sign-in callback: ${err.message || String(error)}`, 'callback_server_error')
		}

		let resolvePending: (credentials: XAiGrokCredentials) => void = () => { }
		let rejectPending: (error: Error) => void = () => { }
		const promise = new Promise<XAiGrokCredentials>((resolve, reject) => {
			resolvePending = resolve
			rejectPending = reject
		})
		promise.catch(() => { /* observed by waitForCallback */ })
		const timeoutId = setTimeout(() => this.rejectBrowser(new XAiGrokOAuthError('xAI sign-in timed out.', 'timeout')), XAI_GROK_OAUTH_CONFIG.authTimeoutMs)
		this.pendingBrowser = { state, codeVerifier, redirectUri: XAI_GROK_REDIRECT_URI, server, resolve: resolvePending, reject: rejectPending, promise, timeoutId }
		this.fireState()

		return buildXAiGrokAuthorizeUrl({ codeChallenge, state, nonce })
	}

	private async handleBrowserCallback(req: http.IncomingMessage, res: http.ServerResponse) {
		const origin = typeof req.headers.origin === 'string' && CORS_ALLOWED_ORIGINS.has(req.headers.origin) ? req.headers.origin : undefined
		if (origin) {
			res.setHeader('Access-Control-Allow-Origin', origin)
			res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
			res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
			res.setHeader('Access-Control-Allow-Private-Network', 'true')
			res.setHeader('Vary', 'Origin')
		}
		if (req.method === 'OPTIONS') {
			res.writeHead(204)
			res.end()
			return
		}
		if (req.method !== 'GET') {
			res.writeHead(405, { Allow: 'GET' })
			res.end('Method not allowed')
			return
		}
		const url = new URL(req.url || '/', XAI_GROK_REDIRECT_URI)
		if (url.pathname !== XAI_GROK_OAUTH_CONFIG.callbackPath) {
			res.writeHead(404, { 'Content-Type': 'text/plain' })
			res.end('Not found')
			return
		}
		const pending = this.pendingBrowser
		if (!pending) {
			this.respondWithHtml(res, false, 'No xAI sign-in is currently in progress.')
			return
		}
		const error = url.searchParams.get('error')
		if (error) {
			const description = url.searchParams.get('error_description')
			const message = error === 'access_denied' ? 'xAI sign-in was cancelled.' : (description || 'xAI sign-in failed.')
			this.respondWithHtml(res, false, message)
			this.rejectBrowser(new XAiGrokOAuthError(message, error))
			return
		}
		if (url.searchParams.get('state') !== pending.state) {
			this.respondWithHtml(res, false, 'State verification failed. Please try again.')
			this.rejectBrowser(new XAiGrokOAuthError('xAI sign-in state mismatch.', 'state_mismatch'))
			return
		}
		const code = url.searchParams.get('code')
		if (!code) {
			this.respondWithHtml(res, false, 'The authorization code was missing. Please try again.')
			this.rejectBrowser(new XAiGrokOAuthError('xAI authorization code was missing.', 'missing_code'))
			return
		}

		try {
			const credentials = await exchangeCodeForTokens(code, pending.codeVerifier)
			await this.persistCredentials(credentials)
			this.respondWithHtml(res, true, 'Your SuperGrok subscription is connected to Orbit. You can close this tab.')
			this.resolveBrowser(credentials)
		} catch (error) {
			const message = error instanceof Error ? error.message : 'xAI token exchange failed.'
			this.respondWithHtml(res, false, message)
			this.rejectBrowser(error instanceof Error ? error : new XAiGrokOAuthError(message))
		}
	}

	async waitForCallback() {
		await this.ready
		if (!this.pendingBrowser) throw new XAiGrokOAuthError('No xAI browser sign-in is in progress.', 'no_flow')
		try {
			await this.pendingBrowser.promise
			return this.getState()
		} finally {
			this.clearBrowser()
		}
	}

	async startDeviceAuthorizationFlow(): Promise<XAiDeviceAuthorization> {
		await this.ready
		this.cancelPending('Superseded by a newer xAI sign-in attempt.')
		const device = await requestDeviceCode()
		const abortController = new AbortController()
		let resolvePending: (credentials: XAiGrokCredentials) => void = () => { }
		let rejectPending: (error: Error) => void = () => { }
		const promise = new Promise<XAiGrokCredentials>((resolve, reject) => {
			resolvePending = resolve
			rejectPending = reject
		})
		promise.catch(() => { /* observed by waitForDeviceAuthorization */ })
		this.pendingDevice = { resolve: resolvePending, reject: rejectPending, promise, abortController }
		this.fireState()
		void pollDeviceCodeToken(device, abortController.signal).then(async credentials => {
			await this.persistCredentials(credentials)
			if (this.pendingDevice?.promise === promise) this.pendingDevice.resolve(credentials)
		}).catch(error => {
			if (this.pendingDevice?.promise === promise) this.pendingDevice.reject(error instanceof Error ? error : new Error(String(error)))
		}).finally(() => this.fireState())
		return {
			verificationUri: device.verification_uri,
			verificationUriComplete: device.verification_uri_complete,
			userCode: device.user_code,
		}
	}

	async waitForDeviceAuthorization() {
		await this.ready
		if (!this.pendingDevice) throw new XAiGrokOAuthError('No xAI device sign-in is in progress.', 'no_flow')
		const pending = this.pendingDevice
		try {
			await pending.promise
			return this.getState()
		} finally {
			if (this.pendingDevice === pending) this.pendingDevice = null
			this.fireState()
		}
	}

	async getAccessToken() {
		await this.ready
		if (!this.credentials) throw new XAiGrokOAuthError('Sign in with your SuperGrok subscription to continue.', 'not_signed_in')
		if (!isTokenExpired(this.credentials)) return this.credentials.accessToken
		return (await this.refreshCredentials()).accessToken
	}

	async forceRefreshAccessToken() {
		await this.ready
		return (await this.refreshCredentials()).accessToken
	}

	private async refreshCredentials() {
		if (this.refreshPromise) return this.refreshPromise
		const refreshToken = this.credentials?.refreshToken
		if (!refreshToken) {
			await this.clearCredentials()
			throw new XAiGrokOAuthError('Your xAI session cannot be refreshed. Sign in again.', 'missing_refresh_token')
		}
		const promise = refreshAccessToken(refreshToken).then(async refreshed => {
			const merged = { ...refreshed, email: refreshed.email || this.credentials?.email, idToken: refreshed.idToken || this.credentials?.idToken }
			await this.persistCredentials(merged)
			return merged
		}).catch(async error => {
			if (error instanceof XAiGrokOAuthTokenError && error.isLikelyInvalidGrant()) await this.clearCredentials()
			throw error
		})
		this.refreshPromise = promise
		promise.finally(() => {
			if (this.refreshPromise === promise) this.refreshPromise = null
		}).catch(() => { })
		return promise
	}

	async clearCredentials() {
		await this.ready
		this.cancelPending('xAI sign-in was cancelled.')
		this.credentials = null
		this.storageService.remove(XAI_GROK_OAUTH_CONFIG.storageKey, StorageScope.APPLICATION)
		this.fireState()
	}

	private async persistCredentials(credentials: XAiGrokCredentials) {
		this.credentials = credentials
		try {
			const encrypted = await this.encryptionService.encrypt(JSON.stringify(credentials))
			this.storageService.store(XAI_GROK_OAUTH_CONFIG.storageKey, encrypted, StorageScope.APPLICATION, StorageTarget.MACHINE)
		} catch (error) {
			this.logService.warn('[XAiGrokOAuthManager] Failed to persist credentials', error)
		}
		this.fireState()
	}

	private cancelPending(message: string) {
		if (this.pendingBrowser) this.rejectBrowser(new XAiGrokOAuthError(message, 'cancelled'))
		if (this.pendingDevice) {
			const pending = this.pendingDevice
			this.pendingDevice = null
			pending.abortController.abort()
			pending.reject(new XAiGrokOAuthError(message, 'cancelled'))
		}
		this.fireState()
	}

	private resolveBrowser(credentials: XAiGrokCredentials) {
		const pending = this.pendingBrowser
		if (!pending) return
		clearTimeout(pending.timeoutId)
		if (pending.server.listening) pending.server.close()
		pending.resolve(credentials)
	}

	private rejectBrowser(error: Error) {
		const pending = this.pendingBrowser
		if (!pending) return
		clearTimeout(pending.timeoutId)
		if (pending.server.listening) pending.server.close()
		this.pendingBrowser = null
		pending.reject(error)
		this.fireState()
	}

	private clearBrowser() {
		const pending = this.pendingBrowser
		if (!pending) return
		clearTimeout(pending.timeoutId)
		if (pending.server.listening) pending.server.close()
		this.pendingBrowser = null
		this.fireState()
	}

	private respondWithHtml(res: http.ServerResponse, success: boolean, rawMessage: string) {
		const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
		const title = success ? 'SuperGrok connected' : 'SuperGrok sign-in failed'
		const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0c;color:#f5f5f5;font:16px system-ui,sans-serif}.card{max-width:560px;margin:24px;padding:32px;border:1px solid #333;border-radius:18px;background:#151517}h1{font-size:26px;margin:0 0 12px}p{color:#b8b8bd;line-height:1.6;margin:0}</style></head><body><main class="card"><h1>${title}</h1><p>${escapeHtml(rawMessage)}</p></main><script>setTimeout(()=>window.close(),1800)</script></body></html>`
		res.writeHead(success ? 200 : 400, {
			'Content-Type': 'text/html; charset=utf-8',
			'X-Content-Type-Options': 'nosniff',
			'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
		})
		res.end(html)
	}
}

let managerSingleton: XAiGrokOAuthManager | null = null

export const initXAiGrokOAuthManager = (services: XAiGrokOAuthManagerServices) => {
	if (!managerSingleton) managerSingleton = new XAiGrokOAuthManager(services.storageService, services.encryptionService, services.logService)
	return managerSingleton
}

export const getXAiGrokOAuthManager = () => {
	if (!managerSingleton) throw new XAiGrokOAuthError('xAI OAuth manager has not been initialized.', 'not_initialized')
	return managerSingleton
}
