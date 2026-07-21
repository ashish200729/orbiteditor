/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert'
import { mapClinePassApiModel } from '../../common/clinePassModelMetadata.js'

suite('ClinePass model metadata', () => {
	test('maps a valid ClinePass API model entry', () => {
		const raw = {
			id: 'cline-pass/deepseek-v4-pro',
			context_length: 1_000_000,
			architecture: { modality: 'text', tokenizer: 'test', instruct_type: 'test' },
			pricing: { prompt: '0.00000174', completion: '0.00000348' },
			supports_tools: true,
			supports_reasoning: true,
		}
		const result = mapClinePassApiModel(raw)
		assert.ok(result)
		assert.strictEqual(result!.modelName, 'cline-pass/deepseek-v4-pro')
		assert.strictEqual(result!.contextWindow, 1_000_000)
		assert.strictEqual(result!.supportsTools, true)
		assert.strictEqual(result!.supportsReasoning, true)
	})

	test('filters out non-ClinePass model IDs', () => {
		const result = mapClinePassApiModel({ id: 'anthropic/claude-sonnet-4', name: 'test' })
		assert.strictEqual(result, null)
	})

	test('converts per-token prices to $/1M', () => {
		const result = mapClinePassApiModel({
			id: 'cline-pass/qwen3.7-plus',
			pricing: { prompt: '0.0000004', completion: '0.0000016' },
		})
		assert.ok(result)
		assert.ok(result.inputPrice !== undefined && Math.abs(result.inputPrice - 0.4) < 1e-9)
		assert.ok(result.outputPrice !== undefined && Math.abs(result.outputPrice - 1.6) < 1e-9)
	})

	test('handles pricing already in $/1M format', () => {
		const result = mapClinePassApiModel({
			id: 'cline-pass/glm-5.2',
			pricing: { input: 1.40, output: 4.40 },
		})
		assert.ok(result)
		assert.strictEqual(result!.inputPrice, 1.40)
		assert.strictEqual(result!.outputPrice, 4.40)
	})

	test('defaults missing fields sensibly', () => {
		const result = mapClinePassApiModel({ id: 'cline-pass/minimax-m3' })
		assert.ok(result)
		assert.strictEqual(result!.contextWindow, 200_000)
		assert.strictEqual(result!.supportsTools, true)
		assert.strictEqual(result!.supportsReasoning, true)
		assert.strictEqual(result!.inputPrice, 0)
		assert.strictEqual(result!.outputPrice, 0)
	})

	test('rejects null/undefined model name', () => {
		assert.strictEqual(mapClinePassApiModel({ id: undefined, name: undefined }), null)
	})

	test('rejects empty string model name', () => {
		assert.strictEqual(mapClinePassApiModel({ id: '', name: '' }), null)
	})

	test('uses name field when id is missing', () => {
		const result = mapClinePassApiModel({ name: 'cline-pass/kimi-k3' })
		assert.ok(result)
		assert.strictEqual(result!.modelName, 'cline-pass/kimi-k3')
	})
})
