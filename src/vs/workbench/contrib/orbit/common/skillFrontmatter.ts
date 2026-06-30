/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Pure (side-effect-free) parser for SKILL.md frontmatter. Lives in `common` with no DI or
 * workbench imports so it can be unit-tested directly and shared by the loader and the
 * import service without dragging in the WorkbenchContribution registration in skillLoader.
 */

/** Frontmatter keys treated as booleans ("true"/"false"). */
const BOOLEAN_KEYS = new Set(['disablemodelinvocation']);

export type ParsedFrontmatter = {
	name?: string;
	description?: string;
	disableModelInvocation?: boolean;
	metadata: Record<string, string>;
};

/**
 * Parse the leading `---` frontmatter block. Supports flat `key: value` pairs plus YAML
 * block scalars (`>`, `>-`, `|`, `|-`, …) which Cursor/Claude often use for multi-line
 * descriptions. Nested mapping/list blocks are skipped gracefully. Quotes are stripped.
 * CRLF line endings are normalized so no value/body carries a trailing carriage return.
 */
export function parseSkillFrontmatter(content: string): { meta: ParsedFrontmatter; body: string } {
	const meta: ParsedFrontmatter = { metadata: {} };
	// Normalize line endings up front so CRLF (Windows-authored) files don't leave a trailing
	// \r on every line — which would otherwise corrupt the description, body, and block scalars.
	const lines = content.replace(/\r\n?/g, '\n').split('\n');
	if (lines[0]?.trim() !== '---') return { meta, body: lines.join('\n').trim() };
	const endIdx = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
	if (endIdx === -1) return { meta, body: lines.join('\n').trim() };

	let i = 1;
	while (i < endIdx) {
		const line = lines[i];
		i++;
		// Skip stray indented / list entries (children of a nested block we don't parse).
		if (/^\s/.test(line) || line.trimStart().startsWith('-')) continue;
		const colonIdx = line.indexOf(':');
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		if (!key) continue;
		let value = line.slice(colonIdx + 1).trim();

		// YAML block scalar: `>` (folded) or `|` (literal), optional chomping indicator.
		// Only treat it as a block when a blank/indented continuation line actually follows;
		// a bare `>`/`|` at end-of-frontmatter or before another key is a literal value, not
		// an (empty) block that would silently drop the field.
		const blockMatch = value.match(/^([|>])([+-]?)\d*$/);
		if (blockMatch && i < endIdx && (lines[i].trim() === '' || /^\s/.test(lines[i]))) {
			const folded = blockMatch[1] === '>';
			const blockLines: string[] = [];
			while (i < endIdx && (lines[i].trim() === '' || /^\s/.test(lines[i]))) {
				blockLines.push(lines[i].replace(/^\s+/, ''));
				i++;
			}
			while (blockLines.length && blockLines[blockLines.length - 1] === '') blockLines.pop();
			value = (folded ? blockLines.join(' ') : blockLines.join('\n')).trim();
		} else {
			// Strip surrounding quotes.
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
		}

		const keyLower = key.toLowerCase();
		if (keyLower === 'name') meta.name = value;
		else if (keyLower === 'description') meta.description = value;
		else if (BOOLEAN_KEYS.has(keyLower)) meta.disableModelInvocation = value.toLowerCase() === 'true';
		else if (value) meta.metadata[key] = value;
	}

	return { meta, body: lines.slice(endIdx + 1).join('\n').trim() };
}
