/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Orbit Editor. All rights reserved.
 *  Licensed under the Apache License. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { IAXNode } from './browserAutomation.js';

/**
 * Mutable snapshot node — the snapshot build pass writes `depth` and
 * `children` after construction. The public `IAXNode` type keeps these
 * readonly for consumers.
 */
export type MutableAXNode = IAXNode & { depth: number; children?: string[] };

/**
 * Exact CDP methods exposed through the model-facing `browser_cdp` surface.
 * This is intentionally an allowlist: new Chromium domains and methods remain
 * unavailable until they have been reviewed for credential, storage, network,
 * filesystem, navigation, or code-execution side effects.
 */
export const ALLOWED_MODEL_CDP_METHODS: ReadonlySet<string> = new Set([
	'Accessibility.getFullAXTree',
	'CSS.disable',
	'CSS.enable',
	'CSS.getComputedStyleForNode',
	'CSS.getMatchedStylesForNode',
	'CSS.getPlatformFontsForNode',
	'DOM.describeNode',
	'DOM.disable',
	'DOM.enable',
	'DOM.getAttributes',
	'DOM.getBoxModel',
	'DOM.getDocument',
	'DOM.getNodeForLocation',
	'DOM.querySelector',
	'DOM.querySelectorAll',
	'Log.disable',
	'Log.enable',
	'Log.startViolationsReport',
	'Log.stopViolationsReport',
	'Page.disable',
	'Page.enable',
	'Page.getLayoutMetrics',
	'Performance.disable',
	'Performance.enable',
	'Performance.getMetrics',
	'Profiler.disable',
	'Profiler.enable',
	'Profiler.start',
	'Profiler.stop',
	'Runtime.getHeapUsage',
]);

export function isModelCdpMethodAllowed(method: string): boolean {
	return ALLOWED_MODEL_CDP_METHODS.has(method.trim());
}

/**
 * Defense in depth for callers that bypass the model-facing allowlist.
 * Dedicated interaction primitives use an internal CDP path.
 */
export const DENIED_CDP_PREFIXES: readonly string[] = [
	'Input.',                              // use clickByRef / typeByRef / pressKey
	'Network.getCookies',                  // no credential exfiltration
	'Network.getAllCookies',
	'Network.getResponseBody',             // response bodies can contain tokens/PII
	'Network.takeResponseBodyForInterceptionAsStream',
	'Network.getRequestPostData',
	'Storage.getCookies',
	'Storage.getStorageKeyForFrame',
	'Network.setCookie',
	'Storage.setCookies',
	'Network.clearBrowserCookies',
	'Storage.clearCookies',
	'Storage.getUsageAndQuota',
	'IndexedDB.',                          // no IndexedDB dump
	'CacheStorage.',                       // no cache dump
	'Browser.grantPermissions',
	'Browser.resetPermissions',
	'Page.setDownloadBehavior',
	'Page.setInterceptFileChooserDialog',
	'Page.handleJavaScriptDialog',         // dialogs should surface to the user
	'Page.navigate',                       // use browser_navigate instead
	'Page.navigateToHistoryEntry',
	'DOM.setFileInputFiles',               // no silent local-file upload
	'Target.createTarget',
	'Target.createBrowserContext',
	'Target.disposeBrowserContext',
	'Target.closeTarget',
	'Target.detachFromTarget',             // would kill our own debugger session
	'Target.attachToTarget',
	'Emulation.setDeviceMetricsOverride',  // can break our bounds sync
];

/**
 * Patterns that must not appear in `Runtime.evaluate` / `Runtime.callFunctionOn`
 * expressions. Blocks the most common credential-exfil paths that bypass the
 * CDP method denylist (document.cookie, localStorage, sessionStorage).
 * This is a best-effort guard — not a full JS sandbox.
 */
