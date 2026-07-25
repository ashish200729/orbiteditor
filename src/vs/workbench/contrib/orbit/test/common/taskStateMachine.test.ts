/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	applyTaskStateTransition,
	canTransitionTaskState,
	getAllowedTransitions,
	isTerminalTaskState,
	validateTaskStateTransition,
} from '../../common/runner/taskStateMachine.js';
import type { RunnerTaskState } from '../../common/runner/runnerProtocol.js';

suite('runner taskStateMachine', () => {
	test('allows CREATED → QUEUED', () => {
		assert.strictEqual(canTransitionTaskState('CREATED', 'QUEUED'), true);
		assert.deepStrictEqual(validateTaskStateTransition('CREATED', 'QUEUED'), { ok: true, from: 'CREATED', to: 'QUEUED' });
	});

	test('allows RUNNING → WAITING_FOR_APPROVAL → RUNNING', () => {
		assert.strictEqual(canTransitionTaskState('RUNNING', 'WAITING_FOR_APPROVAL'), true);
		assert.strictEqual(canTransitionTaskState('WAITING_FOR_APPROVAL', 'RUNNING'), true);
	});

	test('rejects COMPLETED → RUNNING', () => {
		const result = validateTaskStateTransition('COMPLETED', 'RUNNING');
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.ok(result.reason.includes('COMPLETED'));
		}
	});

	test('same-state is not a transition (runner semantics) but validate allows republish', () => {
		assert.strictEqual(canTransitionTaskState('RUNNING', 'RUNNING'), false);
		assert.strictEqual(validateTaskStateTransition('RUNNING', 'RUNNING').ok, true);
		assert.strictEqual(applyTaskStateTransition('FAILED', 'FAILED').state, 'FAILED');
		assert.strictEqual(applyTaskStateTransition('FAILED', 'FAILED').error, undefined);
	});

	test('terminal states have no outgoing transitions', () => {
		const terminals: RunnerTaskState[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LOST'];
		for (const t of terminals) {
			assert.strictEqual(isTerminalTaskState(t), true);
			assert.deepStrictEqual(getAllowedTransitions(t), []);
		}
	});

	test('reconnect exhaustion path: RUNNING → LOST', () => {
		assert.strictEqual(canTransitionTaskState('RUNNING', 'LOST'), true);
		const applied = applyTaskStateTransition('RUNNING', 'LOST');
		assert.strictEqual(applied.state, 'LOST');
		assert.strictEqual(applied.error, undefined);
	});

	test('CREATED / QUEUED can also go LOST (editor reconnect give-up)', () => {
		assert.strictEqual(canTransitionTaskState('CREATED', 'LOST'), true);
		assert.strictEqual(canTransitionTaskState('QUEUED', 'LOST'), true);
	});

	test('applyTaskStateTransition keeps previous state on illegal move', () => {
		const applied = applyTaskStateTransition('COMPLETED', 'QUEUED');
		assert.strictEqual(applied.state, 'COMPLETED');
		assert.ok(applied.error);
	});

	test('happy-path provisioning chain', () => {
		const chain: RunnerTaskState[] = [
			'CREATED', 'QUEUED', 'ASSIGNED', 'PROVISIONING', 'PREPARING_WORKSPACE', 'RUNNING', 'FINALIZING', 'COMPLETED',
		];
		for (let i = 0; i < chain.length - 1; i++) {
			assert.strictEqual(canTransitionTaskState(chain[i], chain[i + 1]), true, `${chain[i]} → ${chain[i + 1]}`);
		}
	});

	test('allows operator deadline during every provisioning stage', () => {
		for (const state of ['ASSIGNED', 'PROVISIONING', 'PREPARING_WORKSPACE'] as RunnerTaskState[]) {
			assert.strictEqual(canTransitionTaskState(state, 'TIMED_OUT'), true, `${state} → TIMED_OUT`);
		}
	});

	// Fail-closed create + connect-timeout (Phase 1 R2/R3): the editor's
	// RemoteTaskService marks a stuck CREATED/QUEUED task FAILED when the
	// WebSocket never authenticates or no progress events arrive. The state
	// machine must permit those transitions for the fail-closed path to land.
	test('allows fail-closed CREATED → FAILED (connect/auth failure)', () => {
		assert.strictEqual(canTransitionTaskState('CREATED', 'FAILED'), true);
		assert.strictEqual(validateTaskStateTransition('CREATED', 'FAILED').ok, true);
	});

	test('allows fail-closed QUEUED → FAILED (no progress timeout)', () => {
		assert.strictEqual(canTransitionTaskState('QUEUED', 'FAILED'), true);
		assert.strictEqual(validateTaskStateTransition('QUEUED', 'FAILED').ok, true);
	});

	test('allows fail-closed CREATED → CANCELLED (user cancels pre-auth)', () => {
		assert.strictEqual(canTransitionTaskState('CREATED', 'CANCELLED'), true);
	});

	test('fail-closed target FAILED is terminal (Running stops clearing)', () => {
		assert.strictEqual(isTerminalTaskState('FAILED'), true);
		assert.deepStrictEqual(getAllowedTransitions('FAILED'), []);
	});

	test('applyTaskStateTransition lands on FAILED from a stuck CREATED task', () => {
		const applied = applyTaskStateTransition('CREATED', 'FAILED');
		assert.strictEqual(applied.state, 'FAILED');
		assert.strictEqual(applied.error, undefined);
	});

	test('applyTaskStateTransition lands on FAILED from a stuck QUEUED task', () => {
		const applied = applyTaskStateTransition('QUEUED', 'FAILED');
		assert.strictEqual(applied.state, 'FAILED');
		assert.strictEqual(applied.error, undefined);
	});

	test('a fail-closed FAILED task republish stays FAILED (no flicker back to running)', () => {
		assert.strictEqual(applyTaskStateTransition('FAILED', 'FAILED').state, 'FAILED');
		assert.strictEqual(validateTaskStateTransition('FAILED', 'FAILED').ok, true);
	});
});
