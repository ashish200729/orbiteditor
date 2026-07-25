/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	RUNNER_DEFAULT_HTTP_PORT,
	RUNNER_DEFAULT_WS_PATH,
	RUNNER_DEFAULT_WS_PORT,
} from '../../common/runner/runnerProtocol.js';
import { isSecureRunnerUrl, normalizeRunnerHostUrl } from '../../common/runner/runnerHostUrl.js';

suite('runnerHostUrl', () => {
	test('defaults loopback missing port and path to WS endpoint', () => {
		assert.strictEqual(
			normalizeRunnerHostUrl('127.0.0.1'),
			`ws://127.0.0.1:${RUNNER_DEFAULT_WS_PORT}${RUNNER_DEFAULT_WS_PATH}`,
		);
		assert.strictEqual(
			normalizeRunnerHostUrl('ws://localhost'),
			`ws://localhost:${RUNNER_DEFAULT_WS_PORT}${RUNNER_DEFAULT_WS_PATH}`,
		);
	});

	test('remaps loopback dashboard port 7420 to WS port 7421', () => {
		assert.strictEqual(
			normalizeRunnerHostUrl(`http://127.0.0.1:${RUNNER_DEFAULT_HTTP_PORT}`),
			`ws://127.0.0.1:${RUNNER_DEFAULT_WS_PORT}${RUNNER_DEFAULT_WS_PATH}`,
		);
		assert.strictEqual(
			normalizeRunnerHostUrl(`ws://localhost:${RUNNER_DEFAULT_HTTP_PORT}/ws`),
			`ws://localhost:${RUNNER_DEFAULT_WS_PORT}${RUNNER_DEFAULT_WS_PATH}`,
		);
	});

	test('preserves explicit non-dashboard WS port', () => {
		assert.strictEqual(
			normalizeRunnerHostUrl('ws://127.0.0.1:7421/ws'),
			`ws://127.0.0.1:${RUNNER_DEFAULT_WS_PORT}${RUNNER_DEFAULT_WS_PATH}`,
		);
		assert.strictEqual(
			normalizeRunnerHostUrl('ws://127.0.0.1:9000/ws'),
			'ws://127.0.0.1:9000/ws',
		);
	});

	test('rejects credentials, query, and hash', () => {
		assert.strictEqual(normalizeRunnerHostUrl('ws://user:pass@127.0.0.1:7421/ws'), undefined);
		assert.strictEqual(normalizeRunnerHostUrl('ws://127.0.0.1:7421/ws?x=1'), undefined);
		assert.strictEqual(normalizeRunnerHostUrl('ws://127.0.0.1:7421/ws#frag'), undefined);
	});

	test('isSecureRunnerUrl allows loopback ws and any wss', () => {
		assert.strictEqual(isSecureRunnerUrl('ws://127.0.0.1:7421/ws'), true);
		assert.strictEqual(isSecureRunnerUrl('ws://localhost:7421/ws'), true);
		assert.strictEqual(isSecureRunnerUrl('wss://runner.example.com/ws'), true);
		assert.strictEqual(isSecureRunnerUrl('ws://192.168.1.10:7421/ws'), false);
	});
});
