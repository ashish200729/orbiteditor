/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { buildPlanImplementationMessage } from '../../common/planBuildMessage.js';
import { TodoItem } from '../../common/chatThreadServiceTypes.js';

const makeTodos = (): TodoItem[] => [
	{ id: 'todo-1', content: 'Read the spec', status: 'pending', activeForm: 'Reading the spec' },
	{ id: 'todo-2', content: 'Implement the API', status: 'pending', activeForm: 'Implementing the API' },
	{ id: 'todo-3', content: 'Write tests', status: 'completed', activeForm: 'Writing tests' },
];

suite('planBuildMessage', () => {
	test('displayContent has no id: text', () => {
		const { displayContent } = buildPlanImplementationMessage('My Plan', 'Do the thing', makeTodos());
		assert.ok(!/id:/.test(displayContent), `displayContent must not leak id: text — got: ${displayContent}`);
		assert.ok(displayContent.includes('My Plan'));
		assert.ok(displayContent.includes('Do the thing'));
		assert.ok(displayContent.includes('Read the spec'));
		assert.ok(displayContent.includes('[COMPLETED] Write tests'));
	});

	test('llmContent suffixes each task with (id: "todo-id")', () => {
		const todos = makeTodos();
		const { llmContent } = buildPlanImplementationMessage('My Plan', 'Do the thing', todos);
		for (const t of todos) {
			assert.ok(
				llmContent.includes(`(id: "${t.id}")`),
				`llmContent must contain (id: "${t.id}") — got: ${llmContent}`,
			);
		}
		assert.ok(llmContent.includes('[PENDING] Read the spec'));
	});

	test('both share identical title and overview', () => {
		const { displayContent, llmContent } = buildPlanImplementationMessage('Shared Title', 'Shared overview', makeTodos());
		assert.ok(displayContent.includes('Shared Title'));
		assert.ok(llmContent.includes('Shared Title'));
		assert.ok(displayContent.includes('Shared overview'));
		assert.ok(llmContent.includes('Shared overview'));
	});

	test('llmContent instructs the agent to reuse the todo ids', () => {
		const { llmContent } = buildPlanImplementationMessage('P', 'O', makeTodos());
		assert.ok(/reuse the exact todo ids/i.test(llmContent), 'llmContent must instruct id reuse');
		assert.ok(llmContent.includes('todo-1'), 'llmContent must reference a concrete id in the instruction');
	});

	test('falls back to default title when empty', () => {
		const { displayContent } = buildPlanImplementationMessage('', 'overview', makeTodos());
		assert.ok(displayContent.includes('Implementation Plan'));
	});

	test('omits the overview block when overview is empty', () => {
		const { displayContent, llmContent } = buildPlanImplementationMessage('P', '', makeTodos());
		assert.ok(!/## Overview/.test(displayContent));
		assert.ok(!/## Overview/.test(llmContent));
	});

	test('task count matches todos length', () => {
		const todos = makeTodos();
		const { displayContent, llmContent } = buildPlanImplementationMessage('P', 'O', todos);
		assert.ok(displayContent.includes(`Tasks (${todos.length})`));
		assert.ok(llmContent.includes(`Tasks (${todos.length})`));
	});
});
