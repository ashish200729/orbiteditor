/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert'
import { defaultModelsOfProvider, getModelCapabilities } from '../../common/modelCapabilities.js'

suite('ClinePass static model catalog', () => {
	const expectedModels = [
		'cline-pass/glm-5.2',
		'cline-pass/kimi-k2.7-code',
		'cline-pass/kimi-k2.6',
		'cline-pass/kimi-k3',
		'cline-pass/deepseek-v4-pro',
		'cline-pass/deepseek-v4-flash',
		'cline-pass/mimo-v2.5',
		'cline-pass/mimo-v2.5-pro',
		'cline-pass/minimax-m3',
		'cline-pass/qwen3.7-max',
		'cline-pass/qwen3.7-plus',
	] as const

	test('all 11 documented model IDs are present', () => {
		const actual: readonly string[] = defaultModelsOfProvider.clinePass
		assert.strictEqual(actual.length, 11, `Expected 11 models, got ${actual.length}: ${actual.join(', ')}`)
		for (const model of expectedModels) {
			assert.ok(actual.includes(model), `Missing model: ${model}`)
		}
	})

	test('all ClinePass models have openai-style tool format', () => {
		for (const modelName of defaultModelsOfProvider.clinePass) {
			const caps = getModelCapabilities('clinePass', modelName, undefined)
			assert.strictEqual(caps.isUnrecognizedModel, false, `${modelName} should be recognized`)
			assert.strictEqual(caps.specialToolFormat, 'openai-style', `${modelName} missing openai-style tools`)
			assert.strictEqual(caps.supportsFIM, false, `${modelName} unexpectedly has FIM`)
		}
	})

	test('all ClinePass models use system-role', () => {
		for (const modelName of defaultModelsOfProvider.clinePass) {
			const caps = getModelCapabilities('clinePass', modelName, undefined)
			assert.strictEqual(caps.supportsSystemMessage, 'system-role', `${modelName} has unexpected supportsSystemMessage`)
		}
	})

	test('static models include reference pricing', () => {
		const glm = getModelCapabilities('clinePass', 'cline-pass/glm-5.2', undefined)
		assert.strictEqual(glm.cost.input, 1.40)
		assert.strictEqual(glm.cost.output, 4.40)

		const flash = getModelCapabilities('clinePass', 'cline-pass/deepseek-v4-flash', undefined)
		assert.strictEqual(flash.cost.input, 0.14)
		assert.strictEqual(flash.cost.output, 0.28)
	})
})
