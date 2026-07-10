/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { TodoItem } from './chatThreadServiceTypes.js';

/**
 * Builds the user-facing + LLM-facing message sent when a plan is "Built"
 * (handed from Plan Mode to the agent for execution).
 *
 * Two strings are produced from one input so the chat bubble and the LLM stay
 * in sync without leaking the instruction scaffolding into the UI:
 *
 *  - `displayContent` — the clean human-readable summary rendered in the chat
 *    bubble. Identical to the legacy message; no `id:` text appears here.
 *  - `llmContent` — the same summary, but each task is suffixed with
 *    `(id: "todo-id")` and an explicit instruction telling the agent to reuse
 *    those exact ids in its subsequent `TodoWrite` calls.
 *
 * Reusing the plan's original todo ids is what keeps `PlanCard`'s id-based
 * status lookup working after the agent starts calling `TodoWrite`. Without it,
 * the agent's free-form ids wholesale-replace `thread.todoList` and every
 * original checklist step appears stuck "pending" forever even as work
 * completes.
 */
export function buildPlanImplementationMessage(
	planTitle: string,
	overview: string,
	todos: readonly TodoItem[],
): { displayContent: string; llmContent: string } {
	const title = planTitle || 'Implementation Plan';
	const overviewBlock = overview ? `\n## Overview\n${overview}\n` : '';

	const displayTasks = todos
		.map((t, i) => `${i + 1}. [${t.status.toUpperCase()}] ${t.content}`)
		.join('\n');

	const llmTasks = todos
		.map((t, i) => `${i + 1}. [${t.status.toUpperCase()}] ${t.content} (id: "${t.id}")`)
		.join('\n');

	const displayContent = `I've created a plan: "${title}"
${overviewBlock}
## Tasks (${todos.length})
${displayTasks}

Let's implement this plan.`;

	const llmContent = `I've created a plan: "${title}"
${overviewBlock}
## Tasks (${todos.length})
${llmTasks}

Let's implement this plan.

IMPORTANT: When you call TodoWrite to track this work, reuse the exact todo ids listed above (e.g. "${todos[0]?.id ?? 'todo-id'}"). Do not invent new ids — the plan's checklist and the UI status lookup depend on id continuity. Set each todo's status to in_progress when you start it and completed when you finish it.`;

	return { displayContent, llmContent };
}
