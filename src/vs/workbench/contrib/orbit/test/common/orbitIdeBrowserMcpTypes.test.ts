/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Orbit Editor. All rights reserved.
 *  Licensed under the Apache License. See LICENSE.txt for more information.
 *---------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ORBIT_IDE_BROWSER_TOOLS, ORBIT_IDE_BROWSER_TOOL_NAMES, ORBIT_IDE_BROWSER_MCP_SERVER_NAME, ORBIT_IDE_BROWSER_MCP_INSTRUCTIONS } from '../../common/builtinMcp/orbitIdeBrowserMcpTypes.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('orbitIdeBrowserMcpTypes - tool schema contract', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('server name and instructions are non-empty', () => {
		assert.ok(ORBIT_IDE_BROWSER_MCP_SERVER_NAME.length > 0);
		assert.ok(ORBIT_IDE_BROWSER_MCP_INSTRUCTIONS.length > 0);
	});

	test('exposes 17 Cursor-parity browser tools (16 cursor-ide-browser tools + browser_hover)', () => {
		// cursor-ide-browser ships 16 tools. Orbit ships those 16 plus the
		// superset `browser_hover` (17). This test pins the contract so
		// accidental additions/removals are caught.
		assert.strictEqual(ORBIT_IDE_BROWSER_TOOLS.length, 17);
	});

	test('every tool has a unique browser_-prefixed name and a description', () => {
		const seen = new Set<string>();
		for (const tool of ORBIT_IDE_BROWSER_TOOLS) {
			assert.ok(tool.name.startsWith('browser_'), `tool ${tool.name} should start with browser_`);
			assert.ok(!seen.has(tool.name), `duplicate tool name: ${tool.name}`);
			seen.add(tool.name);
			assert.ok(typeof tool.description === 'string' && tool.description!.length > 0, `tool ${tool.name} missing description`);
		}
	});

	test('every tool has an object inputSchema with type:"object"', () => {
		for (const tool of ORBIT_IDE_BROWSER_TOOLS) {
			const schema = tool.inputSchema as { type?: string } | undefined;
			assert.ok(schema, `tool ${tool.name} missing inputSchema`);
			assert.strictEqual(schema!.type, 'object', `tool ${tool.name} inputSchema.type should be 'object'`);
		}
	});

	test('tool names list matches the tools array', () => {
		assert.deepStrictEqual(
			ORBIT_IDE_BROWSER_TOOL_NAMES,
			ORBIT_IDE_BROWSER_TOOLS.map(t => t.name),
		);
	});

	test('exposes the same 16 tool names as cursor-ide-browser (plus browser_hover)', () => {
		const cursorNames = new Set([
			'browser_navigate', 'browser_tabs', 'browser_lock', 'browser_snapshot',
			'browser_take_screenshot', 'browser_click', 'browser_mouse_click_xy',
			'browser_type', 'browser_fill', 'browser_select_option', 'browser_press_key',
			'browser_scroll', 'browser_drag', 'browser_highlight', 'browser_get_bounding_box',
			'browser_cdp',
		]);
		const orbitNames = new Set(ORBIT_IDE_BROWSER_TOOL_NAMES);
		for (const name of cursorNames) {
			assert.ok(orbitNames.has(name), `Orbit is missing cursor-ide-browser tool: ${name}`);
		}
		// Orbit ships exactly one superset tool.
		assert.ok(orbitNames.has('browser_hover'), 'Orbit should ship the browser_hover superset tool');
		const extra = [...orbitNames].filter(n => !cursorNames.has(n));
		assert.deepStrictEqual(extra, ['browser_hover'], `unexpected extra tools: ${extra.join(', ')}`);
	});

	test('read-only tools are correctly annotated', () => {
		const readOnly = ORBIT_IDE_BROWSER_TOOLS.filter(t => t.annotations?.readOnly === true).map(t => t.name);
		// Truly inspection-only tools. browser_tabs / browser_lock / browser_highlight
		// mutate tabs or the page and must NOT be readOnly.
		assert.ok(readOnly.includes('browser_snapshot'));
		assert.ok(readOnly.includes('browser_take_screenshot'));
		assert.ok(readOnly.includes('browser_get_bounding_box'));
		assert.ok(!readOnly.includes('browser_tabs'));
		assert.ok(!readOnly.includes('browser_lock'));
		assert.ok(!readOnly.includes('browser_highlight'));
		assert.ok(!readOnly.includes('browser_navigate'));
	});

	test('mutating tools are NOT marked readOnly', () => {
		const mutating = [
			'browser_navigate', 'browser_tabs', 'browser_lock', 'browser_click',
			'browser_mouse_click_xy', 'browser_type', 'browser_fill', 'browser_select_option',
			'browser_press_key', 'browser_scroll', 'browser_drag', 'browser_hover', 'browser_highlight',
		];
		for (const name of mutating) {
			const tool = ORBIT_IDE_BROWSER_TOOLS.find(t => t.name === name);
			assert.ok(tool, `missing tool ${name}`);
			assert.ok(tool!.annotations?.readOnly !== true, `${name} should not be readOnly`);
		}
	});

	test('browser_cdp remains approval-gated even though its methods are allowlisted', () => {
		const cdp = ORBIT_IDE_BROWSER_TOOLS.find(t => t.name === 'browser_cdp');
		assert.ok(cdp);
		assert.ok(cdp!.annotations?.readOnly !== true);
	});

	test('browser_lock is NOT readOnly (installs a pointer overlay)', () => {
		const lock = ORBIT_IDE_BROWSER_TOOLS.find(t => t.name === 'browser_lock');
		assert.ok(lock);
		assert.ok(lock!.annotations?.readOnly !== true);
	});

	test('browser_tabs schema supports both index and viewId (cursor parity + Orbit extension)', () => {
		const tabs = ORBIT_IDE_BROWSER_TOOLS.find(t => t.name === 'browser_tabs');
		assert.ok(tabs);
		const props = (tabs!.inputSchema as { properties: Record<string, unknown> }).properties;
		assert.ok(props.index, 'browser_tabs should have an index property (cursor-ide-browser parity)');
		assert.ok(props.viewId, 'browser_tabs should have a viewId property (Orbit extension)');
		assert.ok(props.url, 'browser_tabs should have a url property for action "new"');
	});

	test('interaction tools support take_screenshot_afterwards', () => {
		const interactionTools = [
			'browser_navigate', 'browser_click', 'browser_mouse_click_xy', 'browser_type',
			'browser_fill', 'browser_select_option', 'browser_press_key', 'browser_scroll',
			'browser_drag', 'browser_hover', 'browser_highlight', 'browser_cdp', 'browser_snapshot',
		];
		for (const name of interactionTools) {
			const tool = ORBIT_IDE_BROWSER_TOOLS.find(t => t.name === name);
			assert.ok(tool, `missing tool ${name}`);
			const props = (tool!.inputSchema as { properties: Record<string, unknown> }).properties;
			assert.ok(props.take_screenshot_afterwards, `${name} should support take_screenshot_afterwards`);
		}
	});

	test('browser_navigate exposes includeSnapshot for the golden path', () => {
		const nav = ORBIT_IDE_BROWSER_TOOLS.find(t => t.name === 'browser_navigate');
		assert.ok(nav);
		const props = (nav!.inputSchema as { properties: Record<string, unknown> }).properties;
		assert.ok(props.includeSnapshot, 'navigate should support includeSnapshot (default true at runtime)');
		assert.ok(props.newTab, 'navigate should support newTab');
		assert.ok(props.position, 'navigate should support position');
	});

	test('browser_take_screenshot exposes cursor-ide-browser parity options', () => {
		const ss = ORBIT_IDE_BROWSER_TOOLS.find(t => t.name === 'browser_take_screenshot');
		assert.ok(ss);
		const props = (ss!.inputSchema as { properties: Record<string, unknown> }).properties;
		assert.ok(props.type, 'screenshot should support type (png/jpeg)');
		assert.ok(props.filename, 'screenshot should support filename');
		assert.ok(props.fullPage, 'screenshot should support fullPage');
		assert.ok(props.ref, 'screenshot should support ref (element clip)');
		assert.ok(props.element, 'screenshot should support element description');
		assert.ok(props.viewId, 'screenshot should support viewId');
	});

	test('browser_type supports clear (cursor-ide-browser parity)', () => {
		const type = ORBIT_IDE_BROWSER_TOOLS.find(t => t.name === 'browser_type');
		assert.ok(type);
		const props = (type!.inputSchema as { properties: Record<string, unknown> }).properties;
		assert.ok(props.clear, 'browser_type should support clear');
		assert.ok(props.submit, 'browser_type should support submit');
		assert.ok(props.slowly, 'browser_type should support slowly');
	});

	test('browser_scroll supports direction, amount, and scrollIntoView (cursor-ide-browser parity)', () => {
		const scroll = ORBIT_IDE_BROWSER_TOOLS.find(t => t.name === 'browser_scroll');
		assert.ok(scroll);
		const props = (scroll!.inputSchema as { properties: Record<string, unknown> }).properties;
		assert.ok(props.direction, 'browser_scroll should support direction');
		assert.ok(props.amount, 'browser_scroll should support amount');
		assert.ok(props.scrollIntoView, 'browser_scroll should support scrollIntoView');
		assert.ok(props.deltaX, 'browser_scroll should support deltaX');
		assert.ok(props.deltaY, 'browser_scroll should support deltaY');
	});

	test('browser_drag supports targetRef and targetX/targetY (cursor-ide-browser parity)', () => {
		const drag = ORBIT_IDE_BROWSER_TOOLS.find(t => t.name === 'browser_drag');
		assert.ok(drag);
		const props = (drag!.inputSchema as { properties: Record<string, unknown> }).properties;
		assert.ok(props.sourceRef, 'browser_drag should require sourceRef');
		assert.ok(props.targetRef, 'browser_drag should support targetRef');
		assert.ok(props.targetX, 'browser_drag should support targetX');
		assert.ok(props.targetY, 'browser_drag should support targetY');
		const required = (drag!.inputSchema as { required: string[] }).required;
		assert.deepStrictEqual(required, ['sourceRef'], 'browser_drag should only require sourceRef');
	});

	test('browser_highlight supports element and durationMs (cursor-ide-browser parity)', () => {
		const hl = ORBIT_IDE_BROWSER_TOOLS.find(t => t.name === 'browser_highlight');
		assert.ok(hl);
		const props = (hl!.inputSchema as { properties: Record<string, unknown> }).properties;
		assert.ok(props.element, 'browser_highlight should support element');
		assert.ok(props.durationMs, 'browser_highlight should support durationMs');
	});

	test('browser_get_bounding_box supports element (cursor-ide-browser parity)', () => {
		const bb = ORBIT_IDE_BROWSER_TOOLS.find(t => t.name === 'browser_get_bounding_box');
		assert.ok(bb);
		const props = (bb!.inputSchema as { properties: Record<string, unknown> }).properties;
		assert.ok(props.element, 'browser_get_bounding_box should support element');
	});

	test('instructions mirror cursor-ide-browser workflow guidance', () => {
		// Core workflow + lock/unlock ordering + CDP usage + waiting strategy.
		assert.match(ORBIT_IDE_BROWSER_MCP_INSTRUCTIONS, /CORE WORKFLOW/);
		assert.match(ORBIT_IDE_BROWSER_MCP_INSTRUCTIONS, /Lock\/unlock workflow/);
		assert.match(ORBIT_IDE_BROWSER_MCP_INSTRUCTIONS, /Waiting strategy/);
		assert.match(ORBIT_IDE_BROWSER_MCP_INSTRUCTIONS, /CDP USAGE/);
		assert.match(ORBIT_IDE_BROWSER_MCP_INSTRUCTIONS, /browser_cdp uses an exact allowlist/);
		assert.doesNotMatch(ORBIT_IDE_BROWSER_MCP_INSTRUCTIONS, /Use Runtime\.evaluate/);
		assert.match(ORBIT_IDE_BROWSER_MCP_INSTRUCTIONS, /AVOID RABBIT HOLES/);
		assert.match(ORBIT_IDE_BROWSER_MCP_INSTRUCTIONS, /browser_snapshot returns snapshot YAML/);
	});

	test('instructions document the Orbit golden-path extension', () => {
		assert.match(ORBIT_IDE_BROWSER_MCP_INSTRUCTIONS, /ORBIT EXTENSIONS/);
		assert.match(ORBIT_IDE_BROWSER_MCP_INSTRUCTIONS, /browser_navigate returns interactive refs by default/);
		assert.match(ORBIT_IDE_BROWSER_MCP_INSTRUCTIONS, /browser_hover is available/);
	});
});
