/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Orbit Editor. All rights reserved.
 *  Licensed under the Apache License. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	isCdpMethodDenied,
	isCdpEvalExpressionDenied,
	isModelCdpMethodAllowed,
	snapshotToYaml,
	snapshotToInteractiveList,
	interactiveRoleRank,
	buildFullPageScreenshotClip,
	buildViewportScreenshotClip,
	buildElementScreenshotClip,
	MAX_SCREENSHOT_DIMENSION_CSS_PX,
	MutableAXNode,
} from '../../../../../platform/browserView/common/browserAutomationPure.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('browserAutomationPure - CDP denylist', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('model-facing CDP uses an exact reviewed allowlist', () => {
		assert.ok(isModelCdpMethodAllowed(' DOM.getDocument '));
		assert.ok(isModelCdpMethodAllowed('Performance.getMetrics'));
		assert.ok(isModelCdpMethodAllowed('Profiler.stop'));
		assert.ok(!isModelCdpMethodAllowed('Runtime.evaluate'));
		assert.ok(!isModelCdpMethodAllowed('Runtime.callFunctionOn'));
		assert.ok(!isModelCdpMethodAllowed('Network.getResponseBody'));
		assert.ok(!isModelCdpMethodAllowed('DOM.setFileInputFiles'));
		assert.ok(!isModelCdpMethodAllowed('FutureDomain.newMethod'));
	});
	test('denies Input.* methods (model must use click/type tools)', () => {
		assert.ok(isCdpMethodDenied('Input.dispatchMouseEvent'));
		assert.ok(isCdpMethodDenied('Input.insertText'));
	});

	test('denies cookie / storage exfiltration', () => {
		assert.ok(isCdpMethodDenied('Network.getCookies'));
		assert.ok(isCdpMethodDenied('Network.getAllCookies'));
		assert.ok(isCdpMethodDenied('Storage.getCookies'));
		assert.ok(isCdpMethodDenied('Network.setCookie'));
		assert.ok(isCdpMethodDenied('Network.getResponseBody'));
		assert.ok(isCdpMethodDenied('IndexedDB.requestDatabaseNames'));
		assert.ok(isCdpMethodDenied('CacheStorage.requestCacheNames'));
	});

	test('denies file-input and download CDP methods', () => {
		assert.ok(isCdpMethodDenied('DOM.setFileInputFiles'));
		assert.ok(isCdpMethodDenied('Page.setDownloadBehavior'));
		assert.ok(isCdpMethodDenied('Page.setInterceptFileChooserDialog'));
	});

	test('denies target management and history navigation', () => {
		assert.ok(isCdpMethodDenied('Target.createTarget'));
		assert.ok(isCdpMethodDenied('Target.closeTarget'));
		assert.ok(isCdpMethodDenied('Target.detachFromTarget'));
		assert.ok(isCdpMethodDenied('Page.navigateToHistoryEntry'));
	});

	test('allows safe read-only / inspection methods', () => {
		assert.ok(!isCdpMethodDenied('Runtime.evaluate'));
		assert.ok(!isCdpMethodDenied('DOM.getDocument'));
		assert.ok(!isCdpMethodDenied('Performance.getMetrics'));
		assert.ok(!isCdpMethodDenied('Accessibility.getFullAXTree'));
	});

	test('denies cookie/storage expressions in Runtime.evaluate', () => {
		assert.ok(isCdpEvalExpressionDenied('document.cookie'));
		assert.ok(isCdpEvalExpressionDenied('return localStorage.getItem("x")'));
		assert.ok(isCdpEvalExpressionDenied('sessionStorage.clear()'));
		assert.ok(isCdpEvalExpressionDenied('indexedDB.databases()'));
		assert.ok(!isCdpEvalExpressionDenied('document.title'));
		assert.ok(!isCdpEvalExpressionDenied('1 + 1'));
		assert.ok(!isCdpEvalExpressionDenied(undefined));
	});

	test('trims whitespace before matching', () => {
		assert.ok(isCdpMethodDenied('  Input.dispatchKeyEvent  '));
	});

	test('does not over-match prefix substrings', () => {
		// `Input.` is denied, but a method literally named `InputFoo` (no dot)
		// must not be denied just because it starts with `Input`.
		assert.ok(!isCdpMethodDenied('InputFoo'));
	});
});

