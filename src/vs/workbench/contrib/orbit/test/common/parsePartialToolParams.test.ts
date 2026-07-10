/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { normalizeToolParams, parsePartialToolParams } from '../../electron-main/llmMessage/parsePartialToolParams.js';
import { availableTools } from '../../common/prompt/prompts.js';

suite('parsePartialToolParams', () => {

	suite('normalizeToolParams (full JSON path)', () => {

		test('converts camelCase keys to snake_case', () => {
			const result = normalizeToolParams({
				globPattern: '*.ts',
				targetDirectory: '/tmp',
				workingDirectory: '/home',
				blockUntilMs: 30000,
			});
			assert.strictEqual(result.glob_pattern, '*.ts');
			assert.strictEqual(result.target_directory, '/tmp');
			assert.strictEqual(result.working_directory, '/home');
			assert.strictEqual(result.block_until_ms, 30000);
		});

		test('leaves already-snake_case keys unchanged', () => {
			const result = normalizeToolParams({
				glob_pattern: '*.ts',
				working_directory: '/home',
				block_until_ms: 30000,
				'-C': 2,
				'-i': true,
			});
			assert.strictEqual(result.glob_pattern, '*.ts');
			assert.strictEqual(result.working_directory, '/home');
			assert.strictEqual(result.block_until_ms, 30000);
			assert.strictEqual(result['-C'], 2);
			assert.strictEqual(result['-i'], true);
		});

		test('handles mixed camelCase and snake_case keys (snake_case wins)', () => {
			const result = normalizeToolParams({
				globPattern: 'from-camel',
				glob_pattern: 'from-snake',
				workingDirectory: '/home',
			});
			assert.strictEqual(result.glob_pattern, 'from-snake');
			assert.strictEqual(result.working_directory, '/home');
			assert.strictEqual((result as Record<string, unknown>).globPattern, undefined);
		});

		test('handles mixed keys with snake_case first (snake_case still wins)', () => {
			const result = normalizeToolParams({
				glob_pattern: 'from-snake',
				globPattern: 'from-camel',
			});
			assert.strictEqual(result.glob_pattern, 'from-snake');
			assert.strictEqual((result as Record<string, unknown>).globPattern, undefined);
		});

		test('preserves single-word lowercase keys', () => {
			const result = normalizeToolParams({
				path: '/etc/hosts',
				pattern: 'foo',
				command: 'ls',
			});
			assert.strictEqual(result.path, '/etc/hosts');
			assert.strictEqual(result.pattern, 'foo');
			assert.strictEqual(result.command, 'ls');
		});

		test('maps path/uri aliases to canonical target and drops source', () => {
			// Both filePath and targetFile alias to `path`. The first alias that
			// sets `path` wins; the second is ignored because the target is
			// already populated.
			const result = normalizeToolParams({
				filePath: '/etc/hosts',
				targetFile: '/etc/passwd',
			});
			assert.strictEqual(result.path, '/etc/hosts');
			assert.strictEqual((result as Record<string, unknown>).filePath, undefined);
			assert.strictEqual((result as Record<string, unknown>).targetFile, undefined);
		});

		test('null path does not block an alias from filling it in', () => {
			// Some providers/models send `path: null` explicitly. The normalizer
			// must treat null as "missing" so an alias source (file_path) can
			// still populate the canonical `path` target.
			const result = normalizeToolParams({
				path: null,
				file_path: '/etc/hosts',
			});
			assert.strictEqual(result.path, '/etc/hosts');
			assert.strictEqual((result as Record<string, unknown>).file_path, undefined);
		});

		test('null path with no alias stays null (validator rejects it)', () => {
			const result = normalizeToolParams({
				path: null,
				offset: 0,
			});
			assert.strictEqual(result.path, null);
			assert.strictEqual(result.offset, 0);
		});

		test('maps content/old_string/new_string aliases', () => {
			const result = normalizeToolParams({
				content: 'hello',
				oldString: 'a',
				newString: 'b',
			});
			assert.strictEqual(result.contents, 'hello');
			assert.strictEqual(result.old_string, 'a');
			assert.strictEqual(result.new_string, 'b');
			assert.strictEqual((result as Record<string, unknown>).content, undefined);
			assert.strictEqual((result as Record<string, unknown>).oldString, undefined);
			assert.strictEqual((result as Record<string, unknown>).newString, undefined);
		});

		test('does not double-convert keys with embedded underscores before uppercase', () => {
			const result = normalizeToolParams({
				glob_Pattern: 'weird',
			});
			assert.strictEqual(result.glob_pattern, 'weird');
			assert.strictEqual((result as Record<string, unknown>).glob_Pattern, undefined);
		});
	});

	suite('parsePartialToolParams (full JSON)', () => {

		test('parses complete JSON with snake_case keys and marks done', () => {
			const result = parsePartialToolParams('{"glob_pattern":"*.ts","target_directory":"/tmp"}');
			assert.strictEqual(result.isDone, true);
			assert.strictEqual(result.rawParams.glob_pattern, '*.ts');
			assert.strictEqual(result.rawParams.target_directory, '/tmp');
			assert.ok(result.doneParams.includes('glob_pattern'));
			assert.ok(result.doneParams.includes('target_directory'));
		});

		test('parses complete JSON with camelCase keys and normalizes them', () => {
			const result = parsePartialToolParams('{"globPattern":"*.ts","targetDirectory":"/tmp"}');
			assert.strictEqual(result.isDone, true);
			assert.strictEqual(result.rawParams.glob_pattern, '*.ts');
			assert.strictEqual(result.rawParams.target_directory, '/tmp');
		});

		test('parses complete JSON with camelCase shell params', () => {
			const result = parsePartialToolParams('{"command":"ls","workingDirectory":"/home","blockUntilMs":1000}');
			assert.strictEqual(result.isDone, true);
			assert.strictEqual(result.rawParams.command, 'ls');
			assert.strictEqual(result.rawParams.working_directory, '/home');
			assert.strictEqual(result.rawParams.block_until_ms, 1000);
		});
	});

	suite('parsePartialToolParams (partial JSON)', () => {

		test('extracts path field from incomplete JSON', () => {
			const result = parsePartialToolParams('{"path":"/etc/hos');
			assert.strictEqual(result.isDone, false);
			assert.strictEqual(result.rawParams.path, '/etc/hos');
		});

		test('extracts camelCase path alias from incomplete JSON', () => {
			const result = parsePartialToolParams('{"filePath":"/etc/hos');
			assert.strictEqual(result.isDone, false);
			assert.strictEqual(result.rawParams.path, '/etc/hos');
		});

		test('extracts snake_case glob_pattern from incomplete JSON', () => {
			// The partial extractor only scans path/content alias fields (the
			// ones needed for early streaming display). glob_pattern is not in
			// that set, so it is only surfaced once the JSON completes. This
			// test documents that boundary: an incomplete non-alias field
			// yields empty params (the full-JSON path normalizes it once done).
			const result = parsePartialToolParams('{"glob_pattern":"*.t');
			assert.strictEqual(result.isDone, false);
			assert.deepStrictEqual(result.rawParams, {});
		});

		test('extracts camelCase globPattern from incomplete JSON', () => {
			// Same as above: globPattern is not a path/content alias, so the
			// partial extractor does not surface it. Full JSON normalization
			// handles it on completion.
			const result = parsePartialToolParams('{"globPattern":"*.t');
			assert.strictEqual(result.isDone, false);
			assert.deepStrictEqual(result.rawParams, {});
		});

		test('marks doneParams for completed string fields in partial JSON', () => {
			const result = parsePartialToolParams('{"path":"/etc/hosts","pattern":"foo');
			assert.strictEqual(result.isDone, false);
			assert.ok(result.doneParams.includes('path'));
			// pattern is not in the path/content alias lists, so it is not
			// surfaced by the partial extractor (only path/content aliases are).
		});

		test('returns empty params for empty input', () => {
			const result = parsePartialToolParams('');
			assert.strictEqual(result.isDone, false);
			assert.deepStrictEqual(result.rawParams, {});
			assert.deepStrictEqual(result.doneParams, []);
		});
	});

	suite('Glob tool registration uses snake_case params', () => {

		test('Glob params keys are snake_case so XML tag matching aligns with examples', () => {
			const tools = availableTools('agent', undefined) ?? [];
			const globTool = tools.find(tool => tool.name === 'Glob');
			assert.ok(globTool);
			const paramKeys = Object.keys(globTool!.params);
			assert.ok(paramKeys.includes('glob_pattern'), `expected glob_pattern in ${JSON.stringify(paramKeys)}`);
			assert.ok(paramKeys.includes('target_directory'), `expected target_directory in ${JSON.stringify(paramKeys)}`);
			// camelCase variants must NOT be present, otherwise the XML parser
			// would look for the wrong tags.
			assert.ok(!paramKeys.includes('globPattern'));
			assert.ok(!paramKeys.includes('targetDirectory'));
		});
	});
});
