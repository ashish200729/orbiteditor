/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	assertNoUnsupportedCapabilities,
	defaultRemoteTaskCapabilities,
	negotiateRunnerCapabilities,
} from '../../common/runner/capabilityNegotiation.js';
import { buildRunnerGitSpec, parseGitHubOrGitLabRemote } from '../../common/runner/gitRemoteHelpers.js';

suite('runner capability negotiation', () => {
	test('defaults agree on v1 supported set', () => {
		const result = negotiateRunnerCapabilities(defaultRemoteTaskCapabilities());
		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.agreed.browser, false);
			assert.strictEqual(result.agreed.computer_use, false);
			assert.strictEqual(result.agreed.semantic_search, false);
			assert.strictEqual(result.agreed.local_workspace_transfer, false);
			assert.strictEqual(result.agreed.git_github, true);
			assert.strictEqual(result.agreed.shell, true);
			// git_push is optional — not part of the default required request set
			assert.strictEqual(result.agreed.git_push, true);
		}
	});

	test('rejects browser when requested', () => {
		const result = negotiateRunnerCapabilities({ browser: true });
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.strictEqual(result.error.code, 'capability_unsupported');
			assert.ok(result.rejected.includes('browser') || result.unsupported.includes('browser'));
		}
	});

	test('rejects computer_use, semantic_search, local_workspace_transfer', () => {
		for (const key of ['computer_use', 'semantic_search', 'local_workspace_transfer'] as const) {
			const result = assertNoUnsupportedCapabilities({ [key]: true });
			assert.strictEqual(result.ok, false, key);
			if (!result.ok) {
				assert.ok(
					result.rejected.includes(key) || result.unsupported.includes(key),
					key,
				);
			}
		}
	});
});

suite('runner git remote helpers', () => {
	test('accepts github https', () => {
		const r = parseGitHubOrGitLabRemote('https://github.com/acme/app.git');
		assert.strictEqual(r.ok, true);
		if (r.ok) {
			assert.strictEqual(r.provider, 'github');
		}
	});

	test('accepts www.github.com https', () => {
		const r = parseGitHubOrGitLabRemote('https://www.github.com/acme/app.git');
		assert.strictEqual(r.ok, true);
		if (r.ok) {
			assert.strictEqual(r.provider, 'github');
		}
	});

	test('rejects gitlab ssh in v1', () => {
		const r = parseGitHubOrGitLabRemote('git@gitlab.com:group/project.git');
		assert.strictEqual(r.ok, false);
		if (!r.ok) {
			assert.strictEqual(r.error.code, 'repo_unsupported');
		}
	});

	test('accepts gitlab https', () => {
		const r = parseGitHubOrGitLabRemote('https://gitlab.com/group/project.git');
		assert.strictEqual(r.ok, true);
		if (r.ok) {
			assert.strictEqual(r.provider, 'gitlab');
		}
	});

	test('accepts www.gitlab.com https', () => {
		const r = parseGitHubOrGitLabRemote('https://www.gitlab.com/group/project.git');
		assert.strictEqual(r.ok, true);
		if (r.ok) {
			assert.strictEqual(r.provider, 'gitlab');
		}
	});

	test('rejects bitbucket', () => {
		const r = parseGitHubOrGitLabRemote('https://bitbucket.org/acme/app.git');
		assert.strictEqual(r.ok, false);
		if (!r.ok) {
			assert.strictEqual(r.error.code, 'repo_unsupported');
		}
	});

	test('buildRunnerGitSpec requires branch', () => {
		const r = buildRunnerGitSpec({ url: 'https://github.com/a/b', branch: '' });
		assert.strictEqual(r.ok, false);
	});

	test('buildRunnerGitSpec requires full commit SHA', () => {
		const r = buildRunnerGitSpec({
			url: 'https://github.com/a/b.git',
			branch: 'main',
			commit: 'abc1234',
		});
		assert.strictEqual(r.ok, false);
	});

	test('buildRunnerGitSpec succeeds', () => {
		const commit = '0123456789abcdef0123456789abcdef01234567';
		const r = buildRunnerGitSpec({
			url: 'https://github.com/a/b.git',
			branch: 'main',
			commit,
		});
		assert.strictEqual(r.ok, true);
		if (r.ok) {
			assert.strictEqual(r.git.branch, 'main');
			assert.strictEqual(r.git.commit, commit);
			assert.strictEqual(r.git.provider, 'github');
		}
	});
});
