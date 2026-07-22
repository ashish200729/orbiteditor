/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { filterThreadsByWorkspaceId } from '../../common/agentWorkspaceHelpers.js';

suite('agentWorkspaceThreadFilter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	type Thread = { id: string; agentWorkspaceId?: string | null; messages?: unknown[] };

	const threads: Thread[] = [
		{ id: 'legacy', messages: [{ role: 'user' }] },
		{ id: 'no-repo', agentWorkspaceId: null, messages: [{ role: 'user' }] },
		{ id: 'ws-a-1', agentWorkspaceId: 'ws-a', messages: [{ role: 'user' }] },
		{ id: 'ws-a-2', agentWorkspaceId: 'ws-a', messages: [{ role: 'user' }] },
		{ id: 'ws-b-1', agentWorkspaceId: 'ws-b', messages: [{ role: 'user' }] },
		{ id: 'empty-ws-a', agentWorkspaceId: 'ws-a', messages: [] },
	];

	test('scoped to workspace A excludes other workspaces and unassigned', () => {
		const result = filterThreadsByWorkspaceId(threads, 'ws-a', 'scoped');
		assert.deepStrictEqual(result.map(t => t.id).sort(), ['empty-ws-a', 'ws-a-1', 'ws-a-2']);
	});

	test('scoped to No Repo (null) only includes explicit null', () => {
		const result = filterThreadsByWorkspaceId(threads, null, 'scoped');
		assert.deepStrictEqual(result.map(t => t.id), ['no-repo']);
	});

	test('unassigned includes only legacy (undefined), not explicit No Repo null', () => {
		const result = filterThreadsByWorkspaceId(threads, 'ws-a', 'unassigned');
		assert.deepStrictEqual(result.map(t => t.id), ['legacy']);
	});

	test('all returns every thread', () => {
		assert.strictEqual(filterThreadsByWorkspaceId(threads, 'ws-a', 'all').length, threads.length);
	});
});
