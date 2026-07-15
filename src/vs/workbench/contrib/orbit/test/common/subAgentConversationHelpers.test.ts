/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ChatMessage } from '../../common/chatThreadServiceTypes.js';
import {
	computeSubAgentExplorationStats,
	formatExplorationStatsLine,
	desc1ToString,
} from '../../browser/react/src/sidebar-tsx/components/subAgent/subAgentConversationStats.js';

// formatSubAgentLiveStatus and getSubAgentToolActivityLabel (in subAgentConversationHelpers.ts,
// not this file) call into toolNameToDesc(), which transitively imports react-jsx-only modules
// (services.tsx, toolHelpers.tsx). Importing that module from this plain-tsc test project fails
// to compile (`--jsx` is not set here), so those two functions aren't covered by this suite —
// only the dependency-free functions re-exported from subAgentConversationStats.ts are.

const toolMsg = (overrides: Partial<ChatMessage & { role: 'tool' }>): ChatMessage & { role: 'tool' } => ({
	role: 'tool',
	type: 'success',
	name: 'Read',
	params: {} as any,
	result: 'ok',
	content: 'ok',
	id: 'id1',
	rawParams: {},
	mcpServerName: undefined,
	...overrides,
} as ChatMessage & { role: 'tool' });

suite('desc1ToString', () => {
	test('returns a string unchanged', () => {
		assert.strictEqual(desc1ToString('hello'), 'hello');
	});
	test('returns empty string for null/undefined/boolean', () => {
		assert.strictEqual(desc1ToString(null), '');
		assert.strictEqual(desc1ToString(undefined), '');
		assert.strictEqual(desc1ToString(true), '');
		assert.strictEqual(desc1ToString(false), '');
	});
	test('stringifies a number', () => {
		assert.strictEqual(desc1ToString(42), '42');
	});
	test('joins an array of strings', () => {
		assert.strictEqual(desc1ToString(['a', 'b', 'c'] as any), 'abc');
	});
	test('recursively flattens a nested array', () => {
		assert.strictEqual(desc1ToString(['a', ['b', 'c']] as any), 'abc');
	});
	test('falls back to String() for a non-primitive React node (e.g. an element)', () => {
		const fakeElement = { type: 'span', props: { children: 'x' }, toString: () => '[object Object]' } as any;
		assert.strictEqual(desc1ToString(fakeElement), '[object Object]');
	});
});

suite('computeSubAgentExplorationStats', () => {
	test('counts Read as a file and a tool', () => {
		const stats = computeSubAgentExplorationStats([toolMsg({ name: 'Read' })]);
		assert.deepStrictEqual(stats, { fileCount: 1, searchCount: 0, toolCount: 1 });
	});

	test('counts Grep and Glob as searches', () => {
		const stats = computeSubAgentExplorationStats([toolMsg({ name: 'Grep' }), toolMsg({ name: 'Glob' })]);
		assert.deepStrictEqual(stats, { fileCount: 0, searchCount: 2, toolCount: 2 });
	});

	test('counts CodebaseSearch as a search', () => {
		const stats = computeSubAgentExplorationStats([toolMsg({ name: 'CodebaseSearch' })]);
		assert.strictEqual(stats.searchCount, 1);
	});

	test('counts other tools toward toolCount only', () => {
		const stats = computeSubAgentExplorationStats([toolMsg({ name: 'Shell' })]);
		assert.deepStrictEqual(stats, { fileCount: 0, searchCount: 0, toolCount: 1 });
	});

	test('ignores non-tool messages', () => {
		const stats = computeSubAgentExplorationStats([
			{ role: 'user', content: 'hi', displayContent: 'hi', selections: null, state: { stagingSelections: [], isBeingEdited: false } } as ChatMessage,
		]);
		assert.deepStrictEqual(stats, { fileCount: 0, searchCount: 0, toolCount: 0 });
	});

	test('ignores invalid_params and tool_request tool messages', () => {
		const stats = computeSubAgentExplorationStats([
			toolMsg({ type: 'invalid_params' as any, name: 'Read' }),
			toolMsg({ type: 'tool_request' as any, name: 'Read' }),
		]);
		assert.deepStrictEqual(stats, { fileCount: 0, searchCount: 0, toolCount: 0 });
	});

	test('ignores the task tool itself', () => {
		const stats = computeSubAgentExplorationStats([toolMsg({ name: 'task' })]);
		assert.deepStrictEqual(stats, { fileCount: 0, searchCount: 0, toolCount: 0 });
	});
});

suite('formatExplorationStatsLine', () => {
	test('returns undefined when no tools were used', () => {
		assert.strictEqual(formatExplorationStatsLine({ fileCount: 0, searchCount: 0, toolCount: 0 }), undefined);
	});
	test('formats files only, with correct pluralization', () => {
		assert.strictEqual(formatExplorationStatsLine({ fileCount: 1, searchCount: 0, toolCount: 1 }), 'Explored 1 file');
		assert.strictEqual(formatExplorationStatsLine({ fileCount: 2, searchCount: 0, toolCount: 2 }), 'Explored 2 files');
	});
	test('formats searches only, with correct pluralization', () => {
		assert.strictEqual(formatExplorationStatsLine({ fileCount: 0, searchCount: 1, toolCount: 1 }), '1 search');
		assert.strictEqual(formatExplorationStatsLine({ fileCount: 0, searchCount: 2, toolCount: 2 }), '2 searches');
	});
	test('formats both files and searches together', () => {
		assert.strictEqual(formatExplorationStatsLine({ fileCount: 1, searchCount: 1, toolCount: 2 }), 'Explored 1 file, 1 search');
	});
	test('falls back to a generic tool count when no files or searches were used', () => {
		assert.strictEqual(formatExplorationStatsLine({ fileCount: 0, searchCount: 0, toolCount: 3 }), '3 tools used');
		assert.strictEqual(formatExplorationStatsLine({ fileCount: 0, searchCount: 0, toolCount: 1 }), '1 tool used');
	});
});
