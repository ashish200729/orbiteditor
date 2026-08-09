/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Orbit Editor. All rights reserved.
 *  Licensed under the Apache License. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { IBrowserViewBounds } from '../common/browserView.js';
import {
	IAccessibilitySnapshot,
	IAccessibilitySnapshotOptions,
	IBrowserAutomationService,
	IBrowserViewInfo,
	IConsoleMessage,
	IDragOptions,
	IKeyDispatchOptions,
	IMouseClickOptions,
	INetworkRequest,
	IScrollOptions,
	IScreenshotOptions,
} from '../common/browserAutomation.js';
import {
	INTERACTIVE_ROLES,
	MutableAXNode,
	ICdpLayoutMetrics,
	buildElementScreenshotClip,
	buildFullPageScreenshotClip,
	buildViewportScreenshotClip,
	isCdpEvalExpressionDenied,
	isCdpMethodDenied,
	snapshotToInteractiveList,
	snapshotToYaml,
} from '../common/browserAutomationPure.js';
import { BrowserViewMainService } from './browserViewMainService.js';
import { ILogService } from '../../log/common/log.js';
import { tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
import { promises as fsPromises } from 'fs';

// Re-export for backwards compatibility with any direct importers.
export { isCdpMethodDenied, snapshotToYaml };

interface ITabAutomationState {
	readonly disposables: DisposableStore;
	/** Ref -> node metadata. Cleared on every main-frame navigation. */
	refMap: Map<string, { backendDOMNodeId?: number; bounds: IBrowserViewBounds | null; role: string; name: string }>;
	/** The last captured snapshot's root ref (for diff mode). */
	lastRootRef: string | undefined;
	/** Previously-seen refs (used to compute removedRefs in diff mode). */
	previousRefs: Set<string>;
	/** Whether the CDP debugger is currently attached. */
	debuggerAttached: boolean;
	/** Whether console/network CDP event buffers have been hooked for this tab. */
	eventBuffersHooked: boolean;
	/** Whether automation has locked user input on this tab. */
	automationLocked: boolean;
	/** Console message ring buffer (populated while debugger is attached). */
	consoleMessages: IConsoleMessage[];
	/** Network request ring buffer (populated while debugger is attached). */
	networkLog: INetworkRequest[];
	/** Active highlight ref, if any. */
	highlightedRef: string | undefined;
}

const MAX_BUFFER_ENTRIES = 500;

function refCandidate(prefix: string): string {
	// 6 hex chars — stable within a snapshot, opaque to the model.
	let s = '';
	for (let i = 0; i < 6; i++) {
		s += Math.floor(Math.random() * 16).toString(16);
	}
	return `${prefix}${s}`;
}

function generateRef(): string {
	// `ref-` prefix matches Cursor's convention so tooling/docs transfer cleanly.
	return refCandidate('ref-');
}

/**
 * Owns per-tab automation state and wraps `BrowserViewMainService` + Chrome
 * DevTools Protocol to provide agent-friendly primitives: accessibility
 * snapshots with stable refs, ref-based click/type/fill, safe input dispatch,
 * CDP proxy with denylist, automation lock, and console/network buffers.
 *
 * Lives in the Electron main process. The built-in `orbit-ide-browser` MCP
 * server calls it directly; the renderer reaches it through the `browserView`
 * IPC channel via the thin passthrough methods on `BrowserViewMainService`.
 */
export class BrowserAutomationMainService extends Disposable implements IBrowserAutomationService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidAutomationLockChange = this._register(new Emitter<{ id: string; locked: boolean }>());
	readonly onDidAutomationLockChange: Event<{ id: string; locked: boolean }> = this._onDidAutomationLockChange.event;

	private readonly states = new Map<string, ITabAutomationState>();
	/** Per-tab promise chain so concurrent tools cannot corrupt the shared ref map. */
	private readonly exclusiveQueues = new Map<string, Promise<unknown>>();

	constructor(
		private readonly browserViewMainService: BrowserViewMainService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		// Clear automation state whenever a tab is closed so we don't leak
		// debugger sessions or buffers for closed views.
		this._register(this.browserViewMainService.onDidClose(id => this.clearState(id)));
		// Invalidate refs on cross-document navigations only. In-page
		// navigations (hash / pushState) keep the same DOM, so clearing refs
		// would force needless re-snapshots on SPAs.
		this._register(this.browserViewMainService.onDidNavigate(e => {
			if (e.inPage) {
				return;
			}
			const state = this.states.get(e.id);
			if (state) {
				state.previousRefs = new Set(state.refMap.keys());
				state.refMap.clear();
				state.lastRootRef = undefined;
				state.highlightedRef = undefined;
			}
		}));
	}

	/**
	 * Serializes automation work for a single tab. Concurrent snapshot/click
	 * calls on the same viewId corrupt the shared ref map.
	 */
	async runExclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.exclusiveQueues.get(id) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const next = prev.then(() => gate, () => gate);
		this.exclusiveQueues.set(id, next);
		await prev.catch(() => { /* ignore prior failure — still run next */ });
		try {
			return await fn();
		} finally {
			release();
			if (this.exclusiveQueues.get(id) === next) {
				this.exclusiveQueues.delete(id);
			}
		}
	}

	/**
	 * Tears down all automation sessions when Browser Automation is disabled.
	 */
	async releaseAllAutomation(): Promise<void> {
		const ids = Array.from(this.states.keys());
		for (const id of ids) {
			try {
				await this.setAutomationLocked(id, false);
			} catch { /* ignore */ }
			try {
				await this.clearHighlight(id);
			} catch { /* ignore */ }
			try {
				await this.detachDebugger(id);
			} catch { /* ignore */ }
			this.clearState(id);
		}
		// Best-effort spill-file cleanup.
		try {
			const dir = join(tmpdir(), 'orbit-browser-automation');
			await fsPromises.rm(dir, { recursive: true, force: true });
		} catch { /* ignore */ }
	}

	// ----- tab enumeration --------------------------------------------------

	listViews(): IBrowserViewInfo[] {
		return this.browserViewMainService.listViewsForAutomation().map(v => {
			const full = this.browserViewMainService.getNavigationStateForAutomation(v.id);
			return {
				id: v.id,
				url: full.url,
				title: full.title,
				isLoading: full.isLoading,
				canGoBack: full.canGoBack,
				canGoForward: full.canGoForward,
				favicon: full.favicon,
				windowId: v.windowId,
			};
		});
	}

	getNavigationState(id: string): { url: string; title: string; isLoading: boolean; canGoBack: boolean; canGoForward: boolean; favicon: string | null } {
		return this.browserViewMainService.getNavigationStateForAutomation(id);
	}

	// ----- CDP --------------------------------------------------------------

	async attachDebugger(id: string): Promise<void> {
		const state = this.getOrCreateState(id);
		if (state.debuggerAttached) {
			return;
		}
		const wc = this.browserViewMainService.getWebContentsForAutomation(id);
		if (!wc) {
			throw new Error(`Browser view not found: ${id}`);
		}
		try {
			wc.debugger.attach('1.3');
			state.debuggerAttached = true;
			this.hookCdpEventBuffers(id, state);
			await this.enableAutomationDomains(id);
		} catch (e) {
			// Already attached by DevTools or a previous call — treat as success.
			const msg = String((e as Error)?.message ?? e);
			if (msg.includes('Another debugger is already attached') || msg.includes('Already attached')) {
				state.debuggerAttached = true;
				// Still hook buffers once (idempotent via disposables) and enable domains.
				this.hookCdpEventBuffers(id, state);
				await this.enableAutomationDomains(id).catch(() => { /* best-effort */ });
				return;
			}
			this.logService.error(`[browserAutomation] Failed to attach debugger for ${id}:`, e);
			throw e;
		}
	}

	/**
	 * Enables the CDP domains required for snapshots, ref resolution, and input.
	 * Without DOM + Accessibility, `DOM.resolveNode` / `getFullAXTree` can return
	 * empty or unresolvable backend node ids, which makes type/fill appear to
	 * "succeed" while nothing is editable in the page.
	 */
	private async enableAutomationDomains(id: string): Promise<void> {
		const domains = ['DOM', 'CSS', 'Page', 'Runtime', 'Accessibility', 'Log', 'Network'] as const;
		for (const domain of domains) {
			try {
				await this.sendCdpCommandInternal(id, `${domain}.enable`, {});
			} catch (e) {
				// Non-fatal: some embeds disable individual domains. Input still works
				// for most cases without Log/Network; DOM/Accessibility are critical.
				this.logService.warn(`[browserAutomation] ${domain}.enable failed for ${id}:`, e);
			}
		}
	}

	async detachDebugger(id: string): Promise<void> {
		const state = this.states.get(id);
		if (!state || !state.debuggerAttached) {
			return;
		}
		const wc = this.browserViewMainService.getWebContentsForAutomation(id);
		if (!wc) {
			state.debuggerAttached = false;
			return;
		}
		try {
			wc.debugger.detach();
		} catch { /* ignore — may already be detached */ }
		state.debuggerAttached = false;
	}

	async sendCdpCommand(id: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
		if (isCdpMethodDenied(method)) {
			throw new Error(`CDP method '${method}' is denied. Use the dedicated browser_* tool instead.`);
		}
		// Best-effort guard against cookie/storage exfil via Runtime.evaluate /
		// callFunctionOn — the method denylist alone cannot catch document.cookie.
		const normalized = method.trim();
		if (normalized === 'Runtime.evaluate' || normalized === 'Runtime.callFunctionOn') {
			const expression = typeof params?.expression === 'string'
				? params.expression
				: (typeof params?.functionDeclaration === 'string' ? params.functionDeclaration : undefined);
			if (isCdpEvalExpressionDenied(expression)) {
				throw new Error(
					`CDP ${normalized} expression is denied (cookie/storage access). ` +
					`Use dedicated browser_* tools for page interaction.`
				);
			}
		}
		return this.sendCdpCommandInternal(id, method, params);
	}

	/**
	 * Internal CDP send used by this service's trusted input primitives
	 * (`clickAt`, `pressKey`, `scroll`, `dispatchDrag`, `dispatchText`, etc.).
	 * Bypasses the denylist so `Input.*` methods reach the debugger — the
	 * denylist is only meant to block the model's raw `browser_cdp` calls,
	 * not our own helpers.
	 */
	private async sendCdpCommandInternal(id: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
		await this.attachDebugger(id);
		const wc = this.browserViewMainService.getWebContentsForAutomation(id);
		if (!wc) {
			throw new Error(`Browser view not found: ${id}`);
		}
		try {
			return await wc.debugger.sendCommand(method as any, params as any);
		} catch (e) {
			this.logService.warn(`[browserAutomation] CDP ${method} failed for ${id}:`, e);
			throw e;
		}
	}

	private hookCdpEventBuffers(id: string, state: ITabAutomationState): void {
		if (state.eventBuffersHooked) {
			return;
		}
		const wc = this.browserViewMainService.getWebContentsForAutomation(id);
		if (!wc) {
			return;
		}
		state.eventBuffersHooked = true;
		const pushConsole = (msg: IConsoleMessage) => {
			state.consoleMessages.push(msg);
			if (state.consoleMessages.length > MAX_BUFFER_ENTRIES) {
				state.consoleMessages.shift();
			}
		};
		const pushNetwork = (req: INetworkRequest) => {
			state.networkLog.push(req);
			if (state.networkLog.length > MAX_BUFFER_ENTRIES) {
				state.networkLog.shift();
			}
		};

		// Electron's debugger `message` event emits (event, method: string, params: any).
		state.disposables.add(Event.fromNodeEventEmitter<[string, any]>(wc.debugger, 'message', (_e, method, params) => [method, params])(([method, params]) => {
			if (method === 'Console.messageAdded' && params?.message) {
				const m = params.message;
				pushConsole({
					level: (m.level ?? 'log') as IConsoleMessage['level'],
					text: String(m.text ?? ''),
					url: m.url,
					lineNumber: m.line,
					timestamp: Date.now(),
				});
			} else if (method === 'Log.entryAdded' && params?.entry) {
				const e = params.entry;
				pushConsole({
					level: (e.level ?? 'info') as IConsoleMessage['level'],
					text: String(e.text ?? ''),
					url: e.url,
					lineNumber: e.lineNumber,
					timestamp: Date.now(),
				});
			} else if (method === 'Network.requestWillBeSent' && params?.request) {
				const r = params.request;
				pushNetwork({
					requestId: String(params.requestId ?? ''),
					url: String(r.url ?? ''),
					method: String(r.method ?? 'GET'),
					resourceType: String(params.type ?? ''),
					timestamp: Date.now(),
				});
			} else if (method === 'Network.responseReceived' && params?.response) {
				const r = params.response;
				pushNetwork({
					requestId: String(params.requestId ?? ''),
					url: String(r.url ?? ''),
					method: String(r.method ?? 'GET'),
					resourceType: String(params.type ?? ''),
					statusCode: r.status,
					timestamp: Date.now(),
				});
			} else if (method === 'Network.loadingFailed' && params) {
				pushNetwork({
					requestId: String(params.requestId ?? ''),
					url: '',
					method: '',
					resourceType: String(params.type ?? ''),
					failed: true,
					errorText: String(params.errorText ?? ''),
					timestamp: Date.now(),
				});
			}
		}));
	}

	// ----- accessibility snapshot + refs ------------------------------------

	async captureAccessibilitySnapshot(id: string, opts: IAccessibilitySnapshotOptions = {}): Promise<IAccessibilitySnapshot> {
		const { interactive = false, maxDepth = 20, compact = false, selector } = opts;
		await this.attachDebugger(id);
		const state = this.getOrCreateState(id);

		// Clear the ref map for this snapshot. Refs are only valid within the
		// snapshot that produced them — the model must re-snapshot after any
		// page mutation that might have changed the DOM.
		state.previousRefs = new Set(state.refMap.keys());
		state.refMap.clear();

		// Ensure DOM backend node ids are resolvable before we walk the AX tree.
		try {
			await this.sendCdpCommand(id, 'DOM.getDocument', { depth: 0 });
		} catch { /* best-effort */ }

		// Prefer a shallow tree for interactive mode (faster, less noise).
		const treeDepth = interactive ? Math.min(maxDepth, 12) : maxDepth + 2;
		const result = await this.sendCdpCommand(id, 'Accessibility.getFullAXTree', {
			depth: treeDepth,
		}) as
			| { nodes?: Array<{ nodeId: string; role: { type?: string; value?: string }; name?: { value?: string }; ignored?: boolean; childIds?: Array<string | number>; backendDOMNodeId?: number; properties?: Array<{ name: string; value: { value?: any } }> }> }
			| undefined;

		// `selector` scopes the snapshot to a DOM subtree when provided (API parity
		// with Cursor). We resolve the selector to a backend node id and later
		// re-root the YAML at the matching AX node when found.
		let selectorBackendId: number | undefined;
		if (selector) {
			try {
				const doc = await this.sendCdpCommand(id, 'DOM.getDocument', { depth: 0 }) as { root?: { nodeId?: number } };
				const rootId = doc?.root?.nodeId;
				if (rootId !== undefined) {
					const q = await this.sendCdpCommand(id, 'DOM.querySelector', { nodeId: rootId, selector }) as { nodeId?: number };
					if (q?.nodeId) {
						const desc = await this.sendCdpCommand(id, 'DOM.describeNode', { nodeId: q.nodeId }) as { node?: { backendNodeId?: number } };
						selectorBackendId = desc?.node?.backendNodeId;
					}
				}
			} catch {
				// Non-fatal — fall back to full-tree snapshot.
			}
		}

		const axNodes = result?.nodes ?? [];
		const nav = this.getNavigationState(id);
		const nodes: Record<string, MutableAXNode> = {};
		let rootRef: string | undefined;

		// Build a map from CDP nodeId -> ref, then materialize IAXNode entries.
		// IMPORTANT: do NOT query bounds for every node here — that was N CDP
		// round-trips and made snapshots slow/flaky. Bounds are resolved lazily
		// in resolveRefBounds / clickByRef when actually needed.
		const nodeIdToRef = new Map<string, string>();
		const seenBackendIds = new Set<number>();
		for (const ax of axNodes) {
			if (ax.ignored) {
				continue;
			}
			const role = String(ax.role?.value ?? ax.role?.type ?? 'generic');
			const name = String(ax.name?.value ?? '');
			// Strict interactive filter: only true interactive roles (no
			// named generics bloating the list and confusing the model).
			if (interactive && !INTERACTIVE_ROLES.has(role.toLowerCase())) {
				continue;
			}
			const ref = generateRef();
			nodeIdToRef.set(String(ax.nodeId), ref);
			const props: Record<string, string | boolean | number> = {};
			if (Array.isArray(ax.properties)) {
				for (const p of ax.properties) {
					const v = p.value?.value;
					if (v !== undefined && v !== null) {
						props[p.name] = typeof v === 'object' ? JSON.stringify(v) : v;
					}
				}
			}
			const node: MutableAXNode = {
				ref,
				role,
				name,
				bounds: null,
				depth: 0,
				attributes: Object.keys(props).length ? props : undefined,
			};
			nodes[ref] = node;
			if (ax.backendDOMNodeId !== undefined) {
				seenBackendIds.add(ax.backendDOMNodeId);
				state.refMap.set(ref, { backendDOMNodeId: ax.backendDOMNodeId, bounds: null, role, name });
			} else {
				state.refMap.set(ref, { bounds: null, role, name });
			}
			if (selectorBackendId !== undefined && ax.backendDOMNodeId === selectorBackendId) {
				rootRef = ref;
			} else if (rootRef === undefined) {
				rootRef = ref;
			}
		}

		// Interactive mode: also pull common DOM editables the AX tree may
		// miss (ChatGPT ProseMirror, custom role=textbox wrappers). This is
		// what lets "type into the message box" work in 2 tools instead of 8.
		if (interactive) {
			await this.augmentInteractiveFromDom(id, state, nodes, seenBackendIds);
		}

		// Full tree mode: attach children + depth. Interactive list mode skips
		// the tree walk — the model gets a flat ranked list instead.
		if (!interactive && rootRef) {
			let rootNodeId: string | undefined;
			for (const [nodeId, ref] of nodeIdToRef) {
				if (ref === rootRef) {
					rootNodeId = nodeId;
					break;
				}
			}
			const rootAx = rootNodeId
				? axNodes.find(n => String(n.nodeId) === rootNodeId)
				: axNodes.find(n => !n.ignored);
			if (rootAx) {
				this.populateChildrenAndDepth(axNodes, nodeIdToRef, nodes, String(rootAx.nodeId), 0, maxDepth);
			}
		}

		state.lastRootRef = rootRef;
		const removedRefs = [...state.previousRefs].filter(r => !state.refMap.has(r));
		const yaml = interactive
			? snapshotToInteractiveList(nodes, nav)
			: snapshotToYaml(nodes, rootRef, nav, compact);

		return {
			viewId: id,
			url: nav.url,
			title: nav.title,
			nodes,
			rootRef: rootRef ?? '',
			yaml,
			removedRefs: removedRefs.length ? removedRefs : undefined,
		};
	}

	/**
	 * Adds refs for visible editables discovered via DOM selectors when the
	 * accessibility tree omits them. Critical for ChatGPT/Claude composers.
	 */
	private async augmentInteractiveFromDom(
		id: string,
		state: ITabAutomationState,
		nodes: Record<string, MutableAXNode>,
		seenBackendIds: Set<number>,
	): Promise<void> {
		const selectors = [
			'#prompt-textarea',
			'textarea[name="prompt-textarea"]',
			'[data-testid="composer"] [contenteditable="true"]',
			'[contenteditable="true"]',
			'[contenteditable=""]',
			'[contenteditable="plaintext-only"]',
			'textarea:not([disabled])',
			'input[type="search"]:not([disabled])',
			'input[type="text"]:not([disabled])',
			'input:not([type]):not([disabled])',
			'[role="textbox"]',
			'[role="searchbox"]',
		];
		try {
			const doc = await this.sendCdpCommand(id, 'DOM.getDocument', { depth: 0, pierce: true }) as { root?: { nodeId?: number } };
			const rootId = doc?.root?.nodeId;
			if (rootId === undefined) {
				return;
			}
			let added = 0;
			const maxAdd = 12;
			for (const selector of selectors) {
				if (added >= maxAdd) {
					break;
				}
				try {
					// querySelector only returns the first match — good enough for
					// primary composers; querySelectorAll is heavier and less portable.
					const q = await this.sendCdpCommand(id, 'DOM.querySelector', { nodeId: rootId, selector }) as { nodeId?: number };
					if (!q?.nodeId) {
						continue;
					}
					const desc = await this.sendCdpCommand(id, 'DOM.describeNode', { nodeId: q.nodeId }) as {
						node?: { backendNodeId?: number; nodeName?: string; attributes?: string[] };
					};
					const backendId = desc?.node?.backendNodeId;
					if (backendId === undefined || seenBackendIds.has(backendId)) {
						continue;
					}
					// Skip zero-size / hidden nodes.
					const bounds = await this.queryBoundsForNode(id, backendId);
					if (!bounds || bounds.width < 2 || bounds.height < 2) {
						continue;
					}
					// Pull a usable accessible name from attributes / placeholder.
					const attrs = desc?.node?.attributes ?? [];
					const attrMap: Record<string, string> = {};
					for (let i = 0; i + 1 < attrs.length; i += 2) {
						attrMap[attrs[i]] = attrs[i + 1];
					}
					const name = attrMap['aria-label'] || attrMap['placeholder'] || attrMap['data-placeholder'] || attrMap['name'] || '';
					const tag = String(desc?.node?.nodeName ?? 'div').toLowerCase();
					const role = (attrMap['role'] || (tag === 'textarea' || tag === 'input' || attrMap['contenteditable'] !== undefined ? 'textbox' : 'textbox')).toLowerCase();
					if (!INTERACTIVE_ROLES.has(role) && role !== 'textbox') {
						continue;
					}
					const ref = generateRef();
					const node: MutableAXNode = {
						ref,
						role: role === 'searchbox' ? 'searchbox' : 'textbox',
						name: name || (tag === 'textarea' ? 'textarea' : 'text input'),
						bounds,
						depth: 0,
						attributes: { source: 'dom-augment', selector },
					};
					nodes[ref] = node;
					state.refMap.set(ref, { backendDOMNodeId: backendId, bounds, role: node.role, name: node.name });
					seenBackendIds.add(backendId);
					added++;
				} catch {
					// Selector may not match — continue.
				}
			}
		} catch (e) {
			this.logService.warn(`[browserAutomation] DOM augment for interactive snapshot failed on ${id}:`, e);
		}
	}

	private populateChildrenAndDepth(
		axNodes: Array<{ nodeId: string; childIds?: Array<string | number>; ignored?: boolean }>,
		nodeIdToRef: Map<string, string>,
		nodes: Record<string, MutableAXNode>,
		rootNodeId: string,
		depth: number,
		maxDepth: number,
	): void {
		const root = axNodes.find(n => n.nodeId === rootNodeId);
		if (!root) {
			return;
		}
		const rootRef = nodeIdToRef.get(root.nodeId);
		if (rootRef && nodes[rootRef]) {
			nodes[rootRef].depth = depth;
		}
		if (depth >= maxDepth) {
			return;
		}
		const childRefs: string[] = [];
		for (const childId of root.childIds ?? []) {
			const childIdStr = String(childId);
			const childRef = nodeIdToRef.get(childIdStr);
			if (childRef) {
				childRefs.push(childRef);
				this.populateChildrenAndDepth(axNodes, nodeIdToRef, nodes, childIdStr, depth + 1, maxDepth);
			} else {
				// Child was filtered out (e.g. interactive mode) — recurse to
				// surface its descendants that weren't filtered.
				this.populateChildrenAndDepth(axNodes, nodeIdToRef, nodes, childIdStr, depth + 1, maxDepth);
			}
		}
		if (rootRef && nodes[rootRef] && childRefs.length) {
			nodes[rootRef].children = childRefs;
		}
	}

	private async queryBoundsForNode(id: string, backendDOMNodeId: number | undefined): Promise<IBrowserViewBounds | null> {
		if (backendDOMNodeId === undefined) {
			return null;
		}
		try {
			const resolved = await this.sendCdpCommand(id, 'DOM.resolveNode', { backendNodeId: backendDOMNodeId }) as { object?: { objectId?: string } };
			const objectId = resolved?.object?.objectId;
			if (!objectId) {
				return null;
			}
			const result = await this.sendCdpCommand(id, 'Runtime.callFunctionOn', {
				objectId,
				functionDeclaration: `function() {
					const r = this.getBoundingClientRect();
					return { x: r.left, y: r.top, width: r.width, height: r.height };
				}`,
				returnByValue: true,
			}) as { result?: { value?: { x: number; y: number; width: number; height: number } } };
			const v = result?.result?.value;
			if (!v || v.width === 0 || v.height === 0) {
				return null;
			}
			return { x: Math.round(v.x), y: Math.round(v.y), width: Math.round(v.width), height: Math.round(v.height) };
		} catch {
			return null;
		}
	}

	// ----- ref resolution ---------------------------------------------------

	async resolveRefBounds(id: string, ref: string): Promise<IBrowserViewBounds> {
		const state = this.states.get(id);
		const entry = state?.refMap.get(ref);
		if (!entry) {
			throw new Error(`Stale or unknown ref: ${ref}. Call browser_snapshot again to get fresh refs.`);
		}
		if (entry.backendDOMNodeId !== undefined) {
			const bounds = await this.queryBoundsForNode(id, entry.backendDOMNodeId);
			if (bounds) {
				entry.bounds = bounds;
				return bounds;
			}
		}
		if (entry.bounds) {
			return entry.bounds;
		}
		throw new Error(`Ref ${ref} has no resolvable bounds. The element may be off-screen or hidden.`);
	}

	private requireRef(id: string, ref: string): { backendDOMNodeId?: number; bounds: IBrowserViewBounds | null; role: string; name: string } {
		const state = this.states.get(id);
		const entry = state?.refMap.get(ref);
		if (!entry) {
			throw new Error(`Stale or unknown ref: ${ref}. Call browser_snapshot again to get fresh refs.`);
		}
		return entry;
	}

	// ----- input dispatch (ref-based, NOT raw CDP Input.*) ------------------

	async clickByRef(id: string, ref: string, opts: IMouseClickOptions = {}): Promise<void> {
		await this.withPointerLockBypass(id, async () => {
			await this.scrollRefIntoView(id, ref);
			const bounds = await this.resolveRefBounds(id, ref);
			const cx = bounds.x + bounds.width / 2 + (opts.offsetX ?? 0);
			const cy = bounds.y + bounds.height / 2 + (opts.offsetY ?? 0);
			await this.focusWebContents(id);
			await this.clickAtUnlocked(id, cx, cy, opts);
		});
	}

	async clickAt(id: string, x: number, y: number, opts: IMouseClickOptions = {}): Promise<void> {
		await this.withPointerLockBypass(id, () => this.clickAtUnlocked(id, x, y, opts));
	}

	/** Internal click that assumes the pointer-lock overlay is already bypassed. */
	private async clickAtUnlocked(id: string, x: number, y: number, opts: IMouseClickOptions = {}): Promise<void> {
		await this.attachDebugger(id);
		await this.focusWebContents(id);
		const button = opts.button ?? 'left';
		const cdpButton = button === 'middle' ? 'middle' : button === 'right' ? 'right' : 'left';
		const clickCount = opts.doubleClick ? 2 : 1;
		// mouseMoved before press matches real pointer sequences and wakes
		// hover-dependent UI (tooltips, CSS :hover menus) before the click.
		await this.sendCdpCommandInternal(id, 'Input.dispatchMouseEvent', { x, y, type: 'mouseMoved' });
		const params: Record<string, unknown> = { x, y, button: cdpButton, clickCount };
		await this.sendCdpCommandInternal(id, 'Input.dispatchMouseEvent', { ...params, type: 'mousePressed' });
		if (opts.holdDurationMs && opts.holdDurationMs > 0) {
			await new Promise(resolve => setTimeout(resolve, opts.holdDurationMs));
		}
		await this.sendCdpCommandInternal(id, 'Input.dispatchMouseEvent', { ...params, type: 'mouseReleased' });
	}

	async hoverByRef(id: string, ref: string): Promise<void> {
		await this.withPointerLockBypass(id, async () => {
			await this.scrollRefIntoView(id, ref);
			const bounds = await this.resolveRefBounds(id, ref);
			const cx = bounds.x + bounds.width / 2;
			const cy = bounds.y + bounds.height / 2;
			await this.attachDebugger(id);
			await this.focusWebContents(id);
			await this.sendCdpCommandInternal(id, 'Input.dispatchMouseEvent', { x: cx, y: cy, type: 'mouseMoved' });
		});
	}

	/**
	 * Types text into an element by ref (appends). Must produce a *visible*
	 * update in the page — used by ChatGPT-style ProseMirror contenteditables
	 * as well as ordinary inputs.
	 *
	 * Multi-path strategy (stops at first verified success):
	 * 1. Activate (scroll + real click + focus nested editable).
	 * 2. CDP `Input.insertText` (or slow key events when `slowly`).
	 * 3. DOM `document.execCommand('insertText')` + beforeinput (ProseMirror).
	 * 4. Native value setter for <input>/<textarea>.
	 * 5. Slow key events as last resort.
	 * Throws if the control still does not contain the text — never silent success.
	 */
	async typeByRef(id: string, ref: string, text: string, opts: { slowly?: boolean; submit?: boolean } = {}): Promise<void> {
		await this.activateEditableByRef(id, ref);
		await this.moveCaretToEnd(id, ref);

		if (!text) {
			if (opts.submit) {
				await this.pressKey(id, 'Enter');
			}
			return;
		}

		if (opts.slowly) {
			await this.dispatchTextSlowly(id, text);
		} else {
			await this.dispatchText(id, text, false);
		}

		if (!(await this.editableContainsText(id, ref, text, /*append*/ true))) {
			// Path 2: DOM execCommand / beforeinput — required for many
			// contenteditable/ProseMirror composers (ChatGPT, Notion, Linear, …)
			// where CDP insertText alone is dropped if focus is on a wrapper.
			await this.insertTextViaDom(id, ref, text, /*replace*/ false);
		}

		if (!(await this.editableContainsText(id, ref, text, /*append*/ true))) {
			// Path 3: native value setter (input/textarea only) — replace with
			// current+text only when the control is a plain form field.
			const current = await this.readEditableText(id, ref);
			const setResult = await this.setElementValueByRef(id, ref, current.includes(text) ? current : (current + text));
			if (setResult !== 'set') {
				// Path 4: character-by-character keys (contenteditable last resort).
				await this.activateEditableByRef(id, ref);
				await this.moveCaretToEnd(id, ref);
				await this.dispatchTextSlowly(id, text);
			}
		}

		if (!(await this.editableContainsText(id, ref, text, /*append*/ true))) {
			const actual = await this.readEditableText(id, ref);
			throw new Error(
				`browser_type failed: typed ${JSON.stringify(text)} into ${ref} but the control still shows ${JSON.stringify(actual)}. ` +
				`Re-snapshot, target the textbox/contenteditable ref (not a parent form/button), and retry with slowly:true if needed.`
			);
		}

		if (opts.submit) {
			// Brief pause so React/ProseMirror commit the value before Enter.
			await new Promise(resolve => setTimeout(resolve, 40));
			await this.pressKey(id, 'Enter');
		}
	}

	/**
	 * Clears and fills an element by ref. Prefer the native-value-setter path
	 * for <input>/<textarea> (React-controlled safe), then contenteditable via
	 * select-all + insertText / execCommand. Throws if the final value does not match.
	 */
	async fillByRef(id: string, ref: string, value: string): Promise<void> {
		await this.activateEditableByRef(id, ref);

		// Path 1: native setter for input/textarea.
		const setResult = await this.setElementValueByRef(id, ref, value);
		if (setResult === 'set' && await this.editableContainsText(id, ref, value, /*append*/ false)) {
			return;
		}

		// Path 2: select-all + CDP insertText.
		await this.selectAllInFocused(id, ref);
		if (value.length === 0) {
			await this.pressKey(id, 'Backspace');
		} else {
			await this.dispatchText(id, value, false);
		}

		// Path 3: DOM execCommand replace (contenteditable / ProseMirror).
		if (!(await this.editableContainsText(id, ref, value, /*append*/ false))) {
			await this.insertTextViaDom(id, ref, value, /*replace*/ true);
		}

		if (!(await this.editableContainsText(id, ref, value, /*append*/ false))) {
			const actual = await this.readEditableText(id, ref);
			throw new Error(
				`browser_fill failed: set ${JSON.stringify(value)} on ${ref} but the control still shows ${JSON.stringify(actual)}. ` +
				`Re-snapshot and target the editable textbox ref, not a wrapper.`
			);
		}
	}

	async selectOptionByRef(id: string, ref: string, values: readonly string[]): Promise<void> {
		const entry = this.requireRef(id, ref);
		if (entry.backendDOMNodeId === undefined) {
			throw new Error(`Ref ${ref} has no backend node id; cannot select.`);
		}
		await this.attachDebugger(id);
		await this.scrollRefIntoView(id, ref);
		const objectId = await this.resolveObjectId(id, entry.backendDOMNodeId);
		if (!objectId) {
			throw new Error(`Could not resolve ref ${ref} to a DOM node for selectOption.`);
		}
		const result = await this.sendCdpCommand(id, 'Runtime.callFunctionOn', {
			objectId,
			functionDeclaration: `function(values) {
				if (!this) return false;
				const tag = (this.tagName || '').toLowerCase();
				// Some a11y trees point at a wrapper; walk to the nearest <select>.
				const el = tag === 'select' ? this : (this.querySelector && this.querySelector('select')) || this.closest?.('select');
				if (!el || el.tagName.toLowerCase() !== 'select') return false;
				const opts = Array.from(el.options);
				for (const opt of opts) {
					opt.selected = values.includes(opt.value) || values.includes(opt.text) || values.includes(opt.label);
				}
				el.dispatchEvent(new Event('input', { bubbles: true }));
				el.dispatchEvent(new Event('change', { bubbles: true }));
				return true;
			}`,
			arguments: [{ value: values }],
			returnByValue: true,
		}) as { result?: { value?: boolean } };
		if (!result?.result?.value) {
			throw new Error(`Ref ${ref} is not a <select> element (or contains none).`);
		}
	}

	async pressKey(id: string, key: string, opts: IKeyDispatchOptions = {}): Promise<void> {
		await this.attachDebugger(id);
		await this.focusWebContents(id);
		const keyDescriptor = this.mapKeyToCdp(key, opts.modifiers);
		// Include a `char` event for keys that produce text so contenteditable
		// and legacy keypress handlers observe the full sequence.
		await this.sendCdpCommandInternal(id, 'Input.dispatchKeyEvent', { type: 'keyDown', ...keyDescriptor });
		if (keyDescriptor.text) {
			await this.sendCdpCommandInternal(id, 'Input.dispatchKeyEvent', { type: 'char', ...keyDescriptor });
		}
		await this.sendCdpCommandInternal(id, 'Input.dispatchKeyEvent', { type: 'keyUp', ...keyDescriptor });
	}

	async scroll(id: string, opts: IScrollOptions): Promise<void> {
		await this.withPointerLockBypass(id, async () => {
			await this.attachDebugger(id);
			await this.focusWebContents(id);
			if (opts.ref) {
				// Prefer DOM scrollIntoView so nested scroll containers work; fall
				// back to a mouse-wheel delta at the element center.
				await this.scrollRefIntoView(id, opts.ref);
				if ((opts.deltaX ?? 0) === 0 && (opts.deltaY ?? 0) === 0) {
					return;
				}
				const bounds = await this.resolveRefBounds(id, opts.ref);
				const cx = bounds.x + bounds.width / 2;
				const cy = bounds.y + bounds.height / 2;
				await this.sendCdpCommandInternal(id, 'Input.dispatchMouseEvent', {
					type: 'mouseWheel',
					x: cx,
					y: cy,
					deltaX: opts.deltaX ?? 0,
					deltaY: opts.deltaY ?? 0,
				});
				return;
			}
			const deltaX = opts.deltaX ?? 0;
			const deltaY = opts.deltaY ?? 0;
			if (deltaX === 0 && deltaY === 0) {
				return;
			}
			await this.sendCdpCommandInternal(id, 'Input.dispatchMouseEvent', {
				type: 'mouseWheel',
				x: 0,
				y: 0,
				deltaX,
				deltaY,
			});
		});
	}

	async dispatchDrag(id: string, opts: IDragOptions): Promise<void> {
		await this.withPointerLockBypass(id, async () => {
			await this.scrollRefIntoView(id, opts.sourceRef);
			const sourceBounds = await this.resolveRefBounds(id, opts.sourceRef);
			await this.attachDebugger(id);
			await this.focusWebContents(id);
			const sx = sourceBounds.x + sourceBounds.width / 2;
			const sy = sourceBounds.y + sourceBounds.height / 2;
			// Resolve the target point: either a ref (preferred) or raw viewport x/y.
			let tx: number;
			let ty: number;
			if (opts.targetRef) {
				const targetBounds = await this.resolveRefBounds(id, opts.targetRef);
				tx = targetBounds.x + targetBounds.width / 2;
				ty = targetBounds.y + targetBounds.height / 2;
			} else if (typeof opts.targetX === 'number' && typeof opts.targetY === 'number') {
				tx = opts.targetX;
				ty = opts.targetY;
			} else {
				throw new Error('browser_drag requires either targetRef or (targetX, targetY).');
			}
			await this.sendCdpCommandInternal(id, 'Input.dispatchMouseEvent', { x: sx, y: sy, type: 'mouseMoved' });
			await this.sendCdpCommandInternal(id, 'Input.dispatchMouseEvent', { x: sx, y: sy, button: 'left', type: 'mousePressed', clickCount: 1 });
			// Intermediate points smooth the drag and avoid some sites' "flung" detection.
			const stops = opts.intermediateRefs ?? [];
			for (const stopRef of stops) {
				try {
					const b = await this.resolveRefBounds(id, stopRef);
					await this.sendCdpCommandInternal(id, 'Input.dispatchMouseEvent', { x: b.x + b.width / 2, y: b.y + b.height / 2, button: 'left', type: 'mouseMoved' });
				} catch { /* ignore intermediate ref failures */ }
			}
			// Step toward the target so drop targets receive dragover.
			const steps = 5;
			for (let i = 1; i <= steps; i++) {
				const t = i / steps;
				const mx = sx + (tx - sx) * t;
				const my = sy + (ty - sy) * t;
				await this.sendCdpCommandInternal(id, 'Input.dispatchMouseEvent', { x: mx, y: my, button: 'left', type: 'mouseMoved' });
			}
			await this.sendCdpCommandInternal(id, 'Input.dispatchMouseEvent', { x: tx, y: ty, button: 'left', type: 'mouseReleased', clickCount: 1 });
		});
	}

	/** Ensures the Electron webContents has focus so CDP input is not dropped. */
	private async focusWebContents(id: string): Promise<void> {
		const wc = this.browserViewMainService.getWebContentsForAutomation(id);
		if (!wc || wc.isDestroyed()) {
			return;
		}
		try {
			if (typeof wc.focus === 'function') {
				wc.focus();
			}
		} catch { /* ignore — some views reject focus while hidden */ }
	}

	/** Scrolls the ref's backend node into view (handles nested scroll containers). */
	private async scrollRefIntoView(id: string, ref: string): Promise<void> {
		const entry = this.requireRef(id, ref);
		if (entry.backendDOMNodeId === undefined) {
			return;
		}
		await this.attachDebugger(id);
		try {
			const objectId = await this.resolveObjectId(id, entry.backendDOMNodeId);
			if (!objectId) {
				return;
			}
			await this.sendCdpCommand(id, 'Runtime.callFunctionOn', {
				objectId,
				functionDeclaration: `function() {
					try {
						this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
					} catch (e) {
						try { this.scrollIntoView(true); } catch (_) { /* ignore */ }
					}
					return true;
				}`,
				returnByValue: true,
			});
			// Give layout a tick to settle before reading bounds for click/type.
			await new Promise(resolve => setTimeout(resolve, 16));
		} catch {
			// Non-fatal: click/type will still attempt with last-known bounds.
		}
	}

	/**
	 * Activates an editable target the way a user would: scroll into view,
	 * real click (so React/onFocus/onClick fire), then JS focus.
	 * This is the fix for "typed via tool but nothing shows in the browser UI".
	 */
	private async activateEditableByRef(id: string, ref: string): Promise<void> {
		await this.scrollRefIntoView(id, ref);
		await this.focusWebContents(id);
		// Real pointer click first — many controlled inputs only enter edit mode
		// on mousedown/mouseup, not on a programmatic focus() alone.
		try {
			const bounds = await this.resolveRefBounds(id, ref);
			const cx = bounds.x + bounds.width / 2;
			const cy = bounds.y + bounds.height / 2;
			await this.clickAt(id, cx, cy, {});
		} catch (e) {
			this.logService.warn(`[browserAutomation] click-to-activate failed for ${ref}; falling back to focus only:`, e);
		}
		await this.focusByRef(id, ref);
	}

	private async focusByRef(id: string, ref: string): Promise<void> {
		const entry = this.requireRef(id, ref);
		if (entry.backendDOMNodeId === undefined) {
			throw new Error(`Ref ${ref} has no backend node id; cannot focus.`);
		}
		await this.attachDebugger(id);
		const objectId = await this.resolveObjectId(id, entry.backendDOMNodeId);
		if (!objectId) {
			throw new Error(`Could not resolve ref ${ref} to a DOM node for focus.`);
		}
		// Shared finder: walks wrappers used by ChatGPT/ProseMirror/etc. so focus
		// lands on the real contenteditable, not a parent form/role=group.
		await this.sendCdpCommand(id, 'Runtime.callFunctionOn', {
			objectId,
			functionDeclaration: `function() {
				${this.editableFinderJs()}
				const el = findEditable(this);
				if (!el) return false;
				try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (__) { /* ignore */ } }
				// Click-focus synthetic for stubborn composers.
				try {
					el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
					el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
					el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
				} catch (_) { /* ignore */ }
				try { el.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
				return true;
			}`,
			returnByValue: true,
		});
	}

	/**
	 * Shared JS snippet inlined into Runtime.callFunctionOn bodies. Locates the
	 * real editable under an a11y ref that may point at a wrapper.
	 */
	private editableFinderJs(): string {
		return `
			function findEditable(root) {
				if (!root) return null;
				const isEditable = (n) => {
					if (!n || n.nodeType !== 1) return false;
					const tag = (n.tagName || '').toLowerCase();
					if (tag === 'input') {
						const t = (n.type || 'text').toLowerCase();
						return !['button','submit','reset','checkbox','radio','file','image','hidden','range','color'].includes(t);
					}
					if (tag === 'textarea') return true;
					if (n.isContentEditable) return true;
					const ce = n.getAttribute && n.getAttribute('contenteditable');
					if (ce === '' || ce === 'true' || ce === 'plaintext-only') return true;
					const role = (n.getAttribute && n.getAttribute('role') || '').toLowerCase();
					if ((role === 'textbox' || role === 'searchbox') && (n.isContentEditable || tag === 'div' || tag === 'p')) return true;
					return false;
				};
				if (isEditable(root)) return root;
				// Prefer known chat composers first (ChatGPT, Claude, etc.).
				const preferred = root.querySelector && root.querySelector(
					'#prompt-textarea, [data-testid="composer"], textarea[name="prompt-textarea"], [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], input:not([type=hidden]):not([type=button]):not([type=submit]), textarea, [role="textbox"]'
				);
				if (preferred && isEditable(preferred)) return preferred;
				if (root.querySelector) {
					const all = root.querySelectorAll('input, textarea, [contenteditable], [role="textbox"], [role="searchbox"]');
					for (const n of all) { if (isEditable(n)) return n; }
				}
				// Walk up for role=textbox wrappers that wrap a child editable.
				let p = root.parentElement;
				for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
					if (isEditable(p)) return p;
					const nested = p.querySelector && p.querySelector('[contenteditable="true"], [contenteditable=""], textarea, input:not([type=hidden])');
					if (nested && isEditable(nested)) return nested;
				}
				return root;
			}
			function readEditable(el) {
				if (!el) return '';
				const tag = (el.tagName || '').toLowerCase();
				if (tag === 'input' || tag === 'textarea') return String(el.value ?? '');
				// ProseMirror / contenteditable: prefer innerText, strip zero-width chars.
				return String(el.innerText ?? el.textContent ?? '').replace(/\\u200b/g, '').trimEnd();
			}
		`;
	}

	private async resolveObjectId(id: string, backendDOMNodeId: number): Promise<string | undefined> {
		// Ensure the DOM document is known so backend node ids resolve.
		try {
			await this.sendCdpCommand(id, 'DOM.getDocument', { depth: 0 });
		} catch { /* ignore */ }
		const resolved = await this.sendCdpCommand(id, 'DOM.resolveNode', { backendNodeId: backendDOMNodeId }) as { object?: { objectId?: string } };
		return resolved?.object?.objectId;
	}

	private async dispatchText(id: string, text: string, slowly?: boolean): Promise<void> {
		await this.attachDebugger(id);
		await this.focusWebContents(id);
		if (!text) {
			return;
		}
		if (slowly) {
			await this.dispatchTextSlowly(id, text);
			return;
		}
		// `Input.insertText` is the most reliable cross-site text input method
		// (bypasses keyboard layout / IME) and is what Playwright uses for fill.
		await this.sendCdpCommandInternal(id, 'Input.insertText', { text });
	}

	/** Per-character keyDown/char/keyUp so autocomplete and key handlers fire. */
	private async dispatchTextSlowly(id: string, text: string): Promise<void> {
		await this.attachDebugger(id);
		await this.focusWebContents(id);
		for (const ch of text) {
			if (ch === '\n' || ch === '\r') {
				await this.pressKey(id, 'Enter');
				continue;
			}
			if (ch === '\t') {
				await this.pressKey(id, 'Tab');
				continue;
			}
			// Prefer insertText per char for non-ASCII / emoji (keyCode mapping is lossy).
			if (ch.length > 1 || ch.charCodeAt(0) > 127) {
				await this.sendCdpCommandInternal(id, 'Input.insertText', { text: ch });
			} else {
				const descriptor = {
					key: ch,
					code: this.codeForPrintable(ch),
					text: ch,
					// Unmodified Latin-1 key codes match the character code for a-z/A-Z/0-9.
					windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
					nativeVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
				};
				await this.sendCdpCommandInternal(id, 'Input.dispatchKeyEvent', { type: 'keyDown', ...descriptor });
				await this.sendCdpCommandInternal(id, 'Input.dispatchKeyEvent', { type: 'char', ...descriptor });
				await this.sendCdpCommandInternal(id, 'Input.dispatchKeyEvent', { type: 'keyUp', ...descriptor });
			}
			// Small delay so debounced site handlers (search-as-you-type) observe each key.
			await new Promise(resolve => setTimeout(resolve, 12));
		}
	}

	private codeForPrintable(ch: string): string {
		if (ch === ' ') {
			return 'Space';
		}
		if (/^[a-zA-Z]$/.test(ch)) {
			return `Key${ch.toUpperCase()}`;
		}
		if (/^[0-9]$/.test(ch)) {
			return `Digit${ch}`;
		}
		return ch;
	}

	/** Moves the caret to the end of an input/textarea/contenteditable. */
	private async moveCaretToEnd(id: string, ref: string): Promise<void> {
		const entry = this.requireRef(id, ref);
		if (entry.backendDOMNodeId === undefined) {
			return;
		}
		try {
			const objectId = await this.resolveObjectId(id, entry.backendDOMNodeId);
			if (!objectId) {
				return;
			}
			await this.sendCdpCommand(id, 'Runtime.callFunctionOn', {
				objectId,
				functionDeclaration: `function() {
					${this.editableFinderJs()}
					const el = findEditable(this);
					if (!el) return false;
					const t = (el.tagName || '').toLowerCase();
					if (t === 'input' || t === 'textarea') {
						const len = (el.value || '').length;
						if (typeof el.setSelectionRange === 'function') {
							el.setSelectionRange(len, len);
						}
						return true;
					}
					// contenteditable / ProseMirror
					const range = document.createRange();
					range.selectNodeContents(el);
					range.collapse(false);
					const sel = window.getSelection();
					if (sel) {
						sel.removeAllRanges();
						sel.addRange(range);
					}
					return true;
				}`,
				returnByValue: true,
			});
		} catch { /* non-fatal */ }
	}

	/**
	 * Select-all that works on macOS and Windows. Avoids Home/End which do not
	 * select text in macOS input fields (they often scroll the page instead).
	 */
	private async selectAllInFocused(id: string, ref: string): Promise<void> {
		const entry = this.requireRef(id, ref);
		if (entry.backendDOMNodeId !== undefined) {
			try {
				const objectId = await this.resolveObjectId(id, entry.backendDOMNodeId);
				if (objectId) {
					const result = await this.sendCdpCommand(id, 'Runtime.callFunctionOn', {
						objectId,
						functionDeclaration: `function() {
							${this.editableFinderJs()}
							const target = findEditable(this);
							if (!target) return false;
							if (typeof target.select === 'function') {
								target.select();
								return true;
							}
							try { document.execCommand('selectAll', false, null); return true; } catch (_) { /* fall through */ }
							const range = document.createRange();
							range.selectNodeContents(target);
							const sel = window.getSelection();
							if (sel) {
								sel.removeAllRanges();
								sel.addRange(range);
							}
							return true;
						}`,
						returnByValue: true,
					}) as { result?: { value?: boolean } };
					if (result?.result?.value) {
						return;
					}
				}
			} catch { /* fall through to keyboard select-all */ }
		}
		// ControlOrMeta+A covers both platforms via our modifier encoder.
		await this.pressKey(id, 'a', { modifiers: ['ControlOrMeta'] });
	}

	/**
	 * Inserts text via DOM APIs that ProseMirror / contenteditable listen to.
	 * Prefer execCommand('insertText') which synthesizes the right beforeinput
	 * events; fall back to InputEvent dispatch.
	 */
	private async insertTextViaDom(id: string, ref: string, text: string, replace: boolean): Promise<void> {
		const entry = this.requireRef(id, ref);
		if (entry.backendDOMNodeId === undefined) {
			return;
		}
		const objectId = await this.resolveObjectId(id, entry.backendDOMNodeId);
		if (!objectId) {
			return;
		}
		await this.focusWebContents(id);
		await this.sendCdpCommand(id, 'Runtime.callFunctionOn', {
			objectId,
			functionDeclaration: `function(text, replace) {
				${this.editableFinderJs()}
				const el = findEditable(this);
				if (!el) return { ok: false, reason: 'no-editable' };
				try { el.focus(); } catch (_) { /* ignore */ }
				const tag = (el.tagName || '').toLowerCase();
				if (tag === 'input' || tag === 'textarea') {
					if (replace) {
						const proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
						const desc = Object.getOwnPropertyDescriptor(proto, 'value');
						if (desc && desc.set) desc.set.call(el, text);
						else el.value = text;
					} else {
						const start = el.selectionStart ?? el.value.length;
						const end = el.selectionEnd ?? el.value.length;
						const next = el.value.slice(0, start) + text + el.value.slice(end);
						const proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
						const desc = Object.getOwnPropertyDescriptor(proto, 'value');
						if (desc && desc.set) desc.set.call(el, next);
						else el.value = next;
						const caret = start + text.length;
						try { el.setSelectionRange(caret, caret); } catch (_) { /* ignore */ }
					}
					try {
						el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
					} catch (_) {
						el.dispatchEvent(new Event('input', { bubbles: true }));
					}
					el.dispatchEvent(new Event('change', { bubbles: true }));
					return { ok: true, value: String(el.value ?? ''), method: 'native-setter' };
				}
				// contenteditable / ProseMirror
				if (replace) {
					try { document.execCommand('selectAll', false, null); } catch (_) {
						const range = document.createRange();
						range.selectNodeContents(el);
						const sel = window.getSelection();
						if (sel) { sel.removeAllRanges(); sel.addRange(range); }
					}
				}
				// execCommand('insertText') is what ProseMirror / Lexical / Draft
				// respond to — it fires beforeinput with inputType insertText.
				let ok = false;
				try { ok = document.execCommand('insertText', false, text); } catch (_) { ok = false; }
				if (!ok) {
					try {
						const before = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text });
						el.dispatchEvent(before);
						if (!before.defaultPrevented) {
							// Last-resort: insert a text node at the selection.
							const sel = window.getSelection();
							if (sel && sel.rangeCount) {
								const range = sel.getRangeAt(0);
								range.deleteContents();
								range.insertNode(document.createTextNode(text));
								range.collapse(false);
								sel.removeAllRanges();
								sel.addRange(range);
							} else {
								el.appendChild(document.createTextNode(text));
							}
						}
						el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
						ok = true;
					} catch (_) { /* ignore */ }
				}
				return { ok, value: readEditable(el), method: ok ? 'execCommand-or-inputevent' : 'failed' };
			}`,
			arguments: [{ value: text }, { value: replace }],
			returnByValue: true,
		});
		// Let the framework commit the edit before we re-read.
		await new Promise(resolve => setTimeout(resolve, 30));
	}

	/**
	 * Sets value via the native HTMLInputElement/HTMLTextAreaElement setter so
	 * React/Vue controlled inputs update their internal state, then dispatches
	 * input + change events. Returns 'set' on success, 'unsupported' otherwise.
	 */
	private async setElementValueByRef(id: string, ref: string, value: string): Promise<'set' | 'unsupported'> {
		const entry = this.requireRef(id, ref);
		if (entry.backendDOMNodeId === undefined) {
			return 'unsupported';
		}
		const objectId = await this.resolveObjectId(id, entry.backendDOMNodeId);
		if (!objectId) {
			return 'unsupported';
		}
		const result = await this.sendCdpCommand(id, 'Runtime.callFunctionOn', {
			objectId,
			functionDeclaration: `function(value) {
				${this.editableFinderJs()}
				const el = findEditable(this);
				if (!el) return { ok: false };
				const t = (el.tagName || '').toLowerCase();
				if (t !== 'input' && t !== 'textarea') {
					return { ok: false, kind: t };
				}
				try { el.focus(); } catch (_) { /* ignore */ }
				const proto = t === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
				const desc = Object.getOwnPropertyDescriptor(proto, 'value');
				if (desc && desc.set) {
					desc.set.call(el, value);
				} else {
					el.value = value;
				}
				try {
					el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: value }));
				} catch (_) {
					el.dispatchEvent(new Event('input', { bubbles: true }));
				}
				el.dispatchEvent(new Event('change', { bubbles: true }));
				return { ok: true, value: String(el.value ?? '') };
			}`,
			arguments: [{ value }],
			returnByValue: true,
		}) as { result?: { value?: { ok?: boolean; value?: string } } };
		if (result?.result?.value?.ok) {
			return 'set';
		}
		return 'unsupported';
	}

	/** Reads the current text from the editable under a ref. */
	private async readEditableText(id: string, ref: string): Promise<string> {
		const entry = this.requireRef(id, ref);
		if (entry.backendDOMNodeId === undefined) {
			return '';
		}
		try {
			const objectId = await this.resolveObjectId(id, entry.backendDOMNodeId);
			if (!objectId) {
				return '';
			}
			const read = await this.sendCdpCommand(id, 'Runtime.callFunctionOn', {
				objectId,
				functionDeclaration: `function() {
					${this.editableFinderJs()}
					return readEditable(findEditable(this));
				}`,
				returnByValue: true,
			}) as { result?: { value?: string } };
			return String(read?.result?.value ?? '');
		} catch {
			return '';
		}
	}

	/**
	 * Returns true when the editable under `ref` contains (append) or equals
	 * (fill) the expected text. Whitespace-normalized so ProseMirror trailing
	 * newlines do not false-negative.
	 */
	private async editableContainsText(id: string, ref: string, text: string, append: boolean): Promise<boolean> {
		if (!text) {
			return true;
		}
		const actual = await this.readEditableText(id, ref);
		const norm = (s: string) => s.replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
		const a = norm(actual);
		const t = norm(text);
		if (!t) {
			return true;
		}
		return append ? a.includes(t) : a === t;
	}

	private mapKeyToCdp(key: string, modifiers?: readonly ('Control' | 'Shift' | 'Alt' | 'Meta' | 'ControlOrMeta')[]): Record<string, unknown> {
		const mods = modifiers ?? [];
		const keyMap: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
			'Enter': { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
			'Tab': { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
			'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
			'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
			'Delete': { key: 'Delete', code: 'Delete', keyCode: 46 },
			'Home': { key: 'Home', code: 'Home', keyCode: 36 },
			'End': { key: 'End', code: 'End', keyCode: 35 },
			'PageUp': { key: 'PageUp', code: 'PageUp', keyCode: 33 },
			'PageDown': { key: 'PageDown', code: 'PageDown', keyCode: 34 },
			'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
			'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
			'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
			'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
			'Space': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
		};
		let mapped = keyMap[key];
		if (!mapped && key.length === 1) {
			// Single printable character (e.g. 'a' for Cmd/Ctrl+A select-all).
			mapped = {
				key,
				code: this.codeForPrintable(key),
				keyCode: key.toUpperCase().charCodeAt(0),
				// Only emit text for unmodified typing; with modifiers (Ctrl/Cmd) the
				// OS treats the combo as a shortcut and text insertion is wrong.
				text: mods.length === 0 ? key : undefined,
			};
		}
		if (!mapped) {
			mapped = { key, code: key, keyCode: 0 };
		}
		return {
			key: mapped.key,
			code: mapped.code,
			keyCode: mapped.keyCode,
			windowsVirtualKeyCode: mapped.keyCode,
			nativeVirtualKeyCode: mapped.keyCode,
			text: mapped.text,
			modifiers: this.encodeModifiers(mods),
		};
	}

	private encodeModifiers(mods: readonly ('Control' | 'Shift' | 'Alt' | 'Meta' | 'ControlOrMeta')[]): number {
		let mask = 0;
		if (mods.includes('Alt')) {
			mask |= 1;
		}
		// ControlOrMeta is platform-aware: Meta (Cmd) on macOS, Control elsewhere.
		// Setting BOTH bits breaks select-all and other shortcuts on some platforms.
		const wantsControlOrMeta = mods.includes('ControlOrMeta');
		const isMac = process.platform === 'darwin';
		if (mods.includes('Control') || (wantsControlOrMeta && !isMac)) {
			mask |= 2;
		}
		if (mods.includes('Meta') || (wantsControlOrMeta && isMac)) {
			mask |= 4;
		}
		if (mods.includes('Shift')) {
			mask |= 8;
		}
		return mask;
	}

	// ----- highlight (visual grounding) -------------------------------------

	async highlightByRef(id: string, ref: string): Promise<void> {
		const entry = this.requireRef(id, ref);
		const state = this.getOrCreateState(id);
		if (entry.backendDOMNodeId === undefined) {
			throw new Error(`Ref ${ref} has no backend node id; cannot highlight.`);
		}
		await this.attachDebugger(id);
		await this.clearHighlightInternal(id, state);
		const resolved = await this.sendCdpCommand(id, 'DOM.resolveNode', { backendNodeId: entry.backendDOMNodeId }) as { object?: { objectId?: string } };
		const objectId = resolved?.object?.objectId;
		if (!objectId) {
			return;
		}
		await this.sendCdpCommand(id, 'Runtime.callFunctionOn', {
			objectId,
			functionDeclaration: `function() {
				const old = document.getElementById('__orbit_highlight');
				if (old) old.remove();
				const r = this.getBoundingClientRect();
				const el = document.createElement('div');
				el.id = '__orbit_highlight';
				el.style.position = 'fixed';
				el.style.left = r.left + 'px';
				el.style.top = r.top + 'px';
				el.style.width = r.width + 'px';
				el.style.height = r.height + 'px';
				el.style.outline = '2px solid #ff6a00';
				el.style.outlineOffset = '1px';
				el.style.pointerEvents = 'none';
				el.style.zIndex = '2147483647';
				document.body.appendChild(el);
				return true;
			}`,
			returnByValue: true,
		});
		state.highlightedRef = ref;
	}

	async clearHighlight(id: string): Promise<void> {
		const state = this.states.get(id);
		if (!state) {
			return;
		}
		await this.clearHighlightInternal(id, state);
	}

	private async clearHighlightInternal(id: string, state: ITabAutomationState): Promise<void> {
		if (!state.highlightedRef) {
			return;
		}
		try {
			const wc = this.browserViewMainService.getWebContentsForAutomation(id);
			if (wc && !wc.isDestroyed()) {
				await wc.executeJavaScript(`(() => { const old = document.getElementById('__orbit_highlight'); if (old) old.remove(); return true; })()`, true);
			}
		} catch { /* ignore */ }
		state.highlightedRef = undefined;
	}

	// ----- screenshots ------------------------------------------------------

	/**
	 * Captures a screenshot of the browser tab.
	 *
	 * Strategy (production-ready, Retina-safe):
	 * 1. Viewport PNG (the common case): prefer Electron's native
	 *    `webContents.capturePage()`. It captures the WebContentsView surface
	 *    at the correct DIP size — no CDP clip math, no HiDPI half-width bug.
	 *    If native returns empty/blank, fall back to CDP with a
	 *    `cssVisualViewport` clip.
	 * 2. Full-page / element / JPEG: use CDP `Page.captureScreenshot` with a
	 *    clip built from `cssContentSize` / `cssVisualViewport` / element
	 *    bounds (CSS pixels). NEVER use the deprecated device-pixel
	 *    `contentSize` as a CSS clip — that is what produced the
	 *    "content squeezed into the left half + white space on the right"
	 *    screenshots on Retina Macs.
	 * 3. Any CDP failure falls back to native `capturePage()`.
	 */
	async captureScreenshot(id: string, opts: IScreenshotOptions = {}): Promise<{ data: string; mimeType: 'image/png' | 'image/jpeg' }> {
		const format = opts.format === 'jpeg' ? 'jpeg' : 'png';
		const wantsFullPage = opts.fullPage === true;
		const wantsElement = typeof opts.ref === 'string' && opts.ref.length > 0;
		const wantsJpeg = format === 'jpeg';

		// Fast path: viewport PNG via native capture. This is what agents call
		// 95% of the time and is immune to CDP clip/DPR bugs.
		if (!wantsFullPage && !wantsElement && !wantsJpeg) {
			try {
				return await this.captureNativeScreenshot(id);
			} catch (nativeErr) {
				this.logService.warn(`[browserAutomation] Native screenshot failed for ${id}, trying CDP viewport clip:`, nativeErr);
				try {
					return await this.captureCdpScreenshot(id, { format: 'png', mode: 'viewport' });
				} catch (cdpErr) {
					this.logService.error(`[browserAutomation] Both native and CDP viewport screenshots failed for ${id}:`, cdpErr);
					throw nativeErr;
				}
			}
		}

		try {
			return await this.captureCdpScreenshot(id, {
				format,
				quality: opts.quality,
				mode: wantsFullPage ? 'fullPage' : wantsElement ? 'element' : 'viewport',
				ref: opts.ref,
			});
		} catch (e) {
			this.logService.warn(`[browserAutomation] CDP screenshot failed for ${id}, falling back to native capture:`, e);
			// Native capture is always PNG viewport — best we can do as a fallback.
			return this.captureNativeScreenshot(id);
		}
	}

	/** Native WebContentsView surface capture (viewport PNG, Retina-correct). */
	private async captureNativeScreenshot(id: string): Promise<{ data: string; mimeType: 'image/png' }> {
		const data = await this.browserViewMainService.screenshot(this.requireWindowId(id), id);
		return { data, mimeType: 'image/png' };
	}

	/**
	 * CDP `Page.captureScreenshot` with a CSS-pixel clip. Modes:
	 * - viewport: clip to cssVisualViewport
	 * - fullPage: clip to cssContentSize + captureBeyondViewport
	 * - element: clip to the ref's getBoundingClientRect
	 */
	private async captureCdpScreenshot(
		id: string,
		opts: {
			format: 'png' | 'jpeg';
			quality?: number;
			mode: 'viewport' | 'fullPage' | 'element';
			ref?: string;
		},
	): Promise<{ data: string; mimeType: 'image/png' | 'image/jpeg' }> {
		await this.attachDebugger(id);
		const params: Record<string, unknown> = {
			format: opts.format,
			fromSurface: true,
		};
		if (opts.format === 'jpeg' && typeof opts.quality === 'number') {
			params.quality = Math.max(0, Math.min(100, Math.round(opts.quality)));
		}

		if (opts.mode === 'fullPage') {
			const metrics = await this.getLayoutMetrics(id);
			const clip = buildFullPageScreenshotClip(metrics);
			if (!clip) {
				throw new Error('Could not resolve full-page content size for screenshot.');
			}
			params.clip = clip;
			params.captureBeyondViewport = true;
		} else if (opts.mode === 'element') {
			if (!opts.ref) {
				throw new Error('Element screenshot requires a ref.');
			}
			const bounds = await this.resolveRefBounds(id, opts.ref);
			const clip = buildElementScreenshotClip(bounds);
			if (!clip) {
				throw new Error(`Ref ${opts.ref} has no capturable bounds.`);
			}
			params.clip = clip;
			params.captureBeyondViewport = false;
		} else {
			const metrics = await this.getLayoutMetrics(id);
			const clip = buildViewportScreenshotClip(metrics);
			if (clip) {
				params.clip = clip;
			}
			params.captureBeyondViewport = false;
		}

		const result = await this.sendCdpCommand(id, 'Page.captureScreenshot', params) as { data?: string };
		if (!result?.data) {
			throw new Error('Page.captureScreenshot returned no data.');
		}
		return { data: result.data, mimeType: opts.format === 'jpeg' ? 'image/jpeg' : 'image/png' };
	}

	/** Fetches CDP layout metrics; prefers css* fields for HiDPI safety. */
	private async getLayoutMetrics(id: string): Promise<ICdpLayoutMetrics | undefined> {
		try {
			return await this.sendCdpCommand(id, 'Page.getLayoutMetrics', {}) as ICdpLayoutMetrics;
		} catch (e) {
			this.logService.warn(`[browserAutomation] Page.getLayoutMetrics failed for ${id}:`, e);
			return undefined;
		}
	}

	private requireWindowId(id: string): number {
		const win = this.browserViewMainService.getWindowIdForView(id);
		if (win === undefined) {
			throw new Error(`Browser view ${id} has no owning window.`);
		}
		return win;
	}

	// ----- automation lock --------------------------------------------------

	async setAutomationLocked(id: string, locked: boolean): Promise<void> {
		const state = this.getOrCreateState(id);
		if (state.automationLocked === locked) {
			return;
		}
		state.automationLocked = locked;
		this.browserViewMainService.setAutomationLockedForAutomation(id, locked);
		// Install/remove a page-level pointer overlay so the user cannot click
		// while the agent holds the lock. CDP Input.* still works because it
		// bypasses the DOM hit-test path. Keyboard is intentionally left open
		// so agent type/fill (which synthesizes key events) keeps working; the
		// toolbar "Take Control" button remains clickable in the Orbit chrome.
		try {
			await this.setPointerLockOverlay(id, locked);
		} catch (e) {
			this.logService.warn(`[browserAutomation] pointer-lock overlay failed for ${id}:`, e);
		}
		this._onDidAutomationLockChange.fire({ id, locked });
	}

	isAutomationLocked(id: string): boolean {
		return this.states.get(id)?.automationLocked ?? false;
	}

	/**
	 * Installs or removes a full-viewport transparent overlay that absorbs
	 * pointer events while automation is locked. The overlay is tagged so
	 * agent tools can temporarily hide it for a real click/type sequence.
	 */
	private async setPointerLockOverlay(id: string, locked: boolean): Promise<void> {
		await this.attachDebugger(id);
		await this.sendCdpCommand(id, 'Runtime.evaluate', {
			expression: locked
				? `(() => {
					let el = document.getElementById('__orbit_automation_lock');
					if (!el) {
						el = document.createElement('div');
						el.id = '__orbit_automation_lock';
						el.setAttribute('data-orbit-lock', '1');
						el.style.cssText = 'position:fixed;inset:0;z-index:2147483646;cursor:not-allowed;background:transparent;pointer-events:auto;';
						document.documentElement.appendChild(el);
					}
					el.style.display = 'block';
					el.style.pointerEvents = 'auto';
					return true;
				})()`
				: `(() => {
					const el = document.getElementById('__orbit_automation_lock');
					if (el) el.remove();
					return true;
				})()`,
			returnByValue: true,
		});
	}

	/**
	 * Temporarily disables the pointer-lock overlay so a real click/type can
	 * hit the underlying element, then restores it if the tab is still locked.
	 */
	private async withPointerLockBypass<T>(id: string, fn: () => Promise<T>): Promise<T> {
		const locked = this.isAutomationLocked(id);
		if (locked) {
			try {
				await this.sendCdpCommand(id, 'Runtime.evaluate', {
					expression: `(() => {
						const el = document.getElementById('__orbit_automation_lock');
						if (el) { el.style.pointerEvents = 'none'; el.style.display = 'none'; }
						return true;
					})()`,
					returnByValue: true,
				});
			} catch { /* best-effort */ }
		}
		try {
			return await fn();
		} finally {
			if (locked && this.isAutomationLocked(id)) {
				try {
					await this.setPointerLockOverlay(id, true);
				} catch { /* best-effort */ }
			}
		}
	}

	// ----- buffers ----------------------------------------------------------

	getConsoleMessages(id: string): IConsoleMessage[] {
		return this.states.get(id)?.consoleMessages ?? [];
	}

	getNetworkLog(id: string): INetworkRequest[] {
		return this.states.get(id)?.networkLog ?? [];
	}

	// ----- hardening: health check + spill files ---------------------------

	healthCheck(id: string): { alive: boolean; debuggerAttached: boolean; url: string; error?: string } {
		const state = this.states.get(id);
		const nav = this.getNavigationState(id);
		try {
			const wc = this.browserViewMainService.getWebContentsForAutomation(id);
			if (!wc) {
				return { alive: false, debuggerAttached: false, url: nav.url, error: 'Tab web contents not found (it may have been closed).' };
			}
			if (wc.isDestroyed()) {
				return { alive: false, debuggerAttached: false, url: nav.url, error: 'Tab web contents has been destroyed.' };
			}
			return { alive: true, debuggerAttached: !!state?.debuggerAttached, url: nav.url };
		} catch (e) {
			return { alive: false, debuggerAttached: false, url: nav.url, error: String((e as Error)?.message ?? e) };
		}
	}

	async spillLargeResponse(id: string, payload: string, label: string, thresholdBytes = 64 * 1024): Promise<{ filePath: string; summary: string } | null> {
		const byteLength = Buffer.byteLength(payload, 'utf8');
		if (byteLength <= thresholdBytes) {
			return null;
		}
		const safeLabel = label.replace(/[^a-z0-9-_]/gi, '_').slice(0, 40) || 'response';
		const stamp = Date.now();
		const fileName = `orbit-browser-${safeLabel}-${stamp}.txt`;
		try {
			const dir = await this.ensureSecureSpillDirectory();
			await this.pruneSpillDirectory(dir);
			const filePath = join(dir, fileName);
			await fsPromises.writeFile(filePath, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
			const summary = `Response was ${byteLength} bytes (over ${thresholdBytes} threshold) and was written to a spill file: ${filePath}`;
			this.logService.info(`[browserAutomation] Spilled ${byteLength}B for ${id} → ${filePath}`);
			return { filePath, summary };
		} catch (e) {
			this.logService.error(`[browserAutomation] Failed to spill response for ${id}:`, e);
			return null;
		}
	}

	/**
	 * Saves a screenshot under the spill directory. `filename` is sanitized to
	 * a basename; extension is forced to match the mime type.
	 */
	async saveScreenshotFile(id: string, base64Data: string, filename: string, mimeType: string): Promise<string | null> {
		const ext = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : 'png';
		const base = filename
			.replace(/\\/g, '/')
			.split('/')
			.pop()
			?.replace(/[^a-z0-9._-]/gi, '_')
			.replace(/^\.+/, '')
			.slice(0, 120) || `page-${Date.now()}`;
		const withExt = /\.(png|jpe?g)$/i.test(base) ? base.replace(/\.(png|jpe?g)$/i, `.${ext}`) : `${base}.${ext}`;
		try {
			const dir = await this.ensureSecureSpillDirectory();
			await this.pruneSpillDirectory(dir);
			let filePath = join(dir, withExt);
			try {
				await fsPromises.writeFile(filePath, Buffer.from(base64Data, 'base64'), { flag: 'wx', mode: 0o600 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
				filePath = join(dir, `${withExt.replace(/\.(png|jpe?g)$/i, '')}-${Date.now()}.${ext}`);
				await fsPromises.writeFile(filePath, Buffer.from(base64Data, 'base64'), { flag: 'wx', mode: 0o600 });
			}
			this.logService.info(`[browserAutomation] Saved screenshot for ${id} → ${filePath}`);
			return filePath;
		} catch (e) {
			this.logService.error(`[browserAutomation] Failed to save screenshot for ${id}:`, e);
			return null;
		}
	}

	private async ensureSecureSpillDirectory(): Promise<string> {
		const dir = join(tmpdir(), 'orbit-browser-automation');
		await fsPromises.mkdir(dir, { recursive: true, mode: 0o700 });
		const stat = await fsPromises.lstat(dir);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Browser spill path is not a safe directory.');
		if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('Browser spill directory is not owned by the current user.');
		if (process.platform !== 'win32') await fsPromises.chmod(dir, 0o700);
		return dir;
	}

	/** Deletes spill files older than 24h and caps the directory at ~50 files. */
	private async pruneSpillDirectory(dir: string): Promise<void> {
		try {
			const entries = await fsPromises.readdir(dir, { withFileTypes: true });
			const files: { name: string; mtimeMs: number }[] = [];
			const now = Date.now();
			const maxAgeMs = 24 * 60 * 60 * 1000;
			for (const entry of entries) {
				if (!entry.isFile()) {
					continue;
				}
				const full = join(dir, entry.name);
				try {
					const stat = await fsPromises.stat(full);
					if (now - stat.mtimeMs > maxAgeMs) {
						await fsPromises.unlink(full);
						continue;
					}
					files.push({ name: entry.name, mtimeMs: stat.mtimeMs });
				} catch { /* ignore per-file errors */ }
			}
			const maxFiles = 50;
			if (files.length > maxFiles) {
				files.sort((a, b) => a.mtimeMs - b.mtimeMs);
				const toRemove = files.slice(0, files.length - maxFiles);
				for (const f of toRemove) {
					try {
						await fsPromises.unlink(join(dir, f.name));
					} catch { /* ignore */ }
				}
			}
		} catch { /* ignore — best-effort */ }
	}

	// ----- lifecycle --------------------------------------------------------

	clearState(id: string): void {
		const state = this.states.get(id);
		if (!state) {
			return;
		}
		// Best-effort debugger detach + highlight cleanup. Failures here are
		// expected when the tab is already gone.
		try {
			const wc = this.browserViewMainService.getWebContentsForAutomation(id);
			if (wc && !wc.isDestroyed() && state.debuggerAttached) {
				void wc.debugger.detach();
			}
		} catch { /* ignore */ }
		state.disposables.dispose();
		this.states.delete(id);
	}

	private getOrCreateState(id: string): ITabAutomationState {
		let state = this.states.get(id);
		if (!state) {
			state = {
				disposables: new DisposableStore(),
				refMap: new Map(),
				lastRootRef: undefined,
				previousRefs: new Set(),
				debuggerAttached: false,
				eventBuffersHooked: false,
				automationLocked: false,
				consoleMessages: [],
				networkLog: [],
				highlightedRef: undefined,
			};
			this.states.set(id, state);
			state.disposables.add(toDisposable(() => {
				this.states.delete(id);
			}));
		}
		return state;
	}

	override dispose(): void {
		for (const id of Array.from(this.states.keys())) {
			this.clearState(id);
		}
		super.dispose();
	}
}
