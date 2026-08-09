/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { XAI_GROK_OAUTH_CONFIG, XAI_GROK_REDIRECT_URI } from './oauthConfig.js'
import type { XAiDeviceCodeResponse, XAiGrokCredentials, XAiTokenResponse } from './oauthTypes.js'
import { fetchWithEndpointPolicy } from '../../common/networkSecurity.js'

const EXPIRY_BUFFER_MS = 2 * 60 * 1000
const REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_DEVICE_EXPIRES_MS = 5 * 60 * 1000
const DEFAULT_DEVICE_INTERVAL_MS = 5_000
const MIN_DEVICE_INTERVAL_MS = 1_000
const DEVICE_SLOW_DOWN_MS = 5_000

export class XAiGrokOAuthTokenError extends Error {
	constructor(message: string, readonly code = 'token_error') {
		super(message)
		this.name = 'XAiGrokOAuthTokenError'
	}

	isLikelyInvalidGrant() {
		return this.code === 'invalid_grant' || this.code === 'invalid_token' || this.message.includes('invalid_grant')
	}
}

const authHeaders = () => ({
	'Content-Type': 'application/x-www-form-urlencoded',
	Accept: 'application/json',
	'User-Agent': 'orbit-editor',
})

const parsePayload = async <T>(response: Response): Promise<T> => {
	const text = await response.text()
	try {
		return (text ? JSON.parse(text) : {}) as T
	} catch {
		throw new XAiGrokOAuthTokenError(`xAI returned an invalid token response (${response.status}).`)
	}
}

const jwtClaims = (token?: string): Record<string, unknown> | null => {
	if (!token) return null
	const parts = token.split('.')
	if (parts.length < 2) return null
	try {
		return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
	} catch {
		return null
	}
}

const resolveEmail = (...tokens: Array<string | undefined>) => {
	for (const token of tokens) {
		const claims = jwtClaims(token)
		const value = claims?.email ?? claims?.preferred_username ?? claims?.upn
		if (typeof value === 'string' && value) return value
	}
	return undefined
}

const toCredentials = (payload: XAiTokenResponse, existingRefreshToken?: string): XAiGrokCredentials => {
	if (!payload.access_token) {
		throw new XAiGrokOAuthTokenError('xAI token response did not include an access token.')
	}
	const expiresIn = Number(payload.expires_in)
	return {
		accessToken: payload.access_token,
		refreshToken: payload.refresh_token || existingRefreshToken,
		expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
		email: resolveEmail(payload.id_token, payload.access_token),
		idToken: payload.id_token,
	}
}

const postToken = async (body: URLSearchParams, signal?: AbortSignal) => {
	const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
	const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
	const response = await fetchWithEndpointPolicy(XAI_GROK_OAUTH_CONFIG.tokenEndpoint, {
		method: 'POST',
		headers: authHeaders(),
		body,
		signal: combinedSignal,
	}, 'xAI token endpoint')
	const payload = await parsePayload<XAiTokenResponse>(response)
	if (!response.ok) {
		throw new XAiGrokOAuthTokenError(
			payload.error_description || `xAI token request failed (${response.status}).`,
			payload.error || 'token_request_failed',
		)
	}
	return payload
}

export const exchangeCodeForTokens = async (code: string, codeVerifier: string, redirectUri: string = XAI_GROK_REDIRECT_URI) => {
	const payload = await postToken(new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		redirect_uri: redirectUri,
		client_id: XAI_GROK_OAUTH_CONFIG.clientId,
		code_verifier: codeVerifier,
	}))
	return toCredentials(payload)
}

export const refreshAccessToken = async (refreshToken: string) => {
	const payload = await postToken(new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
		client_id: XAI_GROK_OAUTH_CONFIG.clientId,
	}))
	return toCredentials(payload, refreshToken)
}

export const requestDeviceCode = async (): Promise<Required<Pick<XAiDeviceCodeResponse, 'device_code' | 'user_code' | 'verification_uri'>> & XAiDeviceCodeResponse> => {
	const response = await fetchWithEndpointPolicy(XAI_GROK_OAUTH_CONFIG.deviceAuthorizationEndpoint, {
		method: 'POST',
		headers: authHeaders(),
		body: new URLSearchParams({ client_id: XAI_GROK_OAUTH_CONFIG.clientId, scope: XAI_GROK_OAUTH_CONFIG.scopes }),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	}, 'xAI device authorization endpoint')
	const payload = await parsePayload<XAiDeviceCodeResponse & XAiTokenResponse>(response)
	if (!response.ok) {
		throw new XAiGrokOAuthTokenError(payload.error_description || `xAI device authorization failed (${response.status}).`, payload.error)
	}
	if (!payload.device_code || !payload.user_code || !payload.verification_uri) {
		throw new XAiGrokOAuthTokenError('xAI device authorization response was incomplete.')
	}
	return payload as Required<Pick<XAiDeviceCodeResponse, 'device_code' | 'user_code' | 'verification_uri'>> & XAiDeviceCodeResponse
}

export const positiveSecondsToMs = (value: unknown, fallback: number) => {
	const seconds = Number(value)
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallback
}

export const pollDeviceCodeToken = async (device: XAiDeviceCodeResponse & Required<Pick<XAiDeviceCodeResponse, 'device_code'>>, signal: AbortSignal) => {
	const deadline = Date.now() + positiveSecondsToMs(device.expires_in, DEFAULT_DEVICE_EXPIRES_MS)
	let intervalMs = Math.max(MIN_DEVICE_INTERVAL_MS, positiveSecondsToMs(device.interval, DEFAULT_DEVICE_INTERVAL_MS))

	while (Date.now() < deadline) {
		if (signal.aborted) throw new XAiGrokOAuthTokenError('xAI device authorization was cancelled.', 'cancelled')
		const payloadPromise = postToken(new URLSearchParams({
			grant_type: XAI_GROK_OAUTH_CONFIG.deviceCodeGrantType,
			client_id: XAI_GROK_OAUTH_CONFIG.clientId,
			device_code: device.device_code,
		}), signal)
		try {
			return toCredentials(await payloadPromise)
		} catch (error) {
			if (!(error instanceof XAiGrokOAuthTokenError)) throw error
			if (error.code === 'access_denied' || error.code === 'authorization_denied') {
				throw new XAiGrokOAuthTokenError('xAI device authorization was denied.', 'access_denied')
			}
			if (error.code === 'expired_token') {
				throw new XAiGrokOAuthTokenError('xAI device code expired. Please try again.', 'expired_token')
			}
			if (error.code !== 'authorization_pending' && error.code !== 'slow_down') throw error
			if (error.code === 'slow_down') intervalMs += DEVICE_SLOW_DOWN_MS
			const remaining = deadline - Date.now()
			if (remaining <= 0) break
			await new Promise<void>((resolve, reject) => {
				const onAbort = () => {
					clearTimeout(timeout)
					reject(new XAiGrokOAuthTokenError('xAI device authorization was cancelled.', 'cancelled'))
				}
				const timeout = setTimeout(() => {
					signal.removeEventListener('abort', onAbort)
					resolve()
				}, Math.min(intervalMs, remaining))
				signal.addEventListener('abort', onAbort, { once: true })
			})
		}
	}
	throw new XAiGrokOAuthTokenError('xAI device authorization timed out.', 'timeout')
}

export const isTokenExpired = (credentials: XAiGrokCredentials) => Date.now() >= credentials.expiresAt - EXPIRY_BUFFER_MS
