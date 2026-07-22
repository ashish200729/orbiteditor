/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { isLinux, isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	addFolderToWorkspace,
	buildWorkspaceDisplayName,
	canMigrateLegacyTerminalsToWorkspace,
	createWorkspaceFromFolders,
	filterThreadsByWorkspaceId,
	findNewestThreadIdInExactScope,
	getActiveFoldersAsUris,
	isUriInsideFolders,
	isValidWorkspaceFolderName,
	normalizeFolderUriKey,
	parseAgentWorkspaceState,
	removeFolderFromWorkspace,
	resolveDisplayPath,
	setActiveWorkspaceId,
} from '../../common/agentWorkspaceHelpers.js';
import { EMPTY_AGENT_WORKSPACE_STATE } from '../../common/agentProjectWorkspaceTypes.js';

suite('agentWorkspaceHelpers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('normalizeFolderUriKey follows host path-casing rules', () => {
		const a = URI.file('/Users/Ashish/Code/Orbit');
		const b = URI.file('/Users/ashish/code/orbit');
		if (isLinux) {
			assert.notStrictEqual(normalizeFolderUriKey(a), normalizeFolderUriKey(b));
		} else {
			assert.strictEqual(normalizeFolderUriKey(a), normalizeFolderUriKey(b));
		}
	});

	test('buildWorkspaceDisplayName', () => {
		assert.strictEqual(buildWorkspaceDisplayName([]), 'No Repo');
		assert.strictEqual(buildWorkspaceDisplayName([{ uri: 'file:///a/orbit-editor', name: 'orbit-editor' }]), 'orbit-editor');
		assert.strictEqual(
			buildWorkspaceDisplayName([
				{ uri: 'file:///a/orbit-editor', name: 'orbit-editor' },
				{ uri: 'file:///a/lori', name: 'Lori' },
				{ uri: 'file:///a/vxbot', name: 'vxbot' },
			]),
			'orbit-editor + 2 more',
		);
	});

	test('resolveDisplayPath uses platform-appropriate home display', () => {
		const uri = URI.file('/Users/ashish/code/orbit-editor');
		const display = resolveDisplayPath(uri, '/Users/ashish');
		if (isWindows) {
			assert.strictEqual(display, uri.fsPath);
		} else {
			assert.ok(display.startsWith('~/'), display);
		}
		assert.ok(display.includes('orbit-editor'), display);
	});

	test('createWorkspaceFromFolders dedupes URIs and reuses matching workspace', () => {
		const uri = URI.file('/tmp/proj-a');
		const first = createWorkspaceFromFolders([uri, uri]);
		assert.strictEqual(first.workspace.folders.length, 1);
		assert.strictEqual(first.state.activeWorkspaceId, first.workspace.id);

		const second = createWorkspaceFromFolders([uri], first.state);
		assert.strictEqual(second.workspace.id, first.workspace.id);
	});

	test('addFolderToWorkspace and removeFolderFromWorkspace', () => {
		const a = URI.file('/tmp/a');
		const b = URI.file('/tmp/b');
		let { state, workspace } = createWorkspaceFromFolders([a]);
		state = addFolderToWorkspace(state, workspace.id, b)!;
		assert.strictEqual(state.workspaces[workspace.id].folders.length, 2);
		assert.strictEqual(state.workspaces[workspace.id].name, 'a + 1 more');

		// Dedupe
		const same = addFolderToWorkspace(state, workspace.id, b);
		assert.strictEqual(same, null);

		state = removeFolderFromWorkspace(state, workspace.id, a)!;
		assert.strictEqual(state.workspaces[workspace.id].folders.length, 1);

		// Removing last folder clears workspace
		state = removeFolderFromWorkspace(state, workspace.id, b)!;
		assert.strictEqual(state.activeWorkspaceId, null);
		assert.strictEqual(state.workspaces[workspace.id], undefined);
	});

	test('setActiveWorkspaceId No Repo and switch', () => {
		const { state, workspace } = createWorkspaceFromFolders([URI.file('/tmp/x')]);
		const cleared = setActiveWorkspaceId(state, null);
		assert.strictEqual(cleared.activeWorkspaceId, null);
		assert.ok(cleared.workspaces[workspace.id]);

		const reactivated = setActiveWorkspaceId(cleared, workspace.id);
		assert.strictEqual(reactivated.activeWorkspaceId, workspace.id);
	});

	test('getActiveFoldersAsUris', () => {
		const uri = URI.file('/tmp/y');
		const { state } = createWorkspaceFromFolders([uri]);
		const folders = getActiveFoldersAsUris(state);
		assert.strictEqual(folders.length, 1);
		assert.strictEqual(folders[0].fsPath, uri.fsPath);

		const empty = getActiveFoldersAsUris(setActiveWorkspaceId(state, null));
		assert.strictEqual(empty.length, 0);
	});

	test('isUriInsideFolders respects path boundaries', () => {
		const root = URI.file('/tmp/foo');
		assert.ok(isUriInsideFolders(URI.file('/tmp/foo'), [root]));
		assert.ok(isUriInsideFolders(URI.file('/tmp/foo/bar.ts'), [root]));
		assert.ok(!isUriInsideFolders(URI.file('/tmp/foobar'), [root]));
		assert.ok(!isUriInsideFolders(URI.file('/tmp/other'), [root]));
	});

	test('isUriInsideFolders follows host path-casing rules', () => {
		const root = URI.file('/tmp/Orbit');
		const candidate = URI.file('/tmp/orbit/src/index.ts');
		assert.strictEqual(isUriInsideFolders(candidate, [root]), !isLinux);
	});

	test('Windows folder names reject reserved names and characters', () => {
		assert.strictEqual(isValidWorkspaceFolderName('project', true), true);
		assert.strictEqual(isValidWorkspaceFolderName('CON', true), false);
		assert.strictEqual(isValidWorkspaceFolderName('aux.txt', true), false);
		assert.strictEqual(isValidWorkspaceFolderName('project.', true), false);
		assert.strictEqual(isValidWorkspaceFolderName('project ', true), false);
		assert.strictEqual(isValidWorkspaceFolderName('project:name', true), false);
		assert.strictEqual(isValidWorkspaceFolderName('project/name', true), false);
		assert.strictEqual(isValidWorkspaceFolderName(`bad${String.fromCharCode(0)}name`, true), false);
	});

	test('macOS/POSIX folder names allow Windows-only characters', () => {
		assert.strictEqual(isValidWorkspaceFolderName('project:name', false), true);
		assert.strictEqual(isValidWorkspaceFolderName('CON', false), true);
		assert.strictEqual(isValidWorkspaceFolderName('project/name', false), false);
	});

	test('filterThreadsByWorkspaceId', () => {
		const threads = [
			{ id: '1', agentWorkspaceId: 'ws-a' },
			{ id: '2', agentWorkspaceId: 'ws-b' },
			{ id: '3', agentWorkspaceId: null },
			{ id: '4' },
		];
		assert.deepStrictEqual(
			filterThreadsByWorkspaceId(threads, 'ws-a', 'scoped').map(t => t.id),
			['1'],
		);
		assert.deepStrictEqual(
			filterThreadsByWorkspaceId(threads, null, 'scoped').map(t => t.id),
			['3'],
		);
		assert.deepStrictEqual(
			filterThreadsByWorkspaceId(threads, 'ws-a', 'unassigned').map(t => t.id),
			['4'],
		);
		assert.strictEqual(filterThreadsByWorkspaceId(threads, 'ws-a', 'all').length, 4);
	});

	test('findNewestThreadIdInExactScope never crosses IDE, No Repo, or workspace scopes', () => {
		const threads = [
			{ id: 'ide-newest', lastModified: '2026-01-05T00:00:00.000Z' },
			{ id: 'no-repo', agentWorkspaceId: null, lastModified: '2026-01-04T00:00:00.000Z' },
			{ id: 'ws-a-old', agentWorkspaceId: 'ws-a', lastModified: '2026-01-01T00:00:00.000Z' },
			{ id: 'ws-a-new', agentWorkspaceId: 'ws-a', lastModified: '2026-01-03T00:00:00.000Z' },
			{ id: 'ws-b', agentWorkspaceId: 'ws-b', lastModified: '2026-01-06T00:00:00.000Z' },
		];
		assert.strictEqual(findNewestThreadIdInExactScope(threads, undefined), 'ide-newest');
		assert.strictEqual(findNewestThreadIdInExactScope(threads, null), 'no-repo');
		assert.strictEqual(findNewestThreadIdInExactScope(threads, 'ws-a'), 'ws-a-new');
	});

	test('legacy terminals cannot migrate into No Repo or an unrelated workspace', () => {
		const entries = [{ workspaceFolderUri: 'file:///repo-a' }];
		assert.strictEqual(canMigrateLegacyTerminalsToWorkspace(entries, null, ['file:///repo-a']), false);
		assert.strictEqual(canMigrateLegacyTerminalsToWorkspace(entries, 'ws-b', ['file:///repo-b']), false);
		assert.strictEqual(canMigrateLegacyTerminalsToWorkspace(entries, 'ws-a', ['file:///repo-a']), true);
		assert.strictEqual(canMigrateLegacyTerminalsToWorkspace([{}], 'ws-a', ['file:///repo-a']), false);
	});

	test('parseAgentWorkspaceState handles corrupt / empty input', () => {
		assert.deepStrictEqual(parseAgentWorkspaceState(undefined).activeWorkspaceId, null);
		assert.deepStrictEqual(parseAgentWorkspaceState('not-json').workspaces, {});
		const valid = parseAgentWorkspaceState(JSON.stringify({
			activeWorkspaceId: 'abc',
			workspaces: {
				abc: {
					id: 'abc',
					name: 'orbit-editor',
					folders: [{ uri: 'file:///tmp/orbit-editor', name: 'orbit-editor' }],
					environment: 'local',
					createdAt: '2026-01-01T00:00:00.000Z',
					lastUsedAt: '2026-01-01T00:00:00.000Z',
				},
			},
			recents: ['abc', 'missing'],
		}));
		assert.strictEqual(valid.activeWorkspaceId, 'abc');
		assert.deepStrictEqual(valid.recents, ['abc']);
	});

	test('EMPTY_AGENT_WORKSPACE_STATE is No Repo', () => {
		assert.strictEqual(EMPTY_AGENT_WORKSPACE_STATE.activeWorkspaceId, null);
	});
});
