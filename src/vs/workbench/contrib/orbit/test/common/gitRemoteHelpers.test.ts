/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	buildRunnerGitSpec,
	isSshGitRemote,
	parseGitHubOrGitLabRemote,
} from '../../common/runner/gitRemoteHelpers.js';

suite('gitRemoteHelpers', () => {
	test('detects SSH remotes', () => {
		assert.strictEqual(isSshGitRemote('git@github.com:org/repo.git'), true);
		assert.strictEqual(isSshGitRemote('ssh://git@github.com/org/repo.git'), true);
		assert.strictEqual(isSshGitRemote('https://github.com/org/repo.git'), false);
	});

	test('rejects SSH remotes without converting to HTTPS', () => {
		const parsed = parseGitHubOrGitLabRemote('git@github.com:org/repo.git');
		assert.strictEqual(parsed.ok, false);
		if (!parsed.ok) {
			assert.strictEqual(parsed.error.code, 'repo_unsupported');
			assert.ok(parsed.error.message.includes('SSH'));
		}
	});

	test('accepts HTTPS github.com / gitlab.com', () => {
		const gh = parseGitHubOrGitLabRemote('https://github.com/org/repo');
		assert.strictEqual(gh.ok, true);
		if (gh.ok) {
			assert.strictEqual(gh.provider, 'github');
		}
		const gl = parseGitHubOrGitLabRemote('https://gitlab.com/org/repo');
		assert.strictEqual(gl.ok, true);
		if (gl.ok) {
			assert.strictEqual(gl.provider, 'gitlab');
		}
	});

	test('rejects enterprise hosts with clear copy', () => {
		const parsed = parseGitHubOrGitLabRemote('https://github.mycompany.com/org/repo');
		assert.strictEqual(parsed.ok, false);
		if (!parsed.ok) {
			assert.ok(parsed.error.message.toLowerCase().includes('enterprise') || parsed.error.message.includes('not supported'));
		}
	});

	test('buildRunnerGitSpec requires full SHA and rejects SSH', () => {
		const ssh = buildRunnerGitSpec({
			url: 'git@github.com:org/repo.git',
			branch: 'main',
			commit: 'a'.repeat(40),
		});
		assert.strictEqual(ssh.ok, false);

		const short = buildRunnerGitSpec({
			url: 'https://github.com/org/repo',
			branch: 'main',
			commit: 'abc',
		});
		assert.strictEqual(short.ok, false);

		const ok = buildRunnerGitSpec({
			url: 'https://github.com/org/repo',
			branch: 'main',
			commit: 'a'.repeat(40),
		});
		assert.strictEqual(ok.ok, true);
	});
});
