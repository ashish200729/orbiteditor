/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert'
import { defaultModelsOfProvider, getModelCapabilities } from '../../common/modelCapabilities.js'
import { getXAiGrokOAuthErrorCode } from '../../common/xAiGrokAuthErrors.js'
import { buildXAiGrokAuthorizeUrl, XAI_GROK_OAUTH_CONFIG, XAI_GROK_REDIRECT_URI } from '../../electron-main/xai-grok/oauthConfig.js'
import { XAiGrokOAuthError } from '../../electron-main/xai-grok/oauthManager.js'
import { parseXAiGrokMonthlyUsage, parseXAiGrokWeeklyUsage } from '../../electron-main/xai-grok/billing.js'
import { isTokenExpired, positiveSecondsToMs } from '../../electron-main/xai-grok/tokenManager.js'

suite('xAI SuperGrok OAuth', () => {
	test('exposes only the supported Composer 2.5 and Grok 4.5 subscription models', () => {
		assert.deepStrictEqual(defaultModelsOfProvider.xAISuperGrok, [
			'grok-composer-2.5-fast',
			'grok-4.5',
		])

		const composer = getModelCapabilities('xAISuperGrok', 'grok-composer-2.5-fast', undefined)
		assert.strictEqual(composer.contextWindow, 200_000)
		assert.strictEqual(composer.reasoningCapabilities, false)

		const grok = getModelCapabilities('xAISuperGrok', 'grok-4.5', undefined)
		assert.strictEqual(grok.contextWindow, 500_000)
		assert.notStrictEqual(grok.reasoningCapabilities, false)
		assert.strictEqual(grok.reasoningCapabilities && grok.reasoningCapabilities.reasoningSlider?.default, 'high')
	})

	test('builds the allowlisted PKCE authorization URL with CSRF and OIDC parameters', () => {
		const url = new URL(buildXAiGrokAuthorizeUrl({ codeChallenge: 'challenge', state: 'state', nonce: 'nonce' }))
		assert.strictEqual(`${url.origin}${url.pathname}`, XAI_GROK_OAUTH_CONFIG.authorizationEndpoint)
		assert.strictEqual(url.searchParams.get('client_id'), XAI_GROK_OAUTH_CONFIG.clientId)
		assert.strictEqual(url.searchParams.get('redirect_uri'), XAI_GROK_REDIRECT_URI)
		assert.strictEqual(url.searchParams.get('scope'), XAI_GROK_OAUTH_CONFIG.scopes)
		assert.strictEqual(url.searchParams.get('code_challenge'), 'challenge')
		assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256')
		assert.strictEqual(url.searchParams.get('state'), 'state')
		assert.strictEqual(url.searchParams.get('nonce'), 'nonce')
		assert.strictEqual(url.searchParams.get('plan'), 'generic')
		assert.strictEqual(url.searchParams.get('referrer'), 'orbit-editor')
	})

	test('uses only the allowlisted 127.0.0.1 loopback redirect', () => {
		assert.strictEqual(XAI_GROK_OAUTH_CONFIG.callbackHost, '127.0.0.1')
		assert.strictEqual(XAI_GROK_OAUTH_CONFIG.callbackPort, 56121)
		assert.strictEqual(XAI_GROK_REDIRECT_URI, 'http://127.0.0.1:56121/callback')
	})

	test('encodes OAuth error codes in error.name so they survive renderer IPC', () => {
		const error = new XAiGrokOAuthError('loopback bind failed', 'port_unavailable')
		assert.strictEqual(error.code, 'port_unavailable')
		assert.strictEqual(error.name, 'XAiGrokOAuthError:port_unavailable')
		assert.strictEqual(getXAiGrokOAuthErrorCode(error), 'port_unavailable')

		// Simulate VS Code IPC deserialization (message/name/stack only).
		const ipcError = new Error(error.message)
		ipcError.name = error.name
		assert.strictEqual(getXAiGrokOAuthErrorCode(ipcError), 'port_unavailable')
	})

	test('normalizes invalid device-code timing values instead of busy-looping', () => {
		for (const value of [undefined, null, 0, -1, Number.NaN, 'invalid']) {
			assert.strictEqual(positiveSecondsToMs(value, 5000), 5000)
		}
		assert.strictEqual(positiveSecondsToMs('7', 5000), 7000)
	})

	test('refreshes credentials before their access token expires', () => {
		assert.strictEqual(isTokenExpired({ accessToken: 'token', expiresAt: Date.now() + 60_000 }), true)
		assert.strictEqual(isTokenExpired({ accessToken: 'token', expiresAt: Date.now() + 10 * 60_000 }), false)
	})

	test('validates monthly and weekly subscription usage payloads', () => {
		const resetsAt = '2026-07-31T12:00:00.000Z'
		assert.deepStrictEqual(parseXAiGrokMonthlyUsage({
			config: { monthlyLimit: { val: 10_000 }, used: { val: 2_500 }, billingPeriodEnd: resetsAt },
		}), { limit: 10_000, used: 2_500, resetsAt })
		assert.deepStrictEqual(parseXAiGrokWeeklyUsage({
			config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' }, creditUsagePercent: 21.5, billingPeriodEnd: resetsAt },
		}), { usedPercent: 21.5, resetsAt })
		assert.strictEqual(parseXAiGrokWeeklyUsage({ config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY' } } }), undefined)
		assert.throws(() => parseXAiGrokMonthlyUsage({ config: { monthlyLimit: { val: 0 } } }), /malformed/)
	})
})
