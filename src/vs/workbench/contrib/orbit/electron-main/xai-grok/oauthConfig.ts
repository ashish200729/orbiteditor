/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Loopback OAuth callback configuration for the xAI SuperGrok desktop flow.
//
// xAI's public `grok-cli` desktop OAuth client is allowlisted for an *exact*
// loopback redirect URI: `http://127.0.0.1:56121/callback`. No other host
// (`localhost`, `::1`) or port is accepted by xAI's authorization server.
//
// On Windows, binding 127.0.0.1:56121 can still fail when:
//
//   1. Windows reserves the port for Hyper-V / WSL2 / Docker Desktop
//      (`netsh int ipv4 show excludedportrange protocol=tcp`). `server.listen`
//      then throws `EACCES` (NOT `EADDRINUSE`).
//   2. Windows Defender Firewall blocks the first inbound loopback connection
//      from the browser, causing the 5-minute `authTimeoutMs` to expire.
//
// When loopback bind fails, Orbit routes Windows users to the device-code flow,
// which needs no local server at all. Do not add fallback hosts or ports here
// unless xAI has explicitly allowlisted the matching redirect URI for client
// `b1a00492-073a-47ea-816f-4c329264a828`.

export const XAI_GROK_OAUTH_CONFIG = {
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

export const buildXAiGrokAuthorizeUrl = (params: { codeChallenge: string; state: string; nonce: string; redirectUri?: string }) => {
	const url = new URL(XAI_GROK_OAUTH_CONFIG.authorizationEndpoint)
	for (const [key, value] of Object.entries({
		response_type: 'code',
		client_id: XAI_GROK_OAUTH_CONFIG.clientId,
		redirect_uri: params.redirectUri ?? XAI_GROK_REDIRECT_URI,
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
