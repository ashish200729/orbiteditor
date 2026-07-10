/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	addTodoToChecklist,
	calculatePlanStatus,
	countTodoItems,
	createAtomicPlanContent,
	createPlanContent,
	extractPlanTitleFromMarkdown,
	generatePlanFileName,
	injectOverviewIntoPlan,
	resolveCreatePlanTitle,
	generatePlanSlug,
	markTodoComplete,
	parsePlanFile,
	parseTodosFromMarkdown,
	stripChecklistSection,
	syncPlanStatus,
	updatePlanSection,
	updatePlanStatus,
	validatePlanContent,
} from '../../common/planTemplate.js';

const SAMPLE_PLAN = `---
title: Test Plan
created: 2025-01-01T00:00:00.000Z
updated: 2025-01-01T00:00:00.000Z
status: planning
---

# Implementation Plan: Test Plan

## Overview

Do the thing.

## Files to Modify

- \`src/foo.ts\`

## Implementation Steps

Step one.

## Implementation Checklist

1. [PENDING] First task <!-- id:task-1 -->
2. [PENDING] Second task <!-- id:task-2 -->

## Testing Strategy

Run tests.

## Notes & Considerations

None.
`;

suite('PlanTemplate', () => {
	test('createPlanContent includes frontmatter and sections', () => {
		const content = createPlanContent({
			planName: 'My Plan',
			overview: 'Overview text',
			metadata: {
				title: 'My Plan',
				created: '2025-01-01T00:00:00.000Z',
				updated: '2025-01-01T00:00:00.000Z',
				status: 'planning',
			},
		});
		assert.ok(content.includes('title: "My Plan"') || content.includes('title: My Plan'));
		assert.ok(content.includes('## Overview'));
		assert.ok(content.includes('## Implementation Checklist'));
	});

	test('parsePlanFile extracts metadata and sections', () => {
		const parsed = parsePlanFile(SAMPLE_PLAN);
		assert.strictEqual(parsed.metadata.title, 'Test Plan');
		assert.ok(parsed.sections.overview.includes('Do the thing'));
		assert.ok(parsed.sections.checklist.includes('First task'));
	});

	test('updatePlanSection replaces section content', () => {
		const updated = updatePlanSection(SAMPLE_PLAN, 'overview', 'Updated overview.');
		const parsed = parsePlanFile(updated);
		assert.strictEqual(parsed.sections.overview.trim(), 'Updated overview.');
		assert.ok(parsed.sections.checklist.includes('First task'));
	});

	test('addTodoToChecklist appends numbered todo', () => {
		const result = addTodoToChecklist(SAMPLE_PLAN, 'Third task');
		assert.strictEqual(result.todoCount, 3);
		assert.ok(result.content.includes('3. [PENDING] Third task'));
	});

	test('markTodoComplete marks numbered item', () => {
		const result = markTodoComplete(SAMPLE_PLAN, 1);
		assert.ok(result.completedItem.includes('First task'));
		assert.ok(result.content.includes('1. [✓] First task'));
	});

	test('updatePlanStatus changes frontmatter status', () => {
		const updated = updatePlanStatus(SAMPLE_PLAN, 'in-progress');
		assert.ok(updated.includes('status: in-progress'));
	});

	test('stripChecklistSection removes the checklist heading and content but keeps other sections', () => {
		const stripped = stripChecklistSection(SAMPLE_PLAN);
		assert.ok(!stripped.includes('## Implementation Checklist'));
		assert.ok(!stripped.includes('First task'));
		assert.ok(!stripped.includes('Second task'));
		assert.ok(stripped.includes('## Overview'));
		assert.ok(stripped.includes('## Testing Strategy'));
		assert.ok(stripped.includes('Run tests.'));
	});

	test('stripChecklistSection is a no-op when there is no checklist section', () => {
		const noChecklist = '## Overview\n\nJust an overview.';
		assert.strictEqual(stripChecklistSection(noChecklist), noChecklist);
	});

	test('generatePlanSlug normalizes names', () => {
		assert.strictEqual(generatePlanSlug('Hello World!'), 'hello-world');
	});

	test('generatePlanFileName uses local date and time', () => {
		const name = generatePlanFileName('Test');
		assert.match(name, /^\d{4}-\d{2}-\d{2}-\d{6}-test\.md$/);
	});

	test('countTodoItems only counts checklist section', () => {
		const content = `${SAMPLE_PLAN}

## Notes & Considerations

- [ ] This is not a todo
1. [PENDING] Also not a checklist todo
`;
		const counts = countTodoItems(content);
		assert.strictEqual(counts.total, 2);
		assert.strictEqual(counts.pending, 2);
		assert.strictEqual(counts.completed, 0);
	});

	test('calculatePlanStatus returns planning when no todos', () => {
		const noTodos = updatePlanSection(SAMPLE_PLAN, 'checklist', '_No tasks yet_');
		assert.strictEqual(calculatePlanStatus(noTodos), 'planning');
	});

	test('calculatePlanStatus returns in-progress when partially complete', () => {
		const partial = markTodoComplete(SAMPLE_PLAN, 1).content;
		assert.strictEqual(calculatePlanStatus(partial), 'in-progress');
	});

	test('syncPlanStatus updates status based on progress', () => {
		const completed = markTodoComplete(markTodoComplete(SAMPLE_PLAN, 1).content, 1).content;
		const synced = syncPlanStatus(completed);
		assert.ok(synced.includes('status: completed'));
	});

	test('validatePlanContent rejects tables outside code blocks only', () => {
		const withTable = `# Plan\n\n| a | b |\n|---|---|\n`;
		assert.strictEqual(validatePlanContent(withTable).valid, false);

		const tableInCode = `# Plan\n\n\`\`\`\n| a | b |\n|---|---|\n\`\`\`\n`;
		assert.strictEqual(validatePlanContent(tableInCode).valid, true);
	});

	test('parseTodosFromMarkdown supports checkbox and numbered formats', () => {
		const markdown = `- [ ] Checkbox task <!-- id:cb-1 -->
1. [IN_PROGRESS] Numbered task <!-- id:num-1 -->`;
		const todos = parseTodosFromMarkdown(markdown);
		assert.strictEqual(todos.length, 2);
		assert.deepStrictEqual(todos[0], { id: 'cb-1', content: 'Checkbox task' });
		assert.deepStrictEqual(todos[1], { id: 'num-1', content: 'Numbered task' });
	});

	test('extractPlanTitleFromMarkdown reads level-1 heading', () => {
		assert.strictEqual(
			extractPlanTitleFromMarkdown('# User Authentication\n\n## Overview\n\nDetails.'),
			'User Authentication',
		);
	});

	test('injectOverviewIntoPlan inserts overview after title', () => {
		const injected = injectOverviewIntoPlan(
			'# Auth Plan\n\n## Approach\n\nUse JWT.',
			'Add JWT auth to secure API routes.',
		);
		assert.ok(injected.includes('## Overview'));
		assert.ok(injected.includes('Add JWT auth to secure API routes.'));
		assert.ok(injected.indexOf('## Overview') < injected.indexOf('## Approach'));
	});

	test('injectOverviewIntoPlan is a no-op when overview section exists', () => {
		const plan = '# Plan\n\n## Overview\n\nAlready here.';
		assert.strictEqual(injectOverviewIntoPlan(plan, 'Ignored'), plan);
	});

	test('resolveCreatePlanTitle ignores name when reusing existing plan', () => {
		assert.strictEqual(
			resolveCreatePlanTitle('New Short Name', '# Different Title', 'Existing Plan', true),
			'Existing Plan',
		);
	});

	test('resolveCreatePlanTitle falls back to plan heading', () => {
		assert.strictEqual(
			resolveCreatePlanTitle(null, '# Heading Title\n\nBody'),
			'Heading Title',
		);
	});

	test('createAtomicPlanContent works with plan-only input (no overview)', () => {
		const content = createAtomicPlanContent({
			name: 'Plan Only',
			plan: '# Plan Only\n\n## Approach\n\nDo work.',
			todos: [],
			metadata: {
				title: 'Plan Only',
				created: '2025-01-01T00:00:00.000Z',
				updated: '2025-01-01T00:00:00.000Z',
				status: 'planning',
			},
		});
		assert.ok(content.startsWith('---'));
		assert.ok(content.includes('# Plan Only'));
	});

	test('createAtomicPlanContent replaces existing checklist when todos provided', () => {
		const planWithChecklist = `# Plan

## Implementation Checklist

1. [PENDING] Old task <!-- id:old -->
`;
		const content = createAtomicPlanContent({
			name: 'Plan',
			plan: planWithChecklist,
			todos: [{ id: 'new-task', content: 'New task' }],
			metadata: {
				title: 'Plan',
				created: '2025-01-01T00:00:00.000Z',
				updated: '2025-01-01T00:00:00.000Z',
				status: 'planning',
			},
		});
		assert.ok(content.includes('1. [PENDING] New task <!-- id:new-task -->'));
		assert.ok(!content.includes('Old task'));
	});

	test('createAtomicPlanContent appends numbered checklist', () => {
		const content = createAtomicPlanContent({
			name: 'Atomic Plan',
			overview: 'ignored',
			plan: '# Atomic Plan\n\n## Overview\n\nDetails.',
			todos: [
				{ id: 'setup', content: 'Setup project' },
				{ id: 'ship', content: 'Ship feature' },
			],
			metadata: {
				title: 'Atomic Plan',
				created: '2025-01-01T00:00:00.000Z',
				updated: '2025-01-01T00:00:00.000Z',
				status: 'planning',
			},
		});
		assert.ok(content.includes('1. [PENDING] Setup project <!-- id:setup -->'));
		const roundTrip = parseTodosFromMarkdown(content);
		assert.strictEqual(roundTrip.length, 2);
	});

	test('escapeYamlString handles backslashes in title', () => {
		const content = createPlanContent({
			planName: 'Path\\to\\plan',
			overview: 'Overview',
			metadata: {
				title: 'Path\\to\\plan',
				created: '2025-01-01T00:00:00.000Z',
				updated: '2025-01-01T00:00:00.000Z',
				status: 'planning',
			},
		});
		assert.ok(content.includes('title: "Path\\\\to\\\\plan"'));
	});
});
