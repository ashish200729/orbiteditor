/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert'
import { getModelCapabilities } from '../../common/modelCapabilities.js'
import {
	clearOrbitProviderModelMetadata,
	pricePerMillionFromCreditMultiplier,
	setOrbitProviderModelMetadata,
} from '../../common/orbitProviderModelMetadata.js'

suite('Orbit Provider model metadata', () => {
	teardown(() => {
		clearOrbitProviderModelMetadata()
	})

	test('converts per-token credit multipliers to $/1M tokens', () => {
		assert.strictEqual(pricePerMillionFromCreditMultiplier(0.00000014), 0.14)
		assert.strictEqual(pricePerMillionFromCreditMultiplier(0.00000028), 0.28)
	})

	test('getModelCapabilities uses gateway metadata for orbit provider models', () => {
		setOrbitProviderModelMetadata([{
			modelName: 'orbit-test-model',
			contextWindow: 512_000,
			supportsTools: true,
			supportsReasoning: true,
			inputCreditMultiplier: 0.0000005,
			outputCreditMultiplier: 0.0000015,
		}])

		const capabilities = getModelCapabilities('orbit', 'orbit-test-model', undefined)
		assert.strictEqual(capabilities.isUnrecognizedModel, false)
		assert.strictEqual(capabilities.contextWindow, 512_000)
		assert.strictEqual(capabilities.cost.input, 0.5)
		assert.strictEqual(capabilities.cost.output, 1.5)
		assert.strictEqual(capabilities.specialToolFormat, 'openai-style')
		assert.notStrictEqual(capabilities.reasoningCapabilities, false)
	})

	test('getModelCapabilities disables tools when gateway metadata says so', () => {
		setOrbitProviderModelMetadata([{
			modelName: 'orbit-no-tools',
			contextWindow: 128_000,
			supportsTools: false,
			supportsReasoning: false,
			inputCreditMultiplier: 0.0000001,
			outputCreditMultiplier: 0.0000002,
		}])

		const capabilities = getModelCapabilities('orbit', 'orbit-no-tools', undefined)
		assert.strictEqual(capabilities.specialToolFormat, undefined)
		assert.strictEqual(capabilities.reasoningCapabilities, false)
	})

	test('falls back to defaults when orbit metadata is unavailable', () => {
		const capabilities = getModelCapabilities('orbit', 'totally-unknown-orbit-model', undefined)
		assert.strictEqual(capabilities.isUnrecognizedModel, true)
		assert.strictEqual(capabilities.contextWindow, 4_096)
	})
})
