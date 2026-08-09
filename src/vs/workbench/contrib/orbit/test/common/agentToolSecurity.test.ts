/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { getBuiltinToolPathUris, getPathAccessApprovalReason } from '../../common/agentToolSecurity.js';
import { assertAgentFileScheme, assertNoWorkspaceSymlinkTraversal } from '../../common/agentPathSecurity.js';
import { FileOperationError, FileOperationResult } from '../../../../../platform/files/common/files.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('agentToolSecurity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('extracts paths for every path-taking built-in tool', () => {
		const uri = URI.file('/workspace/src/app.ts');
		assert.deepStrictEqual(getBuiltinToolPathUris('Read', { uri }), [uri]);
		assert.deepStrictEqual(getBuiltinToolPathUris('Write', { path: uri }), [uri]);
		assert.deepStrictEqual(getBuiltinToolPathUris('StrReplace', { path: uri }), [uri]);
		assert.deepStrictEqual(getBuiltinToolPathUris('Grep', { path: uri }), [uri]);
		assert.deepStrictEqual(getBuiltinToolPathUris('Glob', { targetDirectory: uri }), [uri]);
		assert.deepStrictEqual(getBuiltinToolPathUris('CodebaseSearch', { path: uri }), [uri]);
		assert.deepStrictEqual(getBuiltinToolPathUris('Shell', {}), []);
		assert.deepStrictEqual(getBuiltinToolPathUris('Shell', { workingDirectory: '/workspace/src' }), [URI.file('/workspace/src')]);
	});

	test('allows ordinary files inside the workspace', () => {
		const reason = getPathAccessApprovalReason(
			'Read',
			{ uri: URI.file('/workspace/src/app.ts') },
			uri => uri.fsPath.startsWith('/workspace/'),
		);
		assert.strictEqual(reason, undefined);
	});

	test('requires approval outside the workspace', () => {
		const reason = getPathAccessApprovalReason(
			'Read',
			{ uri: URI.file('/tmp/untrusted.txt') },
			uri => uri.fsPath.startsWith('/workspace/'),
		);
		assert.match(reason ?? '', /outside your workspace/);
	});

	test('requires approval for sensitive files even inside the workspace', () => {
		for (const path of ['/workspace/.env', '/workspace/config/.env.production', '/workspace/.ssh/config', '/workspace/certs/signing.pem']) {
			const reason = getPathAccessApprovalReason('Read', { uri: URI.file(path) }, () => true);
			assert.match(reason ?? '', /sensitive path/, path);
		}
	});

	test('requires approval for unsupported URI schemes', () => {
		const reason = getPathAccessApprovalReason('Read', { uri: URI.parse('untitled:notes') }, () => false);
		assert.match(reason ?? '', /unsupported URI scheme/);
		assert.throws(() => assertAgentFileScheme(URI.parse('vscode-userdata:/User/settings.json')), /do not support/);
	});

	test('rejects symlink components underneath a workspace root', async () => {
		const workspace = URI.file('/workspace');
		const visited: string[] = [];
		await assert.rejects(
			assertNoWorkspaceSymlinkTraversal(
				URI.file('/workspace/vendor/secrets/config'),
				[workspace],
				async uri => {
					visited.push(uri.fsPath);
					return { isSymbolicLink: uri.fsPath === '/workspace/vendor/secrets' };
				},
			),
			/symbolic link/,
		);
		assert.deepStrictEqual(visited, ['/workspace/vendor', '/workspace/vendor/secrets']);
	});

	test('allows a missing write leaf but not a symlinked parent', async () => {
		const workspace = URI.file('/workspace');
		await assert.doesNotReject(assertNoWorkspaceSymlinkTraversal(
			URI.file('/workspace/src/new.ts'),
			[workspace],
			async uri => {
				if (uri.fsPath.endsWith('/new.ts')) throw new FileOperationError('missing', FileOperationResult.FILE_NOT_FOUND);
				return { isSymbolicLink: false };
			},
			true,
		));
		await assert.rejects(assertNoWorkspaceSymlinkTraversal(
			URI.file('/workspace/link/new.ts'),
			[workspace],
			async uri => ({ isSymbolicLink: uri.fsPath.endsWith('/link') }),
			true,
		), /symbolic link/);
	});
});
