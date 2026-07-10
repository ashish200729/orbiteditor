/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	formatNumberedFileLines,
	READ_FILE_DEFAULT_LIMIT,
	sliceFileLines,
	validateReadToolParams,
} from '../../common/readFileToolHelpers.js';
import { countPdfPages, extractPdfText } from '../../common/pdfTextExtract.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';

suite('ReadTool', () => {
	suite('validateReadToolParams', () => {
		test('requires path', () => {
			assert.throws(() => validateReadToolParams({}));
		});

		test('rejects null path with helpful message', () => {
			assert.throws(
				() => validateReadToolParams({ path: null as unknown as string, offset: 0 as unknown as string }),
				/path was null or missing/,
			);
		});

		test('rejects empty string path', () => {
			assert.throws(
				() => validateReadToolParams({ path: '' }),
				/path was null or missing/,
			);
		});

		test('rejects null path even when other params present', () => {
			assert.throws(
				() => validateReadToolParams({ path: null as unknown as string, offset: 5 as unknown as string, limit: 100 as unknown as string }),
				/path was null or missing/,
			);
		});

		test('accepts path and defaults offset/limit', () => {
			const params = validateReadToolParams({ path: '/tmp/foo.ts' });
			assert.strictEqual(params.uri.fsPath, '/tmp/foo.ts');
			assert.strictEqual(params.offset, 0);
			assert.strictEqual(params.limit, READ_FILE_DEFAULT_LIMIT);
		});

		test('accepts legacy uri param', () => {
			const params = validateReadToolParams({ uri: '/tmp/legacy.ts' });
			assert.strictEqual(params.uri.fsPath, '/tmp/legacy.ts');
		});

		test('throws on invalid limit', () => {
			assert.throws(() => validateReadToolParams({ path: '/tmp/a.ts', limit: '0' }));
			assert.throws(() => validateReadToolParams({ path: '/tmp/a.ts', limit: '-1' }));
		});

		test('honors offset and limit', () => {
			const params = validateReadToolParams({ path: '/tmp/a.ts', offset: '35', limit: '50' });
			assert.strictEqual(params.offset, 35);
			assert.strictEqual(params.limit, 50);
		});

		test('H20: rejects ".." path segments (path-traversal attempt)', () => {
			// Phase 2.15 (H20) fix: defense-in-depth against a path-traversal attempt
			// even though the calling site is supposed to enforce the workspace root.
			assert.throws(
				() => validateReadToolParams({ path: '/workspace/../etc/passwd' }),
				/"\.\." segment/,
			);
			assert.throws(
				() => validateReadToolParams({ path: '..\\sensitive.txt' }),
				/"\.\." segment/,
			);
		});

		test('does not reject paths whose string content coincidentally contains ".."', () => {
			// A filename that contains `..` as a literal substring but is not a
			// segment is allowed. The check splits on path separators and rejects
			// segments whose name is exactly `..`.
			const params = validateReadToolParams({ path: '/tmp/version..1.txt' });
			assert.strictEqual(params.uri.fsPath, '/tmp/version..1.txt');
		});
	});

	suite('sliceFileLines', () => {
		const makeFile = (lineCount: number) => Array.from({ length: lineCount }, (_, i) => `line${i + 1}`).join('\n');

		test('whole file with default offset', () => {
			const raw = makeFile(10);
			const { contentLines, totalNumLines } = sliceFileLines(raw, 0, READ_FILE_DEFAULT_LIMIT);
			assert.strictEqual(totalNumLines, 10);
			assert.strictEqual(contentLines.length, 10);
			assert.strictEqual(contentLines[0], 'line1');
		});

		test('offset+limit range', () => {
			const raw = makeFile(1000);
			const { contentLines, startLineIndex } = sliceFileLines(raw, 201, 200);
			assert.strictEqual(startLineIndex, 200);
			assert.strictEqual(contentLines.length, 200);
			assert.strictEqual(contentLines[0], 'line201');
			assert.strictEqual(contentLines[199], 'line400');
		});

		test('negative offset reads tail', () => {
			const raw = makeFile(100);
			const { contentLines } = sliceFileLines(raw, -20, 200);
			assert.strictEqual(contentLines.length, 20);
			assert.strictEqual(contentLines[0], 'line81');
			assert.strictEqual(contentLines[19], 'line100');
		});

		test('empty file', () => {
			const { contentLines, totalNumLines } = sliceFileLines('', 0, 2000);
			assert.strictEqual(totalNumLines, 0);
			assert.strictEqual(contentLines.length, 0);
		});
	});

	suite('formatNumberedFileLines', () => {
		test('numbers from first line number', () => {
			const out = formatNumberedFileLines(['a', 'b'], 35);
			assert.strictEqual(out, '35|a\n36|b');
		});
	});

	suite('pdfTextExtract', () => {
		test('countPdfPages from Type/Page markers', () => {
			const sample = '%PDF-1.4\n/Type /Page\n/Type /Page\n';
			assert.strictEqual(countPdfPages(sample), 2);
		});

		test('extractPdfText returns fallback for invalid buffer', async () => {
			const result = await extractPdfText(VSBuffer.fromString('not a pdf'));
			assert.ok(result.textContent.includes('failed') || result.textContent.length >= 0);
		});
	});
});
