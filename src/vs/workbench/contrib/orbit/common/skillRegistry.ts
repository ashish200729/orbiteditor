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

const REVIEW_BODY = `# Code Review

Run a comprehensive, multi-pass code review on the requested changes. Work through
every category below and report concrete, actionable findings — cite exact
\`file:line\` locations.

## How to Review

1. Understand the purpose of the code by reading any linked issues, PR descriptions,
   or surrounding context.
2. Work through each category below systematically.

## 1. Correctness
- Logic errors, off-by-one, wrong operators, inverted conditions.
- Unhandled edge cases: empty input, null/undefined, boundary values, large input.
- Error handling: are failures caught, surfaced, and not silently swallowed?
- Async correctness: races, unawaited promises, missing cleanup/cancellation.
- State management: stale closures, incorrect dependency arrays, missing cleanups.

## 2. Security
- Untrusted input reaching file system, shell, SQL, or HTML without validation/escaping.
- Secrets or credentials in code or logs.
- Path traversal, injection (SQL, Command, XSS), SSRF, unsafe deserialization.
- Authentication/authorization bypasses.

## 3. Performance
- Unnecessary work in hot paths, N+1 queries, repeated allocations.
- Missing memoization/caching where it helps.
- Blocking the main thread / event loop.
- Memory leaks: unbounded collections, event listeners not cleaned up.

## 4. Maintainability
- Clear naming; dead code; duplicated logic that should be shared.
- Consistency with surrounding code's style and idioms.
- Tests: are new code paths covered? Do existing tests still hold?
- Documentation: do public APIs have adequate JSDoc/TSDoc?

## 5. Architecture
- Does the solution fit the existing architecture?
- Are dependencies appropriate and minimal?
- Is the change backward-compatible where needed?

## Output Format

For each finding: \`path:line — <severity> — <problem>. <suggested fix>.\`
Severity levels: **Critical**, **High**, **Medium**, **Low**, **Info**.
Group by category. If a category is clean, state it briefly. End with a summary of
the most important changes to make first.`

const REVIEW_BUGBOT_BODY = `# Bugbot Review

Hunt for bugs in the code changes with a forensic-level, skeptical approach.
Your goal is to find every possible defect — logical, behavioral, and edge-case —
before the code ships.

## Methodology

1. **Understand the intent**: Read the code to understand what it is supposed to do.
2. **Line-by-line analysis**: Go through each changed line and ask:
   - What could go wrong here?
   - What assumptions is this making?
   - What happens if input is unexpected?
3. **Systematic bug categories**:

### Logic Bugs
- Wrong conditions, inverted booleans, missing cases in switch/if-else.
- Off-by-one errors in loops, array indices, string slicing.
- Incorrect operator precedence.
- Type coercion issues (== vs ===, falsy checks that reject valid 0 / "").

### State Bugs
- Race conditions, missing locks/atomicity.
- Stale state in closures, stale refs in React hooks.
- Missing cleanup in useEffect / event listeners.
- Incorrect state transitions, impossible states not guarded against.

### Data Flow Bugs
- Null/undefined not handled.
- Wrong default values.
- Mutation of shared/immutable data.
- Incorrect serialization/deserialization.

### Edge Cases
- Empty collections, zero values, negative numbers.
- Very large inputs causing overflow or timeout.
- Unicode/encoding issues.
- Timezone, locale, date boundary issues.

### Integration Bugs
- API contract violations (wrong shape, missing fields).
- Race conditions between async operations.
- Incorrect error propagation.
- Ordering dependencies not enforced.

## Output Format

For each bug: \`file:line — **[severity]** — <bug description>. <what triggers it>. <suggested fix>.\`
Severity levels: **Critical** (crash/data loss/security breach), **High** (incorrect
behavior users notice), **Medium** (edge cases), **Low** (cosmetic/unlikely).
End with a count of bugs found per severity and the top 3 to fix first.`

