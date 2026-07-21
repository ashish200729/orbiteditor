/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export const CLINE_PASS_OAUTH_CONFIG = {
	apiBaseUrl: 'https://api.cline.bot',
	appBaseUrl: 'https://app.cline.bot',
	authorizePath: '/api/v1/auth/authorize',
	tokenExchangePath: '/api/v1/auth/token',
	tokenRefreshPath: '/api/v1/auth/refresh',
	modelsPath: '/api/v1/ai/cline/models',
	recommendedModelsPath: '/api/v1/ai/cline/recommended-models',
	chatCompletionsPath: '/api/v1/chat/completions',
	userInfoPath: '/api/v1/users/me',
	clientType: 'extension',
	provider: 'cline-pass',
	callbackHost: '127.0.0.1',
	callbackPort: 1488,
	callbackPath: '/auth',
	authTimeoutMs: 5 * 60 * 1000,
	storageKey: 'cline-pass-oauth-credentials',
	subscriptionDashboardUrl: 'https://app.cline.bot/dashboard/subscription?personal=true',
	httpReferer: 'https://github.com/ashish200729/orbiteditor',
	xTitle: 'Orbit',
} as const
