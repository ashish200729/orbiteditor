/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Conservative SVG sanitizer used to defend `dangerouslySetInnerHTML` against
 * untrusted SVG payloads (Phase 1.9 / C9 fix). Mermaid's render output is
 * server-side-rendered SVG and is normally safe, but we treat it as untrusted
 * because the input (a Mermaid code block from the LLM) is user-controlled.
 *
 * The sanitizer:
 *  1. Strips the following tags entirely: script, foreignObject, iframe, object,
 *     embed, form, input, style, link, meta, base.
 *  2. Strips any attribute whose name starts with "on" (event handlers).
 *  3. Strips href / xlink:href attributes whose value starts with "javascript:".
 *
 * It does NOT attempt to be a full HTML/SVG parser; instead it uses a small set
 * of regex passes. This is intentionally simple and dependency-free, so the
 * React bundle is not affected.
 */
const DANGEROUS_TAGS = new Set([
	'script',
	'foreignobject',
	'iframe',
	'object',
	'embed',
	'form',
	'input',
	'style',
	'link',
	'meta',
	'base',
	// SMIL animation can set an href/attributeName to a javascript: value at runtime — a classic
	// regex-sanitizer bypass. Mermaid's static output doesn't need animation, so drop them entirely.
	'animate',
	'animatetransform',
	'animatemotion',
	'set',
	'handler',
]);

const DANGEROUS_URL_ATTRS = new Set(['href', 'xlink:href']);

/** Whether a URL attribute value is safe in an SVG (local fragment, data:image, http(s)/mailto,
 * or scheme-less/relative). Blocks javascript:, vbscript:, data:text/html, etc. */
function isSafeSvgUrl(value: string): boolean {
	const c = value.trim().replace(/[\u0000-\u001F]/g, '').toLowerCase();
	if (c.startsWith('#')) { return true; }
	if (c.startsWith('data:image/')) { return true; }
	const m = /^([a-z][a-z0-9+.-]*):/.exec(c);
	if (!m) { return true; } // relative / fragment
	return m[1] === 'http' || m[1] === 'https' || m[1] === 'mailto';
}

/** Robust DOM-based scrub (used in the renderer, where DOMParser exists). Returns null when a DOM
 * isn't available (e.g. the Node unit-test environment) so the caller can fall back to regex. */
function sanitizeViaDom(svg: string): string | null {
	if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') { return null; }
	try {
		const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
		if (doc.getElementsByTagName('parsererror').length > 0) { return null; } // malformed → regex fallback
		for (const el of Array.from(doc.querySelectorAll('*'))) {
			if (DANGEROUS_TAGS.has(el.tagName.toLowerCase())) { el.remove(); continue; }
			for (const attr of Array.from(el.attributes)) {
				const name = attr.name.toLowerCase();
				if (name.startsWith('on')) { el.removeAttribute(attr.name); continue; }
				if (DANGEROUS_URL_ATTRS.has(name) && !isSafeSvgUrl(attr.value)) { el.removeAttribute(attr.name); continue; }
				if (name === 'style' && /url\s*\(|expression|javascript:/i.test(attr.value)) { el.removeAttribute(attr.name); }
			}
		}
		const root = doc.documentElement;
		return root ? new XMLSerializer().serializeToString(root) : '';
	} catch {
		return null;
	}
}

/**
 * Sanitize an SVG string for safe insertion via `dangerouslySetInnerHTML`.
 * Returns a string that is safe to render in the DOM. If `svg` is empty, the
 * empty string is returned.
 */
export function sanitizeSvgForRender(svg: string): string {
	if (!svg) {
		return '';
	}

	// Prefer a real DOM parse+scrub (renderer). Regex sanitizers are routinely bypassed by nested,
	// mutated, or malformed markup; a parser normalizes the tree so those tricks can't survive.
	const viaDom = sanitizeViaDom(svg);
	if (viaDom !== null) {
		return viaDom;
	}

	// Fallback (non-DOM environments, e.g. unit tests): strengthened regex passes.
	let out = svg;

	// 1. Strip dangerous tag blocks, looping to a fixed point so obfuscation like
	//    `<scr<script>ipt>` (which reveals a real tag after one pass) can't survive.
	//    Returns null if the string is still mutating at the iteration cap — see below.
	const stripTags = (input: string): string | null => {
		let prev: string;
		let cur = input;
		let iter = 0;
		do {
			prev = cur;
			cur = cur.replace(
				/<(script|foreignObject|iframe|object|embed|form|input|style|link|meta|base|animate|animateTransform|animateMotion|set|handler)\b[^>]*>[\s\S]*?<\/\1>/gi,
				'',
			);
			cur = cur.replace(
				/<(script|foreignObject|iframe|object|embed|form|input|style|link|meta|base|animate|animateTransform|animateMotion|set|handler)\b[^>]*\/?>/gi,
				'',
			);
			iter++;
		} while (cur !== prev && iter < 20);
		// Still changing at the cap means adversarial nesting is progressively revealing new
		// tags faster than we can strip them — we cannot prove the result is clean. Fail secure.
		if (cur !== prev) { return null; }
		return cur;
	};
	const stripped = stripTags(out);
	if (stripped === null) { return ''; }
	out = stripped;

	// 2. Strip event handler attributes (onclick, onload, onbegin, ...).
	out = out.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

	// 3. Strip href / xlink:href attributes carrying a dangerous scheme (javascript:, vbscript:,
	//    data:text/html, etc.). Tolerant of whitespace/quotes.
	const badScheme = 'javascript|vbscript|livescript|mocha|data\\s*:\\s*text/html';
	out = out.replace(new RegExp('\\s+(href|xlink:href)\\s*=\\s*"\\s*(?:' + badScheme + ')[^"]*"', 'gi'), ' $1=""');
	out = out.replace(new RegExp("\\s+(href|xlink:href)\\s*=\\s*'\\s*(?:" + badScheme + ")[^']*'", 'gi'), " $1=''");
	out = out.replace(new RegExp('\\s+(href|xlink:href)\\s*=\\s*(?:' + badScheme + ')[^\\s>]*', 'gi'), ' $1=""');

	return out;
}

/** Test-only: returns whether a given tag name is considered dangerous. */
export function _isDangerousTag(name: string): boolean {
	return DANGEROUS_TAGS.has(name.toLowerCase());
}

/** Test-only: returns whether a given attribute name is a dangerous URL attr. */
export function _isDangerousUrlAttr(name: string): boolean {
	return DANGEROUS_URL_ATTRS.has(name.toLowerCase());
}