export const DENIED_EVAL_PATTERNS: readonly RegExp[] = [
	/\bdocument\s*\.\s*cookie\b/i,
	/\blocalStorage\b/i,
	/\bsessionStorage\b/i,
	/\bindexedDB\b/i,
	/\bcookies?\s*\(/i,
	/\bgetAllCookies\b/i,
];

export function isCdpMethodDenied(method: string): boolean {
	const normalized = method.trim();
	return DENIED_CDP_PREFIXES.some(prefix => normalized === prefix || normalized.startsWith(prefix));
}

/**
 * Returns true when a Runtime.evaluate / callFunctionOn expression looks like
 * it is trying to read cookies or web storage. Used by sendCdpCommand.
 */
export function isCdpEvalExpressionDenied(expression: string | undefined): boolean {
	if (!expression || typeof expression !== 'string') {
		return false;
	}
	return DENIED_EVAL_PATTERNS.some(re => re.test(expression));
}

/** A CSS-pixel rectangle used as a CDP `Page.captureScreenshot` clip. */
export interface IScreenshotClipRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	readonly scale: number;
}

/**
 * Layout metrics returned by CDP `Page.getLayoutMetrics`. Prefer the
 * `css*` fields — the non-css fields are device pixels on HiDPI and will
 * produce left-half content + right white space if used as a CSS clip.
 */
export interface ICdpLayoutMetrics {
	readonly cssContentSize?: { x?: number; y?: number; width?: number; height?: number };
	readonly contentSize?: { x?: number; y?: number; width?: number; height?: number };
	readonly cssVisualViewport?: {
		pageX?: number;
		pageY?: number;
		clientWidth?: number;
		clientHeight?: number;
		scale?: number;
		zoom?: number;
	};
	readonly visualViewport?: {
		pageX?: number;
		pageY?: number;
		clientWidth?: number;
		clientHeight?: number;
		scale?: number;
	};
}

/** Hard cap so a pathological page cannot blow model context / memory. */
export const MAX_SCREENSHOT_DIMENSION_CSS_PX = 16_384;

function sanitizeRect(x: number, y: number, width: number, height: number, scale = 1): IScreenshotClipRect | undefined {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
		return undefined;
	}
	const w = Math.min(Math.max(1, Math.round(width)), MAX_SCREENSHOT_DIMENSION_CSS_PX);
	const h = Math.min(Math.max(1, Math.round(height)), MAX_SCREENSHOT_DIMENSION_CSS_PX);
	return {
		x: Number.isFinite(x) ? Math.max(0, Math.round(x)) : 0,
		y: Number.isFinite(y) ? Math.max(0, Math.round(y)) : 0,
		width: w,
		height: h,
		scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
	};
}

/**
 * Builds a full-page CDP screenshot clip from layout metrics.
 *
 * CRITICAL: use `cssContentSize` (CSS pixels). The deprecated `contentSize`
 * is device pixels on Retina — feeding it as a CSS clip captures a region
 * 2× too wide/tall, which shows up as content squeezed into the left half
 * of the image with white space on the right.
 */
export function buildFullPageScreenshotClip(metrics: ICdpLayoutMetrics | undefined): IScreenshotClipRect | undefined {
	const css = metrics?.cssContentSize;
	if (css && typeof css.width === 'number' && typeof css.height === 'number') {
		return sanitizeRect(css.x ?? 0, css.y ?? 0, css.width, css.height, 1);
	}
	// Last-resort fallback: only use deprecated contentSize when css* is
	// missing (very old Chromium). Prefer under-capturing over the Retina
	// half-width bug — callers should prefer native capturePage instead.
	const legacy = metrics?.contentSize;
	if (legacy && typeof legacy.width === 'number' && typeof legacy.height === 'number') {
		return sanitizeRect(legacy.x ?? 0, legacy.y ?? 0, legacy.width, legacy.height, 1);
	}
	return undefined;
}

/**
 * Builds a viewport CDP screenshot clip from layout metrics (CSS pixels).
 * Prefer omitting the clip entirely and using native `capturePage()` when
 * possible — this is for JPEG / element-adjacent CDP paths.
 */
export function buildViewportScreenshotClip(metrics: ICdpLayoutMetrics | undefined): IScreenshotClipRect | undefined {
	const css = metrics?.cssVisualViewport;
	if (css && typeof css.clientWidth === 'number' && typeof css.clientHeight === 'number') {
		return sanitizeRect(css.pageX ?? 0, css.pageY ?? 0, css.clientWidth, css.clientHeight, 1);
	}
	const legacy = metrics?.visualViewport;
	if (legacy && typeof legacy.clientWidth === 'number' && typeof legacy.clientHeight === 'number') {
		return sanitizeRect(legacy.pageX ?? 0, legacy.pageY ?? 0, legacy.clientWidth, legacy.clientHeight, 1);
	}
	return undefined;
}

