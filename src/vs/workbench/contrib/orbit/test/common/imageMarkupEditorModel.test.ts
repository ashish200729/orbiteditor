/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	commitMarkupStroke,
	createMarkupHistory,
	imageMarkupOutputType,
	isValidImageMarkupOutput,
	redoMarkupStroke,
	type MarkupStroke,
	undoMarkupStroke,
} from '../../common/imageMarkupEditorModel.js';

const stroke = (color: string): MarkupStroke => ({
	color,
	width: 4,
	points: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
});

suite('ImageMarkupEditorModel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('commits strokes and clears the redo branch', () => {
		const red = stroke('red');
		const blue = stroke('blue');
		const history = commitMarkupStroke({ strokes: [red], redo: [blue] }, blue);

		assert.deepStrictEqual(history.strokes, [red, blue]);
		assert.deepStrictEqual(history.redo, []);
	});

	test('ignores an empty pointer stroke', () => {
		const history = createMarkupHistory();
		const result = commitMarkupStroke(history, { color: 'red', width: 4, points: [] });
		assert.strictEqual(result, history);
	});

	test('undo and redo preserve stroke order', () => {
		const first = stroke('red');
		const second = stroke('blue');
		const initial = { strokes: [first, second], redo: [] };

		const undone = undoMarkupStroke(initial);
		assert.deepStrictEqual(undone.strokes, [first]);
		assert.deepStrictEqual(undone.redo, [second]);

		const redone = redoMarkupStroke(undone);
		assert.deepStrictEqual(redone.strokes, [first, second]);
		assert.deepStrictEqual(redone.redo, []);
	});

	test('undo and redo are stable when their stacks are empty', () => {
		const empty = createMarkupHistory();
		assert.strictEqual(undoMarkupStroke(empty), empty);
		assert.strictEqual(redoMarkupStroke(empty), empty);
	});

	test('preserves efficient lossy formats and uses PNG for everything else', () => {
		assert.strictEqual(imageMarkupOutputType('data:image/jpeg;base64,abc'), 'image/jpeg');
		assert.strictEqual(imageMarkupOutputType('DATA:IMAGE/WEBP;BASE64,abc'), 'image/webp');
		assert.strictEqual(imageMarkupOutputType('data:image/png;base64,abc'), 'image/png');
		assert.strictEqual(imageMarkupOutputType('not-a-data-url'), 'image/png');
	});

	test('rejects failed or malformed canvas output', () => {
		assert.strictEqual(isValidImageMarkupOutput('data:image/png;base64,aGVsbG8='), true);
		assert.strictEqual(isValidImageMarkupOutput('DATA:IMAGE/WEBP;BASE64,AQID'), true);
		assert.strictEqual(isValidImageMarkupOutput('data:,'), false);
		assert.strictEqual(isValidImageMarkupOutput('data:text/plain;base64,aGVsbG8='), false);
		assert.strictEqual(isValidImageMarkupOutput('data:image/png;base64,'), false);
	});
});
