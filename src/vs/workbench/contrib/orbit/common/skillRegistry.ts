/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * In-memory registry of available skills.
 *
 * Skills come from three sources, merged by priority (later overrides earlier on name
 * collision):
 *   built-in  <  user (~/.orbit/skills)  <  project (.orbit/skills)
 *
 * The browser-side `skillLoader` discovers user/project skills from disk and calls
 * `setUserSkills` / `setProjectSkills`. The `enabled` flag of each skill is derived from
 * a separately-tracked disabled-name set (persisted in settings), so toggling a skill on
 * or off never requires re-reading files.
 *
 * This module is intentionally framework-free (no DI) so it can be imported from both
 * `common/prompt/prompts.ts` (system prompt assembly) and the React settings UI.
 */

import { SkillDefinition } from './orbitSkillTypes.js'

// ---------------------------------------------------------------------------------------
// Built-in skills — defined inline (mirrors BUILTIN_SUBAGENTS in subAgentRegistry.ts).
// Inline definitions avoid any runtime filesystem/resource-path dependency.
// ---------------------------------------------------------------------------------------

const CREATE_SKILL_BODY = `# Create a Skill

A skill is a reusable bundle of instructions packaged as a \`SKILL.md\` file. Orbit loads a
skill's body on demand (via the \`skill\` tool) when a task matches the skill's description.

## File layout

Each skill lives in its own folder containing a \`SKILL.md\` file:

- User-level (available everywhere): \`~/.orbit/skills/<name>/SKILL.md\`
- Project-level (this workspace only, overrides user): \`.orbit/skills/<name>/SKILL.md\`

## Frontmatter

Begin the file with a YAML-style frontmatter block:

\`\`\`
---
name: my-skill
description: Third-person summary of what the skill does and WHEN to use it. The model reads this to decide whether to load the skill.
---
\`\`\`

Fields:
- \`name\` (required): lowercase-hyphenated, max 64 chars, unique.
- \`description\` (required): third-person, max 1024 chars. Lead with the trigger ("Use when …").
- \`disableModelInvocation\` (optional): \`true\` to hide the skill from automatic loading (explicit use only).

## Writing a good skill

- Put the trigger conditions up front in the description — that is all the model sees until it loads the skill.
- Keep the body focused: concrete steps, checklists, commands, and conventions.
- Prefer imperative, scannable instructions over prose.
- Reference exact file paths, commands, and tools where relevant.

## After creating

The skill is picked up automatically. Toggle it on/off or delete it from
Orbit's Settings → Skills tab.`

const CODE_REVIEW_BODY = `# Code Review

Run a thorough, structured review of the code in question. Work through every category
below and report concrete, actionable findings — cite exact \`file:line\` locations.

## 1. Correctness
- Logic errors, off-by-one, wrong operators, inverted conditions.
- Unhandled edge cases: empty input, null/undefined, boundary values, large input.
- Error handling: are failures caught, surfaced, and not silently swallowed?
- Async correctness: races, unawaited promises, missing cleanup/cancellation.

## 2. Security
- Untrusted input reaching file system, shell, SQL, or HTML without validation/escaping.
- Secrets or credentials in code or logs.
- Path traversal, injection, SSRF, unsafe deserialization.

## 3. Performance
- Unnecessary work in hot paths, N+1 patterns, repeated allocations.
- Missing memoization/caching where it clearly helps.
- Blocking the main thread / event loop.

## 4. Maintainability
- Clear naming; dead code; duplicated logic that should be shared.
- Consistency with surrounding code's style and idioms.
- Tests: are new code paths covered? Do existing tests still hold?

## Output format

For each finding: \`path:line — <severity> — <problem>. <suggested fix>.\`
Group by category. If a category is clean, say so briefly. End with the single most
important change to make first.`

export const BUILTIN_SKILLS: SkillDefinition[] = [
	{
		name: 'create-skill',
		description: 'Guide for creating effective skills in Orbit Editor. Use when the user wants to create a new skill, write a SKILL.md file, or extend the agent with reusable domain knowledge.',
		source: 'built-in',
		filePath: '',
		body: CREATE_SKILL_BODY,
		enabled: true,
	},
	{
		name: 'code-review',
		description: 'Run a thorough code review for correctness bugs, security issues, performance problems, and maintainability. Use when the user asks for a code review, PR review, or to check code quality.',
		source: 'built-in',
		filePath: '',
		body: CODE_REVIEW_BODY,
		enabled: true,
	},
]

// ---------------------------------------------------------------------------------------
// Registry state
// ---------------------------------------------------------------------------------------

let _userSkills: SkillDefinition[] = []
let _projectSkills: SkillDefinition[] = []
let _disabledSkillNames: Set<string> = new Set()

const _onChangeListeners = new Set<() => void>()

/**
 * Memoized result of listSkills(). Invalidated on every registry mutation (_fireChange).
 * listSkills() is called several times per LLM turn during prompt assembly, so caching the
 * merged+sorted list avoids rebuilding a Map and re-sorting on each call.
 */
let _cachedList: SkillDefinition[] | null = null

const _fireChange = (): void => {
	_cachedList = null
	for (const listener of _onChangeListeners) {
		try { listener() } catch { /* never let one listener break others */ }
	}
}

/** Subscribe to registry changes (skills added/removed, or enabled-state toggled). */
export function onSkillsChanged(listener: () => void): () => void {
	_onChangeListeners.add(listener)
	return () => { _onChangeListeners.delete(listener) }
}

/** Replace the set of user-level (~/.orbit/skills) skills. */
export function setUserSkills(skills: SkillDefinition[]): void {
	_userSkills = skills
	_fireChange()
}

/** Replace the set of project-level (.orbit/skills) skills. */
export function setProjectSkills(skills: SkillDefinition[]): void {
	_projectSkills = skills
	_fireChange()
}

/** Update which skills are disabled (by name). Persisted by the caller in settings. */
export function setDisabledSkills(names: string[]): void {
	const next = new Set(names)
	// Avoid spurious change events when nothing actually changed.
	if (next.size === _disabledSkillNames.size && [...next].every(n => _disabledSkillNames.has(n))) return
	_disabledSkillNames = next
	_fireChange()
}

/**
 * Returns all skills merged by priority (project > user > built-in), with the `enabled`
 * flag computed from the current disabled-set. Sorted: enabled first, then by name.
 */
export function listSkills(): SkillDefinition[] {
	if (_cachedList) return _cachedList

	const byName = new Map<string, SkillDefinition>()
	const add = (skill: SkillDefinition) => { byName.set(skill.name, skill) }

	for (const s of BUILTIN_SKILLS) add(s)
	for (const s of _userSkills) add(s)
	for (const s of _projectSkills) add(s)

	const merged = [...byName.values()].map(s => ({
		...s,
		enabled: !_disabledSkillNames.has(s.name),
	}))

	merged.sort((a, b) => {
		if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
		return a.name.localeCompare(b.name)
	})

	_cachedList = merged
	return merged
}

/** Look up a single skill by name (respecting priority merge + enabled computation). */
export function getSkill(name: string): SkillDefinition | undefined {
	return listSkills().find(s => s.name === name)
}
