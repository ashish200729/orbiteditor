/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert'
import { defaultModelsOfProvider, getModelCapabilities } from '../../common/modelCapabilities.js'
import { buildOpenAiCodexRequestHeaders } from '../../electron-main/llmMessage/openAiCodexRequestHeaders.js'

suite('OpenAI Codex models', () => {
	const currentModels = [
		'gpt-5.6-sol',
		'gpt-5.6-terra',
		'gpt-5.6-luna',
		'gpt-5.5',
		'gpt-5.4-mini',
	]

	test('lists the current ChatGPT Codex models in documented order', () => {
		assert.deepStrictEqual(defaultModelsOfProvider.openAICodex, currentModels)
	})

	test('uses subscription-specific capabilities for every current model', () => {
		for (const model of currentModels) {
			const capabilities = getModelCapabilities('openAICodex', model, undefined)
			assert.strictEqual(capabilities.isUnrecognizedModel, false, model)
			assert.strictEqual(capabilities.contextWindow, 272_000, model)
			assert.strictEqual(capabilities.reservedOutputTokenSpace, 128_000, model)
			assert.deepStrictEqual(capabilities.cost, { input: 0, output: 0 }, model)
			assert.strictEqual(capabilities.specialToolFormat, 'openai-style', model)
			assert.notStrictEqual(capabilities.reasoningCapabilities, false, model)
			if (capabilities.reasoningCapabilities) {
				assert.strictEqual(capabilities.reasoningCapabilities.canTurnOffReasoning, false, model)
				assert.strictEqual(capabilities.reasoningCapabilities.canIOReasoning, true, model)
			}
		}
	})

	test('exposes documented reasoning defaults and raw request effort levels', () => {
		const sol = getModelCapabilities('openAICodex', 'gpt-5.6-sol', undefined)
		assert.notStrictEqual(sol.reasoningCapabilities, false)
		if (sol.reasoningCapabilities) {
			assert.deepStrictEqual(sol.reasoningCapabilities.reasoningSlider, {
				type: 'effort_slider',
				values: ['low', 'medium', 'high', 'xhigh', 'max'],
				default: 'low',
			})
		}

		const mini = getModelCapabilities('openAICodex', 'gpt-5.4-mini', undefined)
		assert.notStrictEqual(mini.reasoningCapabilities, false)
		if (mini.reasoningCapabilities) {
			assert.deepStrictEqual(mini.reasoningCapabilities.reasoningSlider, {
				type: 'effort_slider',
				values: ['low', 'medium', 'high', 'xhigh'],
				default: 'medium',
			})
		}
	})

	test('recognizes the gpt-5.6 alias while preserving it on the wire', () => {
		const capabilities = getModelCapabilities('openAICodex', 'gpt-5.6', undefined)
		assert.strictEqual(capabilities.isUnrecognizedModel, false)
		assert.strictEqual(capabilities.modelName, 'gpt-5.6')
		assert.strictEqual(capabilities.recognizedModelName, 'gpt-5.6-sol')
	})

	test('builds the documented ChatGPT Codex Responses headers', () => {
		const headers = buildOpenAiCodexRequestHeaders({
			accessToken: 'access-token',
			accountId: 'account-id',
			originator: 'orbit',
			sessionId: 'session-id-value',
			clientVersion: '1.2.3',
		})
		assert.deepStrictEqual(headers, {
			Authorization: 'Bearer access-token',
			'Content-Type': 'application/json',
			Accept: 'text/event-stream',
			originator: 'orbit',
			'session-id': 'session-id-value',
			'ChatGPT-Account-Id': 'account-id',
			version: '1.2.3',
			'User-Agent': 'orbit-editor',
		})
		assert.ok(!('session_id' in headers))
	})
})