const REVIEW_SECURITY_BODY = `# Security Review

Perform a security-focused audit of the code. Focus exclusively on vulnerabilities,
attack vectors, and security anti-patterns. Skip code style, performance, and general
correctness — those are covered by other reviews.

## Threat Model
Assume an external attacker with network access to the application.

## 1. Injection Vulnerabilities
- SQL/NoSQL injection via string concatenation.
- Command injection via exec/spawn with user input.
- XSS via unsanitized HTML/JSX output.
- Server-side template injection.
- LDAP/XML/XPATH injection.
- Regular expression DoS (ReDoS) from user-provided regex.

## 2. Authentication & Authorization
- Missing auth checks on endpoints/actions.
- Privilege escalation paths.
- Session fixation, weak session tokens.
- JWT misconfigurations (none algorithm, weak secrets, missing expiry).
- OAuth/OIDC misconfigurations (open redirects, missing state param).

## 3. Data Exposure
- Secrets in code, config, logs, or client bundles.
- Sensitive data exposed in API responses.
- Debug endpoints left enabled in production.
- Verbose error messages leaking stack traces/internal paths.
- Source maps deployed to production.

## 4. CSRF & Request Forgery
- State-changing GET requests.
- Missing CSRF tokens on forms/API.
- CORS misconfigurations (wildcard origins with credentials).
- SSRF opportunities (user-supplied URLs being fetched).

## 5. File & Path Security
- Path traversal (../ in file paths).
- Arbitrary file write via user-controlled filenames.
- Zip bomb / decompression attacks.
- Symlink attacks.
- File upload with no type/size validation.

## 6. Cryptography
- Use of weak/deprecated algorithms (MD5, SHA1, DES, RC4).
- Hardcoded keys or IVs.
- Custom crypto implementations.
- Missing integrity checks on encrypted data.
- Randomness from non-cryptographic sources (Math.random).

## 7. Dependency & Supply Chain
- Known-vulnerable dependencies (check versions against CVE databases).
- Unpinned/vague dependency versions.
- Typosquatting risk with typos in package names.
- Unsafe eval or dynamic require of user input.

## 8. Rate Limiting & DoS
- Missing rate limiting on auth/login endpoints.
- Unbounded resource allocation per request.
- Infinite loops or exponential blowup from user input.
- Missing timeouts on external calls.

## Output Format

For each finding: \`file:line — **<severity>** — <vulnerability>. <attack scenario>. <remediation>.\`
Severity (CVSS-like): **Critical** (RCE, privilege escalation, mass data exfiltration),
**High** (auth bypass, injection, significant data exposure), **Medium** (information
disclosure, DoS, CSRF), **Low** (defense-in-depth improvements).
End with a risk summary and the top 3 most critical fixes.`

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
	{
		name: 'review',
		description: 'Run a comprehensive, multi-pass code review covering correctness, security, performance, maintainability, and architecture. Use when the user asks for a detailed code review, PR review, or code audit.',
		source: 'built-in',
		filePath: '',
		body: REVIEW_BODY,
		enabled: true,
	},
	{
		name: 'review-bugbot',
		description: 'Hunt for bugs with a forensic-level, skeptical approach. Covers logic bugs, state bugs, data flow bugs, edge cases, and integration bugs. Use when the user asks to find bugs, debug, or bug-hunt in code.',
		source: 'built-in',
		filePath: '',
		body: REVIEW_BUGBOT_BODY,
		enabled: true,
	},
	{
		name: 'review-security',
		description: 'Perform a focused security audit covering injection, auth, data exposure, CSRF, path traversal, cryptography, supply chain, and DoS. Use when the user asks for a security review, security audit, or vulnerability check.',
		source: 'built-in',
		filePath: '',
		body: REVIEW_SECURITY_BODY,
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
 * flag computed from the current disabled-set. Sorted: built-in skills first, then enabled
 * skills before disabled, then alphabetically by name.
 *
 * Built-in skills are shown first so they appear at the top of the slash-menu Skills
 * section, ahead of any user-imported or project-level skills.
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

	const sourceOrder: Record<string, number> = { 'built-in': 0, 'user': 1, 'project': 2 }

	merged.sort((a, b) => {
		const srcA = sourceOrder[a.source] ?? 3
		const srcB = sourceOrder[b.source] ?? 3
		if (srcA !== srcB) return srcA - srcB
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
