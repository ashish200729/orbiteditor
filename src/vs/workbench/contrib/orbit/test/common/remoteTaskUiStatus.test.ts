/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	commandBarThreadStatus,
	isRemoteChatWaitingForResponse,
	isRemoteTaskTerminal,
	isRemoteTaskUiPhaseActive,
	remoteChatStatusLineLabel,
	remoteTaskUiPhase,
	remoteTaskUiPhaseLabel,
	remoteTaskUiPhaseStatusLabel,
	remoteTaskUiRunningValue,
} from '../../common/runner/remoteTaskUiStatus.js';
import type { RunnerTaskState } from '../../common/runner/runnerProtocol.js';
import type { RemoteTaskLiveState, RemoteTaskSummary } from '../../common/runner/runnerTypes.js';

const baseSummary = (state: RunnerTaskState): RemoteTaskSummary => ({
	taskId: '00000000-0000-4000-a000-000000000001',
	runnerId: 'runner_test',
	state,
	prompt: 'Fix the connection',
	createdAt: 1,
	updatedAt: 1,
	lastSeq: 0,
});

const live = (overrides: Partial<RemoteTaskLiveState> = {}): RemoteTaskLiveState => ({
	summary: baseSummary('RUNNING'),
	events: [],
	reconnecting: false,
	connected: false,
	...overrides,
});

