/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import http from 'http'
import { URL } from 'url'
import { Emitter, Event } from '../../../../../base/common/event.js'
import { ILogService } from '../../../../../platform/log/common/log.js'
import { IEncryptionMainService } from '../../../../../platform/encryption/common/encryptionService.js'
import { IApplicationStorageMainService } from '../../../../../platform/storage/electron-main/storageMainService.js'
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js'
import { OPENAI_CODEX_OAUTH_CONFIG } from './oauthConfig.js'
import { exchangeCodeForTokens, isTokenExpired, OpenAiCodexOAuthTokenError, refreshAccessToken } from './tokenManager.js'
import { generateCodeChallenge, generateCodeVerifier, generateState } from './pkce.js'
import type { OpenAiCodexCredentials, PendingAuthState } from './oauthTypes.js'
import type { OpenAiCodexAuthState } from '../../common/openAiCodexAuthService.js'

export class OpenAiCodexOAuthError extends Error {
	readonly code: string
	constructor(message: string, code = 'oauth_error') {
		super(message)
		this.name = 'OpenAiCodexOAuthError'
		this.code = code
	}
}

export type OpenAiCodexOAuthManagerServices = {
	storageService: IApplicationStorageMainService
	encryptionService: IEncryptionMainService
	logService: ILogService
}

