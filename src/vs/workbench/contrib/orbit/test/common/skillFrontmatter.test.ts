/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { parseSkillFrontmatter } from '../../common/skillFrontmatter.js';

suite('SkillFrontmatter', () => {
	test('parses flat name + description', () => {
		const { meta, body } = parseSkillFrontmatter('---\nname: my-skill\ndescription: Does a thing.\n---\n# Body\ntext');
		assert.strictEqual(meta.name, 'my-skill');
		assert.strictEqual(meta.description, 'Does a thing.');
		assert.strictEqual(body, '# Body\ntext');
	});

	test('strips surrounding quotes', () => {
		const { meta } = parseSkillFrontmatter('---\nname: "quoted"\ndescription: \'single\'\n---\nbody');
		assert.strictEqual(meta.name, 'quoted');
		assert.strictEqual(meta.description, 'single');
	});

	test('folded block scalar (>-) joins continuation lines with spaces', () => {
		const src = '---\nname: s\ndescription: >-\n  line one\n  line two\n---\nbody';
		const { meta } = parseSkillFrontmatter(src);
		assert.strictEqual(meta.description, 'line one line two');
	});

	test('literal block scalar (|) joins continuation lines with newlines', () => {
		const src = '---\nname: s\ndescription: |\n  line one\n  line two\n---\nbody';
		const { meta } = parseSkillFrontmatter(src);
		assert.strictEqual(meta.description, 'line one\nline two');
	});

	test('block scalar does not swallow a following base-level key', () => {
		const src = '---\ndescription: >-\n  folded text\nname: after-block\n---\nbody';
		const { meta } = parseSkillFrontmatter(src);
		assert.strictEqual(meta.description, 'folded text');
		assert.strictEqual(meta.name, 'after-block');
	});

	test('CRLF input leaves no trailing carriage return in description or body', () => {
		const src = '---\r\nname: s\r\ndescription: hello world\r\n---\r\n# Body\r\nmore\r\n';
		const { meta, body } = parseSkillFrontmatter(src);
		assert.strictEqual(meta.description, 'hello world');
		assert.ok(!meta.description!.includes('\r'), 'description must not contain \\r');
		assert.ok(!body.includes('\r'), 'body must not contain \\r');
		assert.strictEqual(body, '# Body\nmore');
	});

	test('CRLF folded block scalar has no embedded carriage returns', () => {
		const src = '---\r\nname: s\r\ndescription: >-\r\n  alpha\r\n  beta\r\n---\r\nbody\r\n';
		const { meta } = parseSkillFrontmatter(src);
		assert.strictEqual(meta.description, 'alpha beta');
		assert.ok(!meta.description!.includes('\r'));
	});

	test('bare > before another key is treated literally, not as an empty block', () => {
		// `description: >` immediately followed by a base-level key must NOT enter block mode
		// (which would yield an empty description); the following key must still parse.
		const src = '---\ndescription: >\nname: still-here\n---\nbody';
		const { meta } = parseSkillFrontmatter(src);
		assert.strictEqual(meta.name, 'still-here');
		assert.notStrictEqual(meta.description, '');
	});

	test('nested mapping under a key is skipped, not mis-assigned', () => {
		const src = '---\nname: s\ndescription: d\nmetadata:\n  foo: bar\n  baz: qux\n---\nbody';
		const { meta } = parseSkillFrontmatter(src);
		assert.strictEqual(meta.name, 's');
		assert.strictEqual(meta.description, 'd');
		// Indented children are skipped (not folded into description/name).
		assert.strictEqual(meta.metadata.foo, undefined);
	});

	test('disableModelInvocation parses as boolean', () => {
		const on = parseSkillFrontmatter('---\nname: s\ndescription: d\ndisableModelInvocation: true\n---\nx');
		assert.strictEqual(on.meta.disableModelInvocation, true);
		const off = parseSkillFrontmatter('---\nname: s\ndescription: d\ndisableModelInvocation: false\n---\nx');
		assert.strictEqual(off.meta.disableModelInvocation, false);
	});

	test('content without frontmatter returns the whole (normalized) content as body', () => {
		const { meta, body } = parseSkillFrontmatter('no frontmatter\r\nhere');
		assert.strictEqual(meta.name, undefined);
		assert.strictEqual(meta.description, undefined);
		assert.strictEqual(body, 'no frontmatter\nhere');
	});

	test('extra top-level keys land in metadata', () => {
		const { meta } = parseSkillFrontmatter('---\nname: s\ndescription: d\nversion: 1.2.3\n---\nbody');
		assert.strictEqual(meta.metadata.version, '1.2.3');
	});
});