suite('browserAutomationPure - snapshotToYaml', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('emits url and title header comments', () => {
		const yaml = snapshotToYaml({}, undefined, { url: 'https://example.com', title: 'Example' }, false);
		assert.match(yaml, /# url: https:\/\/example\.com/);
		assert.match(yaml, /# title: Example/);
	});

	test('renders empty marker when rootRef is undefined', () => {
		const yaml = snapshotToYaml({}, undefined, { url: 'about:blank', title: '' }, false);
		assert.match(yaml, /- \(empty\)/);
	});

	test('renders a simple tree with refs and indentation', () => {
		const nodes: Record<string, MutableAXNode> = {
			'ref-root': { ref: 'ref-root', role: 'WebArea', name: 'Home', bounds: null, depth: 0, children: ['ref-btn', 'ref-link'] },
			'ref-btn': { ref: 'ref-btn', role: 'button', name: 'Submit', bounds: { x: 0, y: 0, width: 100, height: 40 }, depth: 1 },
			'ref-link': { ref: 'ref-link', role: 'link', name: 'Docs', bounds: { x: 0, y: 50, width: 80, height: 20 }, depth: 1, children: ['ref-span'] },
			'ref-span': { ref: 'ref-span', role: 'generic', name: '', bounds: null, depth: 2 },
		};
		const yaml = snapshotToYaml(nodes, 'ref-root', { url: 'https://x.test', title: 'X' }, false);
		const lines = yaml.split('\n');
		// header + 4 nodes
		assert.strictEqual(lines.length, 6);
		assert.match(lines[2], /^- WebArea "Home" \[ref=ref-root\]/);
		assert.match(lines[3], /^  - button "Submit" \[ref=ref-btn\]/);
		assert.match(lines[4], /^  - link "Docs" \[ref=ref-link\]/);
		assert.match(lines[5], /^    - generic \[ref=ref-span\]/);
	});

	test('escapes double quotes in node names', () => {
		const nodes: Record<string, MutableAXNode> = {
			'ref-1': { ref: 'ref-1', role: 'button', name: 'Say "hi"', bounds: null, depth: 0 },
		};
		const yaml = snapshotToYaml(nodes, 'ref-1', { url: '', title: '' }, false);
		assert.match(yaml, /- button "Say \\"hi\\"" \[ref=ref-1\]/);
	});

	test('compact mode omits attributes', () => {
		const nodes: Record<string, MutableAXNode> = {
			'ref-1': { ref: 'ref-1', role: 'textbox', name: 'Email', bounds: null, depth: 0, attributes: { value: 'a@b.com', required: true } },
		};
		const compact = snapshotToYaml(nodes, 'ref-1', { url: '', title: '' }, true);
		assert.ok(!compact.includes('value='));
		assert.ok(!compact.includes('required='));
	});

	test('non-compact mode includes attributes as key=value pairs', () => {
		const nodes: Record<string, MutableAXNode> = {
			'ref-1': { ref: 'ref-1', role: 'textbox', name: 'Email', bounds: null, depth: 0, attributes: { value: 'a@b.com', required: true } },
		};
		const yaml = snapshotToYaml(nodes, 'ref-1', { url: '', title: '' }, false);
		assert.match(yaml, /value="a@b\.com"/);
		assert.match(yaml, /required=true/);
	});
});

suite('browserAutomationPure - snapshotToInteractiveList', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('lists textboxes before buttons/links', () => {
		const nodes: Record<string, MutableAXNode> = {
			'ref-btn': { ref: 'ref-btn', role: 'button', name: 'Send', bounds: null, depth: 0 },
			'ref-tb': { ref: 'ref-tb', role: 'textbox', name: 'Message', bounds: null, depth: 0 },
			'ref-link': { ref: 'ref-link', role: 'link', name: 'Docs', bounds: null, depth: 0 },
		};
		const list = snapshotToInteractiveList(nodes, { url: 'https://x.test', title: 'X' });
		const lines = list.split('\n').filter(l => l.startsWith('- '));
		assert.strictEqual(lines.length, 3);
		// Editables first; same-rank roles (button/link) are name-sorted.
		assert.match(lines[0], /textbox "Message"/);
		assert.match(lines[1], /link "Docs"/);
		assert.match(lines[2], /button "Send"/);
	});

	test('empty interactive set has a clear marker', () => {
		const list = snapshotToInteractiveList({}, { url: 'about:blank', title: '' });
		assert.match(list, /no interactive elements found/);
	});

	test('interactiveRoleRank orders editables first', () => {
		assert.ok(interactiveRoleRank('textbox') < interactiveRoleRank('button'));
		assert.ok(interactiveRoleRank('button') < interactiveRoleRank('checkbox'));
	});
});

