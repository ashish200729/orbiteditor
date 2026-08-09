/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { MCPTool } from '../mcpServiceTypes.js';
/**
 * Stable identifier for the built-in browser MCP server. Matches Cursor's
 * `cursor-ide-browser` convention so skill/playbook content transfers cleanly.
 * This server is registered in-process (not via `mcp.json`) and is controlled
 * by the Browser Automation settings toggle.
 */
export const ORBIT_IDE_BROWSER_MCP_SERVER_NAME = 'orbit-ide-browser';

/**
 * MCP instructions returned to the model. Mirrors Cursor's
 * `cursor-ide-browser` server instructions (core workflow, lock/unlock
 * ordering, waiting strategy, CDP usage, vision, notes) and adds Orbit-only
 * golden-path notes at the end for the in-process `orbit-ide-browser` server
 * (no separate Chrome to launch, navigate returns refs by default).
 */
export const ORBIT_IDE_BROWSER_MCP_INSTRUCTIONS = `Orbit's integrated browser MCP server provides a Cursor-owned browser tab plus a raw Chrome DevTools Protocol command tool. It runs in-process (no separate Chrome to launch, no npx dependency).

CORE WORKFLOW:
1. Start by understanding the user's goal and what success looks like on the page.
2. Use browser_tabs with action "list" to inspect open tabs and URLs before acting.
3. Use browser_navigate to create or navigate the target tab. Omit the position parameter for background automation so focus is preserved. By default browser_navigate also returns an interactive element list (textboxes first) so you can usually browser_type/browser_click in the very next call.
4. Use browser_lock before longer automation on an existing tab, then browser_lock with action "unlock" when finished.
5. Use browser_snapshot for accessibility context and browser_take_screenshot for visual verification.
6. Use browser_click, browser_type, browser_fill, browser_select_option, browser_press_key, browser_scroll, and browser_drag for page interactions.
7. Use browser_highlight and browser_get_bounding_box for visual grounding and coordinate diagnostics.
8. Use browser_cdp only for reviewed read-only page inspection, profiling, DOM/CSS queries, and performance data.

AVOID RABBIT HOLES:
1. Do not repeat the same failing action more than once without new evidence such as a fresh snapshot, a different ref, a changed page state, or a clear new hypothesis.
2. IMPORTANT: If four attempts fail or progress stalls, stop acting and report what you observed, what blocked progress, and the most likely next step.
3. Prefer gathering evidence over brute force. If the page is confusing, use browser_snapshot, browser_take_screenshot, or CDP inspection before trying more actions.
4. If you encounter a blocker such as login, passkey/manual user interaction, permissions, captchas, destructive confirmations, missing data, or an unexpected state, stop and report it instead of improvising repeated actions.
5. Do not get stuck in wait-action-wait loops. Every retry should be justified by something newly observed.

CRITICAL - Lock/unlock workflow:
1. browser_lock requires an existing browser tab - you CANNOT call browser_lock with action: "lock" before browser_navigate
2. Correct order: browser_navigate -> browser_lock({ action: "lock" }) -> (interactions) -> browser_lock({ action: "unlock" })
3. If a browser tab already exists (check with browser_tabs list), call browser_lock with action: "lock" FIRST before any interactions
4. Only call browser_lock with action: "unlock" when completely done with ALL browser operations for this turn

IMPORTANT - Waiting strategy:
When waiting for page changes, prefer fresh browser_snapshot checks or reviewed DOM/performance CDP queries rather than a single long wait.

CDP USAGE:
- Use browser_cdp with a reviewed DevTools Protocol inspection/profiling method and params object, for example DOM.getDocument, CSS.getComputedStyleForNode, Profiler.start/stop, Performance.getMetrics, or Log.enable.
- browser_cdp uses an exact allowlist. Runtime evaluation, Input.*, network bodies, cookies, storage, navigation, downloads, permissions, target management, and filesystem-backed commands are unavailable.
- Use browser_click, browser_type, browser_fill, browser_select_option, browser_press_key, browser_scroll, and browser_drag for clicks, typing, filling inputs, selecting options, keyboard actions, scrolling, and drag-and-drop.
- For profiling, call Profiler.enable, Profiler.start, reproduce the behavior, then Profiler.stop. The profile is saved to a file and returned as a log_file; read that file only when you need to inspect details.
- Large CDP responses are saved to files instead of being inlined. Prefer using the returned file path over immediately stuffing large payloads into context; read focused sections only when needed.

VISION:
- browser_take_screenshot attaches an image result that the model can inspect. CDP Page.captureScreenshot returns data inside JSON and should not replace browser_take_screenshot when visual verification is needed.

NOTES:
- browser_snapshot returns snapshot YAML and is the main source of truth for page structure.
- Refs are opaque handles tied to the latest browser_snapshot for that tab.
- Iframe content is not accessible - only elements outside iframes can be interacted with.
- When you stop to report a blocker, include the current page, the target you were trying to reach, the blocker you observed, and the best next action. If the blocker requires manual user interaction, ask the user to take over at that point rather than assuming it in advance.

ORBIT EXTENSIONS (vs cursor-ide-browser):
- browser_navigate returns interactive refs by default (includeSnapshot defaults true). This makes the common "open ChatGPT and type hi" goal finish in 2 calls: browser_navigate then browser_type. Do NOT call browser_snapshot again right after navigate unless the returned refs fail.
- browser_type self-focuses and self-verifies the typed text landed in the control; no prior click or screenshot is needed. submit:true presses Enter after typing.
- browser_hover is available for tooltip/menu interactions (a superset tool not present in cursor-ide-browser).
- The Orbit server uses viewId (a stable tab id) instead of tab index for select/close; browser_tabs "list" prints the ids. index is also accepted as a convenience and resolves by list order.

## STOP CONDITIONS
Max 4 attempts per goal, then report the blocker with evidence. Login/captcha/2FA -> stop and ask the user. Don't repeat a failed action without a fresh snapshot. Don't claim success without verification (tool confirmation or screenshot).
`;