export class OpenAiCodexOAuthManager {
	private credentials: OpenAiCodexCredentials | null = null
	private pendingAuth: PendingAuthState | null = null
	private readonly _onDidChangeState = new Emitter<OpenAiCodexAuthState>()
	readonly onDidChangeState: Event<OpenAiCodexAuthState> = this._onDidChangeState.event
	private readonly ready: Promise<void>
	private refreshPromise: Promise<OpenAiCodexCredentials> | null = null

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
			const encrypted = this.storageService.get(OPENAI_CODEX_OAUTH_CONFIG.storageKey, StorageScope.APPLICATION, undefined)
			if (!encrypted) {
				return
			}
			const decrypted = await this.encryptionService.decrypt(encrypted)
			const parsed = JSON.parse(decrypted) as OpenAiCodexCredentials
			// Validate credentials structure
			if (parsed && typeof parsed === 'object' &&
				typeof parsed.accessToken === 'string' && parsed.accessToken.length > 0 &&
				typeof parsed.expiresAt === 'number' && parsed.expiresAt > 0) {
				this.credentials = parsed
			} else {
				this.logService.warn('[OpenAiCodexOAuthManager] Invalid credentials structure, clearing')
				this.credentials = null
			}
		}
		catch (error) {
			this.logService.warn('[OpenAiCodexOAuthManager] Failed to load credentials', error)
			this.credentials = null
		}
		this._onDidChangeState.fire(this.getState())
	}

	getState(): OpenAiCodexAuthState {
		return {
			isAuthenticated: !!this.credentials,
			email: this.credentials?.email,
			accountId: this.credentials?.accountId,
		}
	}

	async startAuthorizationFlow(): Promise<string> {
		await this.ready
		if (this.pendingAuth) {
			this.logService.warn('[OpenAiCodexOAuthManager] Authorization already in progress, cancelling previous flow')
			this.cancelPending('Authorization cancelled.')
		}

		const codeVerifier = generateCodeVerifier()
		const codeChallenge = generateCodeChallenge(codeVerifier)
		const state = generateState()

		const server = http.createServer(async (req, res) => {
			const reqUrl = req.url ? new URL(req.url, `http://${OPENAI_CODEX_OAUTH_CONFIG.callbackHost}`) : null
			if (!reqUrl || reqUrl.pathname !== OPENAI_CODEX_OAUTH_CONFIG.callbackPath) {
				res.writeHead(404, { 'Content-Type': 'text/plain' })
				res.end('Not found')
				return
			}

			const error = reqUrl.searchParams.get('error')
			if (error) {
				const errorDescription = reqUrl.searchParams.get('error_description')
				const message = error === 'access_denied'
					? 'Authorization was cancelled.'
					: errorDescription ?? 'Authorization failed.'
				this.respondWithHtml(res, error === 'access_denied' ? 'Sign-in cancelled' : 'Sign-in failed', message)
				this.rejectPending(new OpenAiCodexOAuthError(message, error === 'access_denied' ? 'cancelled' : error))
				return
			}

			const returnedState = reqUrl.searchParams.get('state')
			const code = reqUrl.searchParams.get('code')
			if (!returnedState || returnedState !== state) {
				this.respondWithHtml(res, 'Sign-in failed', 'State mismatch detected. Please try again.')
				this.rejectPending(new OpenAiCodexOAuthError('State mismatch detected.', 'state_mismatch'))
				return
			}
			if (!code) {
				this.respondWithHtml(res, 'Sign-in failed', 'Authorization code missing. Please try again.')
				this.rejectPending(new OpenAiCodexOAuthError('Authorization code missing.', 'missing_code'))
				return
			}

			try {
				const redirectUri = this.pendingAuth?.redirectUri
				if (!redirectUri) {
					throw new OpenAiCodexOAuthError('Authorization flow not initialized.', 'flow_not_initialized')
				}
				const credentials = await exchangeCodeForTokens({ code, codeVerifier, redirectUri })
				this.respondWithHtml(res, 'Signed in', 'You can close this window.')
				await this.persistCredentials(credentials)
				this.resolvePending(credentials)
			}
			catch (err) {
				const message = err instanceof Error ? err.message : 'Token exchange failed.'
				this.respondWithHtml(res, 'Sign-in failed', message)
				this.rejectPending(err instanceof Error ? err : new OpenAiCodexOAuthError(message, 'token_exchange_failed'))
			}
		})

		try {
			await new Promise<void>((resolve, reject) => {
				server.once('error', (err) => {
					server.close()
					reject(err)
				})
				server.listen(OPENAI_CODEX_OAUTH_CONFIG.callbackPort, OPENAI_CODEX_OAUTH_CONFIG.callbackHost, () => resolve())
			})
		}
		catch (error) {
			const err = error as NodeJS.ErrnoException
			if (err?.code === 'EADDRINUSE') {
				throw new OpenAiCodexOAuthError(`Port ${OPENAI_CODEX_OAUTH_CONFIG.callbackPort} is already in use. Close the other app and try again.`, 'port_in_use')
			}
			const message = err?.message ?? `${error}`
			throw new OpenAiCodexOAuthError(`Failed to start OAuth callback server: ${message}`, 'callback_server_error')
		}

		const redirectUri = `http://${OPENAI_CODEX_OAUTH_CONFIG.callbackHost}:${OPENAI_CODEX_OAUTH_CONFIG.callbackPort}${OPENAI_CODEX_OAUTH_CONFIG.callbackPath}`

		const authUrl = new URL(OPENAI_CODEX_OAUTH_CONFIG.authorizationEndpoint)
		authUrl.searchParams.set('response_type', 'code')
		authUrl.searchParams.set('client_id', OPENAI_CODEX_OAUTH_CONFIG.clientId)
		authUrl.searchParams.set('redirect_uri', redirectUri)
		authUrl.searchParams.set('scope', OPENAI_CODEX_OAUTH_CONFIG.scopes)
		authUrl.searchParams.set('code_challenge', codeChallenge)
		authUrl.searchParams.set('code_challenge_method', 'S256')
		authUrl.searchParams.set('state', state)
		authUrl.searchParams.set('codex_cli_simplified_flow', OPENAI_CODEX_OAUTH_CONFIG.codexSimplifiedFlow)
		authUrl.searchParams.set('originator', OPENAI_CODEX_OAUTH_CONFIG.originatorHeader)

		let resolvePending: (credentials: OpenAiCodexCredentials) => void = () => { }
		let rejectPending: (error: Error) => void = () => { }
		const timeoutId = setTimeout(() => {
			this.rejectPending(new OpenAiCodexOAuthError('Authorization timed out.', 'timeout'))
		}, OPENAI_CODEX_OAUTH_CONFIG.authTimeoutMs)

		const pendingPromise = new Promise<OpenAiCodexCredentials>((resolve, reject) => {
			resolvePending = resolve
			rejectPending = reject
		})
		pendingPromise.catch(() => { /* observed by waitForCallback; swallow to avoid unhandled rejection if cancelled/timed out before waitForCallback runs */ })

		this.pendingAuth = {
			state,
			codeVerifier,
			codeChallenge,
			redirectUri,
			server,
			resolve: resolvePending,
			reject: rejectPending,
			promise: pendingPromise,
			timeoutId,
			startedAt: Date.now(),
		}

		return authUrl.toString()
	}

	async waitForCallback(): Promise<OpenAiCodexAuthState> {
		await this.ready
		if (!this.pendingAuth) {
			throw new OpenAiCodexOAuthError('No authorization flow in progress.', 'no_flow')
		}
		try {
			const credentials = await this.pendingAuth.promise
			return {
				isAuthenticated: true,
				email: credentials.email,
				accountId: credentials.accountId,
			}
		}
		finally {
			this.clearPending()
		}
	}

	async getAccessToken(): Promise<string> {
		await this.ready
		if (!this.credentials) {
			throw new OpenAiCodexOAuthError('Sign in to OpenAI Codex to continue.', 'not_signed_in')
		}
		if (!isTokenExpired(this.credentials)) {
			return this.credentials.accessToken
		}
		const refreshed = await this.refreshAccessToken()
		return refreshed.accessToken
	}

	async forceRefreshAccessToken(): Promise<string> {
		await this.ready
		if (!this.credentials?.refreshToken) {
			await this.clearCredentials()
			throw new OpenAiCodexOAuthError('Missing refresh token. Please sign in again.', 'missing_refresh_token')
		}
		try {
			const refreshed = await this.refreshAccessToken(true)
			return refreshed.accessToken
		} catch (error) {
			// If refresh fails, clear credentials and rethrow
			if (error instanceof OpenAiCodexOAuthTokenError && error.isLikelyInvalidGrant()) {
				await this.clearCredentials()
			}
			throw error
		}
	}

	getAccountId(): string | undefined {
		return this.credentials?.accountId
	}

	getEmail(): string | undefined {
		return this.credentials?.email
	}

	async clearCredentials() {
		await this.ready
		this.credentials = null
		this.storageService.remove(OPENAI_CODEX_OAUTH_CONFIG.storageKey, StorageScope.APPLICATION)
		this._onDidChangeState.fire(this.getState())
	}

	private async refreshAccessToken(force = false): Promise<OpenAiCodexCredentials> {
		if (this.refreshPromise && !force) {
			return this.refreshPromise
		}
		const refreshToken = this.credentials?.refreshToken
		if (!refreshToken) {
			await this.clearCredentials()
			throw new OpenAiCodexOAuthError('Missing refresh token.', 'missing_refresh_token')
		}

		const p = (async () => {
			try {
				const refreshed = await refreshAccessToken(refreshToken)
				const merged = {
					...refreshed,
					email: refreshed.email ?? this.credentials?.email,
					accountId: refreshed.accountId ?? this.credentials?.accountId,
					idToken: refreshed.idToken ?? this.credentials?.idToken,
				}
				await this.persistCredentials(merged)
				return merged
			}
			catch (error) {
				if (error instanceof OpenAiCodexOAuthTokenError && error.isLikelyInvalidGrant()) {
					this.logService.warn('[OpenAiCodexOAuthManager] Refresh token invalid, clearing credentials')
					await this.clearCredentials()
				}
				throw error
			}
		})()
		this.refreshPromise = p
		// Only clear the shared in-flight promise if it is still THIS refresh — a forced refresh
		// (force=true) may have replaced it, and we must not null out the newer one. The extra
		// .catch keeps this cleanup chain from surfacing as an unhandled rejection; the original
		// `p` returned to callers still rejects as before.
		p.finally(() => {
			if (this.refreshPromise === p) {
				this.refreshPromise = null
			}
		}).catch(() => { })
		return p
	}

	private async persistCredentials(credentials: OpenAiCodexCredentials) {
		this.credentials = credentials
		try {
			const serialized = JSON.stringify(credentials)
			const encrypted = await this.encryptionService.encrypt(serialized)
			this.storageService.store(
				OPENAI_CODEX_OAUTH_CONFIG.storageKey,
				encrypted,
				StorageScope.APPLICATION,
				// MACHINE, not USER: OAuth tokens are machine-local secrets and must never be flagged
				// for Settings Sync roaming (the GitHub flow already uses MACHINE).
				StorageTarget.MACHINE,
			)
		}
		catch (error) {
			this.logService.warn('[OpenAiCodexOAuthManager] Failed to persist credentials', error)
		}
		if (!credentials.accountId) {
			this.logService.warn('[OpenAiCodexOAuthManager] Missing ChatGPT account id in credentials; Codex may fail for workspace-scoped access.')
		}
		this._onDidChangeState.fire(this.getState())
	}

	private respondWithHtml(res: http.ServerResponse, titleRaw: string, messageRaw: string) {
		const isSuccess = titleRaw.toLowerCase().includes('signed in')
		const statusLabel = isSuccess ? 'Success' : 'Action needed'
		// `message` can carry the OAuth `error_description` (attacker-controllable via a crafted
		// loopback request during the pending window). Escape all interpolated values so it can't
		// inject markup/script into the loopback-origin page.
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
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Space+Grotesk:wght@400;600&display=swap" rel="stylesheet">
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
			font-family: "Space Grotesk", "Segoe UI", sans-serif;
			color: var(--ink);
			background:
				radial-gradient(1200px 700px at 10% 15%, rgba(12, 122, 97, 0.08), transparent 60%),
				radial-gradient(900px 600px at 90% 20%, rgba(196, 85, 26, 0.08), transparent 55%),
				linear-gradient(135deg, #f4efe7 0%, #f7f2ea 40%, #f0f5f7 100%);
		}

		.wrap {
			width: min(620px, 100%);
			padding: 28px 28px 32px;
			background: var(--card);
			border-radius: 24px;
			border: 1px solid var(--stroke);
			box-shadow: var(--shadow);
			position: relative;
			overflow: hidden;
		}

		.wrap::before,
		.wrap::after {
			content: "";
			position: absolute;
			border-radius: 999px;
			filter: blur(0);
			opacity: 0.3;
		}

		.wrap::before {
			width: 220px;
			height: 220px;
			top: -110px;
			right: -70px;
			background: var(--accent-soft);
		}

		.wrap::after {
			width: 160px;
			height: 160px;
			bottom: -90px;
			left: -50px;
			background: rgba(25, 26, 31, 0.08);
		}

		.badge {
			display: inline-flex;
			align-items: center;
			gap: 10px;
			padding: 6px 14px;
			border-radius: 999px;
			font-size: 12px;
			text-transform: uppercase;
			letter-spacing: 0.12em;
			color: var(--accent);
			background: var(--accent-soft);
			border: 1px solid rgba(0, 0, 0, 0.05);
		}

		h1 {
			font-family: "Fraunces", "Times New Roman", serif;
			font-size: clamp(26px, 4vw, 34px);
			margin: 16px 0 10px;
		}

		p {
			margin: 0 0 12px;
			color: var(--muted);
			font-size: 15px;
			line-height: 1.6;
		}

		.meta {
			margin-top: 18px;
			padding-top: 14px;
			border-top: 1px dashed rgba(0, 0, 0, 0.1);
			font-size: 13px;
			color: var(--muted);
		}
	</style>
</head>
<body>
	<div class="wrap">
		<div class="badge">${statusLabel}</div>
		<h1>${title}</h1>
		<p>${message}</p>
		<p class="meta">You can return to Orbit. This tab is safe to close.</p>
	</div>
	<script>
		setTimeout(() => window.close(), 1500);
	</script>
</body>
</html>`
		res.writeHead(200, {
			'Content-Type': 'text/html; charset=utf-8',
			'X-Content-Type-Options': 'nosniff',
			'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'",
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
		pending.reject(new OpenAiCodexOAuthError(message, 'cancelled'))
	}

	private resolvePending(credentials: OpenAiCodexCredentials) {
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

let managerSingleton: OpenAiCodexOAuthManager | null = null

export const initOpenAiCodexOAuthManager = (services: OpenAiCodexOAuthManagerServices) => {
	if (!managerSingleton) {
		managerSingleton = new OpenAiCodexOAuthManager(
			services.storageService,
			services.encryptionService,
			services.logService,
		)
	}
	return managerSingleton
}

export const getOpenAiCodexOAuthManager = () => {
	if (!managerSingleton) {
		throw new OpenAiCodexOAuthError('OpenAI Codex OAuth manager has not been initialized.', 'not_initialized')
	}
	return managerSingleton
}
