/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';

/**
 * Reproduces the OpenAI-compatible streaming tool-call accumulation logic from
 * `sendLLMMessage.impl.ts` (`_sendOpenAICompatibleChat`). The real implementation
 * lives inside a closure and is not directly importable, so we mirror the
 * `shouldSplit` + accumulation rules here to lock in the fix for providers
 * (GLM/zhipu and others) that send `type: 'function'` on every delta chunk.
 *
 * Regression for: "Invalid LLM output: path was null" — caused by fragmentation
 * of a single tool call into many entries when `isExplicitStart` was treated as
 * a new-tool signal.
 */

interface ToolCallDelta {
	index?: number;
	id?: string;
	type?: 'function' | string;
	function?: { name?: string; arguments?: string };
}

interface AccumulatedTool {
	name: string;
	id: string;
	paramsStr: string;
}

const accumulateStreamingToolCalls = (chunks: ToolCallDelta[]): AccumulatedTool[] => {
	const toolsByIndex = new Map<number, AccumulatedTool>();
	const allTools: AccumulatedTool[] = [];

	for (const tool of chunks) {
		const index = tool.index ?? 0;
		let toolData = toolsByIndex.get(index);

		const hasArgs = !!toolData && toolData.paramsStr.length > 0;

		const isIdMismatch = !!toolData && !!tool.id && !!toolData.id
			&& !toolData.id.startsWith(tool.id) && !tool.id.startsWith(toolData.id);

		const incomingName = tool.function?.name ?? '';
		const isNameUpdate = !!incomingName;
		const isConflictingName = isNameUpdate && !!toolData?.name
			&& !toolData.name.startsWith(incomingName) && !incomingName.startsWith(toolData.name);

		const shouldSplit = !toolData
			|| isIdMismatch
			|| (hasArgs && isNameUpdate && isConflictingName);

		if (shouldSplit) {
			toolData = { name: '', id: '', paramsStr: '' };
			toolsByIndex.set(index, toolData);
			allTools.push(toolData);
		}
		if (!toolData) {
			toolData = { name: '', id: '', paramsStr: '' };
			toolsByIndex.set(index, toolData);
			allTools.push(toolData);
		}

		toolData.name += tool.function?.name ?? '';
		toolData.paramsStr += tool.function?.arguments ?? '';
		// Only set the id once (providers that repeat the id on every chunk must
		// not produce a concatenated id like "call_1call_1...").
		if (!toolData.id && tool.id) {
			toolData.id = tool.id;
		}
	}

	return allTools;
};

