/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	parseArtifactBranch,
	parseArtifactPatch,
	parseArtifactPr,
} from '../../common/runner/remoteHandoffArtifacts.js';

suite('remote handoff artifacts', () => {
	test('parses artifact.branch', () => {
		const b = parseArtifactBranch({
			name: 'orbit/aaaaaaaa',
			baseCommit: '0123456789abcdef0123456789abcdef01234567',
			headCommit: 'abcdef0123456789abcdef0123456789abcdef01',
			baseBranch: 'main',
			pushed: true,
			hasChanges: true,
		});
		assert.ok(b);
		assert.strictEqual(b!.name, 'orbit/aaaaaaaa');
		assert.strictEqual(b!.pushed, true);
		assert.strictEqual(b!.hasChanges, true);
	});

	test('parses failed push reason', () => {
		const b = parseArtifactBranch({
			name: 'orbit/bbbbbbbb',
			baseCommit: '0123456789abcdef0123456789abcdef01234567',
			pushed: false,
			reason: 'Push skipped: allowlist',
			hasChanges: true,
		});
		assert.ok(b);
		assert.strictEqual(b!.pushed, false);
		assert.ok(b!.reason?.includes('allowlist'));
	});

	test('parses artifact.pr without stripping orbit/ prefix', () => {
		const pr = parseArtifactPr({
			url: 'https://github.com/acme/app/compare/main...orbit%2Faaaaaaaa?expand=1',
			kind: 'compare',
			baseBranch: 'main',
			headBranch: 'orbit/aaaaaaaa',
		});
		assert.ok(pr);
		assert.strictEqual(pr!.headBranch, 'orbit/aaaaaaaa');
		assert.ok(pr!.url.includes('orbit'));
	});

	test('parses artifact.patch truncation', () => {
		const p = parseArtifactPatch({
			baseCommit: '0123456789abcdef0123456789abcdef01234567',
			patch: 'diff --git a/x b/x\n',
			truncated: true,
			exitCode: 0,
		});
		assert.ok(p);
		assert.strictEqual(p!.truncated, true);
		assert.strictEqual(p!.exitCode, 0);
	});

	test('rejects invalid branch payload', () => {
		assert.strictEqual(parseArtifactBranch({ pushed: true }), undefined);
		assert.strictEqual(parseArtifactPr({ url: 'https://x' }), undefined);
	});
});
