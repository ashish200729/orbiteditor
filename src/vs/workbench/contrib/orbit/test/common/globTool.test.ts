/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	GLOB_MTIME_SORT_CAP,
	GLOB_RESULT_LIMIT,
	normalizeGlobPattern,
	toFilenameSearchGlobPattern,
} from '../../common/globToolHelpers.js';
import { availableTools } from '../../common/prompt/prompts.js';

suite('Glob tool helpers', () => {

	suite('normalizeGlobPattern', () => {
		test('prepends recursive prefix for simple extension patterns', () => {
			assert.strictEqual(normalizeGlobPattern('*.js'), '**/*.js');
		});

		test('leaves double-star patterns unchanged', () => {
			assert.strictEqual(normalizeGlobPattern('**/node_modules/**'), '**/node_modules/**');
		});

		test('prepends recursive prefix for directory-anchored patterns', () => {
			assert.strictEqual(normalizeGlobPattern('src/**/*.tsx'), '**/src/**/*.tsx');
		});

		test('rejects empty pattern', () => {
			assert.throws(() => normalizeGlobPattern('   '), /non-empty/);
		});
	});

	suite('toFilenameSearchGlobPattern', () => {
		test('wraps plain text as substring glob', () => {
			assert.strictEqual(toFilenameSearchGlobPattern('prompt'), '**/*prompt*');
		});

		test('preserves explicit glob metacharacters', () => {
			assert.strictEqual(toFilenameSearchGlobPattern('*.ts'), '**/*.ts');
		});
	});

	suite('Glob tool registration', () => {
		test('Glob is exposed in agent tool list with glob_pattern param', () => {
			const tools = availableTools('agent', undefined) ?? [];
			const globTool = tools.find(tool => tool.name === 'Glob');
			assert.ok(globTool);
			assert.ok(globTool!.params.glob_pattern);
			assert.ok(globTool!.inputSchema?.properties?.glob_pattern);
		});

		for (const chatMode of ['agent', 'normal', 'plan'] as const) {
			test(`removed directory listing tools are not in ${chatMode} tool list`, () => {
				const toolNames = (availableTools(chatMode, undefined) ?? []).map(tool => tool.name);
				assert.ok(!toolNames.includes('ls_dir'));
				assert.ok(!toolNames.includes('get_dir_tree'));
			});
		}
	});

	suite('constants', () => {
		test('result limit is 500', () => {
			assert.strictEqual(GLOB_RESULT_LIMIT, 500);
		});

		test('mtime sort cap exceeds result limit', () => {
			assert.ok(GLOB_MTIME_SORT_CAP >= GLOB_RESULT_LIMIT);
		});
	});
});
