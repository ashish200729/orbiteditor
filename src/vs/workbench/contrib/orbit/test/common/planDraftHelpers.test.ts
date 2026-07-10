/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import {
	applyStringReplaceToContent,
	buildPlanContentFromDraft,
	createPlanDraftFromParams,
	isPlanFilePath,
	parsePlanSectionTitles,
	preparePlanDraftSave,
	resolvePlanModeEditDecision,
	syncPlanChecklistToThreadTodos,
	updateDraftFromPlanContent,
} from '../../common/planDraftHelpers.js';

suite('planDraftHelpers', () => {
	test('createPlanDraftFromParams preserves createdAt on update', () => {
		const first = createPlanDraftFromParams('Auth Plan', 'Overview text', '# Auth Plan\n\n## Steps\n\nDo things', [
			{ id: 'setup', content: 'Setup auth' },
		]);
		const second = createPlanDraftFromParams(null, 'Updated overview', '# Auth Plan\n\n## Steps\n\nUpdated', [
			{ id: 'setup', content: 'Setup auth' },
			{ id: 'tests', content: 'Add tests' },
		], first);
		assert.strictEqual(second.createdAt, first.createdAt);
		assert.ok(second.updatedAt >= first.updatedAt);
		assert.strictEqual(second.name, 'Auth Plan');
		assert.strictEqual(second.todos.length, 2);
	});

	test('buildPlanContentFromDraft matches save content with approved status', () => {
		const draft = createPlanDraftFromParams('My Plan', 'Short overview', '# My Plan\n\n## Overview\n\nDetails', [
			{ id: 'task-1', content: 'First task' },
		]);
		const planning = buildPlanContentFromDraft(draft, 'planning');
		const approved = buildPlanContentFromDraft(draft, 'approved');
		assert.ok(planning.includes('status: planning'));
		assert.ok(approved.includes('status: approved'));
		assert.ok(approved.includes('## Implementation Checklist'));
	});

	test('applyStringReplaceToContent updates draft body', () => {
		const draft = createPlanDraftFromParams('Plan', null, '# Plan\n\n## Overview\n\nOld text', []);
		const content = buildPlanContentFromDraft(draft);
		const updated = applyStringReplaceToContent(content, 'Old text', 'New text', false);
		const parsed = updateDraftFromPlanContent(updated, draft);
		assert.ok(parsed.planMarkdown.includes('New text'));
		assert.ok(!parsed.planMarkdown.includes('Old text'));
	});

	test('H4: applyStringReplaceToContent throws on ambiguous match (replaceAll=false)', () => {
		// Phase 2.4 (H4) fix: previously, an ambiguous old_string with replaceAll=false
		// would silently replace only the first match. We now throw to surface the
		// ambiguity to the LLM.
		const content = 'foo bar foo bar foo';
		assert.throws(
			() => applyStringReplaceToContent(content, 'foo', 'baz', false),
			/[0-9]+ locations/,
		);
	});

	test('applyStringReplaceToContent with replaceAll=true still replaces all', () => {
		const content = 'foo bar foo bar foo';
		const out = applyStringReplaceToContent(content, 'foo', 'baz', true);
		assert.strictEqual(out, 'baz bar baz bar baz');
	});

	test('syncPlanChecklistToThreadTodos parses numbered checklist', () => {
		const draft = createPlanDraftFromParams('Plan', null, '# Plan\n\nBody', [
			{ id: 'a', content: 'Task A' },
			{ id: 'b', content: 'Task B' },
		]);
		const content = buildPlanContentFromDraft(draft);
		const todos = syncPlanChecklistToThreadTodos(content);
		assert.strictEqual(todos.length, 2);
		assert.strictEqual(todos[0].id, 'a');
		assert.strictEqual(todos[0].status, 'pending');
	});

	test('isPlanFilePath accepts linked and .void/plans paths', () => {
		assert.ok(isPlanFilePath('/workspace/.void/plans/2026-01-01-plan.md'));
		assert.ok(isPlanFilePath('/workspace/.void/plans/foo.md', '/workspace/.void/plans/foo.md'));
		assert.ok(!isPlanFilePath('/workspace/src/index.ts'));
	});

	test('resolvePlanModeEditDecision routes edits correctly (plan-mode guard)', () => {
		// Unsaved draft wins over everything — edits go to the in-memory draft.
		assert.strictEqual(resolvePlanModeEditDecision('/workspace/src/index.ts', true, null), 'draft');
		assert.strictEqual(resolvePlanModeEditDecision('/workspace/.void/plans/foo.md', true, '/workspace/.void/plans/foo.md'), 'draft');
		// No draft, target is the linked plan file → allowed on disk.
		assert.strictEqual(resolvePlanModeEditDecision('/workspace/.void/plans/foo.md', false, '/workspace/.void/plans/foo.md'), 'plan-file');
		// No draft, target is any .void/plans/*.md → allowed (matches the plan dir).
		assert.strictEqual(resolvePlanModeEditDecision('/workspace/.void/plans/2026-01-01-x.md', false, null), 'plan-file');
		// No draft, target is a source file → blocked (the headline bug fix).
		assert.strictEqual(resolvePlanModeEditDecision('/workspace/src/index.ts', false, null), 'blocked');
		assert.strictEqual(resolvePlanModeEditDecision('/workspace/src/index.ts', false, '/workspace/.void/plans/foo.md'), 'blocked');
		// No draft, no thread (linkedPath null) — arbitrary path blocked.
		assert.strictEqual(resolvePlanModeEditDecision('/etc/passwd', false, null), 'blocked');
	});

	test('preparePlanDraftSave generates timestamped filename', () => {
		const draft = createPlanDraftFromParams('User Auth', null, '# User Auth\n\nBody', []);
		const { planUri, planName, content } = preparePlanDraftSave(draft, URI.file('/workspace'));
		assert.strictEqual(planName, 'User Auth');
		assert.ok(planUri.path.includes('/.void/plans/'));
		assert.ok(planUri.path.endsWith('.md'));
		assert.ok(content.includes('status: approved'));
	});

	test('parsePlanSectionTitles extracts markdown headings', () => {
		const sections = parsePlanSectionTitles('# Title\n\n## Overview\n\nText\n\n## Implementation Steps\n\nMore');
		assert.deepStrictEqual(sections, ['Overview', 'Implementation Steps']);
	});
});