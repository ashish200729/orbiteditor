/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Parsing for inline `/slash` tokens in the chat input text.
 *
 * A token is `/<name>` appearing at the start of the text or after whitespace, where
 * `<name>` is lowercase-hyphenated (skill or command name). This matches both the menu
 * trigger boundary and the highlight overlay so display and injection stay consistent.
 *
 * Framework-free — shared by the React input (highlighting) and the prompt builder
 * (injection in chat_userMessageContent).
 */

/**
 * Global regex matching slash tokens. Group 1 is the bare name (without the leading `/`).
 * Boundary: start-of-string or a whitespace char before the `/`; name ends at a non
 * `[a-z0-9_-]` char. The `g` flag means callers using it with `.exec()` must reset
 * `lastIndex` or create a fresh regex — prefer `slashTokenRegex()` to get a fresh instance.
 */
export const SLASH_TOKEN_RE = /(^|\s)\/([a-z0-9][a-z0-9_-]*)/g

/** Returns a fresh stateful regex instance (safe for `.exec()` loops). */
export const slashTokenRegex = (): RegExp => new RegExp(SLASH_TOKEN_RE.source, 'g')

/**
 * Extract the ordered, de-duplicated token names present in `text`. Does not resolve them
 * against the skill/command registries — callers decide what a name maps to.
 */
export const parseSlashTokenNames = (text: string): string[] => {
	if (!text) return []
	const re = slashTokenRegex()
	const seen = new Set<string>()
	const names: string[] = []
	let m: RegExpExecArray | null
	while ((m = re.exec(text)) !== null) {
		const name = m[2]
		if (name && !seen.has(name)) {
			seen.add(name)
			names.push(name)
		}
	}
	return names
}
