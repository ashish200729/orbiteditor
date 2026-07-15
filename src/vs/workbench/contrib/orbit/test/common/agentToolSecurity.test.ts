/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { getBuiltinToolPathUris, getPathAccessApprovalReason } from '../../common/agentToolSecurity.js';

suite('agentToolSecurity', () => {
	test('extracts paths for every path-taking built-in tool', () => {
		const uri = URI.file('/workspace/src/app.ts');
		assert.deepStrictEqual(getBuiltinToolPathUris('Read', { uri }), [uri]);
		assert.deepStrictEqual(getBuiltinToolPathUris('Write', { path: uri }), [uri]);
		assert.deepStrictEqual(getBuiltinToolPathUris('StrReplace', { path: uri }), [uri]);
		assert.deepStrictEqual(getBuiltinToolPathUris('Grep', { path: uri }), [uri]);
		assert.deepStrictEqual(getBuiltinToolPathUris('Glob', { targetDirectory: uri }), [uri]);
		assert.deepStrictEqual(getBuiltinToolPathUris('CodebaseSearch', { path: uri }), [uri]);
		assert.deepStrictEqual(getBuiltinToolPathUris('Shell', {}), []);
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

	test('ignores non-filesystem schemes', () => {
		const reason = getPathAccessApprovalReason('Read', { uri: URI.parse('untitled:notes') }, () => false);
		assert.strictEqual(reason, undefined);
	});
});
