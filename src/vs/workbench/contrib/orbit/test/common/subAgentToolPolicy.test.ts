/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { availableTools } from '../../common/prompt/prompts.js';
import type { InternalToolInfo } from '../../common/prompt/prompts.js';

suite('SubAgentToolPolicy', () => {
	test('hides delegation tool when delegation is denied', () => {
		const tools = availableTools('agent', undefined, { denyDelegation: true }) ?? [];
		const toolNames = tools.map(tool => tool.name);

		assert.ok(!toolNames.includes('task'));
		assert.ok(toolNames.includes('Read'));
	});

	test('hides disallowed builtin tools before prompting the model', () => {
		const tools = availableTools('agent', undefined, { disallowedBuiltinTools: ['StrReplace', 'Shell'] }) ?? [];
		const toolNames = tools.map(tool => tool.name);

		assert.ok(!toolNames.includes('StrReplace'));
		assert.ok(!toolNames.includes('Shell'));
		assert.ok(toolNames.includes('Read'));
	});

	const removedDirectoryTools = ['ls_dir', 'get_dir_tree'] as const;
	const readOnlyDiscoveryTools = ['Glob', 'Grep', 'CodebaseSearch'] as const;

	for (const chatMode of ['agent', 'normal', 'plan'] as const) {
		test(`does not expose removed directory listing tools in ${chatMode} mode`, () => {
			const toolNames = (availableTools(chatMode, undefined) ?? []).map(tool => tool.name);

			for (const removed of removedDirectoryTools) {
				assert.ok(!toolNames.includes(removed), `${removed} should not be in ${chatMode} tools`);
			}
			for (const discovery of readOnlyDiscoveryTools) {
				assert.ok(toolNames.includes(discovery), `${discovery} should be in ${chatMode} tools`);
			}
		});
	}

	test('exposes lexical and semantic search as LLM-visible read-only tools', () => {
		const tools = availableTools('agent', undefined) ?? [];
		const toolNames = tools.map(tool => tool.name);

		assert.ok(toolNames.includes('Grep'));
		assert.ok(toolNames.includes('Glob'));
		assert.ok(toolNames.includes('CodebaseSearch'));
	});

	test('Glob and Grep are reachable through allowed tool policy', () => {
		const tools = availableTools('agent', undefined, { allowedBuiltinTools: ['Glob', 'Grep'] }) ?? [];
		const toolNames = tools.map(tool => tool.name);

		assert.ok(toolNames.includes('Glob'));
		assert.ok(toolNames.includes('Grep'));
	});

	test('CodebaseSearch has a bounded natural-language query schema', () => {
		const tool = (availableTools('agent', undefined) ?? []).find(candidate => candidate.name === 'CodebaseSearch');
		assert.ok(tool);
		assert.ok(tool!.inputSchema?.properties?.query);
		assert.deepStrictEqual(tool!.inputSchema?.required, ['query']);
	});

	test('filters MCP tools to read-only annotations for read-only sub-agents', () => {
		const mcpTools = [
			{
				name: 'readonly_lookup',
				description: 'Read-only lookup',
				params: {},
				annotations: { readOnly: true },
			},
			{
				name: 'write_action',
				description: 'Mutating action',
				params: {},
				annotations: { readOnly: false },
			},
		] as InternalToolInfo[];

		const tools = availableTools('agent', mcpTools, { allowReadOnlyMcpOnly: true }) ?? [];
		const toolNames = tools.map(tool => tool.name);

		assert.ok(toolNames.includes('readonly_lookup'));
		assert.ok(!toolNames.includes('write_action'));
	});
});
