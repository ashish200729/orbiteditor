/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import http from 'http'
import { URL } from 'url'
import { generateUuid } from '../../../../../base/common/uuid.js'
import { Emitter, Event } from '../../../../../base/common/event.js'
import { ILogService } from '../../../../../platform/log/common/log.js'
import { IEncryptionMainService } from '../../../../../platform/encryption/common/encryptionService.js'
import { IApplicationStorageMainService } from '../../../../../platform/storage/electron-main/storageMainService.js'
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js'
import { CLINE_PASS_OAUTH_CONFIG } from './oauthConfig.js'
import {
	exchangeCodeForTokens,
	formatClinePassBearerToken,
	isTokenExpired,
	ClinePassOAuthTokenError,
	refreshAccessToken,
} from './tokenManager.js'
import type { ClinePassCredentials, PendingAuthState } from './oauthTypes.js'
import type { ClinePassAuthState } from '../../common/clinePassAuthService.js'

export class ClinePassOAuthError extends Error {
	readonly code: string
	constructor(message: string, code = 'oauth_error') {
		super(message)
		this.name = 'ClinePassOAuthError'
		this.code = code
	}
}

export type ClinePassOAuthManagerServices = {
	storageService: IApplicationStorageMainService
	encryptionService: IEncryptionMainService
	logService: ILogService
}

