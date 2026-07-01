/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { parseSlashTokenNames } from '../../common/slashCommands/slashTokens.js';
import { BUILTIN_COMMANDS, getBuiltinCommand } from '../../common/slashCommands/builtinCommands.js';

suite('SlashTokens', () => {
	test('extracts a single leading token', () => {
		assert.deepStrictEqual(parseSlashTokenNames('/explain do the thing'), ['explain']);
	});

	test('extracts a token after whitespace', () => {
		assert.deepStrictEqual(parseSlashTokenNames('please /review this'), ['review']);
	});

	test('handles hyphenated names', () => {
		assert.deepStrictEqual(parseSlashTokenNames('run /review-bugbot now'), ['review-bugbot']);
	});

	test('does NOT match slashes mid-word (and/or, paths)', () => {
		assert.deepStrictEqual(parseSlashTokenNames('use and/or read path/to/file.ts'), []);
	});

	test('orders and de-duplicates', () => {
		assert.deepStrictEqual(parseSlashTokenNames('/a then /b then /a again'), ['a', 'b']);
	});

	test('matches after a newline', () => {
		assert.deepStrictEqual(parseSlashTokenNames('first line\n/plan'), ['plan']);
	});

	test('does not match uppercase tokens', () => {
		assert.deepStrictEqual(parseSlashTokenNames('/Plan /Review'), []);
	});

	test('empty / no-token input returns []', () => {
		assert.deepStrictEqual(parseSlashTokenNames(''), []);
		assert.deepStrictEqual(parseSlashTokenNames('no tokens here'), []);
	});
});

suite('BuiltinCommands', () => {
	test('names are unique, valid kebab tokens', () => {
		const names = BUILTIN_COMMANDS.map(c => c.name);
		assert.strictEqual(new Set(names).size, names.length, 'command names must be unique');
		for (const n of names) {
			assert.ok(/^[a-z0-9][a-z0-9_-]*$/.test(n), `invalid command name: ${n}`);
		}
	});

	test('do not collide with built-in skill names', () => {
		const skillNames = new Set(['create-skill', 'code-review', 'review', 'review-bugbot', 'review-security']);
		for (const c of BUILTIN_COMMANDS) {
			assert.ok(!skillNames.has(c.name), `command "${c.name}" collides with a built-in skill`);
		}
	});

	test('every command has a non-empty template and description', () => {
		for (const c of BUILTIN_COMMANDS) {
			assert.ok(c.description.trim().length > 0, `${c.name} missing description`);
			assert.ok(c.template.trim().length > 0, `${c.name} missing template`);
		}
	});

	test('getBuiltinCommand looks up by name', () => {
		assert.strictEqual(getBuiltinCommand('explain')?.name, 'explain');
		assert.strictEqual(getBuiltinCommand('nope'), undefined);
	});
});
