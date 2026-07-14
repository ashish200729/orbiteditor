/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { PlanDraft, TodoItem } from './chatThreadServiceTypes.js';
import { PlanTodoItem } from './toolsServiceTypes.js';
import {
	createAtomicPlanContent,
	extractPlanTitleFromMarkdown,
	generatePlanFileName,
	parseNumberedTodoMarkdown,
	parsePlanFile,
	parseTodosFromMarkdown,
	PlanStatus,
	convertPlanTodoToExecutionTodo,
} from './planTemplate.js';
import { normalizeTodoList } from './todoToolHelpers.js';

export type { PlanDraft };

export const PLAN_DRAFT_SCHEME = 'void-plan-draft';
export const PLAN_DIR = '.void/plans';

export function getPlanDraftUri(threadId: string): URI {
	return URI.from({ scheme: PLAN_DRAFT_SCHEME, path: `/${threadId}` });
}

export function isPlanDraftUri(uri: URI): boolean {
	return uri.scheme === PLAN_DRAFT_SCHEME;
}

export function getThreadIdFromPlanDraftUri(uri: URI): string | null {
	if (!isPlanDraftUri(uri)) {
		return null;
	}
	const id = uri.path.replace(/^\//, '');
	return id || null;
}

export function isPlanFilePath(fsPath: string, linkedPlanPath?: string | null): boolean {
	const normalized = fsPath.replace(/\\/g, '/');
	// Normalize both sides before comparing: on Windows the two paths can carry
	// mixed separators (backslash vs forward slash), which raw string equality
	// would treat as different and false-negative the plan-file guard.
	if (linkedPlanPath && normalized === linkedPlanPath.replace(/\\/g, '/')) {
		return true;
	}
	return /\/\.void\/plans\/[^/]+\.md$/.test(normalized);
}

/**
 * Pure decision for the plan-mode edit guard in toolsService.ts. Returns one of:
 *  - 'draft'     — an unsaved plan draft exists; the edit should be applied to
 *                  the in-memory draft via `_applyPlanDraftEdit`.
 *  - 'plan-file' — no unsaved draft, but the target path IS the linked/saved
 *                  plan file (or any `.void/plans/*.md`); the edit may proceed
 *                  against the file on disk.
 *  - 'blocked'   — the target is neither the draft nor a plan file; the tool
 *                  must throw "Plan mode only allows editing the plan."
 *
 * Extracted so the guard's scoping logic is unit-testable without instantiating
 * the full ToolsService. The `hasUnsavedDraft` argument is computed by the
 * caller from the thread's plan draft (so this helper stays pure / synchronous).
 */
export function resolvePlanModeEditDecision(
	fsPath: string,
	hasUnsavedDraft: boolean,
	linkedPlanPath: string | null | undefined,
): 'draft' | 'plan-file' | 'blocked' {
	if (hasUnsavedDraft) {
		return 'draft';
	}
	if (isPlanFilePath(fsPath, linkedPlanPath)) {
		return 'plan-file';
	}
	return 'blocked';
}

export function buildPlanContentFromDraft(
	draft: PlanDraft,
	status: PlanStatus = 'planning',
	model?: string,
): string {
	return createAtomicPlanContent({
		name: draft.name,
		overview: draft.overview,
		plan: draft.planMarkdown,
		todos: draft.todos,
		metadata: {
			title: draft.name,
			created: draft.createdAt,
			updated: draft.updatedAt,
			status,
			model,
		},
	});
}

export function applyStringReplaceToContent(
	content: string,
	oldString: string,
	newString: string,
	replaceAll: boolean,
): string {
	if (!oldString) {
		throw new Error('StrReplace: old_string must not be empty.');
	}
	if (oldString === newString) {
		throw new Error('StrReplace: old_string and new_string must be different.');
	}
	if (replaceAll) {
		if (!content.includes(oldString)) {
			throw new Error('StrReplace: old_string not found in plan content');
		}
		return content.split(oldString).join(newString);
	}
	// Phase 2.4 (H4) fix: if oldString matches more than once and replaceAll is
	// false, the previous code would silently replace only the first match. This is
	// almost always a sign of an underspecified edit, so throw to surface the
	// ambiguity to the LLM (which can then expand the anchor or set replaceAll=true).
	const occurrences = content.split(oldString).length - 1;
	if (occurrences > 1) {
		throw new Error(
			`StrReplace: old_string matches ${occurrences} locations in the plan content. ` +
			`Provide more surrounding context to make the match unique, or pass replaceAll=true.`
		);
	}
	const idx = content.indexOf(oldString);
	if (idx === -1) {
		throw new Error('StrReplace: old_string not found in plan content');
	}
	return content.slice(0, idx) + newString + content.slice(idx + oldString.length);
}

export function updateDraftFromPlanContent(
	content: string,
	existingDraft: PlanDraft | undefined,
): PlanDraft {
	const parsed = parsePlanFile(content);
	const planMarkdown = content.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
	const checklistContent = parsed.sections.checklist;
	type ParsedChecklistTodo = { id: string; content: string; status?: 'pending' | 'in_progress' | 'completed' | 'cancelled' };
	let parsedTodos: ParsedChecklistTodo[] = parseNumberedTodoMarkdown(checklistContent);
	if (parsedTodos.length === 0) {
		parsedTodos = parseTodosFromMarkdown(checklistContent || planMarkdown);
	}
	const now = new Date().toISOString();
	// Re-derive the overview from the parsed section so StrReplace/Write edits to
	// the "## Overview" section propagate. Only fall back to the existing draft's
	// overview when the section is genuinely empty (e.g. a plan with no overview).
	const derivedOverview = parsed.sections.overview?.trim() || null;
	const overview = derivedOverview ?? existingDraft?.overview ?? null;
	return {
		name: parsed.metadata.title || existingDraft?.name || extractPlanTitleFromMarkdown(planMarkdown) || 'Implementation Plan',
		overview,
		planMarkdown,
		todos: parsedTodos.map(t => ({ id: t.id, content: t.content })),
		createdAt: existingDraft?.createdAt ?? parsed.metadata.created ?? now,
		updatedAt: now,
		savedPlanPath: existingDraft?.savedPlanPath,
	};
}

export function parsePlanSectionTitles(planMarkdown: string): string[] {
	const titles: string[] = [];
	for (const line of planMarkdown.split('\n')) {
		const match = line.match(/^##\s+(.+?)\s*$/);
		if (match) {
			titles.push(match[1].trim());
		}
	}
	return titles;
}

export function syncPlanChecklistToThreadTodos(planContent: string): TodoItem[] {
	const parsed = parsePlanFile(planContent);
	const checklistContent = parsed.sections.checklist;
	type ParsedChecklistTodo = { id: string; content: string; status?: 'pending' | 'in_progress' | 'completed' | 'cancelled' };
	let parsedTodos: ParsedChecklistTodo[] = parseNumberedTodoMarkdown(checklistContent);
	if (parsedTodos.length === 0) {
		parsedTodos = parseTodosFromMarkdown(checklistContent || planContent);
	}
	const executionTodos = parsedTodos.map(todo => convertPlanTodoToExecutionTodo(todo));
	return normalizeTodoList(executionTodos);
}

/** Proposed on-disk filename for a draft (Cursor-style *.plan.md slug in .void/plans/). */
export function getProposedPlanFileName(draft: PlanDraft): string {
	return generatePlanFileName(draft.name);
}

export function preparePlanDraftSave(
	draft: PlanDraft,
	workspaceRoot: URI,
	model?: string,
): { content: string; planUri: URI; planName: string } {
	const plansDirUri = URI.joinPath(workspaceRoot, PLAN_DIR);
	const fileName = generatePlanFileName(draft.name);
	const planUri = URI.joinPath(plansDirUri, fileName);
	const content = buildPlanContentFromDraft(draft, 'approved', model);
	return { content, planUri, planName: draft.name };
}

export function createPlanDraftFromParams(
	name: string | null,
	overview: string | null,
	plan: string,
	todos: PlanTodoItem[],
	existingDraft?: PlanDraft,
	model?: string,
): PlanDraft {
	const effectiveName = name?.trim()
		|| existingDraft?.name
		|| extractPlanTitleFromMarkdown(plan)
		|| 'Implementation Plan';
	const now = new Date().toISOString();
	return {
		name: effectiveName,
		overview,
		planMarkdown: plan,
		todos,
		createdAt: existingDraft?.createdAt ?? now,
		updatedAt: now,
		savedPlanPath: existingDraft?.savedPlanPath,
	};
}

/**
 * Shapes the result object returned by the `create_plan` tool. Extracted as a
 * pure helper so the result shape is unit-testable without instantiating the
 * full ToolsService.
 */
export function buildCreatePlanResult(
	draft: PlanDraft,
	overview: string | null,
	todos: PlanTodoItem[],
): { planPath: string; planName: string; isDraft: true; overview: string; todos: PlanTodoItem[] } {
	return {
		planPath: draft.savedPlanPath ?? '',
		planName: draft.name,
		isDraft: true as const,
		overview: overview ?? '',
		todos,
	};
}