export class ClinePassOAuthManager {
	private credentials: ClinePassCredentials | null = null
	private pendingAuth: PendingAuthState | null = null
	private readonly _onDidChangeState = new Emitter<ClinePassAuthState>()
	readonly onDidChangeState: Event<ClinePassAuthState> = this._onDidChangeState.event
	private readonly ready: Promise<void>
	private refreshPromise: Promise<ClinePassCredentials> | null = null

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
			const encrypted = this.storageService.get(CLINE_PASS_OAUTH_CONFIG.storageKey, StorageScope.APPLICATION, undefined)
			if (!encrypted) {
				return
			}
			const decrypted = await this.encryptionService.decrypt(encrypted)
			const parsed = JSON.parse(decrypted) as ClinePassCredentials
			if (
				parsed
				&& typeof parsed === 'object'
				&& typeof parsed.accessToken === 'string'
				&& parsed.accessToken.length > 0
				&& typeof parsed.refreshToken === 'string'
				&& parsed.refreshToken.length > 0
				&& typeof parsed.expiresAt === 'number'
				&& parsed.expiresAt > 0
			) {
				this.credentials = parsed
			} else {
				this.logService.warn('[ClinePassOAuthManager] Invalid credentials structure, clearing')
				this.credentials = null
			}
		} catch (error) {
			this.logService.warn('[ClinePassOAuthManager] Failed to load credentials', error)
			this.credentials = null
		}
		this._onDidChangeState.fire(this.getState())
	}

	getState(): ClinePassAuthState {
		return {
			isAuthenticated: !!this.credentials,
			email: this.credentials?.email,
			userId: this.credentials?.userId,
			displayName: this.credentials?.displayName,
		}
	}

	async startAuthorizationFlow(): Promise<string> {
		await this.ready
		if (this.pendingAuth) {
			this.logService.warn('[ClinePassOAuthManager] Authorization already in progress, cancelling previous flow')
			this.cancelPending('Authorization cancelled.')
		}

		const state = generateUuid()
		let callbackConsumed = false
		const server = http.createServer(async (req, res) => {
			const expectedHost = `${CLINE_PASS_OAUTH_CONFIG.callbackHost}:${CLINE_PASS_OAUTH_CONFIG.callbackPort}`
			if (req.method !== 'GET' || req.headers.host !== expectedHost) {
				res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
				res.end('Invalid callback request')
				return
			}
			const reqUrl = req.url ? new URL(req.url, `http://${CLINE_PASS_OAUTH_CONFIG.callbackHost}`) : null
			if (!reqUrl || reqUrl.pathname !== CLINE_PASS_OAUTH_CONFIG.callbackPath) {
				res.writeHead(404, { 'Content-Type': 'text/plain' })
				res.end('Not found')
				return
			}

			const returnedState = reqUrl.searchParams.get('state')
			if (!returnedState || returnedState !== state) {
				res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
				res.end('Invalid or expired OAuth state')
				return
			}
			if (callbackConsumed) {
				res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
				res.end('OAuth callback already consumed')
				return
			}
			callbackConsumed = true

			const error = reqUrl.searchParams.get('error')
			if (error) {
				const errorDescription = reqUrl.searchParams.get('error_description')
				const message = error === 'access_denied'
					? 'Authorization was cancelled.'
					: errorDescription ?? 'Authorization failed.'
				this.respondWithHtml(res, error === 'access_denied' ? 'Sign-in cancelled' : 'Sign-in failed', message)
				this.rejectPending(new ClinePassOAuthError(message, error === 'access_denied' ? 'cancelled' : error))
				return
			}

			// Long-lived refresh/id tokens must never travel in a browser URL.
			const code = reqUrl.searchParams.get('code')
			const provider = reqUrl.searchParams.get('provider') || CLINE_PASS_OAUTH_CONFIG.provider
			if (!code) {
				this.respondWithHtml(res, 'Sign-in failed', 'Authorization code missing. Please try again.')
				this.rejectPending(new ClinePassOAuthError('Authorization code missing.', 'missing_code'))
				return
			}

			try {
				const redirectUri = this.pendingAuth?.redirectUri
				if (!redirectUri) {
					throw new ClinePassOAuthError('Authorization flow not initialized.', 'flow_not_initialized')
				}
				const credentials = await exchangeCodeForTokens({ code, redirectUri, provider })
				this.respondWithHtml(res, 'Signed in', 'You can close this window.')
				await this.persistCredentials(credentials)
				this.resolvePending(credentials)
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Token exchange failed.'
				this.respondWithHtml(res, 'Sign-in failed', message)
				this.rejectPending(err instanceof Error ? err : new ClinePassOAuthError(message, 'token_exchange_failed'))
			}
		})

		try {
			await new Promise<void>((resolve, reject) => {
				server.once('error', (err) => {
					server.close()
					reject(err)
				})
				server.listen(CLINE_PASS_OAUTH_CONFIG.callbackPort, CLINE_PASS_OAUTH_CONFIG.callbackHost, () => resolve())
			})
		} catch (error) {
			const err = error as NodeJS.ErrnoException
			if (err?.code === 'EADDRINUSE') {
				throw new ClinePassOAuthError(
					`Port ${CLINE_PASS_OAUTH_CONFIG.callbackPort} is already in use. Close the other app and try again.`,
					'port_in_use',
				)
			}
			const message = err?.message ?? `${error}`
			throw new ClinePassOAuthError(`Failed to start OAuth callback server: ${message}`, 'callback_server_error')
		}

		// Embed state in callback URL so it is present when Cline redirects back (their
		// authorize flow does not always echo a separate state query param).
		const redirectUri = `http://${CLINE_PASS_OAUTH_CONFIG.callbackHost}:${CLINE_PASS_OAUTH_CONFIG.callbackPort}${CLINE_PASS_OAUTH_CONFIG.callbackPath}?state=${encodeURIComponent(state)}`

		let resolvePending: (credentials: ClinePassCredentials) => void = () => { }
		let rejectPending: (error: Error) => void = () => { }
		const timeoutId = setTimeout(() => {
			this.rejectPending(new ClinePassOAuthError('Authorization timed out.', 'timeout'))
		}, CLINE_PASS_OAUTH_CONFIG.authTimeoutMs)

		const pendingPromise = new Promise<ClinePassCredentials>((resolve, reject) => {
			resolvePending = resolve
			rejectPending = reject
		})
		pendingPromise.catch(() => { /* observed by waitForCallback */ })

		this.pendingAuth = {
			state,
			redirectUri,
			server,
			resolve: resolvePending,
			reject: rejectPending,
			promise: pendingPromise,
			timeoutId,
			startedAt: Date.now(),
		}

		try {
			// Resolve Cline authorize → WorkOS/provider redirect URL (same as Cline extension).
			return await this.resolveAuthorizeRedirectUrl(redirectUri, state)
		} catch (error) {
			this.clearPending()
			throw error
		}
	}

	private async resolveAuthorizeRedirectUrl(callbackUrl: string, state: string): Promise<string> {
		const authUrl = new URL(CLINE_PASS_OAUTH_CONFIG.authorizePath, CLINE_PASS_OAUTH_CONFIG.apiBaseUrl)
		authUrl.searchParams.set('client_type', CLINE_PASS_OAUTH_CONFIG.clientType)
		authUrl.searchParams.set('callback_url', callbackUrl)
		authUrl.searchParams.set('redirect_uri', callbackUrl)
		authUrl.searchParams.set('state', state)

		try {
			const safeRedirect = (raw: string) => {
				const target = new URL(raw, authUrl)
				if (target.protocol !== 'https:' || target.username || target.password) {
					throw new ClinePassOAuthError('Cline auth returned an unsafe authorization redirect.', 'unsafe_redirect')
				}
				return target.toString()
			}
			const response = await fetch(authUrl.toString(), {
				method: 'GET',
				redirect: 'manual',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				signal: AbortSignal.timeout(30_000),
			})

			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get('Location')
				if (location) {
					return safeRedirect(location)
				}
			}

			// Some environments return JSON { redirect_url }
			try {
				const json = await response.json() as { redirect_url?: string }
				if (json.redirect_url) {
					return safeRedirect(json.redirect_url)
				}
			} catch {
				// fall through
			}

			// Fallback: open the authorize URL itself if the API does not redirect.
			if (response.ok || (response.status >= 300 && response.status < 400)) {
				return authUrl.toString()
			}

			throw new ClinePassOAuthError(
				`Cline auth authorize failed (${response.status}).`,
				'authorize_failed',
			)
		} catch (error) {
			if (error instanceof ClinePassOAuthError) {
				throw error
			}
			const message = error instanceof Error ? error.message : `${error}`
			throw new ClinePassOAuthError(`Authentication failed: ${message}`, 'authorize_failed')
		}
	}

	async waitForCallback(): Promise<ClinePassAuthState> {
		await this.ready
		if (!this.pendingAuth) {
			throw new ClinePassOAuthError('No authorization flow in progress.', 'no_flow')
		}
		try {
			const credentials = await this.pendingAuth.promise
			return {
				isAuthenticated: true,
				email: credentials.email,
				userId: credentials.userId,
				displayName: credentials.displayName,
			}
		} finally {
			this.clearPending()
		}
	}

	async getAccessToken(): Promise<string> {
		await this.ready
		if (!this.credentials) {
			throw new ClinePassOAuthError('Sign in to ClinePass to continue.', 'not_signed_in')
		}
		if (!isTokenExpired(this.credentials)) {
			return formatClinePassBearerToken(this.credentials.accessToken)
		}
		const refreshed = await this.refreshAccessToken()
		return formatClinePassBearerToken(refreshed.accessToken)
	}

	getEmail(): string | undefined {
		return this.credentials?.email
	}

	async clearCredentials() {
		await this.ready
		this.credentials = null
		this.storageService.remove(CLINE_PASS_OAUTH_CONFIG.storageKey, StorageScope.APPLICATION)
		this._onDidChangeState.fire(this.getState())
	}

	private async refreshAccessToken(force = false): Promise<ClinePassCredentials> {
		if (this.refreshPromise && !force) {
			return this.refreshPromise
		}
		const refreshToken = this.credentials?.refreshToken
		if (!refreshToken) {
			await this.clearCredentials()
			throw new ClinePassOAuthError('Missing refresh token.', 'missing_refresh_token')
		}

		const existing = {
			email: this.credentials?.email,
			userId: this.credentials?.userId,
			displayName: this.credentials?.displayName,
		}

		const p = (async () => {
			try {
				const refreshed = await refreshAccessToken(refreshToken, existing)
				const merged: ClinePassCredentials = {
					...refreshed,
					email: refreshed.email ?? existing.email,
					userId: refreshed.userId ?? existing.userId,
					displayName: refreshed.displayName ?? existing.displayName,
				}
				await this.persistCredentials(merged)
				return merged
			} catch (error) {
				if (error instanceof ClinePassOAuthTokenError && error.isLikelyInvalidGrant()) {
					this.logService.warn('[ClinePassOAuthManager] Refresh token invalid, clearing credentials')
					await this.clearCredentials()
				}
				throw error
			}
		})()
		this.refreshPromise = p
		p.finally(() => {
			if (this.refreshPromise === p) {
				this.refreshPromise = null
			}
		}).catch(() => { })
		return p
	}

	private async persistCredentials(credentials: ClinePassCredentials) {
		this.credentials = credentials
		try {
			const serialized = JSON.stringify(credentials)
			const encrypted = await this.encryptionService.encrypt(serialized)
			this.storageService.store(
				CLINE_PASS_OAUTH_CONFIG.storageKey,
				encrypted,
				StorageScope.APPLICATION,
				StorageTarget.MACHINE,
			)
		} catch (error) {
			this.logService.warn('[ClinePassOAuthManager] Failed to persist credentials', error)
		}
		this._onDidChangeState.fire(this.getState())
	}

	private respondWithHtml(res: http.ServerResponse, titleRaw: string, messageRaw: string) {
		const isSuccess = titleRaw.toLowerCase().includes('signed in')
		const statusLabel = isSuccess ? 'Success' : 'Action needed'
		const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => (
			{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
		))
		const title = escapeHtml(titleRaw)
		const message = escapeHtml(messageRaw)
		const html = `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${title}</title>
	<style>
		:root {
			--bg: #f7f2ea;
			--ink: #191a1f;
			--muted: #5a5f6b;
			--card: rgba(255, 255, 255, 0.86);
			--accent: ${isSuccess ? '#0c7a61' : '#c4551a'};
			--accent-soft: ${isSuccess ? 'rgba(12, 122, 97, 0.15)' : 'rgba(196, 85, 26, 0.15)'};
			--stroke: rgba(15, 23, 42, 0.12);
			--shadow: 0 24px 60px rgba(15, 23, 42, 0.12);
		}
		* { box-sizing: border-box; }
		body {
			margin: 0;
			min-height: 100vh;
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 32px 20px 48px;
			font-family: "Segoe UI", system-ui, sans-serif;
			color: var(--ink);
			background: linear-gradient(135deg, #f4efe7 0%, #f7f2ea 40%, #f0f5f7 100%);
		}
		.wrap {
			width: min(620px, 100%);
			padding: 28px 28px 32px;
			background: var(--card);
			border-radius: 24px;
			border: 1px solid var(--stroke);
			box-shadow: var(--shadow);
		}
		.badge {
			display: inline-flex;
			padding: 6px 14px;
			border-radius: 999px;
			font-size: 12px;
			text-transform: uppercase;
			letter-spacing: 0.12em;
			color: var(--accent);
			background: var(--accent-soft);
		}
		h1 { font-size: 28px; margin: 16px 0 10px; }
		p { margin: 0 0 12px; color: var(--muted); font-size: 15px; line-height: 1.6; }
	</style>
</head>
<body>
	<div class="wrap">
		<div class="badge">${statusLabel}</div>
		<h1>${title}</h1>
		<p>${message}</p>
		<p>You can return to Orbit. This tab is safe to close.</p>
	</div>
	<script>setTimeout(() => window.close(), 1500);</script>
</body>
</html>`
		res.writeHead(200, {
			'Content-Type': 'text/html; charset=utf-8',
			'X-Content-Type-Options': 'nosniff',
			'Cache-Control': 'no-store',
			'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
		})
		res.end(html)
	}

	private cancelPending(message: string) {
		const pending = this.pendingAuth
		if (!pending) return
		clearTimeout(pending.timeoutId)
		this.pendingAuth = null
		if (pending.server.listening) {
			pending.server.close()
		}
		pending.reject(new ClinePassOAuthError(message, 'cancelled'))
	}

	private resolvePending(credentials: ClinePassCredentials) {
		if (!this.pendingAuth) return
		clearTimeout(this.pendingAuth.timeoutId)
		this.pendingAuth.resolve(credentials)
		if (this.pendingAuth.server.listening) {
			this.pendingAuth.server.close()
		}
		this.schedulePendingCleanup()
	}

	private rejectPending(error: Error) {
		if (!this.pendingAuth) return
		clearTimeout(this.pendingAuth.timeoutId)
		this.pendingAuth.reject(error)
		if (this.pendingAuth.server.listening) {
			this.pendingAuth.server.close()
		}
		this.schedulePendingCleanup()
	}

	private clearPending() {
		if (!this.pendingAuth) return
		clearTimeout(this.pendingAuth.timeoutId)
		if (this.pendingAuth.server.listening) {
			this.pendingAuth.server.close()
		}
		this.pendingAuth = null
	}

	private schedulePendingCleanup() {
		const pending = this.pendingAuth
		if (!pending) return
		setTimeout(() => {
			if (this.pendingAuth === pending) {
				this.pendingAuth = null
			}
		}, 30_000)
	}
}

let managerSingleton: ClinePassOAuthManager | null = null

export const initClinePassOAuthManager = (services: ClinePassOAuthManagerServices) => {
	if (!managerSingleton) {
		managerSingleton = new ClinePassOAuthManager(
			services.storageService,
			services.encryptionService,
			services.logService,
		)
	}
	return managerSingleton
}

export const getClinePassOAuthManager = () => {
	if (!managerSingleton) {
		throw new ClinePassOAuthError('ClinePass OAuth manager has not been initialized.', 'not_initialized')
	}
	return managerSingleton
}
