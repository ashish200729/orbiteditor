/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { remoteTaskChatMessages, shouldSkipRemoteUserMessage } from '../../common/runner/remoteTaskChatMessages.js';
import type { ChatMessage } from '../../common/chatThreadServiceTypes.js';
import type { RunnerTaskEventPayload } from '../../common/runner/runnerProtocol.js';
import type { RemoteTaskSummary } from '../../common/runner/runnerTypes.js';

const summary: RemoteTaskSummary = {
	taskId: '00000000-0000-4000-a000-000000000001',
	runnerId: 'runner_test',
	state: 'RUNNING',
	prompt: 'Fix the connection',
	git: { provider: 'github', repoUrl: 'https://github.com/acme/repo.git', branch: 'main', commit: 'abcdef1234567890' },
	createdAt: 1,
	updatedAt: 1,
	lastSeq: 3,
};

const event = (seq: number, kind: string, data: unknown): RunnerTaskEventPayload => ({
	taskId: summary.taskId,
	seq,
	kind,
	data,
	ts: seq + 1,
});

suite('remoteTaskChatMessages', () => {
	test('renders remote reasoning, tools, and responses through local chat messages', () => {
		const events = [
			event(0, 'agent.reasoning', { content: 'Inspecting the protocol.' }),
			event(1, 'tool.start', { toolCallId: 'call_1', name: 'Read', args: { path: 'src/index.ts' } }),
			event(2, 'tool.result', { toolCallId: 'call_1', name: 'Read', ok: true, output: 'file contents' }),
			event(3, 'agent.message', { content: 'The connection is fixed.' }),
		];
		const messages = remoteTaskChatMessages(summary, events);

		assert.strictEqual(messages[0].role, 'user');
		assert.strictEqual(messages[1].role, 'assistant');
		if (messages[1].role === 'assistant') assert.strictEqual(messages[1].reasoning, 'Inspecting the protocol.');
		assert.strictEqual(messages[2].role, 'tool');
		if (messages[2].role === 'tool') {
			assert.strictEqual(messages[2].type, 'success');
			assert.strictEqual(messages[2].id, 'call_1');
			assert.strictEqual(messages[2].content, 'file contents');
			const structured = messages[2].result as { kind: string; fileContents: string };
			assert.strictEqual(structured.kind, 'text');
			assert.strictEqual(structured.fileContents, 'file contents');
		}
		assert.strictEqual(messages[3].role, 'assistant');
		if (messages[3].role === 'assistant') assert.strictEqual(messages[3].displayContent, 'The connection is fixed.');
	});

	test('deduplicates final text already emitted as an agent message', () => {
		const messages = remoteTaskChatMessages(summary, [
			event(0, 'agent.message', { content: 'Done.' }),
			event(1, 'agent.done', { status: 'completed', finalText: 'Done.' }),
		]);
		assert.strictEqual(messages.filter(message => message.role === 'assistant').length, 1);
	});

	test('skips synthetic user bubble when local user message exists', () => {
		const localMessages: ChatMessage[] = [{
			role: 'user',
			content: summary.prompt,
			displayContent: summary.prompt,
			selections: [],
			state: { stagingSelections: [], isBeingEdited: false },
		}];
		assert.strictEqual(shouldSkipRemoteUserMessage(summary, localMessages, 1), true);
		const messages = remoteTaskChatMessages(summary, [
			event(0, 'agent.message', { content: 'Working…' }),
		], { skipUserMessage: true });
		assert.strictEqual(messages.length, 1);
		assert.strictEqual(messages[0].role, 'assistant');
	});

	test('maps lifecycle queue and workspace state events to RemoteSetup card (not Thought)', () => {
		const messages = remoteTaskChatMessages(summary, [
			event(0, 'queue.wait', { reason: 'max concurrent' }),
			event(1, 'state', { from: 'ASSIGNED', to: 'PROVISIONING' }),
			event(2, 'state', { from: 'PROVISIONING', to: 'PREPARING_WORKSPACE', branch: 'main', commit: 'abcdef1234567890' }),
			event(3, 'model.resolved', { modelId: 'gpt-test' }),
		]);
		const setup = messages.find(message => message.role === 'tool' && message.name === 'RemoteSetup');
		assert.ok(setup && setup.role === 'tool');
		if (!setup || setup.role !== 'tool') {
			return;
		}
		assert.strictEqual(setup.type, 'running_now');
		const params = setup.params as { steps: Array<{ id: string; label: string; detail?: string }>; phase?: string };
		assert.ok(params.steps.some(step => step.label.includes('Waiting for a runner')));
		assert.ok(params.steps.some(step => step.label.includes('Preparing environment')));
		assert.ok(params.steps.some(step => step.label.includes('Setting up workspace')));
		assert.ok(params.steps.some(step => step.detail?.includes('main') && step.detail?.includes('abcdef1')));
		assert.strictEqual(params.phase, 'workspace');
		assert.ok(!params.steps.some(step => step.label.includes('Model:')));
		assert.ok(!messages.some(message => message.role === 'assistant' && message.reasoning?.includes('Preparing environment')));
		assert.ok(!messages.some(message => message.role === 'tool' && message.name === 'Shell'));
	});

	test('maps approval.requested to tool_request before tool.start', () => {
		const messages = remoteTaskChatMessages(summary, [
			event(0, 'approval.requested', {
				approvalId: 'appr_1',
				toolCallId: 'call_shell',
				toolName: 'Shell',
				toolArgs: { command: 'ls' },
				reason: 'Run terminal command?',
			}),
			event(1, 'approval.resolved', {
				approvalId: 'appr_1',
				toolCallId: 'call_shell',
				decision: 'allow',
			}),
			event(2, 'tool.start', {
				toolCallId: 'call_shell',
				name: 'Shell',
				args: { command: 'ls' },
			}),
			event(3, 'tool.result', {
				toolCallId: 'call_shell',
				name: 'Shell',
				ok: true,
				output: 'ok',
			}),
		], { skipUserMessage: true });
		const tools = messages.filter(message => message.role === 'tool' && message.name === 'Shell');
		assert.strictEqual(tools.length, 1);
		const shell = tools[0];
		assert.ok(shell && shell.role === 'tool');
		if (shell?.role === 'tool') {
			assert.strictEqual(shell.type, 'success');
		}
	});

	test('keeps real agent reasoning in Thought and completes RemoteSetup first', () => {
		const messages = remoteTaskChatMessages(summary, [
			event(0, 'state', { from: 'ASSIGNED', to: 'PROVISIONING' }),
			event(1, 'state', { from: 'PROVISIONING', to: 'PREPARING_WORKSPACE', branch: 'main', commit: 'abcdef1234567890' }),
			event(2, 'agent.reasoning', { content: 'Inspecting the protocol.' }),
		]);
		const setup = messages.find(message => message.role === 'tool' && message.name === 'RemoteSetup');
		assert.ok(setup && setup.role === 'tool' && setup.type === 'success');
		const thought = messages.find(message => message.role === 'assistant' && message.reasoning);
		assert.ok(thought && thought.role === 'assistant');
		if (thought?.role === 'assistant') {
			assert.strictEqual(thought.reasoning, 'Inspecting the protocol.');
			assert.ok(!thought.reasoning.includes('Provisioning'));
		}
	});

	test('maps Read tool.start/result to local Read card shapes', () => {
		const messages = remoteTaskChatMessages(summary, [
			event(0, 'tool.start', {
				toolCallId: 'call_read',
				name: 'Read',
				args: { path: 'README.md' },
			}),
			event(1, 'tool.result', {
				toolCallId: 'call_read',
				name: 'Read',
				ok: true,
				output: '# Welcome\n',
			}),
		]);
		const read = messages.find(message => message.role === 'tool' && message.name === 'Read');
		assert.ok(read && read.role === 'tool' && read.type === 'success');
		if (!read || read.role !== 'tool' || read.type !== 'success') {
			return;
		}
		const params = read.params as { uri: { fsPath: string } };
		assert.ok(params.uri?.fsPath?.endsWith('README.md'));
		const structured = read.result as { kind: string; fileContents: string };
		assert.strictEqual(structured.kind, 'text');
		assert.strictEqual(structured.fileContents, '# Welcome\n');
	});

	test('maps Shell tool.result to structured result for ShellToolCard', () => {
		const messages = remoteTaskChatMessages(summary, [
			event(0, 'tool.start', {
				toolCallId: 'call_shell',
				name: 'Shell',
				args: { command: 'echo hi', block_until_ms: 30000 },
			}),
			event(1, 'tool.result', {
				toolCallId: 'call_shell',
				name: 'Shell',
				ok: true,
				output: 'hi\n',
			}),
		]);
		const shell = messages.find(message => message.role === 'tool' && message.name === 'Shell');
		assert.ok(shell && shell.role === 'tool' && shell.type === 'success');
		if (!shell || shell.role !== 'tool' || shell.type !== 'success') {
			return;
		}
		assert.strictEqual(shell.content, 'hi\n');
		assert.ok(typeof shell.result === 'object' && shell.result !== null);
		const structured = shell.result as { kind: string; result?: string; exitCode?: number };
		assert.strictEqual(structured.kind, 'done');
		assert.strictEqual(structured.result, 'hi\n');
		assert.strictEqual(structured.exitCode, 0);
	});

	test('maps failed Shell tool.result with exit code from error field', () => {
		const messages = remoteTaskChatMessages(summary, [
			event(0, 'tool.start', {
				toolCallId: 'call_shell',
				name: 'Shell',
				args: { command: 'false' },
			}),
			event(1, 'tool.result', {
				toolCallId: 'call_shell',
				name: 'Shell',
				ok: false,
				output: '',
				error: 'exit 2',
			}),
		]);
		const shell = messages.find(message => message.role === 'tool' && message.name === 'Shell');
		assert.ok(shell && shell.role === 'tool' && shell.type === 'success');
		if (!shell || shell.role !== 'tool' || shell.type !== 'success') {
			return;
		}
		const structured = shell.result as { kind: string; exitCode?: number };
		assert.strictEqual(structured.kind, 'done');
		assert.strictEqual(structured.exitCode, 2);
	});

	test('maps Glob tool.result to structured result for Glob cards', () => {
		const messages = remoteTaskChatMessages(summary, [
			event(0, 'tool.start', {
				toolCallId: 'call_glob',
				name: 'Glob',
				args: { glob_pattern: '**/*.ts' },
			}),
			event(1, 'tool.result', {
				toolCallId: 'call_glob',
				name: 'Glob',
				ok: true,
				output: '/workspace/src/a.ts\n/workspace/src/b.ts',
			}),
		]);
		const glob = messages.find(message => message.role === 'tool' && message.name === 'Glob');
		assert.ok(glob && glob.role === 'tool' && glob.type === 'success');
		if (!glob || glob.role !== 'tool' || glob.type !== 'success') {
			return;
		}
		assert.ok(typeof glob.result === 'object' && glob.result !== null);
		const structured = glob.result as { uris: unknown[] };
		assert.strictEqual(structured.uris.length, 2);
	});

	test('maps Grep tool.result to structured result for Grep cards', () => {
		const messages = remoteTaskChatMessages(summary, [
			event(0, 'tool.start', {
				toolCallId: 'call_grep',
				name: 'Grep',
				args: { pattern: 'foo' },
			}),
			event(1, 'tool.result', {
				toolCallId: 'call_grep',
				name: 'Grep',
				ok: true,
				output: '/workspace/src/a.ts:10:const foo = 1',
			}),
		]);
		const grep = messages.find(message => message.role === 'tool' && message.name === 'Grep');
		assert.ok(grep && grep.role === 'tool' && grep.type === 'success');
		if (!grep || grep.role !== 'tool' || grep.type !== 'success') {
			return;
		}
		assert.ok(typeof grep.result === 'object' && grep.result !== null);
		const structured = grep.result as { results: unknown[]; shownMatchCount: number };
		assert.strictEqual(structured.results.length, 1);
		assert.strictEqual(structured.shownMatchCount, 1);
	});

	test('coalesces agent.message.delta within the same iteration into one bubble', () => {
		const messages = remoteTaskChatMessages(summary, [
			event(0, 'agent.message.delta', { content: 'Hello', iteration: 1 }),
			event(1, 'agent.message.delta', { content: ', ', iteration: 1 }),
			event(2, 'agent.message.delta', { content: 'world.', iteration: 1 }),
		], { skipUserMessage: true });
		const assistants = messages.filter(message => message.role === 'assistant');
		assert.strictEqual(assistants.length, 1);
		if (assistants[0]?.role === 'assistant') {
			assert.strictEqual(assistants[0].displayContent, 'Hello, world.');
		}
	});

	test('starts a fresh assistant bubble when the iteration changes', () => {
		const messages = remoteTaskChatMessages(summary, [
			event(0, 'agent.message.delta', { content: 'First answer.', iteration: 1 }),
			event(1, 'agent.message.delta', { content: ' Revised.', iteration: 2 }),
		], { skipUserMessage: true });
		const assistants = messages.filter(message => message.role === 'assistant');
		assert.strictEqual(assistants.length, 2);
		if (assistants[0]?.role === 'assistant') assert.strictEqual(assistants[0].displayContent, 'First answer.');
		if (assistants[1]?.role === 'assistant') assert.strictEqual(assistants[1].displayContent, ' Revised.');
	});

	test('reattaches full agent.message to the matching-iteration bubble across a tool call (reconnect replay)', () => {
		// Simulates a reconnect replay: deltas stream in iteration 1, then a tool
		// runs, then the final full-text agent.message for iteration 1 arrives.
		// The full text must land in the original bubble, not a duplicate.
		const messages = remoteTaskChatMessages(summary, [
			event(0, 'agent.message.delta', { content: 'Let me check the file.', iteration: 1 }),
			event(1, 'tool.start', { toolCallId: 'call_1', name: 'Read', args: { path: 'src/index.ts' } }),
			event(2, 'tool.result', { toolCallId: 'call_1', name: 'Read', ok: true, output: 'contents' }),
			event(3, 'agent.message', { content: 'Let me check the file. The file looks good.', iteration: 1 }),
		], { skipUserMessage: true });
		const assistants = messages.filter(message => message.role === 'assistant');
		assert.strictEqual(assistants.length, 1);
		if (assistants[0]?.role === 'assistant') {
			assert.strictEqual(assistants[0].displayContent, 'Let me check the file. The file looks good.');
		}
	});

	test('appends same-iteration deltas after a tool to the original assistant bubble', () => {
		const messages = remoteTaskChatMessages(summary, [
			event(0, 'agent.message.delta', { content: 'Checking…', iteration: 1 }),
			event(1, 'tool.start', { toolCallId: 'call_1', name: 'Read', args: { path: 'a.ts' } }),
			event(2, 'tool.result', { toolCallId: 'call_1', name: 'Read', ok: true, output: 'ok' }),
			event(3, 'agent.message.delta', { content: ' done.', iteration: 1 }),
		], { skipUserMessage: true });
		const assistants = messages.filter(message => message.role === 'assistant');
		assert.strictEqual(assistants.length, 1);
		if (assistants[0]?.role === 'assistant') {
			assert.strictEqual(assistants[0].displayContent, 'Checking… done.');
		}
	});

	test('does not concatenate agent.message deltas across iterations even without a tool boundary', () => {
		// Two iterations back-to-back: the model may restate its answer, so the
		// second iteration's text must never append to the first bubble.
		const messages = remoteTaskChatMessages(summary, [
			event(0, 'agent.message.delta', { content: 'Draft', iteration: 1 }),
			event(1, 'agent.message.delta', { content: 'Final answer', iteration: 2 }),
		], { skipUserMessage: true });
		const assistants = messages.filter(message => message.role === 'assistant');
		assert.strictEqual(assistants.length, 2);
		if (assistants[0]?.role === 'assistant') assert.strictEqual(assistants[0].displayContent, 'Draft');
		if (assistants[1]?.role === 'assistant') assert.strictEqual(assistants[1].displayContent, 'Final answer');
	});

	test('treats agent.message.delta without iteration as a single growing bubble', () => {
		// Legacy events without iteration fall back to the previous bubble when
		// the last message is an assistant message (preserves prior behavior).
		const messages = remoteTaskChatMessages(summary, [
			event(0, 'agent.message.delta', { content: 'Hello ' }),
			event(1, 'agent.message.delta', { content: 'there.' }),
		], { skipUserMessage: true });
		const assistants = messages.filter(message => message.role === 'assistant');
		assert.strictEqual(assistants.length, 1);
		if (assistants[0]?.role === 'assistant') assert.strictEqual(assistants[0].displayContent, 'Hello there.');
	});

	test('surfaces summary.lastError when FAILED with empty events', () => {
		const failed: RemoteTaskSummary = {
			...summary,
			state: 'FAILED',
			lastError: 'Timed out connecting to the Self-hosted Runner.',
		};
		const messages = remoteTaskChatMessages(failed, [], { skipUserMessage: true });
		assert.strictEqual(messages.length, 1);
		assert.strictEqual(messages[0]?.role, 'assistant');
		if (messages[0]?.role === 'assistant') {
			assert.ok(messages[0].displayContent.includes('Timed out connecting'));
			assert.ok(messages[0].displayContent.startsWith('Remote task failed:'));
		}
	});

	test('does not duplicate lastError when task.error already present', () => {
		const failed: RemoteTaskSummary = {
			...summary,
			state: 'FAILED',
			lastError: 'boom',
		};
		const messages = remoteTaskChatMessages(failed, [
			event(0, 'task.error', { message: 'boom' }),
		], { skipUserMessage: true });
		const assistants = messages.filter(message => message.role === 'assistant');
		assert.strictEqual(assistants.length, 1);
	});
});