/**
 * Tool definitions for the built-in browser MCP server. Argument shapes mirror
 * Cursor's `cursor-ide-browser` MCP descriptors so agent skills transfer; Orbit
 * keeps a few superset parameters (includeSnapshot on navigate, modifiers on
 * press_key, hover) and its viewId-based tab addressing.
 *
 * Read-only tools are annotated with `annotations.readOnly = true` so the
 * Orbit agent runtime can parallelize them and allow them in read-only
 * subagents (see `isMCPToolReadOnly` in prompts.ts).
 */
export const ORBIT_IDE_BROWSER_TOOLS: readonly MCPTool[] = [
	{
		name: 'browser_navigate',
		description: 'Navigate to a URL. By default reuses an existing tab; set newTab: true to open in a new tab. The response includes an interactive element list (textboxes first) by default so the next call can be browser_type/browser_click without a separate browser_snapshot.',
		inputSchema: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'The URL to navigate to.' },
				viewId: { type: 'string', description: 'Target browser tab ID. If omitted, uses the last interacted tab.' },
				position: {
					type: 'string',
					enum: ['active', 'side'],
					description: 'Only set when the user explicitly asks to reveal, show, focus, or open the browser visibly. Set to "active" for visible/revealed browser UI, or "side" if the user mentions "side", "beside", "side panel", or "side by side". Omit this parameter for background automation so focus is preserved.',
				},
				take_screenshot_afterwards: { type: 'boolean', description: 'When true, takes a screenshot after navigation completes. Defaults to false.' },
				newTab: { type: 'boolean', description: 'When true, creates a new tab before navigating instead of reusing an existing tab. Defaults to false.' },
				includeSnapshot: {
					type: 'boolean',
					description: 'Orbit extension (default true): return an interactive element list after load so the next call can type/click with refs. Set false only if you do not need refs.',
				},
			},
			required: ['url'],
		},
	},
	{
		name: 'browser_tabs',
		description: 'List, create, close, or select a browser tab. Only action "list" is read-only; new/close/select mutate tabs and run sequentially.',
		inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['list', 'new', 'close', 'select'], description: 'Operation to perform.' },
				index: { type: 'number', description: 'Tab index (0-based from browser_tabs "list"). Required for "select". Optional for "close" (defaults to current tab). Orbit also accepts viewId for the same operations.' },
				viewId: { type: 'string', description: 'Target browser tab ID. Used for "select" (required) or "close". If both index and viewId are given, viewId wins.' },
				url: { type: 'string', description: 'URL for action "new". Defaults to about:blank.' },
				position: {
					type: 'string',
					enum: ['active', 'side'],
					description: 'Only set for action "new" when the user explicitly asks to reveal, show, focus, or open the browser visibly. Set to "active" for visible/revealed browser UI, or "side" if the user mentions "side", "beside", "side panel", or "side by side". Omit this parameter for background automation so focus is preserved.',
				},
			},
			required: ['action'],
		},
		// Not readOnly: action "new"/"close"/"select" mutate tabs. Marking the
		// whole tool readOnly would let read-only subagents open/close tabs and
		// allow parallel execution that races with other browser tools.
	},
	{
		name: 'browser_lock',
		description: 'Lock or unlock the browser to control whether the user can interact while you work. Set action to "lock" or "unlock". When locked, a pointer overlay blocks user clicks and the user can still click "Take Control" to unlock if needed. Skip for a single navigate->type task; use it for long multi-step sequences.',
		inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['lock', 'unlock'], description: 'Whether to lock or unlock the browser for user interaction.' },
				viewId: { type: 'string', description: 'Target browser tab ID. If omitted, uses the last interacted tab.' },
			},
			required: ['action'],
		},
		// Not readOnly: lock installs a page overlay and changes interaction state.
	},
	{
		name: 'browser_snapshot',
		description: 'Capture accessibility snapshot of the current page; this is better than a screenshot and the main source of truth for page structure. Refs returned are opaque handles tied to this snapshot.',
		inputSchema: {
			type: 'object',
			properties: {
				viewId: { type: 'string', description: 'Target browser tab ID. If omitted, uses the last interacted tab.' },
				interactive: { type: 'boolean', description: 'When true, only include interactive elements in the snapshot. Defaults to false.' },
				maxDepth: { type: 'number', description: 'Maximum depth for snapshot output. Defaults to 20.' },
				compact: { type: 'boolean', description: 'When true, outputs a more compact snapshot format. Defaults to false.' },
				selector: { type: 'string', description: 'Optional CSS selector to scope the snapshot to a subtree.' },
				includeDiff: { type: 'boolean', description: 'When true, include a diff vs the previous snapshot for this tab. Defaults to false.' },
				take_screenshot_afterwards: { type: 'boolean', description: 'When true, takes a screenshot after snapshot completes and returns it alongside the YAML refs. Defaults to false.' },
			},
			required: [],
		},
		annotations: { readOnly: true },
	},
	{
		name: 'browser_take_screenshot',
		description: 'Take a screenshot of the current page. You can\'t perform actions based on the screenshot; use browser_snapshot for actions.',
		inputSchema: {
			type: 'object',
			properties: {
				type: { type: 'string', description: 'Image format for the screenshot. Default is png. Also accepts jpeg.' },
				filename: { type: 'string', description: 'File name to save the screenshot to. Defaults to page-{timestamp}.{png|jpeg} if not specified.' },
				element: { type: 'string', description: 'Description of the element, if taking a screenshot of an element (requires ref).' },
				ref: { type: 'string', description: 'Element ref from browser_snapshot, if taking a screenshot of an element. (Cursor describes this as a CSS selector; Orbit accepts a ref for consistency with the other ref-based tools.)' },
				fullPage: { type: 'boolean', description: 'When true, takes a screenshot of the full scrollable page, instead of the currently visible viewport. Cannot be used with element screenshots.' },
				viewId: { type: 'string', description: 'Target browser tab ID. If omitted, uses the last interacted tab.' },
			},
			required: [],
		},
		annotations: { readOnly: true },
	},
	{
		name: 'browser_click',
		description: 'Click an element by ref from browser_snapshot. Use this instead of CDP Input.* methods. Do not click a textbox just to focus it before browser_type - type focuses itself.',
		inputSchema: {
			type: 'object',
			properties: {
				ref: { type: 'string', description: 'Element ref from browser_snapshot.' },
				element: { type: 'string', description: 'Human-readable description of the element.' },
				offsetX: { type: 'number', description: 'Optional x offset from the element center.' },
				offsetY: { type: 'number', description: 'Optional y offset from the element center.' },
				doubleClick: { type: 'boolean', description: 'When true, double-click the element.' },
				button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button. Defaults to left.' },
				modifiers: {
					type: 'array',
					items: { type: 'string', enum: ['Control', 'Shift', 'Alt', 'Meta', 'ControlOrMeta'] },
					description: 'Optional modifier keys.',
				},
				holdDurationMs: { type: 'number', description: 'Optional mouse hold duration before release.' },
				viewId: { type: 'string', description: 'Target browser tab ID. If omitted, uses the last interacted tab.' },
				take_screenshot_afterwards: { type: 'boolean', description: 'When true, takes a screenshot after the click completes. Defaults to false.' },
			},
			required: ['ref'],
		},
	},
	{
		name: 'browser_mouse_click_xy',
		description: 'Click at viewport coordinates. Prefer browser_click with refs when possible.',
		inputSchema: {
			type: 'object',
			properties: {
				x: { type: 'number', description: 'Viewport x coordinate.' },
				y: { type: 'number', description: 'Viewport y coordinate.' },
				button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button. Defaults to left.' },
				doubleClick: { type: 'boolean', description: 'When true, double-click. (Orbit extension.)' },
				viewId: { type: 'string', description: 'Target browser tab ID. If omitted, uses the last interacted tab.' },
				take_screenshot_afterwards: { type: 'boolean', description: 'When true, takes a screenshot after the click completes. Defaults to false.' },
			},
			required: ['x', 'y'],
		},
	},
	{
		name: 'browser_type',
		description: 'Type text into an input, textarea, or contenteditable element by ref. Self-focuses and self-verifies - no prior click or screenshot is needed. submit:true presses Enter after typing.',
		inputSchema: {
			type: 'object',
			properties: {
				ref: { type: 'string', description: 'Element ref from browser_snapshot.' },
				text: { type: 'string', description: 'Text to type.' },
				element: { type: 'string', description: 'Human-readable description of the element.' },
				clear: { type: 'boolean', description: 'When true, clear existing text first. (Orbit: prefer browser_fill for a guaranteed replace; type+clear clears then appends.)' },
				submit: { type: 'boolean', description: 'When true, press Enter after typing.' },
				slowly: { type: 'boolean', description: 'When true, type character by character. Retry with this if bulk type fails.' },
				viewId: { type: 'string', description: 'Target browser tab ID. If omitted, uses the last interacted tab.' },
				take_screenshot_afterwards: { type: 'boolean', description: 'When true, takes a screenshot after typing completes. Defaults to false. Usually unnecessary - type already verifies.' },
			},
			required: ['ref', 'text'],
		},
	},
	{
		name: 'browser_fill',
		description: 'Set the value of an input, textarea, or contenteditable element by ref (clear and replace). Self-verifies. Prefer over browser_type when replacing entire content.',
		inputSchema: {
			type: 'object',
			properties: {
				ref: { type: 'string', description: 'Element ref from browser_snapshot.' },
				value: { type: 'string', description: 'Value to set.' },
				element: { type: 'string', description: 'Human-readable description of the element.' },
				viewId: { type: 'string', description: 'Target browser tab ID. If omitted, uses the last interacted tab.' },
				take_screenshot_afterwards: { type: 'boolean', description: 'When true, takes a screenshot after filling completes. Defaults to false. Usually unnecessary.' },
			},
			required: ['ref', 'value'],
		},
	},
	{
		name: 'browser_select_option',
		description: 'Select one or more options in a select element by ref.',
		inputSchema: {
			type: 'object',
			properties: {
				ref: { type: 'string', description: 'Element ref from browser_snapshot.' },
				values: { type: 'array', items: { type: 'string' }, description: 'Option values or labels to select.' },
				element: { type: 'string', description: 'Human-readable description of the element.' },
				viewId: { type: 'string', description: 'Target browser tab ID. If omitted, uses the last interacted tab.' },
				take_screenshot_afterwards: { type: 'boolean', description: 'When true, takes a screenshot after selection completes. Defaults to false.' },
			},
			required: ['ref', 'values'],
		},
	},
	{
		name: 'browser_press_key',
		description: 'Press a key in the browser page using DOM keyboard events. Examples: Enter, Escape, Tab, ArrowDown, or a single character. Prefer browser_type submit:true to send a chat message.',
		inputSchema: {
			type: 'object',
			properties: {
				key: { type: 'string', description: 'Key to press, for example Enter, Escape, Tab, ArrowDown, or a single character.' },
				modifiers: {
					type: 'array',
					items: { type: 'string', enum: ['Control', 'Shift', 'Alt', 'Meta', 'ControlOrMeta'] },
					description: 'Optional modifier keys. (Orbit extension.)',
				},
				viewId: { type: 'string', description: 'Target browser tab ID. If omitted, uses the last interacted tab.' },
				take_screenshot_afterwards: { type: 'boolean', description: 'When true, takes a screenshot after the key press completes. Defaults to false.' },
			},
			required: ['key'],
		},
	},
	{
		name: 'browser_scroll',
		description: 'Scroll the page, a scrollable container, or an element into view. Use this instead of CDP Input.* wheel events. browser_type/click already scroll their target into view.',
		inputSchema: {
			type: 'object',
			properties: {
				ref: { type: 'string', description: 'Optional element ref from browser_snapshot.' },
				direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction. Used with amount; ignored when deltaX/deltaY are set.' },
				amount: { type: 'number', description: 'Scroll amount in pixels. Defaults to 300. Used with direction; ignored when deltaX/deltaY are set.' },
				deltaX: { type: 'number', description: 'Explicit horizontal scroll delta.' },
				deltaY: { type: 'number', description: 'Explicit vertical scroll delta.' },
				scrollIntoView: { type: 'boolean', description: 'When true, scroll the ref into view.' },
				viewId: { type: 'string', description: 'Target browser tab ID. If omitted, uses the last interacted tab.' },
				take_screenshot_afterwards: { type: 'boolean', description: 'When true, takes a screenshot after scrolling completes. Defaults to false.' },
			},
			required: [],
		},
	},
	{
		name: 'browser_drag',
		description: 'Drag an element by ref to another ref or viewport coordinates.',
		inputSchema: {
			type: 'object',
			properties: {
				sourceRef: { type: 'string', description: 'Source element ref from browser_snapshot.' },
				targetRef: { type: 'string', description: 'Optional target element ref from browser_snapshot. Either targetRef or (targetX, targetY) must be provided.' },
				targetX: { type: 'number', description: 'Optional target viewport x coordinate. Used when targetRef is not provided.' },
				targetY: { type: 'number', description: 'Optional target viewport y coordinate. Used when targetRef is not provided.' },
				intermediateRefs: { type: 'array', items: { type: 'string' }, description: 'Optional mid-path refs for multi-step drags. (Orbit extension.)' },
				viewId: { type: 'string', description: 'Target browser tab ID. If omitted, uses the last interacted tab.' },
				take_screenshot_afterwards: { type: 'boolean', description: 'When true, takes a screenshot after drag completes. Defaults to false.' },
			},
			required: ['sourceRef'],
		},
	},
	{
		name: 'browser_hover',
		description: 'Hover an element by ref (tooltips/menus). Orbit extension - not present in cursor-ide-browser.',
		inputSchema: {
			type: 'object',
			properties: {
				ref: { type: 'string', description: 'Element ref from browser_snapshot.' },
				element: { type: 'string', description: 'Human-readable description of the element.' },
				viewId: { type: 'string', description: 'Target browser tab ID. If omitted, uses the last interacted tab.' },
				take_screenshot_afterwards: { type: 'boolean', description: 'When true, takes a screenshot after hovering completes. Defaults to false.' },
			},
			required: ['ref'],
		},
	},
	{
		name: 'browser_highlight',
		description: 'Highlight an element by ref in the browser page for visual grounding.',
		inputSchema: {
			type: 'object',
			properties: {
				ref: { type: 'string', description: 'Element ref from browser_snapshot.' },
				element: { type: 'string', description: 'Human-readable description of the element.' },
				durationMs: { type: 'number', description: 'Highlight duration in milliseconds. Defaults to 2000. (Orbit keeps the highlight until cleared; durationMs is accepted for API parity and best-effort honored.)' },
				viewId: { type: 'string', description: 'Target browser tab ID. If omitted, uses the last interacted tab.' },
				take_screenshot_afterwards: { type: 'boolean', description: 'When true, takes a screenshot showing the highlight. Defaults to false.' },
			},
			required: ['ref'],
		},
		// Not readOnly: injects a DOM overlay into the page.
	},
	{
		name: 'browser_get_bounding_box',
		description: 'Get the viewport bounding box for an element ref.',
		inputSchema: {
			type: 'object',
			properties: {
				ref: { type: 'string', description: 'Element ref from browser_snapshot.' },
				element: { type: 'string', description: 'Human-readable description of the element.' },
				viewId: { type: 'string', description: 'Target browser tab ID. If omitted, uses the last interacted tab.' },
			},
			required: ['ref'],
		},
		annotations: { readOnly: true },
	},
	{
		name: 'browser_cdp',
		description: 'Send a reviewed Chrome DevTools Protocol inspection or profiling command to the target browser tab. An exact allowlist excludes runtime evaluation, input, network bodies, cookies, storage, navigation, downloads, permissions, target management, and filesystem access.',
		inputSchema: {
			type: 'object',
			properties: {
				method: { type: 'string', description: 'Allowed CDP method name, for example DOM.getDocument, CSS.getComputedStyleForNode, Profiler.start, or Performance.getMetrics.' },
				params: { type: 'object', description: 'CDP params object. Omit or pass {} when the command takes no params.' },
				viewId: { type: 'string', description: 'Target browser tab ID. If omitted, uses the last interacted tab.' },
				take_screenshot_afterwards: { type: 'boolean', description: 'When true, takes a screenshot after the CDP command completes. Defaults to false.' },
			},
			required: ['method'],
		},
	},
];

/** Tool names exposed by the built-in browser MCP server. */
export const ORBIT_IDE_BROWSER_TOOL_NAMES = ORBIT_IDE_BROWSER_TOOLS.map(t => t.name);