/**
 * Builds an element-clip CDP screenshot rect from CSS-pixel bounds
 * (e.g. from `getBoundingClientRect`).
 */
export function buildElementScreenshotClip(bounds: { x: number; y: number; width: number; height: number } | undefined): IScreenshotClipRect | undefined {
	if (!bounds) {
		return undefined;
	}
	return sanitizeRect(bounds.x, bounds.y, bounds.width, bounds.height, 1);
}

export const INTERACTIVE_ROLES = new Set([
	'button',
	'link',
	'textbox',
	'searchbox',
	'checkbox',
	'radio',
	'slider',
	'spinbutton',
	'combobox',
	'listbox',
	'menuitem',
	'menuitemcheckbox',
	'menuitemradio',
	'tab',
	'tabitem',
	'treeitem',
	'option',
	'switch',
]);

/** Roles the agent types into — listed first in interactive snapshots. */
export const EDITABLE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

/**
 * Rank for sorting interactive list: editables first (type targets), then
 * buttons, then everything else. Lower = earlier in the list the model sees.
 */
export function interactiveRoleRank(role: string): number {
	const r = role.toLowerCase();
	if (r === 'textbox' || r === 'searchbox') {
		return 0;
	}
	if (r === 'combobox' || r === 'spinbutton') {
		return 1;
	}
	if (r === 'button' || r === 'link') {
		return 2;
	}
	if (r === 'checkbox' || r === 'radio' || r === 'switch') {
		return 3;
	}
	return 4;
}

/**
 * Flat interactive-element list for the agent. Prefer this over a deep tree
 * when the goal is click/type — the model finds textboxes in one glance.
 */
export function snapshotToInteractiveList(nodes: Record<string, MutableAXNode>, nav: { url: string; title: string }): string {
	const lines: string[] = [];
	lines.push(`# url: ${nav.url}`);
	lines.push(`# title: ${nav.title}`);
	lines.push(`# Interactive elements — use these refs with browser_type / browser_fill / browser_click.`);
	lines.push(`# Prefer textbox/searchbox refs for typing. No extra browser_snapshot needed if refs are here.`);
	const items = Object.values(nodes).filter(n => INTERACTIVE_ROLES.has(n.role.toLowerCase()));
	items.sort((a, b) => {
		const rankDiff = interactiveRoleRank(a.role) - interactiveRoleRank(b.role);
		if (rankDiff !== 0) {
			return rankDiff;
		}
		return (a.name || '').localeCompare(b.name || '');
	});
	if (items.length === 0) {
		lines.push('- (no interactive elements found — try browser_snapshot without interactive:true)');
		return lines.join('\n');
	}
	for (const node of items) {
		const namePart = node.name ? ` "${node.name.replace(/"/g, '\\"')}"` : '';
		lines.push(`- ${node.role}${namePart} [ref=${node.ref}]`);
	}
	return lines.join('\n');
}

/**
 * Serializes a snapshot's node tree to the YAML-ish text the model consumes.
 * Pure function — exported so it can be contract-tested without Electron.
 */
export function snapshotToYaml(nodes: Record<string, MutableAXNode>, rootRef: string | undefined, nav: { url: string; title: string }, compact: boolean): string {
	const lines: string[] = [];
	lines.push(`# url: ${nav.url}`);
	lines.push(`# title: ${nav.title}`);
	if (!rootRef) {
		lines.push('- (empty)');
		return lines.join('\n');
	}
	const writeNode = (ref: string, indent: number) => {
		const node = nodes[ref];
		if (!node) {
			return;
		}
		const pad = '  '.repeat(indent);
		const namePart = node.name ? ` "${node.name.replace(/"/g, '\\"')}"` : '';
		const attrPart = !compact && node.attributes
			? ' ' + Object.entries(node.attributes).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
			: '';
		lines.push(`${pad}- ${node.role}${namePart}${attrPart} [ref=${ref}]`);
		for (const child of node.children ?? []) {
			writeNode(child, indent + 1);
		}
	};
	writeNode(rootRef, 0);
	return lines.join('\n');
}
