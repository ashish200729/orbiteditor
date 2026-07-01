/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Built-in slash commands. A command is a fixed, code-defined prompt template (no user
 * authoring). When the user inserts a `/command` token in the chat input and submits, the
 * command's full `template` is appended to the user message (see chat_userMessageContent).
 *
 * Framework-free so it can be shared by the prompt builder (common) and the React input.
 *
 * Command names must be lowercase-hyphenated and must NOT collide with built-in skill
 * names (create-skill, code-review) — on a token collision, commands win (resolved first).
 */

export type BuiltinCommand = {
	/** Token id — `/<name>`. Lowercase letters, digits, hyphens. */
	name: string
	/** One-line description shown in the slash menu. */
	description: string
	/** Full prompt text injected into the user message when the command is used. */
	template: string
}

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
	{
		name: 'explain',
		description: 'Explain the current code or context in depth',
		template: `Explain the relevant code/context clearly and in depth:
- What it does and why it exists.
- How the key pieces fit together (data flow, control flow).
- Any non-obvious behavior, edge cases, or gotchas.
Use concrete references to specific files, functions, and lines.`,
	},
	{
		name: 'plan',
		description: 'Produce a step-by-step implementation plan before coding',
		template: `Before writing any code, produce a concise implementation plan:
1. Restate the goal and constraints.
2. List the files to create/modify and what each change does.
3. Outline the steps in order, noting dependencies between them.
4. Call out risks and how to avoid breaking existing behavior.
Do not edit files yet — present the plan first.`,
	},
	{
		name: 'tests',
		description: 'Write tests covering the current changes',
		template: `Write thorough tests for the code in question:
- Cover the happy path plus edge cases (empty/null, boundaries, error paths).
- Follow the project's existing test framework and conventions.
- Keep tests deterministic and isolated.
Then run the tests and report the results.`,
	},
	{
		name: 'refactor',
		description: 'Refactor for clarity without changing behavior',
		template: `Refactor the relevant code for clarity and maintainability WITHOUT changing its
observable behavior:
- Improve names, remove duplication, reduce nesting, and delete dead code.
- Preserve all existing functionality and public interfaces.
- Make the smallest set of changes that achieves the improvement.
Explain what you changed and why.`,
	},
	{
		name: 'fix',
		description: 'Diagnose and fix the described bug',
		template: `Diagnose and fix the bug:
1. Reproduce or precisely identify the failing behavior.
2. Find the root cause (not just the symptom) and explain it.
3. Apply a minimal, correct fix.
4. Verify the fix and confirm nothing else regressed.`,
	},
	{
		name: 'optimize',
		description: 'Improve performance of the current code',
		template: `Optimize the relevant code for performance:
- Identify the actual bottleneck before changing anything (avoid speculative micro-tuning).
- Reduce wasted work: redundant computation, repeated I/O, unnecessary allocations, or
  sequential work that can run in parallel.
- Preserve correctness and readability; note any trade-offs.
Explain the expected impact of each change.`,
	},
	{
		name: 'commit',
		description: 'Write a Conventional Commit message for the staged changes',
		template: `Generate a Conventional Commit message for the current changes:
- Subject line in the form \`type(scope): summary\`, <= 72 chars, imperative mood.
- A body only when the "why" isn't obvious from the subject.
Do not commit unless asked — just produce the message.`,
	},
	{
		name: 'summarize',
		description: 'Summarize the conversation or files so far',
		template: `Summarize the current context concisely:
- The goal and what has been done so far.
- Key decisions and their rationale.
- Open questions and the next concrete step.
Keep it scannable.`,
	},
]

const _byName = new Map(BUILTIN_COMMANDS.map(c => [c.name, c]))

export const getBuiltinCommand = (name: string): BuiltinCommand | undefined => _byName.get(name)
