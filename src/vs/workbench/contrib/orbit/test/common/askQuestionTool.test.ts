/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	ASK_QUESTION_MAX_LABEL_LENGTH,
	ASK_QUESTION_MAX_PROMPT_LENGTH,
	ASK_QUESTION_MAX_QUESTIONS,
	ASK_QUESTION_RESERVED_OTHER_OPTION_ID,
	formatAnswersForLLM,
	normalizeAnswer,
	validateAskQuestionItems,
} from '../../common/askQuestionToolHelpers.js';
import { AskQuestionItem } from '../../common/chatThreadServiceTypes.js';
import { availableTools } from '../../common/prompt/prompts.js';

const sampleQuestion = (overrides?: Partial<AskQuestionItem>): AskQuestionItem => ({
	id: 'q1',
	prompt: 'Pick one',
	options: [
		{ id: 'a', label: 'Alpha' },
		{ id: 'b', label: 'Beta' },
	],
	allow_multiple: false,
	...overrides,
});

suite('AskQuestionTool', () => {
	test('validateAskQuestionItems — happy path', () => {
		const single = validateAskQuestionItems([sampleQuestion()]);
		assert.strictEqual(single.valid, true);
		if (single.valid) {
			assert.strictEqual(single.items.length, 1);
			assert.strictEqual(single.items[0]!.allow_multiple, false);
		}

		const multi = validateAskQuestionItems([
			sampleQuestion({ id: 'q1', allow_multiple: true }),
			sampleQuestion({ id: 'q2', prompt: 'Second?', options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] }),
		]);
		assert.strictEqual(multi.valid, true);
		if (multi.valid) {
			assert.strictEqual(multi.items[1]!.allow_multiple, false);
			assert.strictEqual(multi.items[0]!.allow_multiple, true);
		}
	});

	test('validateAskQuestionItems — rejection cases', () => {
		assert.strictEqual(validateAskQuestionItems([]).valid, false);
		assert.strictEqual(validateAskQuestionItems([{ id: 'q', prompt: 'P', options: [{ id: 'a', label: 'A' }] }]).valid, false);
		assert.strictEqual(validateAskQuestionItems([
			sampleQuestion(),
			sampleQuestion(),
		]).valid, false);

		const dupOpt = validateAskQuestionItems([{
			id: 'q',
			prompt: 'P',
			options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }],
		}]);
		assert.strictEqual(dupOpt.valid, false);

		const reservedOther = validateAskQuestionItems([{
			id: 'q',
			prompt: 'P',
			options: [
				{ id: 'a', label: 'A' },
				{ id: ASK_QUESTION_RESERVED_OTHER_OPTION_ID, label: 'Other' },
			],
		}]);
		assert.strictEqual(reservedOther.valid, false);

		const trimmed = validateAskQuestionItems([{
			id: '  q1  ',
			prompt: '  Pick one  ',
			options: [{ id: '  a  ', label: '  Alpha  ' }, { id: 'b', label: 'Beta' }],
		}]);
		assert.strictEqual(trimmed.valid, true);
		if (trimmed.valid) {
			assert.strictEqual(trimmed.items[0]!.id, 'q1');
			assert.strictEqual(trimmed.items[0]!.prompt, 'Pick one');
			assert.strictEqual(trimmed.items[0]!.options[0]!.id, 'a');
			assert.strictEqual(trimmed.items[0]!.options[0]!.label, 'Alpha');
		}

		const longPrompt = 'x'.repeat(ASK_QUESTION_MAX_PROMPT_LENGTH + 1);
		assert.strictEqual(validateAskQuestionItems([{
			id: 'q',
			prompt: longPrompt,
			options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
		}]).valid, false);

		const longLabel = 'x'.repeat(ASK_QUESTION_MAX_LABEL_LENGTH + 1);
		assert.strictEqual(validateAskQuestionItems([{
			id: 'q',
			prompt: 'P',
			options: [{ id: 'a', label: longLabel }, { id: 'b', label: 'B' }],
		}]).valid, false);

		const tooMany = Array.from({ length: ASK_QUESTION_MAX_QUESTIONS + 1 }, (_, i) =>
			sampleQuestion({ id: `q${i}`, prompt: `Q${i}` }),
		);
		assert.strictEqual(validateAskQuestionItems(tooMany).valid, false);
	});

	test('normalizeAnswer — filters unknown ids and clamps selection', () => {
		const q = sampleQuestion({ allow_multiple: false });
		const single = normalizeAnswer(q, { selectedOptionIds: ['a', 'bogus', 'b'] });
		assert.deepStrictEqual(single.selectedOptionIds, ['a']);

		const multiQ = sampleQuestion({ allow_multiple: true });
		const multi = normalizeAnswer(multiQ, { selectedOptionIds: ['a', 'a', 'bogus'] });
		assert.deepStrictEqual(multi.selectedOptionIds, ['a']);

		const other = normalizeAnswer(q, {
			selectedOptionIds: [ASK_QUESTION_RESERVED_OTHER_OPTION_ID],
			otherText: '  note  ',
		});
		assert.deepStrictEqual(other.selectedOptionIds, []);
		assert.strictEqual(other.otherText, 'note');

		const orphanNote = normalizeAnswer(q, { selectedOptionIds: ['a'], otherText: 'note' });
		assert.strictEqual(orphanNote.otherText, undefined);
	});

	test('formatAnswersForLLM — Q/A block, skip, and otherText', () => {
		const questions = [
			sampleQuestion({ id: 'q1', prompt: 'First?' }),
			sampleQuestion({ id: 'q2', prompt: 'Second?' }),
		];
		const answers = [
			{ questionId: 'q1', selectedOptionIds: ['a'] },
			{ questionId: 'q2', selectedOptionIds: [], otherText: 'custom only' },
		];
		const formatted = formatAnswersForLLM('My form', questions, answers, false);
		assert.ok(formatted.includes('# My form'));
		assert.ok(formatted.includes('Q1: First?'));
		assert.ok(formatted.includes('A: Alpha'));
		assert.ok(formatted.includes('Q2: Second?'));
		assert.ok(formatted.includes('A: custom only'));
		assert.ok(!formatted.includes('User note: custom only'));

		const skipped = formatAnswersForLLM('My form', questions, [], true);
		assert.ok(skipped.includes('skipped the question form'));
		assert.ok(skipped.includes('My form'));
	});

	suite('availableTools', () => {
		test('AskQuestion available in every chat mode', () => {
			// normalModeToolNames deliberately includes AskQuestion — it's a read-only
			// clarification tool, useful in Chat (normal) mode too.
			const plan = availableTools('plan', undefined) ?? [];
			const agent = availableTools('agent', undefined) ?? [];
			const normal = availableTools('normal', undefined) ?? [];
			assert.ok(plan.some((t) => t.name === 'AskQuestion'));
			assert.ok(agent.some((t) => t.name === 'AskQuestion'));
			assert.ok(normal.some((t) => t.name === 'AskQuestion'));
		});

		test('denyDelegation does not remove AskQuestion', () => {
			const tools = availableTools('agent', undefined, { denyDelegation: true }) ?? [];
			assert.ok(tools.some((t) => t.name === 'AskQuestion'));
		});
	});
});