suite('browserAutomationPure - screenshot clip builders (Retina-safe)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('buildFullPageScreenshotClip prefers cssContentSize over device-pixel contentSize', () => {
		// Simulate a Retina Mac: cssContentSize is CSS px, contentSize is 2× device px.
		const clip = buildFullPageScreenshotClip({
			cssContentSize: { x: 0, y: 0, width: 800, height: 2000 },
			contentSize: { x: 0, y: 0, width: 1600, height: 4000 },
		});
		assert.ok(clip);
		assert.strictEqual(clip!.width, 800);
		assert.strictEqual(clip!.height, 2000);
		assert.strictEqual(clip!.scale, 1);
	});

	test('buildFullPageScreenshotClip falls back to contentSize when css* is missing', () => {
		const clip = buildFullPageScreenshotClip({
			contentSize: { x: 0, y: 0, width: 900, height: 1200 },
		});
		assert.ok(clip);
		assert.strictEqual(clip!.width, 900);
		assert.strictEqual(clip!.height, 1200);
	});

	test('buildFullPageScreenshotClip returns undefined for empty metrics', () => {
		assert.strictEqual(buildFullPageScreenshotClip(undefined), undefined);
		assert.strictEqual(buildFullPageScreenshotClip({}), undefined);
		assert.strictEqual(buildFullPageScreenshotClip({ cssContentSize: { width: 0, height: 0 } }), undefined);
	});

	test('buildFullPageScreenshotClip clamps pathological dimensions', () => {
		const clip = buildFullPageScreenshotClip({
			cssContentSize: { x: 0, y: 0, width: 100_000, height: 50 },
		});
		assert.ok(clip);
		assert.ok(clip!.width <= MAX_SCREENSHOT_DIMENSION_CSS_PX);
	});

	test('buildViewportScreenshotClip prefers cssVisualViewport', () => {
		const clip = buildViewportScreenshotClip({
			cssVisualViewport: { pageX: 0, pageY: 100, clientWidth: 1024, clientHeight: 768 },
			visualViewport: { pageX: 0, pageY: 200, clientWidth: 2048, clientHeight: 1536 },
		});
		assert.ok(clip);
		assert.strictEqual(clip!.x, 0);
		assert.strictEqual(clip!.y, 100);
		assert.strictEqual(clip!.width, 1024);
		assert.strictEqual(clip!.height, 768);
	});

	test('buildElementScreenshotClip rounds and rejects zero-size', () => {
		const ok = buildElementScreenshotClip({ x: 10.4, y: 20.6, width: 100.2, height: 50.8 });
		assert.ok(ok);
		assert.strictEqual(ok!.x, 10);
		assert.strictEqual(ok!.y, 21);
		assert.strictEqual(ok!.width, 100);
		assert.strictEqual(ok!.height, 51);

		assert.strictEqual(buildElementScreenshotClip({ x: 0, y: 0, width: 0, height: 10 }), undefined);
		assert.strictEqual(buildElementScreenshotClip(undefined), undefined);
	});
});
