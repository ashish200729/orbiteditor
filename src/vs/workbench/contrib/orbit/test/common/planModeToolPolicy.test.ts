/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { availableTools, isLLMHiddenBuiltinToolName, llmVisibleBuiltinToolNames } from '../../common/prompt/prompts.js';

suite('PlanModeToolPolicy', () => {
	test('plan mode excludes Shell and legacy plan tools from LLM', () => {
		const tools = availableTools('plan', undefined) ?? [];
		const names = tools.map(t => t.name);
		assert.ok(!names.includes('Shell'));
		assert.ok(!names.includes('AwaitShell'));
		assert.ok(!names.includes('update_plan_section'));
		assert.ok(!names.includes('add_plan_todo'));
		assert.ok(!names.includes('mark_plan_item_complete'));
	});

	test('plan mode includes plan authoring tools but NOT file-editing tools', () => {
		const tools = availableTools('plan', undefined) ?? [];
		const names = tools.map(t => t.name);
		// Plan authoring + research tools ARE available.
		assert.ok(names.includes('task'));
		assert.ok(names.includes('create_plan'));
		assert.ok(names.includes('read_plan'));
		assert.ok(names.includes('CodebaseSearch'));
		// File-editing tools are NOT available — the agent must use create_plan to
		// author a plan, never edit code directly in plan mode.
		assert.ok(!names.includes('StrReplace'), 'StrReplace must NOT be available in plan mode (forces create_plan)');
		assert.ok(!names.includes('Write'), 'Write must NOT be available in plan mode (forces create_plan)');
	});

	test('plan mode excludes every mutating tool (defense-in-depth contract)', () => {
		// The agent in plan mode must only research + author plans. No file edits,
		// no shell, no legacy plan mutation tools. This is the tool-list half of
		// the contract; the runtime half is the StrReplace/Write/Shell guard in
		// toolsService.ts (resolvePlanModeEditDecision + _isPlanMode checks).
		const tools = availableTools('plan', undefined) ?? [];
		const names = tools.map(t => t.name);
		for (const blocked of ['StrReplace', 'Write', 'Shell', 'AwaitShell', 'update_plan_section', 'add_plan_todo', 'mark_plan_item_complete']) {
			assert.ok(!names.includes(blocked as any), `${blocked} must NOT be available in plan mode`);
		}
	});

	test('legacy plan tools are llm hidden globally', () => {
		assert.ok(isLLMHiddenBuiltinToolName('update_plan_section'));
		assert.ok(isLLMHiddenBuiltinToolName('add_plan_todo'));
		assert.ok(isLLMHiddenBuiltinToolName('mark_plan_item_complete'));
		assert.ok(!llmVisibleBuiltinToolNames.includes('update_plan_section'));
	});
});
