/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License 2.0. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { fetchWithEndpointPolicy, isLoopbackHostname, remoteHttpEndpointPolicyError } from '../../common/networkSecurity.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Orbit network security policy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('allows HTTPS and unambiguous loopback HTTP only', () => {
		assert.strictEqual(remoteHttpEndpointPolicyError('https://example.com/mcp', 'endpoint'), undefined);
		assert.strictEqual(remoteHttpEndpointPolicyError('http://localhost:3000/mcp', 'endpoint'), undefined);
		assert.strictEqual(remoteHttpEndpointPolicyError('http://127.42.0.1:3000/mcp', 'endpoint'), undefined);
		assert.strictEqual(remoteHttpEndpointPolicyError('http://[::1]:3000/mcp', 'endpoint'), undefined);
		assert.match(remoteHttpEndpointPolicyError('http://example.com/mcp', 'endpoint') ?? '', /must use HTTPS/);
		assert.match(remoteHttpEndpointPolicyError('ftp://example.com/mcp', 'endpoint') ?? '', /must use HTTPS/);
		assert.match(remoteHttpEndpointPolicyError('https://user:pass@example.com/mcp', 'endpoint') ?? '', /must not contain credentials/);
	});

	test('does not confuse lookalike hosts with loopback', () => {
		assert.strictEqual(isLoopbackHostname('localhost'), true);
		assert.strictEqual(isLoopbackHostname('api.localhost'), true);
		assert.strictEqual(isLoopbackHostname('localhost.example.com'), false);
		assert.strictEqual(isLoopbackHostname('127.0.0.1.example.com'), false);
		assert.strictEqual(isLoopbackHostname('128.0.0.1'), false);
	});

	test('revalidates redirect targets before following them', async () => {
		const originalFetch = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return new Response(null, { status: 302, headers: { location: 'http://example.com/insecure' } });
		}) as typeof fetch;
		try {
			await assert.rejects(fetchWithEndpointPolicy('https://safe.example/start', undefined, 'endpoint'), /must use HTTPS/);
			assert.strictEqual(calls, 1, 'the insecure redirect target must not be requested');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test('strips credentials when a safe redirect crosses origins', async () => {
		const originalFetch = globalThis.fetch;
		const requests: Array<{ url: string; headers: Headers }> = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			requests.push({ url: request.url, headers: request.headers });
			if (requests.length === 1) return new Response(null, { status: 307, headers: { location: 'https://other.example/next' } });
			return new Response('{}', { status: 200 });
		}) as typeof fetch;
		try {
			await fetchWithEndpointPolicy('https://safe.example/start', { method: 'GET', headers: { Authorization: 'Bearer secret', Cookie: 'session=x' } }, 'endpoint');
			assert.strictEqual(requests.length, 2);
			assert.strictEqual(requests[1].url, 'https://other.example/next');
			assert.strictEqual(requests[1].headers.has('authorization'), false);
			assert.strictEqual(requests[1].headers.has('cookie'), false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test('does not replay a request body across origins', async () => {
		const originalFetch = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return new Response(null, { status: 307, headers: { location: 'https://other.example/collect' } });
		}) as typeof fetch;
		try {
			await assert.rejects(fetchWithEndpointPolicy('https://safe.example/start', { method: 'POST', body: 'private prompt' }, 'endpoint'), /would forward a request body/);
			assert.strictEqual(calls, 1);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
