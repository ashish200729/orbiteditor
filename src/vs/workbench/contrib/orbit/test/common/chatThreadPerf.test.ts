/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { appendMessageImmutable, replaceMessageImmutable, resolveThreadStorePolicy, shouldNotifyGlobalThreadChange, threadStructurallyEqual, ThreadStructuralFields } from '../../common/chatThreadHelpers.js';
import { getDateBucket } from '../../common/chatHistoryHelpers.js';

const makeThread = (overrides: Partial<ThreadStructuralFields> = {}): ThreadStructuralFields => ({
	lastModified: '2026-06-12T00:00:00.000Z',
	messages: [],
	filesWithUserChanges: new Set(),
	state: {},
	...overrides,
});

suite('ChatThread performance helpers', () => {
	test('threadStructurallyEqual returns true for identical field references', () => {
		const messages: ThreadStructuralFields['messages'] = [];
		const state = {};
		const files = new Set<string>();
		const a = makeThread({ messages, state, filesWithUserChanges: files });
		const b = makeThread({ messages, state, filesWithUserChanges: files });
		assert.strictEqual(threadStructurallyEqual(a, b), true);
	});

	test('threadStructurallyEqual returns false when messages reference changes', () => {
		const a = makeThread({ messages: [] });
		const b = makeThread({ messages: [] });
		assert.strictEqual(threadStructurallyEqual(a, b), false);
	});

	test('threadStructurallyEqual returns false when lastModified changes', () => {
		const messages: ThreadStructuralFields['messages'] = [];
		const a = makeThread({ messages, lastModified: '2026-06-12T00:00:00.000Z' });
		const b = makeThread({ messages, lastModified: '2026-06-12T01:00:00.000Z' });
		assert.strictEqual(threadStructurallyEqual(a, b), false);
	});

	test('getDateBucket is stable for the same timestamp within a day', () => {
		const noon = new Date();
		noon.setHours(12, 0, 0, 0);
		const ts = noon.getTime();
		const first = getDateBucket(ts);
		const second = getDateBucket(ts);
		assert.strictEqual(first, second);
		assert.ok(['Today', 'Yesterday', 'Last 7 Days', 'Older'].includes(first));
	});

	test('threadStructurallyEqual returns false when state reference changes', () => {
		const messages: ThreadStructuralFields['messages'] = [];
		const files = new Set<string>();
		const a = makeThread({ messages, state: { stagingSelections: [] }, filesWithUserChanges: files });
		const b = makeThread({ messages, state: { stagingSelections: [{ type: 'File' }] }, filesWithUserChanges: files });
		assert.strictEqual(threadStructurallyEqual(a, b), false);
	});

	test('replaceMessageImmutable returns a new array without mutating the original', () => {
		const original = [{ role: 'user' as const, content: 'a' }, { role: 'assistant' as const, content: 'b' }];
		const next = replaceMessageImmutable(original, 0, { role: 'user', content: 'edited' });
		assert.notStrictEqual(next, original);
		assert.strictEqual(original[0].content, 'a');
		assert.strictEqual(next[0].content, 'edited');
	});

	test('appendMessageImmutable returns a new array reference', () => {
		const original = [{ role: 'user', content: 'hi' }];
		const { messages, idx } = appendMessageImmutable(original, { role: 'assistant', content: 'hello' });
		assert.notStrictEqual(messages, original);
		assert.strictEqual(messages.length, 2);
		assert.strictEqual(idx, 1);
		assert.strictEqual(original.length, 1);
	});

	test('shouldNotifyGlobalThreadChange only fires for current thread', () => {
		assert.strictEqual(shouldNotifyGlobalThreadChange('thread-a', 'thread-a'), true);
		assert.strictEqual(shouldNotifyGlobalThreadChange('thread-b', 'thread-a'), false);
	});

	test('resolveThreadStorePolicy returns immediate only when requested', () => {
		assert.strictEqual(resolveThreadStorePolicy({ immediate: true }), 'immediate');
		assert.strictEqual(resolveThreadStorePolicy({ immediate: false }), 'debounced');
		assert.strictEqual(resolveThreadStorePolicy({}), 'debounced');
	});
});