/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	compareThreadsByOrdering,
	DEFAULT_AGENT_HISTORY_LIST_PREFS,
	getThreadGroupKey,
	getWorkspaceGroupLabel,
	groupThreads,
	orderGroupKeys,
	parseAgentHistoryListPrefs,
	WORKSPACE_BUCKET_NO_REPO,
	WORKSPACE_BUCKET_UNASSIGNED,
} from '../../common/agentHistoryListHelpers.js';

suite('agentHistoryListHelpers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parseAgentHistoryListPrefs falls back to defaults on invalid JSON', () => {
		assert.deepStrictEqual(parseAgentHistoryListPrefs(undefined), DEFAULT_AGENT_HISTORY_LIST_PREFS);
		assert.deepStrictEqual(parseAgentHistoryListPrefs('{'), DEFAULT_AGENT_HISTORY_LIST_PREFS);
	});

	test('parseAgentHistoryListPrefs keeps known values and repairs unknown', () => {
		const prefs = parseAgentHistoryListPrefs(JSON.stringify({
			filterMode: 'all',
			grouping: 'workspace',
			ordering: 'name',
			extra: true,
		}));
		assert.deepStrictEqual(prefs, {
			filterMode: 'all',
			grouping: 'workspace',
			ordering: 'name',
		});
		const repaired = parseAgentHistoryListPrefs(JSON.stringify({
			filterMode: 'pr',
			grouping: 'status',
			ordering: 'environment',
		}));
		assert.deepStrictEqual(repaired, DEFAULT_AGENT_HISTORY_LIST_PREFS);
	});

	test('compareThreadsByOrdering sorts by updated, created, and name', () => {
		const a = {
			lastModified: '2026-01-02T00:00:00.000Z',
			createdAt: '2026-01-01T00:00:00.000Z',
			messages: [{ role: 'user', displayContent: 'Beta' }],
		};
		const b = {
			lastModified: '2026-01-03T00:00:00.000Z',
			createdAt: '2025-12-01T00:00:00.000Z',
			messages: [{ role: 'user', displayContent: 'Alpha' }],
		};
		assert.ok(compareThreadsByOrdering(a, b, 'updated') > 0); // b newer updated
		assert.ok(compareThreadsByOrdering(a, b, 'created') < 0); // a newer created
		assert.ok(compareThreadsByOrdering(a, b, 'name') > 0); // Alpha before Beta
	});

	test('workspace group labels and key order', () => {
		assert.strictEqual(getWorkspaceGroupLabel(undefined, {}), WORKSPACE_BUCKET_UNASSIGNED);
		assert.strictEqual(getWorkspaceGroupLabel(null, {}), WORKSPACE_BUCKET_NO_REPO);
		assert.strictEqual(getWorkspaceGroupLabel('ws-1', { 'ws-1': { name: 'Orbit' } }), 'Orbit');

		assert.deepStrictEqual(
			orderGroupKeys(['Unassigned', 'Orbit', 'No Repo', 'Alpha'], 'workspace'),
			['Alpha', 'Orbit', 'No Repo', 'Unassigned'],
		);
	});

	test('groupThreads by workspace preserves sorted members', () => {
		const threads = [
			{ id: '1', agentWorkspaceId: 'ws-b', lastModified: '2026-01-02T00:00:00.000Z', messages: [] as { role: string; displayContent?: string }[] },
			{ id: '2', agentWorkspaceId: 'ws-a', lastModified: '2026-01-03T00:00:00.000Z', messages: [] },
			{ id: '3', agentWorkspaceId: null, lastModified: '2026-01-01T00:00:00.000Z', messages: [] },
			{ id: '4', lastModified: '2026-01-04T00:00:00.000Z', messages: [] },
		];
		const names = { 'ws-a': { name: 'Alpha' }, 'ws-b': { name: 'Beta' } };
		const { order, groups } = groupThreads(threads, 'workspace', names);
		assert.deepStrictEqual(order, ['Alpha', 'Beta', WORKSPACE_BUCKET_NO_REPO, WORKSPACE_BUCKET_UNASSIGNED]);
		assert.deepStrictEqual(groups['Alpha'].map(t => t.id), ['2']);
		assert.deepStrictEqual(groups['Beta'].map(t => t.id), ['1']);
		assert.strictEqual(getThreadGroupKey(threads[0], 'none', names), '');
	});
});
