/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { OPENAI_CODEX_OAUTH_CONFIG } from './oauthConfig.js'
import type { IdTokenClaims, OAuthTokenResponse, OpenAiCodexCredentials } from './oauthTypes.js'
import { fetchWithEndpointPolicy } from '../../common/networkSecurity.js'

const EXPIRY_BUFFER_MS = 5 * 60 * 1000

export class OpenAiCodexOAuthTokenError extends Error {
	readonly code: string
	constructor(message: string, code = 'token_error') {
		super(message)
		this.name = 'OpenAiCodexOAuthTokenError'
		this.code = code
	}

	isLikelyInvalidGrant() {
		return this.code === 'invalid_grant' || this.message.includes('invalid_grant')
	}
}

const parseJsonResponse = async (response: Response) => {
	try {
		return await response.json()
	}
	catch (error) {
		throw new OpenAiCodexOAuthTokenError(`Invalid token response: ${error}`)
	}
}

const parseJwtClaims = (token: string | undefined): IdTokenClaims | null => {
	if (!token) return null
	const parts = token.split('.')
	if (parts.length < 2) return null
	try {
		const payload = Buffer.from(parts[1], 'base64url').toString('utf8')
		return JSON.parse(payload)
	}
	catch {
		return null
	}
}

const resolveAccountId = (claims: IdTokenClaims | null): string | undefined => {
	if (!claims) return undefined
	const direct = claims.chatgpt_account_id ?? claims.account_id ?? claims.org_id
	if (typeof direct === 'string') return direct
	const auth = claims['https://api.openai.com/auth']
	if (typeof auth === 'object' && auth !== null) {
		const authAccount = (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id
		if (typeof authAccount === 'string') return authAccount
	}
	const openAiAccount = claims['https://api.openai.com/account_id']
	if (typeof openAiAccount === 'string') return openAiAccount
	const openAiAccountAlt = claims['https://openai.com/account_id']
	if (typeof openAiAccountAlt === 'string') return openAiAccountAlt
	return undefined
}

const resolveEmail = (claims: IdTokenClaims | null): string | undefined => {
	if (!claims) return undefined
	const email = claims.email ?? claims.preferred_username ?? claims.upn
	return typeof email === 'string' ? email : undefined
}

const toCredentials = (response: OAuthTokenResponse, existingRefreshToken?: string): OpenAiCodexCredentials => {
	if (!response.access_token) {
		throw new OpenAiCodexOAuthTokenError('Missing access_token in response')
	}
	const expiresIn = response.expires_in ?? 3600
	const idTokenClaims = parseJwtClaims(response.id_token)
	const accessTokenClaims = parseJwtClaims(response.access_token)
	const accountId = resolveAccountId(idTokenClaims) ?? resolveAccountId(accessTokenClaims)
	const email = resolveEmail(idTokenClaims) ?? resolveEmail(accessTokenClaims)
	return {
		accessToken: response.access_token,
		refreshToken: response.refresh_token ?? existingRefreshToken,
		expiresAt: Date.now() + expiresIn * 1000,
		email,
		accountId,
		idToken: response.id_token,
	}
}

export const exchangeCodeForTokens = async (params: { code: string; codeVerifier: string; redirectUri: string }): Promise<OpenAiCodexCredentials> => {
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		client_id: OPENAI_CODEX_OAUTH_CONFIG.clientId,
		code: params.code,
		code_verifier: params.codeVerifier,
		redirect_uri: params.redirectUri,
	})

	const response = await fetchWithEndpointPolicy(OPENAI_CODEX_OAUTH_CONFIG.tokenEndpoint, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body,
		signal: AbortSignal.timeout(30000), // 30 second timeout
	}, 'OpenAI Codex token endpoint')

	const payload = await parseJsonResponse(response)
	if (!response.ok) {
		const errorCode = typeof payload?.error === 'string' ? payload.error : 'token_exchange_failed'
		throw new OpenAiCodexOAuthTokenError(payload?.error_description ?? 'Token exchange failed.', errorCode)
	}

	return toCredentials(payload as OAuthTokenResponse)
}

export const refreshAccessToken = async (refreshToken: string): Promise<OpenAiCodexCredentials> => {
	const body = new URLSearchParams({
		grant_type: 'refresh_token',
		client_id: OPENAI_CODEX_OAUTH_CONFIG.clientId,
		refresh_token: refreshToken,
	})

	const response = await fetchWithEndpointPolicy(OPENAI_CODEX_OAUTH_CONFIG.tokenEndpoint, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body,
		signal: AbortSignal.timeout(30000), // 30 second timeout
	}, 'OpenAI Codex token endpoint')

	const payload = await parseJsonResponse(response)
	if (!response.ok) {
		const errorCode = typeof payload?.error === 'string' ? payload.error : 'token_refresh_failed'
		throw new OpenAiCodexOAuthTokenError(payload?.error_description ?? 'Token refresh failed.', errorCode)
	}

	// Use new refresh_token if provided, otherwise keep the existing one
	return toCredentials(payload as OAuthTokenResponse, payload.refresh_token ?? refreshToken)
}

export const isTokenExpired = (credentials: OpenAiCodexCredentials) => {
	return Date.now() >= credentials.expiresAt - EXPIRY_BUFFER_MS
}
