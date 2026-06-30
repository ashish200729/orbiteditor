/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Type definitions for the Orbit Skills system.
 *
 * A "skill" is a reusable bundle of domain knowledge / instructions packaged as a
 * `SKILL.md` file with YAML-style frontmatter. The agent lazily loads a skill's body
 * via the `skill` tool when a task matches the skill's description.
 */

/** Where a skill came from. Determines display label and whether it can be deleted. */
export type SkillSource = 'built-in' | 'user' | 'project'

/** Hard cap (chars) on a skill name to keep prompts bounded. */
export const MAX_SKILL_NAME_LENGTH = 64

/** Hard cap (chars) on a skill description to keep the available-skills prompt bounded. */
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024

/** Parsed frontmatter fields of a `SKILL.md` file. */
export type SkillFrontmatter = {
	/** Lowercase-hyphenated identifier, unique within the merged registry. */
	name: string
	/** Third-person description used by the model to decide when to load the skill. */
	description: string
	/** When true, the skill is shown to the model but only loaded on explicit invocation. */
	disableModelInvocation?: boolean
	/** Optional free-form metadata preserved from frontmatter. */
	metadata?: Record<string, string>
}

/** A fully-resolved skill ready to be listed/loaded. */
export type SkillDefinition = SkillFrontmatter & {
	/** Origin of the skill. */
	source: SkillSource
	/** Absolute path to the backing `SKILL.md` (empty for inline built-ins). */
	filePath: string
	/** Markdown body (everything after the frontmatter block). */
	body: string
	/** Whether the user currently has the skill enabled. Computed from the disabled-set. */
	enabled: boolean
	/**
	 * True when the skill lives in an external/shared registry (e.g. ~/.agents/skills) that
	 * Orbit does not own. External skills can be loaded and toggled, but Orbit will not
	 * delete or rewrite them — other tools share that directory.
	 */
	external?: boolean
}

/** Validate/normalize a skill name. Returns null if invalid. */
export const normalizeSkillName = (raw: string | undefined | null): string | null => {
	if (!raw) return null
	const trimmed = raw.trim().toLowerCase()
	if (!trimmed) return null
	if (trimmed.length > MAX_SKILL_NAME_LENGTH) return null
	// Allow letters, digits, hyphens, and underscores.
	if (!/^[a-z0-9][a-z0-9_-]*$/.test(trimmed)) return null
	return trimmed
}