suite('remoteTaskUiStatus', () => {
	suite('remoteTaskUiPhase', () => {
		test('returns idle when summary is missing', () => {
			assert.strictEqual(remoteTaskUiPhase(undefined, undefined), 'idle');
		});

		test('CREATED without connection → connecting (R1: not generic Running)', () => {
			assert.strictEqual(remoteTaskUiPhase(baseSummary('CREATED'), live({ connected: false })), 'connecting');
		});

		test('QUEUED without connection → connecting', () => {
			assert.strictEqual(remoteTaskUiPhase(baseSummary('QUEUED'), live({ connected: false })), 'connecting');
		});

		test('CREATED with connected WebSocket → provisioning (post-auth)', () => {
			assert.strictEqual(remoteTaskUiPhase(baseSummary('CREATED'), live({ connected: true })), 'provisioning');
		});

		test('provisioning states map to provisioning', () => {
			for (const state of ['ASSIGNED', 'PROVISIONING', 'PREPARING_WORKSPACE'] as RunnerTaskState[]) {
				assert.strictEqual(remoteTaskUiPhase(baseSummary(state), undefined), 'provisioning');
			}
		});

		test('running states map to running', () => {
			for (const state of ['RUNNING', 'VERIFYING', 'FINALIZING', 'CANCELLING'] as RunnerTaskState[]) {
				assert.strictEqual(remoteTaskUiPhase(baseSummary(state), undefined), 'running');
			}
		});

		test('WAITING_FOR_APPROVAL → awaiting', () => {
			assert.strictEqual(remoteTaskUiPhase(baseSummary('WAITING_FOR_APPROVAL'), undefined), 'awaiting');
		});

		test('pendingPermission in live state overrides to awaiting', () => {
			const s = baseSummary('RUNNING');
			const l = live({ summary: s, pendingPermission: { taskId: s.taskId, approvalId: 'a1', toolName: 'Bash', summary: 'run cmd', receivedAt: 1 } });
			assert.strictEqual(remoteTaskUiPhase(s, l), 'awaiting');
		});

		test('terminal states map to done / failed', () => {
			assert.strictEqual(remoteTaskUiPhase(baseSummary('COMPLETED'), undefined), 'done');
			assert.strictEqual(remoteTaskUiPhase(baseSummary('FAILED'), undefined), 'failed');
			assert.strictEqual(remoteTaskUiPhase(baseSummary('CANCELLED'), undefined), 'failed');
			assert.strictEqual(remoteTaskUiPhase(baseSummary('TIMED_OUT'), undefined), 'failed');
			assert.strictEqual(remoteTaskUiPhase(baseSummary('LOST'), undefined), 'failed');
		});

		test('reconnecting live state → reconnecting phase (non-terminal)', () => {
			assert.strictEqual(
				remoteTaskUiPhase(baseSummary('RUNNING'), live({ reconnecting: true, connected: false })),
				'reconnecting',
			);
			assert.strictEqual(remoteTaskUiPhaseLabel('reconnecting'), 'Reconnecting');
			// Terminal LOST should not show reconnecting even if flag is set.
			assert.strictEqual(
				remoteTaskUiPhase(baseSummary('LOST'), live({ reconnecting: true, connected: false })),
				'failed',
			);
		});
	});

	suite('remoteTaskUiRunningValue (services running-map)', () => {
		test('CREATED + !connected → idle (list shows spinner, R1)', () => {
			assert.strictEqual(remoteTaskUiRunningValue(baseSummary('CREATED'), live({ connected: false })), 'idle');
		});

		test('RUNNING → idle (generic spinner; precise phase shown in command bar)', () => {
			assert.strictEqual(remoteTaskUiRunningValue(baseSummary('RUNNING'), undefined), 'idle');
		});

		test('WAITING_FOR_APPROVAL → awaiting_user (wins over generic idle)', () => {
			assert.strictEqual(remoteTaskUiRunningValue(baseSummary('WAITING_FOR_APPROVAL'), undefined), 'awaiting_user');
		});

		test('terminal states → undefined (drop from running map)', () => {
			for (const state of ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LOST'] as RunnerTaskState[]) {
				assert.strictEqual(remoteTaskUiRunningValue(baseSummary(state), undefined), undefined);
			}
		});

		test('undefined summary → undefined', () => {
			assert.strictEqual(remoteTaskUiRunningValue(undefined, undefined), undefined);
		});

		test('connecting + provisioning → idle (still shows a spinner)', () => {
			assert.strictEqual(remoteTaskUiRunningValue(baseSummary('CREATED'), live({ connected: false })), 'idle');
			assert.strictEqual(remoteTaskUiRunningValue(baseSummary('PROVISIONING'), undefined), 'idle');
		});
	});

	suite('isRemoteTaskUiPhaseActive', () => {
		test('active for connecting/provisioning/running/awaiting', () => {
			assert.strictEqual(isRemoteTaskUiPhaseActive('connecting'), true);
			assert.strictEqual(isRemoteTaskUiPhaseActive('provisioning'), true);
			assert.strictEqual(isRemoteTaskUiPhaseActive('running'), true);
			assert.strictEqual(isRemoteTaskUiPhaseActive('awaiting'), true);
		});

		test('inactive for failed/done/idle', () => {
			assert.strictEqual(isRemoteTaskUiPhaseActive('failed'), false);
			assert.strictEqual(isRemoteTaskUiPhaseActive('done'), false);
			assert.strictEqual(isRemoteTaskUiPhaseActive('idle'), false);
		});
	});

	suite('remoteTaskUiPhaseLabel', () => {
		test('connecting → Connecting, provisioning → Provisioning, running → Running', () => {
			assert.strictEqual(remoteTaskUiPhaseLabel('connecting'), 'Connecting');
			assert.strictEqual(remoteTaskUiPhaseLabel('provisioning'), 'Provisioning');
			assert.strictEqual(remoteTaskUiPhaseLabel('running'), 'Running');
		});

		test('awaiting → Awaiting approval, failed → Failed, done → Done', () => {
			assert.strictEqual(remoteTaskUiPhaseLabel('awaiting'), 'Awaiting approval');
			assert.strictEqual(remoteTaskUiPhaseLabel('failed'), 'Failed');
			assert.strictEqual(remoteTaskUiPhaseLabel('done'), 'Done');
		});

		test('idle falls back to Done (terminal-ish display)', () => {
			assert.strictEqual(remoteTaskUiPhaseLabel('idle'), 'Done');
		});
	});

	suite('remoteTaskUiPhaseStatusLabel (in-stream friendly copy)', () => {
		test('connecting → Connecting to runner, provisioning → Setting up workspace', () => {
			assert.strictEqual(remoteTaskUiPhaseStatusLabel('connecting'), 'Connecting to runner');
			assert.strictEqual(remoteTaskUiPhaseStatusLabel('provisioning'), 'Setting up workspace');
		});

		test('running → Planning next moves (parity with local stream)', () => {
			assert.strictEqual(remoteTaskUiPhaseStatusLabel('running'), 'Planning next moves');
		});

		test('awaiting → Awaiting approval, failed → Failed, done → Done', () => {
			assert.strictEqual(remoteTaskUiPhaseStatusLabel('awaiting'), 'Awaiting approval');
			assert.strictEqual(remoteTaskUiPhaseStatusLabel('failed'), 'Failed');
			assert.strictEqual(remoteTaskUiPhaseStatusLabel('done'), 'Done');
		});

		test('idle falls back to Done', () => {
			assert.strictEqual(remoteTaskUiPhaseStatusLabel('idle'), 'Done');
		});
	});

	suite('isRemoteTaskTerminal', () => {
		test('true for terminal summaries, false for active/undefined', () => {
			assert.strictEqual(isRemoteTaskTerminal(baseSummary('COMPLETED')), true);
			assert.strictEqual(isRemoteTaskTerminal(baseSummary('FAILED')), true);
			assert.strictEqual(isRemoteTaskTerminal(baseSummary('RUNNING')), false);
			assert.strictEqual(isRemoteTaskTerminal(undefined), false);
		});
	});

	suite('commandBarThreadStatus (label matrix)', () => {
		test('awaiting_user + pending AskQuestion → Waiting for answers (yellow)', () => {
			assert.deepStrictEqual(
				commandBarThreadStatus({ effectiveIsRunning: 'awaiting_user', pendingAskQuestion: true }),
				{ title: 'Waiting for answers', color: 'yellow' },
			);
		});

		test('awaiting_user without AskQuestion → Awaiting approval (yellow)', () => {
			assert.deepStrictEqual(
				commandBarThreadStatus({ effectiveIsRunning: 'awaiting_user', pendingAskQuestion: false }),
				{ title: 'Awaiting approval', color: 'yellow' },
			);
		});

		test('generic running → Running (orange)', () => {
			assert.deepStrictEqual(
				commandBarThreadStatus({ effectiveIsRunning: 'LLM', pendingAskQuestion: false }),
				{ title: 'Running', color: 'orange' },
			);
		});

		test('running with remotePhaseLabel Connecting → Connecting (orange)', () => {
			assert.deepStrictEqual(
				commandBarThreadStatus({ effectiveIsRunning: 'idle', pendingAskQuestion: false, remotePhaseLabel: 'Connecting' }),
				{ title: 'Connecting', color: 'orange' },
			);
		});

		test('running with remotePhaseLabel Provisioning → Provisioning (orange)', () => {
			assert.deepStrictEqual(
				commandBarThreadStatus({ effectiveIsRunning: 'idle', pendingAskQuestion: false, remotePhaseLabel: 'Provisioning' }),
				{ title: 'Provisioning', color: 'orange' },
			);
		});

		test('not running + remoteFailed → Failed (dark)', () => {
			assert.deepStrictEqual(
				commandBarThreadStatus({ effectiveIsRunning: undefined, pendingAskQuestion: false, remoteFailed: true }),
				{ title: 'Failed', color: 'dark' },
			);
		});

		test('not running + draft (user msg, no assistant) → Draft (dark)', () => {
			assert.deepStrictEqual(
				commandBarThreadStatus({ effectiveIsRunning: undefined, pendingAskQuestion: false, isDraftThread: true }),
				{ title: 'Draft', color: 'dark' },
			);
		});

		test('not running, no draft, not failed → Done (dark)', () => {
			assert.deepStrictEqual(
				commandBarThreadStatus({ effectiveIsRunning: undefined, pendingAskQuestion: false, isDraftThread: false }),
				{ title: 'Done', color: 'dark' },
			);
		});

		test('running wins over remoteFailed (a still-running task is not "Failed")', () => {
			assert.deepStrictEqual(
				commandBarThreadStatus({ effectiveIsRunning: 'idle', pendingAskQuestion: false, remoteFailed: true, remotePhaseLabel: 'Running' }),
				{ title: 'Running', color: 'orange' },
			);
		});

		test('draft is suppressed while running', () => {
			assert.deepStrictEqual(
				commandBarThreadStatus({ effectiveIsRunning: 'LLM', pendingAskQuestion: false, isDraftThread: true }),
				{ title: 'Running', color: 'orange' },
			);
		});

		test('remoteFailed wins over draft (failed draft shows Failed)', () => {
			assert.deepStrictEqual(
				commandBarThreadStatus({ effectiveIsRunning: undefined, pendingAskQuestion: false, remoteFailed: true, isDraftThread: true }),
				{ title: 'Failed', color: 'dark' },
			);
		});

		test('awaiting_user wins over running state', () => {
			assert.deepStrictEqual(
				commandBarThreadStatus({ effectiveIsRunning: 'awaiting_user', pendingAskQuestion: false, remotePhaseLabel: 'Running' }),
				{ title: 'Awaiting approval', color: 'yellow' },
			);
		});
	});

	suite('remoteChatStatusLineLabel / isRemoteChatWaitingForResponse', () => {
		test('connecting without events → Connecting to runner', () => {
			assert.strictEqual(remoteChatStatusLineLabel({
				isStopping: false,
				phase: 'connecting',
				pendingApproval: false,
				hasRemoteEvents: false,
				tipMessages: [{ role: 'user', content: 'hi' }],
			}), 'Connecting to runner');
		});

		test('provisioning with events → null (RemoteSetupCard owns shimmer)', () => {
			assert.strictEqual(remoteChatStatusLineLabel({
				isStopping: false,
				phase: 'provisioning',
				pendingApproval: false,
				hasRemoteEvents: true,
				tipMessages: [{ role: 'tool', name: 'RemoteSetup', type: 'running_now' }],
			}), null);
		});

		test('running while waiting after user → Planning next moves', () => {
			assert.strictEqual(remoteChatStatusLineLabel({
				isStopping: false,
				phase: 'running',
				pendingApproval: false,
				hasRemoteEvents: true,
				tipMessages: [{ role: 'user', content: 'hi' }],
			}), 'Planning next moves');
		});

		test('running with assistant text → null', () => {
			assert.strictEqual(isRemoteChatWaitingForResponse([
				{ role: 'user', content: 'hi' },
				{ role: 'assistant', displayContent: 'Working on it' },
			]), false);
			assert.strictEqual(remoteChatStatusLineLabel({
				isStopping: false,
				phase: 'running',
				pendingApproval: false,
				hasRemoteEvents: true,
				tipMessages: [
					{ role: 'user', content: 'hi' },
					{ role: 'assistant', displayContent: 'Working on it' },
				],
			}), null);
		});

		test('running with non-setup tool running_now → null', () => {
			assert.strictEqual(isRemoteChatWaitingForResponse([
				{ role: 'user', content: 'hi' },
				{ role: 'tool', name: 'Shell', type: 'running_now' },
			]), false);
		});

		test('stopping wins', () => {
			assert.strictEqual(remoteChatStatusLineLabel({
				isStopping: true,
				phase: 'running',
				pendingApproval: false,
				hasRemoteEvents: true,
				tipMessages: [{ role: 'user', content: 'hi' }],
			}), 'Stopping');
		});
	});
});
