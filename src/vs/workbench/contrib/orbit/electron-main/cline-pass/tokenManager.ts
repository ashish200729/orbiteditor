/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { CLINE_PASS_OAUTH_CONFIG } from './oauthConfig.js'
import type { ClinePassCredentials, ClinePassTokenApiResponse, ClinePassTokenResponseData } from './oauthTypes.js'

const EXPIRY_BUFFER_MS = 5 * 60 * 1000
const DEFAULT_EXPIRES_IN_MS = 60 * 60 * 1000

export class ClinePassOAuthTokenError extends Error {
	readonly code: string
	readonly status?: number
	constructor(message: string, code = 'token_error', status?: number) {
		super(message)
		this.name = 'ClinePassOAuthTokenError'
		this.code = code
		this.status = status
	}

	isLikelyInvalidGrant() {
		return this.code === 'invalid_grant'
			|| this.code === 'invalid_token'
			|| this.message.toLowerCase().includes('invalid')
			|| this.message.toLowerCase().includes('expired')
			|| this.status === 400
			|| this.status === 401
	}
}

const parseJsonResponse = async (response: Response): Promise<ClinePassTokenApiResponse> => {
	try {
		return await response.json() as ClinePassTokenApiResponse
	} catch (error) {
		throw new ClinePassOAuthTokenError(`Invalid token response: ${error}`)
	}
}

const parseExpiresAtMs = (expiresAt?: string): number => {
	if (expiresAt) {
		const parsed = Date.parse(expiresAt)
		if (!Number.isNaN(parsed)) {
			return parsed
		}
	}
	return Date.now() + DEFAULT_EXPIRES_IN_MS
}

const toCredentials = (
	data: ClinePassTokenResponseData,
	existing?: Pick<ClinePassCredentials, 'refreshToken' | 'email' | 'userId' | 'displayName'>,
): ClinePassCredentials => {
	if (!data.accessToken) {
		throw new ClinePassOAuthTokenError('Missing accessToken in response')
	}
	const refreshToken = data.refreshToken ?? existing?.refreshToken
	if (!refreshToken) {
		throw new ClinePassOAuthTokenError('Missing refreshToken in response')
	}
	return {
		accessToken: data.accessToken,
		refreshToken,
		expiresAt: parseExpiresAtMs(data.expiresAt),
		email: data.userInfo?.email ?? existing?.email,
		userId: data.userInfo?.clineUserId ?? existing?.userId,
		displayName: data.userInfo?.name ?? existing?.displayName,
	}
}

const tokenUrl = (path: string) => `${CLINE_PASS_OAUTH_CONFIG.apiBaseUrl}${path}`

export const exchangeCodeForTokens = async (params: {
	code: string
	redirectUri: string
	provider?: string
}): Promise<ClinePassCredentials> => {
	const response = await fetch(tokenUrl(CLINE_PASS_OAUTH_CONFIG.tokenExchangePath), {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: JSON.stringify({
			grant_type: 'authorization_code',
			code: params.code,
			client_type: CLINE_PASS_OAUTH_CONFIG.clientType,
			redirect_uri: params.redirectUri,
			provider: params.provider || CLINE_PASS_OAUTH_CONFIG.provider,
		}),
		signal: AbortSignal.timeout(30_000),
	})

	const payload = await parseJsonResponse(response)
	if (!response.ok || !payload.data?.accessToken) {
		const errorCode = typeof payload.error === 'string' ? payload.error : 'token_exchange_failed'
		throw new ClinePassOAuthTokenError(
			payload.error_description ?? payload.error ?? 'Token exchange failed.',
			errorCode,
			response.status,
		)
	}

	return toCredentials(payload.data)
}

export const refreshAccessToken = async (
	refreshToken: string,
	existing?: Pick<ClinePassCredentials, 'email' | 'userId' | 'displayName'>,
): Promise<ClinePassCredentials> => {
	const response = await fetch(tokenUrl(CLINE_PASS_OAUTH_CONFIG.tokenRefreshPath), {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: JSON.stringify({
			grantType: 'refresh_token',
			refreshToken,
		}),
		signal: AbortSignal.timeout(30_000),
	})

	const payload = await parseJsonResponse(response)
	if (!response.ok || !payload.data?.accessToken) {
		const errorCode = typeof payload.error === 'string' ? payload.error : 'token_refresh_failed'
		const invalid = response.status === 400 || response.status === 401
		throw new ClinePassOAuthTokenError(
			payload.error_description ?? payload.error ?? 'Token refresh failed.',
			invalid ? 'invalid_grant' : errorCode,
			response.status,
		)
	}

	return toCredentials(payload.data, { refreshToken, ...existing })
}

export const isTokenExpired = (credentials: ClinePassCredentials) => {
	return Date.now() >= credentials.expiresAt - EXPIRY_BUFFER_MS
}

/** Prefix required by Cline account-auth API requests. */
export const formatClinePassBearerToken = (accessToken: string): string => {
	if (accessToken.startsWith('workos:')) {
		return accessToken
	}
	return `workos:${accessToken}`
}

export type ClinePassMappedError = {
	message: string
	clearCredentials: boolean
	retryable: boolean
	dashboardUrl?: string
}

export const mapClinePassHttpError = async (response: Response): Promise<ClinePassMappedError> => {
	const dashboardUrl = CLINE_PASS_OAUTH_CONFIG.subscriptionDashboardUrl
	let apiMessage: string | undefined
	let apiCode: string | undefined
	try {
		const json = await response.json() as {
			error?: { message?: string; code?: string } | string
			message?: string
		}
		if (typeof json.error === 'string') {
			apiMessage = json.error
		} else if (json.error && typeof json.error === 'object') {
			apiMessage = json.error.message
			apiCode = json.error.code
		} else if (typeof json.message === 'string') {
			apiMessage = json.message
		}
	} catch {
		// keep defaults
	}

	if (response.status === 401) {
		return {
			message: 'ClinePass session expired. Sign in again.',
			clearCredentials: true,
			retryable: false,
		}
	}
	if (response.status === 402) {
		return {
			message: apiMessage ?? 'No active ClinePass subscription. Subscribe at app.cline.bot to continue.',
			clearCredentials: false,
			retryable: false,
			dashboardUrl,
		}
	}
	if (response.status === 429) {
		const quotaHint = apiCode
			? `ClinePass quota reached (${apiCode}).`
			: 'ClinePass quota reached (5h / weekly / monthly).'
		return {
			message: apiMessage ?? `${quotaHint} Check your Cline dashboard for usage details.`,
			clearCredentials: false,
			retryable: false,
			dashboardUrl,
		}
	}
	if (response.status >= 500) {
		return {
			message: apiMessage ?? 'Cline API unavailable.',
			clearCredentials: false,
			retryable: true,
		}
	}
	return {
		message: apiMessage ?? `ClinePass request failed (${response.status}).`,
		clearCredentials: false,
		retryable: false,
	}
}
