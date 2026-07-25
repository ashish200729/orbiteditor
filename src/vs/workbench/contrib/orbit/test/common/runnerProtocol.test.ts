/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	RUNNER_PROTOCOL_VERSION,
	RUNNER_CAPABILITY_KEYS,
	createRunnerEnvelope,
	formatRunnerError,
	generateRunnerMessageId,
	isRunnerProtocolVersion,
	isRunnerTaskState,
	parseRunnerWireJson,
	parseRunnerWireMessage,
	validateRunnerWelcome,
} from '../../common/runner/runnerProtocol.js';

suite('runnerProtocol validation', () => {
	test('recognizes protocol version', () => {
		assert.strictEqual(isRunnerProtocolVersion(RUNNER_PROTOCOL_VERSION), true);
		assert.strictEqual(isRunnerProtocolVersion('orbit-runner-protocol/0'), false);
	});

	test('recognizes task states', () => {
		assert.strictEqual(isRunnerTaskState('WAITING_FOR_APPROVAL'), true);
		assert.strictEqual(isRunnerTaskState('NOT_A_STATE'), false);
	});

	test('parseRunnerWireMessage accepts a valid welcome', () => {
		const msg = createRunnerEnvelope('welcome', {
			runnerId: 'r1',
			runnerVersion: '0.1.0',
			protocol: RUNNER_PROTOCOL_VERSION,
			capabilities: {
				browser: false,
				computer_use: false,
				semantic_search: false,
				local_workspace_transfer: false,
				git_github: true,
				git_gitlab: true,
				git_push: true,
				shell: true,
				file_tools: true,
			},
			uiLabel: 'Self-hosted Runner',
			transportMode: 'direct',
		});
		const result = parseRunnerWireMessage(msg);
		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.message.type, 'welcome');
			assert.strictEqual(result.message.protocol, RUNNER_PROTOCOL_VERSION);
		}
	});

	test('rejects wrong protocol version', () => {
		const result = parseRunnerWireMessage({
			protocol: 'orbit-runner-protocol/99',
			id: '00000000-0000-4000-a000-000000000001',
			ts: Date.now(),
			type: 'hello',
			payload: {},
		});
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.strictEqual(result.error.code, 'protocol_version_mismatch');
		}
	});

	test('rejects missing payload', () => {
		const result = parseRunnerWireMessage({
			protocol: RUNNER_PROTOCOL_VERSION,
			id: '00000000-0000-4000-a000-000000000001',
			ts: Date.now(),
			type: 'hello',
		});
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.strictEqual(result.error.code, 'invalid_message');
		}
	});

	test('rejects unknown message type', () => {
		const result = parseRunnerWireMessage({
			protocol: RUNNER_PROTOCOL_VERSION,
			id: '00000000-0000-4000-a000-000000000001',
			ts: Date.now(),
			type: 'not.a.real.type',
			payload: {},
		});
		assert.strictEqual(result.ok, false);
	});

	test('parseRunnerWireJson parses JSON text', () => {
		const msg = createRunnerEnvelope('heartbeat', { lastAckSeq: 0 });
		const result = parseRunnerWireJson(JSON.stringify(msg));
		assert.strictEqual(result.ok, true);
	});

	test('parseRunnerWireJson rejects invalid JSON', () => {
		const result = parseRunnerWireJson('{not json');
		assert.strictEqual(result.ok, false);
	});

	test('formatRunnerError maps pairing_expired', () => {
		const text = formatRunnerError({ code: 'pairing_expired', message: 'gone' });
		assert.ok(text.toLowerCase().includes('expired'));
	});

	test('formatRunnerError maps runner wire EXPIRED / INVALID_CODE / CAPABILITY_UNSUPPORTED', () => {
		assert.ok(formatRunnerError({ code: 'EXPIRED', message: 'Pairing code expired' }).toLowerCase().includes('expired'));
		assert.ok(formatRunnerError({ code: 'INVALID_CODE', message: 'Invalid pairing code' }).toLowerCase().includes('invalid'));
		assert.ok(formatRunnerError({ code: 'CAPABILITY_UNSUPPORTED', message: 'browser' }).includes('Unsupported capability'));
		assert.ok(formatRunnerError({ code: 'UNAUTHORIZED', message: 'nope' }).includes('nope'));
	});

	test('formatRunnerError maps continuation / conflict / provision codes', () => {
		assert.ok(formatRunnerError({ code: 'CONTINUATION_UNAVAILABLE', message: '' }).toLowerCase().includes('continuation'));
		assert.ok(formatRunnerError({ code: 'TASK_ID_CONFLICT', message: '' }).toLowerCase().includes('already exists'));
		assert.ok(formatRunnerError({ code: 'INVALID_STATE', message: '' }).toLowerCase().includes('state'));
		assert.ok(formatRunnerError({ code: 'provision_failed', message: '' }).toLowerCase().includes('provision'));
		assert.ok(formatRunnerError({ code: 'NOT_FOUND', message: '' }).toLowerCase().includes('not found'));
	});

	test('RUNNER_CAPABILITY_KEYS includes provider_sync', () => {
		assert.ok(RUNNER_CAPABILITY_KEYS.includes('provider_sync'));
	});

	test('validateRunnerWelcome accepts matching protocol and direct transport', () => {
		const ok = validateRunnerWelcome({
			protocol: RUNNER_PROTOCOL_VERSION,
			transportMode: 'direct',
		});
		assert.strictEqual(ok.ok, true);
	});

	test('validateRunnerWelcome rejects protocol mismatch and relay transport', () => {
		const badProto = validateRunnerWelcome({ protocol: 'orbit-runner-protocol/99', transportMode: 'direct' });
		assert.strictEqual(badProto.ok, false);
		const badTransport = validateRunnerWelcome({ protocol: RUNNER_PROTOCOL_VERSION, transportMode: 'relay' });
		assert.strictEqual(badTransport.ok, false);
	});

	test('generateRunnerMessageId fallback is UUID-shaped', () => {
		const id = generateRunnerMessageId();
		assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
	});

	test('createRunnerEnvelope stamps protocol and id', () => {
		const env = createRunnerEnvelope('task.cancel', { taskId: '00000000-0000-4000-a000-000000000099' });
		assert.strictEqual(env.protocol, RUNNER_PROTOCOL_VERSION);
		assert.ok(env.id.length > 0);
		assert.strictEqual(env.type, 'task.cancel');
	});
});
