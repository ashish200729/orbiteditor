/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { TodoItem } from './chatThreadServiceTypes.js';
import { updatePlanSection, todosToNumberedMarkdown, syncPlanStatus, parseNumberedTodoMarkdown } from './planTemplate.js';
import { normalizeTodoList } from './todoToolHelpers.js';
export { syncPlanChecklistToThreadTodos } from './planDraftHelpers.js';

export const PLAN_SYNC_MAX_FAILURES = 3;

/**
 * Applies thread todos to a plan file's checklist and syncs status.
 */
export function buildPlanContentFromTodos(planContent: string, todos: readonly TodoItem[]): string {
	const normalized = normalizeTodoList(todos);
	const todosMarkdown = todosToNumberedMarkdown(normalized);
	let updated = updatePlanSection(planContent, 'checklist', todosMarkdown);
	updated = syncPlanStatus(updated);
	return updated;
}

export function shouldNotifyPlanSyncFailure(failureCount: number): boolean {
	return failureCount >= PLAN_SYNC_MAX_FAILURES;
}

/**
 * Decision helper for the per-thread sync-failure notification. Returns true the
 * first time a streak reaches the threshold, and false thereafter until the
 * streak resets — so we notify once per failure streak instead of spamming on
 * every subsequent failing sync.
 *
 * Pure / unit-testable: callers own the persisted state.
 *
 * @param failureCount current consecutive failure count for this thread
 * @param alreadyNotifiedThisStreak whether we already surfaced the notification
 *        for the current failure streak (reset to false by the caller on a
 *        successful sync)
 */
export function shouldNotifyPlanSyncFailureOnce(failureCount: number, alreadyNotifiedThisStreak: boolean): boolean {
	return shouldNotifyPlanSyncFailure(failureCount) && !alreadyNotifiedThisStreak;
}

/**
 * Extracts the todo ids currently persisted in the plan file's checklist
 * section, in order. Used by the ID-reconciliation safety net to detect a full
 * turnover (the agent ignored the reuse-id instruction and invented new ids).
 */
export function getPlanChecklistIds(planContent: string): string[] {
	const parsed = parseNumberedTodoMarkdown(extractChecklistSection(planContent));
	return parsed.map(t => t.id);
}

function extractChecklistSection(content: string): string {
	const marker = '## Implementation Checklist';
	const markerIndex = content.indexOf(marker);
	if (markerIndex === -1) {
		return '';
	}
	const start = content.indexOf('\n', markerIndex) + 1;
	if (start === 0) {
		return '';
	}
	const nextSectionMatch = content.slice(start).match(/\n## /);
	const end = nextSectionMatch && nextSectionMatch.index !== undefined ? start + nextSectionMatch.index : content.length;
	return content.slice(start, end);
}

/**
 * Safety-net predicate for the todo-id reconciliation fix. Returns true when the
 * incoming thread todo ids have zero overlap with the ids currently persisted in
 * the plan file's checklist — a strong signal that the agent ignored the
 * reuse-id instruction and wholesale-replaced the list with free-form ids.
 *
 * Pure / unit-testable. Never used to discard the LLM's intent; callers always
 * write the incoming list and only use the return value to decide whether to
 * surface a "review the plan file" notification.
 *
 * @param planChecklistIds ids currently in the plan file's checklist section
 * @param incomingTodos the thread's current todos (about to be written)
 */
export function isFullTodoIdTurnover(planChecklistIds: readonly string[], incomingTodos: readonly TodoItem[]): boolean {
	if (planChecklistIds.length === 0 || incomingTodos.length === 0) {
		return false;
	}
	const onDiskSet = new Set(planChecklistIds);
	for (const todo of incomingTodos) {
		if (onDiskSet.has(todo.id)) {
			return false;
		}
	}
	return true;
}
