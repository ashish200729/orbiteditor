/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	parseNotifyOnOutput,
	parseOptionalIntInRange,
	stringOfAwaitShellResult,
	stringOfShellResult,
	validateAwaitShellParams,
	validateShellParams,
	buildShellCommandWithCwd,
} from '../../common/shellToolHelpers.js';
import { availableTools } from '../../common/prompt/prompts.js';
import { DEFAULT_SHELL_BLOCK_UNTIL_MS, MAX_SHELL_BLOCK_UNTIL_MS } from '../../common/prompt/prompts.js';

suite('ShellTool', () => {
	suite('validateShellParams', () => {
		test('happy path', () => {
			const params = validateShellParams({
				command: 'npm test',
				working_directory: './src',
				block_until_ms: '5000',
				description: 'Run tests',
			});
			assert.strictEqual(params.command, 'npm test');
			assert.strictEqual(params.workingDirectory, './src');
			assert.strictEqual(params.blockUntilMs, 5000);
			assert.strictEqual(params.description, 'Run tests');
			assert.ok(params.shellId);
		});

		test('missing command throws', () => {
			assert.throws(() => validateShellParams({}));
		});

		test('malformed notify_on_output throws', () => {
			assert.throws(() => validateShellParams({ command: 'echo hi', notify_on_output: 'not-json' }));
		});

		test('out-of-range block_until_ms throws', () => {
			assert.throws(() => validateShellParams({
				command: 'echo hi',
				block_until_ms: String(MAX_SHELL_BLOCK_UNTIL_MS + 1),
			}));
		});

		test('defaults block_until_ms', () => {
			const params = validateShellParams({ command: 'echo hi' });
			assert.strictEqual(params.blockUntilMs, DEFAULT_SHELL_BLOCK_UNTIL_MS);
		});
	});

	suite('validateAwaitShellParams', () => {
		test('happy path', () => {
			const params = validateAwaitShellParams({ shell_id: 'abc-123', pattern: 'done' });
			assert.strictEqual(params.shellId, 'abc-123');
			assert.strictEqual(params.pattern, 'done');
		});

		test('allows omitted shell_id for sleep-only await', () => {
			const params = validateAwaitShellParams({ block_until_ms: '5000' });
			assert.strictEqual(params.shellId, null);
			assert.strictEqual(params.blockUntilMs, 5000);
		});
	});

	suite('buildShellCommandWithCwd', () => {
		test('prefixes cd when cwd changes', () => {
			const { command, workingDirectory } = buildShellCommandWithCwd('npm test', './src', null);
			assert.strictEqual(command, 'cd ./src && npm test');
			assert.strictEqual(workingDirectory, './src');
		});

		test('leaves command unchanged when cwd matches', () => {
			const { command } = buildShellCommandWithCwd('npm test', './src', './src');
			assert.strictEqual(command, 'npm test');
		});
	});

	suite('parseNotifyOnOutput', () => {
		test('parses valid JSON', () => {
			const result = parseNotifyOnOutput('{"pattern": "ready", "debounce_ms": 2000, "reason": "server up"}');
			assert.deepStrictEqual(result, { pattern: 'ready', debounceMs: 2000, reason: 'server up' });
		});

		test('H17: rejects nested-quantifier (ReDoS) patterns', () => {
			// Phase 2.14 (H17) fix: nested quantifiers like (a+)+ can pin a
			// single-threaded regex engine. Reject them outright.
			assert.throws(
				() => parseNotifyOnOutput('{"pattern": "(a+)+", "reason": "r"}'),
				/nested quantifiers/,
			);
			assert.throws(
				() => parseNotifyOnOutput('{"pattern": "(a+){2,}", "reason": "r"}'),
				/nested quantifiers/,
			);
		});

		test('H17: rejects patterns longer than 1024 chars', () => {
			const long = 'a'.repeat(1025);
			assert.throws(
				() => parseNotifyOnOutput(`{"pattern": "${long}", "reason": "r"}`),
				/too long/,
			);
		});
	});

	suite('stringOfShellResult', () => {
		test('done', () => {
			const msg = stringOfShellResult(
				{ command: 'echo hi', workingDirectory: null, blockUntilMs: 0, description: null, notifyOnOutput: null, requestSmartModeApproval: false, shellId: 'id' },
				{ kind: 'done', result: 'hi', exitCode: 0, shellId: 'id' },
			);
			assert.ok(msg.includes('exit code 0'));
		});

		test('timeout', () => {
			const msg = stringOfShellResult(
				{ command: 'sleep 99', workingDirectory: null, blockUntilMs: 1000, description: null, notifyOnOutput: null, requestSmartModeApproval: false, shellId: 'id' },
				{ kind: 'timeout', result: 'partial', shellId: 'id', elapsedMs: 1000 },
			);
			assert.ok(msg.includes('still alive'));
		});

		test('backgrounded', () => {
			const msg = stringOfShellResult(
				{ command: 'npm run dev', workingDirectory: null, blockUntilMs: 0, description: null, notifyOnOutput: null, requestSmartModeApproval: false, shellId: 'id' },
				{ kind: 'backgrounded', shellId: 'id', pid: 42 },
			);
			assert.ok(msg.includes('shell_id="id"'));
			assert.ok(msg.includes('pid=42'));
		});
	});

	suite('stringOfAwaitShellResult', () => {
		test('notfound', () => {
			const msg = stringOfAwaitShellResult(
				{ shellId: 'missing', blockUntilMs: 0, pattern: null },
				{ kind: 'notfound', error: 'Shell with id "missing" does not exist.', runningForMs: 0 },
			);
			assert.strictEqual(msg, 'Shell with id "missing" does not exist.');
		});

		test('sleep-only await', () => {
			const msg = stringOfAwaitShellResult(
				{ shellId: null, blockUntilMs: 5000, pattern: null },
				{ kind: 'timeout', result: '', runningForMs: 5000, matchedPattern: false },
			);
			assert.ok(msg.includes('still running'));
		});

		test('matchedPattern', () => {
			const msg = stringOfAwaitShellResult(
				{ shellId: 'id', blockUntilMs: 5000, pattern: 'done' },
				{ kind: 'timeout', result: 'output', runningForMs: 1200, matchedPattern: true },
			);
			assert.ok(msg.includes('Pattern matched'));
		});

		test('done', () => {
			const msg = stringOfAwaitShellResult(
				{ shellId: 'id', blockUntilMs: 5000, pattern: null },
				{ kind: 'done', result: 'done output', exitCode: 0, runningForMs: 500 },
			);
			assert.ok(msg.includes('exit code 0'));
		});

		test('backgrounded (released to background)', () => {
			const msg = stringOfAwaitShellResult(
				{ shellId: 'id', blockUntilMs: 5000, pattern: null },
				{ kind: 'backgrounded', result: 'partial output', runningForMs: 1200 },
			);
			assert.ok(msg.includes('Released to background'));
			assert.ok(msg.includes('1200ms'));
			assert.ok(msg.includes('partial output'));
		});

		test('timeout without pattern', () => {
			const msg = stringOfAwaitShellResult(
				{ shellId: 'id', blockUntilMs: 5000, pattern: null },
				{ kind: 'timeout', result: 'still going', runningForMs: 5000, matchedPattern: false },
			);
			assert.ok(msg.includes('still running'));
		});
	});

	suite('availableTools plan mode', () => {
		test('excludes Shell and AwaitShell from plan mode', () => {
			// Plan mode must not grant shell execution — see planModeToolNames in
			// prompts.ts. Allowing Shell here let the model mutate the system after
			// presenting a plan, without the user clicking Build.
			const tools = availableTools('plan', undefined) ?? [];
			const toolNames = tools.map(t => t.name);
			assert.ok(!toolNames.includes('Shell'));
			assert.ok(!toolNames.includes('AwaitShell'));
		});

		test('excludes Shell from normal mode', () => {
			const tools = availableTools('normal', undefined) ?? [];
			const toolNames = tools.map(t => t.name);
			assert.ok(!toolNames.includes('Shell'));
			assert.ok(!toolNames.includes('AwaitShell'));
		});
	});

	suite('parseOptionalIntInRange', () => {
		test('returns default when empty', () => {
			assert.strictEqual(parseOptionalIntInRange('block_until_ms', undefined, 0, 100, 30), 30);
		});
	});
});
