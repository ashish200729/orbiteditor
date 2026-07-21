/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert'
import { CLINE_PASS_OAUTH_CONFIG } from '../../electron-main/cline-pass/oauthConfig.js'
import { mapClinePassHttpError } from '../../electron-main/cline-pass/tokenManager.js'

const mockResponse = (status: number, body?: unknown): Response => {
	return new Response(body !== undefined ? JSON.stringify(body) : null, {
		status,
		headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
	})
}

suite('ClinePass HTTP error mapping', () => {
	test('401 clears credentials and is not retryable', async () => {
		const mapped = await mapClinePassHttpError(mockResponse(401))
		assert.strictEqual(mapped.clearCredentials, true)
		assert.strictEqual(mapped.retryable, false)
		assert.ok(mapped.message.includes('Sign in'))
	})

	test('402 maps subscription errors with dashboard link', async () => {
		const mapped = await mapClinePassHttpError(mockResponse(402, {
			error: { message: 'ClinePass subscription required.', code: 'no_subscription' },
		}))
		assert.strictEqual(mapped.clearCredentials, false)
		assert.strictEqual(mapped.retryable, false)
		assert.strictEqual(mapped.message, 'ClinePass subscription required.')
		assert.strictEqual(mapped.dashboardUrl, CLINE_PASS_OAUTH_CONFIG.subscriptionDashboardUrl)
	})

	test('429 maps quota errors with dashboard link', async () => {
		const mapped = await mapClinePassHttpError(mockResponse(429, {
			error: { message: 'Weekly quota exceeded.', code: 'usage_limit_exceeded' },
		}))
		assert.strictEqual(mapped.clearCredentials, false)
		assert.strictEqual(mapped.retryable, false)
		assert.strictEqual(mapped.message, 'Weekly quota exceeded.')
		assert.strictEqual(mapped.dashboardUrl, CLINE_PASS_OAUTH_CONFIG.subscriptionDashboardUrl)
	})

	test('429 without API message includes quota hint', async () => {
		const mapped = await mapClinePassHttpError(mockResponse(429))
		assert.ok(mapped.message.includes('quota'))
		assert.strictEqual(mapped.dashboardUrl, CLINE_PASS_OAUTH_CONFIG.subscriptionDashboardUrl)
	})

	test('5xx is retryable', async () => {
		const mapped = await mapClinePassHttpError(mockResponse(503, {
			error: { message: 'Service temporarily unavailable.' },
		}))
		assert.strictEqual(mapped.retryable, true)
		assert.strictEqual(mapped.clearCredentials, false)
		assert.strictEqual(mapped.message, 'Service temporarily unavailable.')
	})

	test('other errors use API message when present', async () => {
		const mapped = await mapClinePassHttpError(mockResponse(400, {
			error: { message: 'Invalid model.' },
		}))
		assert.strictEqual(mapped.message, 'Invalid model.')
		assert.strictEqual(mapped.retryable, false)
	})
})