suite('OpenAICompatibleStreamingToolAccumulation', () => {

	suite('GLM/zhipu pattern (type on every chunk)', () => {

		test('accumulates a single tool call without fragmenting', () => {
			// GLM 5.2 sends type:'function' and the same id on EVERY delta chunk.
			// The old logic split on isExplicitStart, creating one tool entry per
			// chunk and losing the arguments. This is the "path was null" regression.
			const chunks: ToolCallDelta[] = [
				{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '' } },
				{ index: 0, id: 'call_1', type: 'function', function: { name: '', arguments: '{"' } },
				{ index: 0, id: 'call_1', type: 'function', function: { name: '', arguments: 'path' } },
				{ index: 0, id: 'call_1', type: 'function', function: { name: '', arguments: '":"/etc/hosts"}' } },
			];
			const tools = accumulateStreamingToolCalls(chunks);
			assert.strictEqual(tools.length, 1);
			assert.strictEqual(tools[0].name, 'Read');
			assert.strictEqual(tools[0].id, 'call_1');
			assert.strictEqual(tools[0].paramsStr, '{"path":"/etc/hosts"}');
		});

		test('does not duplicate the id when it is repeated on every chunk', () => {
			const chunks: ToolCallDelta[] = [
				{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '' } },
				{ index: 0, id: 'call_1', type: 'function', function: { name: '', arguments: '{"path":"/a"}' } },
				{ index: 0, id: 'call_1', type: 'function', function: { name: '', arguments: '}' } },
			];
			const tools = accumulateStreamingToolCalls(chunks);
			assert.strictEqual(tools[0].id, 'call_1');
		});

		test('accumulates arguments sent as a single complete JSON object on one chunk', () => {
			// Some providers send the full arguments in one chunk.
			const chunks: ToolCallDelta[] = [
				{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"/etc/hosts"}' } },
				{ index: 0, id: 'call_1', type: 'function', function: { name: '', arguments: '' } },
			];
			const tools = accumulateStreamingToolCalls(chunks);
			assert.strictEqual(tools.length, 1);
			assert.strictEqual(tools[0].paramsStr, '{"path":"/etc/hosts"}');
		});

		test('handles multiple parallel tool calls with type on every chunk', () => {
			const chunks: ToolCallDelta[] = [
				{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"/a"}' } },
				{ index: 1, id: 'call_2', type: 'function', function: { name: 'Grep', arguments: '{"pattern":"x"}' } },
			];
			const tools = accumulateStreamingToolCalls(chunks);
			assert.strictEqual(tools.length, 2);
			assert.strictEqual(tools[0].name, 'Read');
			assert.strictEqual(tools[0].paramsStr, '{"path":"/a"}');
			assert.strictEqual(tools[1].name, 'Grep');
			assert.strictEqual(tools[1].paramsStr, '{"pattern":"x"}');
		});

		test('handles interleaved parallel tool call deltas', () => {
			const chunks: ToolCallDelta[] = [
				{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"' } },
				{ index: 1, id: 'call_2', type: 'function', function: { name: 'Grep', arguments: '{"' } },
				{ index: 0, id: 'call_1', type: 'function', function: { name: '', arguments: 'path":"/a"}' } },
				{ index: 1, id: 'call_2', type: 'function', function: { name: '', arguments: 'pattern":"x"}' } },
			];
			const tools = accumulateStreamingToolCalls(chunks);
			assert.strictEqual(tools.length, 2);
			assert.strictEqual(tools[0].name, 'Read');
			assert.strictEqual(tools[0].paramsStr, '{"path":"/a"}');
			assert.strictEqual(tools[1].name, 'Grep');
			assert.strictEqual(tools[1].paramsStr, '{"pattern":"x"}');
		});
	});

	suite('OpenAI standard pattern (type only on first chunk)', () => {

		test('accumulates a single tool call', () => {
			const chunks: ToolCallDelta[] = [
				{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '' } },
				{ index: 0, id: '', type: undefined, function: { name: '', arguments: '{"path":"/etc/hosts"}' } },
			];
			const tools = accumulateStreamingToolCalls(chunks);
			assert.strictEqual(tools.length, 1);
			assert.strictEqual(tools[0].name, 'Read');
			assert.strictEqual(tools[0].paramsStr, '{"path":"/etc/hosts"}');
		});
	});

	suite('name split across chunks', () => {

		test('accumulates "Rea" + "d" into "Read" without splitting', () => {
			// A tool name can arrive split across chunks. The conflicting-name
			// check uses startsWith so a prefix-compatible name update is treated
			// as a continuation, not a new tool.
			const chunks: ToolCallDelta[] = [
				{ index: 0, id: 'call_1', type: 'function', function: { name: 'Rea', arguments: '' } },
				{ index: 0, id: '', type: undefined, function: { name: 'd', arguments: '{"path":"/a"}' } },
			];
			const tools = accumulateStreamingToolCalls(chunks);
			assert.strictEqual(tools.length, 1);
			assert.strictEqual(tools[0].name, 'Read');
			assert.strictEqual(tools[0].paramsStr, '{"path":"/a"}');
		});
	});

	suite('sequential tool calls at the same index', () => {

		test('splits when a genuinely different tool name arrives after args', () => {
			// After a complete Read call, the model emits a Grep call at the same
			// index. hasArgs is true and the name conflicts, so we split.
			const chunks: ToolCallDelta[] = [
				{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"/a"}' } },
				{ index: 0, id: 'call_2', type: 'function', function: { name: 'Grep', arguments: '{"pattern":"x"}' } },
			];
			const tools = accumulateStreamingToolCalls(chunks);
			assert.strictEqual(tools.length, 2);
			assert.strictEqual(tools[0].name, 'Read');
			assert.strictEqual(tools[0].paramsStr, '{"path":"/a"}');
			assert.strictEqual(tools[1].name, 'Grep');
			assert.strictEqual(tools[1].paramsStr, '{"pattern":"x"}');
		});

		test('splits when id explicitly mismatches', () => {
			const chunks: ToolCallDelta[] = [
				{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"/a"}' } },
				{ index: 0, id: 'call_99', type: 'function', function: { name: '', arguments: '{"path":"/b"}' } },
			];
			const tools = accumulateStreamingToolCalls(chunks);
			assert.strictEqual(tools.length, 2);
			assert.strictEqual(tools[0].id, 'call_1');
			assert.strictEqual(tools[1].id, 'call_99');
		});
	});
});
