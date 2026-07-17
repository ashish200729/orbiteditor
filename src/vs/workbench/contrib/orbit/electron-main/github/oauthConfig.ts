/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { GITHUB_AUTH_STORAGE_KEY } from '../../common/storageKeys.js'

export const GITHUB_OAUTH_CONFIG = {
	desktopStartPath: '/api/auth/github',
	callbackScheme: 'orbit',
	callbackHost: 'auth-callback',
	// Dev builds use a loopback HTTP callback instead of orbit:// so Windows does
	// not spawn a second Electron instance when the browser finishes OAuth.
	devLoopbackHost: '127.0.0.1',
	devLoopbackPort: 4783,
	devLoopbackPath: '/auth/callback',
	authTimeoutMs: 5 * 60 * 1000,
	storageKey: GITHUB_AUTH_STORAGE_KEY,
	stateParamLength: 32,
	expirySafetyWindowMs: 60_000,
	pkceVerifierLength: 32,
} as const
