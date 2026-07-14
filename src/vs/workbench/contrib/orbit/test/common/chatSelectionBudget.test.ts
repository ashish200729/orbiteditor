/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { truncateSelectionsToBudget } from '../../common/chatInputLimits.js';

suite('truncateSelectionsToBudget', () => {
	test('includes all selections when under budget', () => {
		const result = truncateSelectionsToBudget(['aaa', 'bbb', 'ccc'], 100);
		assert.deepStrictEqual(result.included, ['aaa', 'bbb', 'ccc']);
		assert.strictEqual(result.truncated, false);
	});

	test('stops at budget and appends truncation notice when it fits', () => {
		const result = truncateSelectionsToBudget(
			['12345', '67890', 'abcde'],
			12,
			'!',
		);
		assert.deepStrictEqual(result.included, ['12345', '67890']);
		assert.strictEqual(result.truncated, true);
	});

	test('appends truncation notice when there is room after partial inclusion', () => {
		const result = truncateSelectionsToBudget(
			['aaaa', 'bbbbbbbb'],
			13,
			'[!!]',
		);
		assert.deepStrictEqual(result.included, ['aaaa', '[!!]']);
		assert.strictEqual(result.truncated, true);
	});

	test('preserves selection order', () => {
		const result = truncateSelectionsToBudget(['first', 'second'], 20);
		assert.deepStrictEqual(result.included, ['first', 'second']);
	});

	test('uses default truncation notice constant when it fits', () => {
		const selections = ['short', 'x'.repeat(50)];
		const result = truncateSelectionsToBudget(selections, 20);
		assert.strictEqual(result.truncated, true);
		assert.ok(result.included.includes('short'));
	});
});
