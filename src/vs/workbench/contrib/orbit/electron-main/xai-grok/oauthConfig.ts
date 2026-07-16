/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export const XAI_GROK_OAUTH_CONFIG = {
	// Public desktop OAuth client shipped for Grok CLI. xAI currently requires this
	// allowlisted client and exact loopback redirect for third-party desktop flows.
	clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
	authorizationEndpoint: 'https://auth.x.ai/oauth2/authorize',
	tokenEndpoint: 'https://auth.x.ai/oauth2/token',
	deviceAuthorizationEndpoint: 'https://auth.x.ai/oauth2/device/code',
	scopes: 'openid profile email offline_access grok-cli:access api:access',
	callbackHost: '127.0.0.1',
	callbackPort: 56121,
	callbackPath: '/callback',
	authTimeoutMs: 5 * 60 * 1000,
	storageKey: 'xai-grok-oauth-credentials',
	referrer: 'orbit-editor',
	apiBaseUrl: 'https://api.x.ai/v1',
	cliApiBaseUrl: 'https://cli-chat-proxy.grok.com/v1',
	deviceCodeGrantType: 'urn:ietf:params:oauth:grant-type:device_code',
} as const

export const XAI_GROK_REDIRECT_URI = `http://${XAI_GROK_OAUTH_CONFIG.callbackHost}:${XAI_GROK_OAUTH_CONFIG.callbackPort}${XAI_GROK_OAUTH_CONFIG.callbackPath}`

export const buildXAiGrokAuthorizeUrl = (params: { codeChallenge: string; state: string; nonce: string }) => {
	const url = new URL(XAI_GROK_OAUTH_CONFIG.authorizationEndpoint)
	for (const [key, value] of Object.entries({
		response_type: 'code',
		client_id: XAI_GROK_OAUTH_CONFIG.clientId,
		redirect_uri: XAI_GROK_REDIRECT_URI,
		scope: XAI_GROK_OAUTH_CONFIG.scopes,
		code_challenge: params.codeChallenge,
		code_challenge_method: 'S256',
		state: params.state,
		nonce: params.nonce,
		plan: 'generic',
		referrer: XAI_GROK_OAUTH_CONFIG.referrer,
	})) url.searchParams.set(key, value)
	return url.toString()
}
