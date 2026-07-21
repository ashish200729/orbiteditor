/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert'
import {
	ClinePassOAuthTokenError,
	formatClinePassBearerToken,
	isTokenExpired,
} from '../../electron-main/cline-pass/tokenManager.js'

suite('ClinePass token manager', () => {
	test('formatClinePassBearerToken prefixes workos when missing', () => {
		assert.strictEqual(formatClinePassBearerToken('abc123'), 'workos:abc123')
	})

	test('formatClinePassBearerToken leaves existing workos prefix', () => {
		assert.strictEqual(formatClinePassBearerToken('workos:abc123'), 'workos:abc123')
	})

	test('isTokenExpired respects 5-minute refresh buffer', () => {
		const soon = Date.now() + 4 * 60_000
		const later = Date.now() + 10 * 60_000
		assert.strictEqual(isTokenExpired({ accessToken: 't', refreshToken: 'r', expiresAt: soon }), true)
		assert.strictEqual(isTokenExpired({ accessToken: 't', refreshToken: 'r', expiresAt: later }), false)
	})

	test('ClinePassOAuthTokenError.isLikelyInvalidGrant detects invalid grant', () => {
		const err = new ClinePassOAuthTokenError('Token expired', 'invalid_grant', 400)
		assert.strictEqual(err.isLikelyInvalidGrant(), true)
	})

	test('ClinePassOAuthTokenError.isLikelyInvalidGrant ignores transient 5xx', () => {
		const err = new ClinePassOAuthTokenError('Server error', 'server_error', 503)
		assert.strictEqual(err.isLikelyInvalidGrant(), false)
	})
})
