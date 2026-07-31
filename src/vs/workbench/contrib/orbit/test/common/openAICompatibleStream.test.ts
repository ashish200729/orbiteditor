/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert'
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js'
import {
	appendOpenAICompatibleStreamFrame,
	createOpenAICompatibleStreamAccumulator,
	mergeOpenAICompatibleToolName,
	textFromOpenAICompatibleContent,
} from '../../common/openAICompatibleStream.js'

suite('OpenAI-compatible stream normalization', () => {
	ensureNoDisposablesAreLeakedInTestSuite()
	test('preserves repeated standalone deltas', () => {
		const state = createOpenAICompatibleStreamAccumulator()
		appendOpenAICompatibleStreamFrame(state, 'ha')
		appendOpenAICompatibleStreamFrame(state, 'ha')
		assert.strictEqual(state.value, 'haha')
		assert.strictEqual(state.sawCumulativeFrame, false)
	})

	test('normalizes cumulative frames without repeating the prefix', () => {
		const state = createOpenAICompatibleStreamAccumulator()
		appendOpenAICompatibleStreamFrame(state, 'I do')
		appendOpenAICompatibleStreamFrame(state, 'I do not currently')
		appendOpenAICompatibleStreamFrame(state, 'I do not currently have access')
		appendOpenAICompatibleStreamFrame(state, 'I do not currently have access')
		assert.strictEqual(state.value, 'I do not currently have access')
		assert.strictEqual(state.sawCumulativeFrame, true)
	})

	test('accepts OpenAI content-part arrays', () => {
		assert.strictEqual(textFromOpenAICompatibleContent([
			{ type: 'text', text: 'hello' },
			{ type: 'text', text: ' world' },
		]), 'hello world')
	})

	test('does not duplicate repeated tool names', () => {
		assert.strictEqual(mergeOpenAICompatibleToolName('', 'Read'), 'Read')
		assert.strictEqual(mergeOpenAICompatibleToolName('Read', 'Read'), 'Read')
		assert.strictEqual(mergeOpenAICompatibleToolName('Rea', 'Read'), 'Read')
	})
})
