/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Orbit Editor. All rights reserved.
 *  Licensed under the Apache License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { BrowserAutomationMainService } from '../../../../../platform/browserView/electron-main/browserAutomationMainService.js';
import { BrowserViewMainService } from '../../../../../platform/browserView/electron-main/browserViewMainService.js';
import { BROWSER_AUTOMATION_IPC_CHANNELS, makeBrowserAutomationReplyChannel } from '../../../../../platform/browserView/common/browserView.js';
import { IWindowsMainService } from '../../../../../platform/windows/electron-main/windows.js';
import { IAuxiliaryWindowsMainService } from '../../../../../platform/auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { MCPTool, RawMCPToolCall } from '../../common/mcpServiceTypes.js';
import { IOrbitBuiltinMcpServer } from './orbitBuiltinMcpRegistry.js';
import { ipcMain } from 'electron';
import {
	ORBIT_IDE_BROWSER_MCP_INSTRUCTIONS,
	ORBIT_IDE_BROWSER_MCP_SERVER_NAME,
	ORBIT_IDE_BROWSER_TOOLS,
} from '../../common/builtinMcp/orbitIdeBrowserMcpTypes.js';

/**
 * Whether the built-in browser MCP server is enabled. Toggled by the Browser
 * Automation setting (Phase 3). When disabled, the server still registers but
 * reports `status: 'offline'` and its tools are hidden from the agent.
 */
export type BrowserAutomationEnabledProvider = () => boolean;

/**
 * Blocks the two agent-navigation targets that have no legitimate use for a
 * web-dev-testing agent but a clear exfiltration/SSRF payoff:
 *  - `file://` — would let a prompt-injected agent read arbitrary local files
 *    (SSH keys, .env, source of other projects) via navigate+snapshot/CDP.
 *  - the cloud-metadata link-local address — a classic SSRF target for
 *    exfiltrating instance credentials.
 * Deliberately does NOT block localhost/private-network hosts: agents driving
 * the browser against `http://localhost:*` (the app they're building) is the
 * primary use case for this tool.
 */
/** True if an IP address is in a cloud-metadata / link-local range we must never let the agent reach.
 * We intentionally do NOT block general private/localhost ranges — driving the app under
 * development at http://localhost / 127.0.0.1 / 192.168.x is the primary use case. */
function isBlockedIp(ipRaw: string): boolean {
	const ip = ipRaw.split('%')[0]; // strip IPv6 zone id
	// IPv6-mapped IPv4 (e.g. ::ffff:169.254.169.254) — unwrap and re-check.
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
	if (mapped) { return isBlockedIp(mapped[1]); }
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
	if (v4) {
		const a = Number(v4[1]); const b = Number(v4[2]);
		return a === 169 && b === 254; // link-local / cloud metadata (AWS/GCP/Azure all use 169.254.169.254)
	}
	const low = ip.toLowerCase();
	// IPv6 link-local fe80::/10 (first hextet 0xfe80-0xfebf, i.e. "fe8"/"fe9"/"fea"/"feb")
	// and unique-local fc00::/7 (first byte 0xfc-0xfd, i.e. starts with "fc" or "fd")
	// metadata endpoints — e.g. AWS IMDSv6 is fd00:ec2::254, which is in fc00::/7.
	if (/^fe[89ab]/.test(low)) { return true; }
	if (/^f[cd]/.test(low)) { return true; }
	return false;
}

function isIpLiteral(host: string): boolean {
	return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

async function isAgentNavigableUrl(url: string): Promise<boolean> {
	if (url === 'about:blank') { return true; }
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { return false; }
	let host = parsed.hostname;
	if (host.startsWith('[') && host.endsWith(']')) { host = host.slice(1, -1); } // IPv6 literal
	if (host === 'metadata.google.internal') { return false; }
	// IP literal (incl. decimal/hex forms new URL keeps verbatim): check directly.
	if (isIpLiteral(host)) { return !isBlockedIp(host); }
	// DNS name: resolve and reject if ANY resolved address is a blocked range (defeats
	// rebinding / a benign-looking name that points at the metadata endpoint).
	try {
		const { lookup } = await import('dns/promises');
		const results = await lookup(host, { all: true });
		for (const r of results) { if (isBlockedIp(r.address)) { return false; } }
		return true;
	} catch {
		return true; // resolution failed — let the navigation itself fail naturally
	}
}

/**
 * Minimal window surface the browser MCP server needs to dispatch tab-orchestration
 * IPC to a renderer: the backing `BrowserWindow` and a `sendWhenReady` that queues
 * the message until the renderer is ready. Both `ICodeWindow` and the concrete
 * `AuxiliaryWindow` (the standalone Agents pop-out) satisfy this — they both extend
 * `BaseWindow`, which declares `win` and `sendWhenReady`.
 */
type BrowserAutomationTargetWindow = { readonly id: number; readonly win: Electron.BrowserWindow | null; sendWhenReady(channel: string, token: CancellationToken, ...args: any[]): void };

/** Events emitted when the lock state or active tab changes (for the chat UI). */
export interface IOrbitIdeBrowserMcpEvents {
	readonly onDidLockChange: Event<{ viewId: string; locked: boolean }>;
}

/**
 * Built-in MCP server that exposes the integrated Orbit browser to agents.
 *
 * Implements the 18 Cursor-parity tools (`browser_navigate`, `browser_snapshot`,
 * `browser_click`, `browser_cdp`, etc.) by delegating to
 * `BrowserAutomationMainService` for CDP, ref maps, and input dispatch, and to
 * `BrowserViewMainService` for navigation and screenshots.
 *
 * Tool results are returned as `RawMCPToolCall` in the same shape as external
 * SDK-backed MCP servers, so the Orbit agent runtime treats them identically
 * (approval, parallelization, prompt merge).
 *
 * Tab orchestration that requires the renderer (opening a visible tab into an
 * editor group, selecting/closing a tab) is dispatched back to the renderer
 * via `IWindowsMainService` → `codeWindow.sendWhenReady`, which routes to the
 * `orbit.browserAutomation.*` commands registered in `browserTabRegistryService`.
 */
export class OrbitIdeBrowserMcpServer extends Disposable implements IOrbitBuiltinMcpServer {
	readonly name = ORBIT_IDE_BROWSER_MCP_SERVER_NAME;

	private readonly _onDidLockChange = this._register(new Emitter<{ viewId: string; locked: boolean }>());
	readonly onDidLockChange: Event<{ viewId: string; locked: boolean }> = this._onDidLockChange.event;

	/** Id of the tab the agent most recently interacted with. */
	private _lastInteractedViewId: string | undefined;

	/**
	 * Single-flight guard for auto-open. Parallel first tool calls (e.g. a snapshot +
	 * screenshot batch) can each observe zero tabs before any tab is created; without
	 * this they would each open a tab. All concurrent callers await the one open.
	 */
	private _autoOpenInFlight: Promise<void> | undefined;

	constructor(
		private readonly browserAutomationService: BrowserAutomationMainService,
		private readonly browserViewMainService: BrowserViewMainService,
		private readonly windowsMainService: IWindowsMainService,
		private readonly auxiliaryWindowsMainService: IAuxiliaryWindowsMainService,
		private readonly enabledProvider: BrowserAutomationEnabledProvider,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(browserAutomationService.onDidAutomationLockChange(({ id, locked }) => {
			this._onDidLockChange.fire({ viewId: id, locked });
		}));
	}

	isEnabled(): boolean {
		return this.enabledProvider();
	}

	listTools(): MCPTool[] {
		// Apply the unique-name prefix the MCP channel uses for external servers
		// so the agent runtime's `removeMCPToolNamePrefix` works uniformly.
		// The prefix is stable per server name (hash-derived in the channel for
		// external servers); for built-in servers we use a fixed 3-char prefix
		// derived from the server name so refs in chat history stay stable.
		const prefix = this.toolNamePrefix();
		return ORBIT_IDE_BROWSER_TOOLS.map(tool => ({
			name: `${prefix}_${tool.name}`,
			description: tool.description,
			inputSchema: tool.inputSchema,
			annotations: tool.annotations,
		}));
	}

	getInstructions(): string {
		return ORBIT_IDE_BROWSER_MCP_INSTRUCTIONS;
	}

	async callTool(prefixedToolName: string, params: Record<string, unknown>): Promise<RawMCPToolCall> {
		const toolName = this.stripPrefix(prefixedToolName);
		try {
			// Legacy sentinel from older renderer builds — strip it so it never reaches the
			// tool dispatch / CDP params. Auto-open below no longer depends on it.
			if (params.__orbitAutoOpenBrowser !== undefined) {
				delete params.__orbitAutoOpenBrowser;
			}
			// Auto-open the browser for any tool that needs a tab when none is open, so the
			// agent never has to open the browser as a separate step and never sees the
			// "No browser tab is open" error. `browser_navigate` and `browser_tabs` manage
			// their own tab lifecycle (open / select / close / list), so they are skipped here.
			// Skip when the model targeted an explicit `viewId`: if that tab was closed we must
			// let resolveViewId() throw "Browser tab not found" rather than pop an unrelated
			// google.com tab and then fail anyway.
			const hasExplicitViewId = typeof params.viewId === 'string' && params.viewId.length > 0;
			if (toolName !== 'browser_navigate' && toolName !== 'browser_tabs' && !hasExplicitViewId) {
				await this.ensureAtLeastOneTab();
			}
			const viewId = this.resolveViewId(params);
			// Serialize all tools that touch a specific tab so parallel read-only
			// batches (snapshot + screenshot) cannot corrupt the shared ref map.
			// Tools that create a new tab (navigate/tabs new without a viewId) skip
			// the queue until a viewId is known.
			const run = () => this.dispatchTool(toolName, viewId, params);
			const result = viewId
				? await this.browserAutomationService.runExclusive(viewId, run)
				: await run();
			return result;
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this.logService.warn(`[orbit-ide-browser] Tool ${toolName} failed:`, message);
			// Augment the error with a health check so the model gets an
			// actionable hint (e.g. "tab was closed") instead of a generic failure.
			let hint = '';
			const maybeViewId = typeof params.viewId === 'string' ? params.viewId : this._lastInteractedViewId;
			if (maybeViewId) {
				try {
					const health = this.browserAutomationService.healthCheck(maybeViewId);
					if (!health.alive && health.error) {
						hint = ` (health check: ${health.error})`;
					}
				} catch { /* ignore — best-effort */ }
			}
			return {
				event: 'error',
				text: `Browser MCP tool '${toolName}' failed: ${message}${hint}`,
				toolName: prefixedToolName,
				serverName: this.name,
			};
		}
	}

	/**
	 * Ensures at least one browser tab exists, opening a neutral home page if not.
	 * Single-flighted via {@link _autoOpenInFlight} so a batch of parallel first tool
	 * calls opens exactly one tab. Uses a Google home page rather than `about:blank`
	 * because the renderer's `resolveBrowserNavigationTarget` treats blank input as a
	 * search query.
	 */
	private async ensureAtLeastOneTab(): Promise<void> {
		if (this.browserAutomationService.listViews().length > 0) {
			return;
		}
		if (!this._autoOpenInFlight) {
			this._autoOpenInFlight = (async () => {
				const id = await this.openTabInRenderer('https://www.google.com/', 'active');
				this._lastInteractedViewId = id;
				await this.waitForViewReady(id);
				await this.waitForNavigationSettle(id);
			})().finally(() => { this._autoOpenInFlight = undefined; });
		}
		await this._autoOpenInFlight;
	}

	// ----- tool dispatch ----------------------------------------------------

	private async dispatchTool(toolName: string, viewId: string | undefined, params: Record<string, unknown>): Promise<RawMCPToolCall> {
		switch (toolName) {
			case 'browser_navigate':
				return this.toolNavigate(params);
			case 'browser_tabs':
				return this.toolTabs(params);
			case 'browser_lock':
				return this.toolLock(params);
			case 'browser_snapshot':
				return this.toolSnapshot(params);
			case 'browser_take_screenshot':
				return this.toolScreenshot(params);
			case 'browser_click':
				return this.toolClick(params);
			case 'browser_mouse_click_xy':
				return this.toolMouseClickXY(params);
			case 'browser_type':
				return this.toolType(params);
			case 'browser_fill':
				return this.toolFill(params);
			case 'browser_select_option':
				return this.toolSelectOption(params);
			case 'browser_press_key':
				return this.toolPressKey(params);
			case 'browser_scroll':
				return this.toolScroll(params);
			case 'browser_drag':
				return this.toolDrag(params);
			case 'browser_hover':
				return this.toolHover(params);
			case 'browser_highlight':
				return this.toolHighlight(params);
			case 'browser_get_bounding_box':
				return this.toolGetBoundingBox(params);
			case 'browser_cdp':
				return this.toolCdp(params);
			default:
				return this.error(`Unknown browser tool: ${toolName}`);
		}
	}

	private async toolNavigate(params: Record<string, unknown>): Promise<RawMCPToolCall> {
		const url = String(params.url ?? '');
		if (!url) {
			return this.error('browser_navigate requires a `url` parameter.');
		}
		if (!await isAgentNavigableUrl(url)) {
			return this.error(`browser_navigate: "${url}" is not allowed (only http/https URLs are navigable by the agent).`);
		}
		const newTab = params.newTab === true;
		const position = params.position === 'active' || params.position === 'side' ? params.position : undefined;
		const existingViewId = typeof params.viewId === 'string' ? params.viewId : undefined;

		// Reuse an existing tab if one exists and newTab is not requested.
		if (!newTab && existingViewId) {
			await this.browserViewMainService.navigate(this.windowIdForView(existingViewId), existingViewId, url);
			this._lastInteractedViewId = existingViewId;
		} else if (!newTab && !existingViewId) {
			// Reuse the last-interacted tab, or open one if none exist.
			const tabs = this.browserAutomationService.listViews();
			const target = this._lastInteractedViewId && tabs.find(t => t.id === this._lastInteractedViewId)
				? this._lastInteractedViewId
				: tabs[0]?.id;
			if (target) {
				await this.browserViewMainService.navigate(this.windowIdForView(target), target, url);
				this._lastInteractedViewId = target;
			} else {
				// No tabs open — ask the renderer to open a visible tab.
				const id = await this.openTabInRenderer(url, position);
				this._lastInteractedViewId = id;
			}
		} else {
			// newTab === true
			const id = await this.openTabInRenderer(url, position);
			this._lastInteractedViewId = id;
		}

		// Wait for the native WebContentsView to register in main (pane setInput /
		// overlay preload is async after openEditor returns the input id).
		const viewId = this._lastInteractedViewId!;
		await this.waitForViewReady(viewId);
		// Wait for the main frame to settle so a subsequent snapshot/type sees
		// the destination page instead of an intermediate about:blank/spinner.
		await this.waitForNavigationSettle(viewId);

		const nav = this.browserAutomationService.getNavigationState(viewId);
		const header = `Navigated to ${nav.url}\nTitle: ${nav.title}\nviewId: ${viewId}`;

		// GOLDEN PATH: include an interactive snapshot by default so the model
		// can browser_type / browser_click with refs in the NEXT call — no
		// separate browser_snapshot required. Set includeSnapshot:false to skip.
		const includeSnapshot = params.includeSnapshot !== false;
		let body: string;
		if (!includeSnapshot) {
			body = `${header}\nLoading: ${nav.isLoading}`;
		} else {
			try {
				// Brief settle for late-hydrating SPAs (ChatGPT composer mounts after load).
				await new Promise(resolve => setTimeout(resolve, 250));
				const snapshot = await this.browserAutomationService.captureAccessibilitySnapshot(viewId, {
					interactive: true,
					compact: true,
					maxDepth: 12,
				});
				body =
					`${header}\n\n` +
					`Interactive elements (use these refs NOW with browser_type / browser_fill / browser_click — do NOT call browser_snapshot again unless these refs fail):\n` +
					`${snapshot.yaml}`;
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				body = `${header}\nLoading: ${nav.isLoading}\n(Interactive snapshot failed: ${msg}. Call browser_snapshot with interactive:true next.)`;
			}
		}
		// When take_screenshot_afterwards is set, return image + refs text so
		// the model keeps actionable refs (vision path still receives pixels).
		return this.maybeScreenshotAfterwards(viewId, params, body);
	}

	private async toolTabs(params: Record<string, unknown>): Promise<RawMCPToolCall> {
		const action = String(params.action ?? '');
		const tabs = this.browserAutomationService.listViews();
		// Resolve a target id from either viewId or index (index is 0-based from
		// the last "list" order, matching cursor-ide-browser's contract).
		const resolveId = (): string | undefined => {
			if (typeof params.viewId === 'string' && params.viewId) {
				return params.viewId;
			}
			if (typeof params.index === 'number') {
				return tabs[params.index]?.id;
			}
			return undefined;
		};
		switch (action) {
			case 'list': {
				const lines = tabs.map((t, i) => `${i}: id=${t.id} url=${t.url} title=${t.title} loading=${t.isLoading}`);
				return this.text(`Open browser tabs (${tabs.length}):\n${lines.join('\n') || '(none)'}`);
			}
			case 'new': {
				const url = String(params.url ?? 'about:blank');
				if (!await isAgentNavigableUrl(url)) {
					return this.error(`browser_tabs new: "${url}" is not allowed (only http/https URLs are navigable by the agent).`);
				}
				const position = params.position === 'active' || params.position === 'side' ? params.position : undefined;
				const id = await this.openTabInRenderer(url, position);
				await this.waitForViewReady(id);
				this._lastInteractedViewId = id;
				return this.text(`Opened new tab ${id} at ${url}`);
			}
			case 'close': {
				const id = resolveId() ?? this._lastInteractedViewId;
				if (!id) {
					return this.error('browser_tabs close requires a viewId or index (or an active tab).');
				}
				await this.closeTabInRenderer(id);
				if (this._lastInteractedViewId === id) {
					this._lastInteractedViewId = undefined;
				}
				return this.text(`Closed tab ${id}`);
			}
			case 'select': {
				const id = resolveId();
				if (!id) {
					return this.error('browser_tabs select requires a viewId or index.');
				}
				await this.selectTabInRenderer(id);
				this._lastInteractedViewId = id;
				return this.text(`Selected tab ${id}`);
			}
			default:
				return this.error(`Unknown browser_tabs action: ${action}`);
		}
	}

	private async toolLock(params: Record<string, unknown>): Promise<RawMCPToolCall> {
		const action = String(params.action ?? '');
		const viewId = this.resolveViewId(params) ?? this.ensureActiveTab();
		if (action !== 'lock' && action !== 'unlock') {
			return this.error('browser_lock action must be "lock" or "unlock".');
		}
		await this.browserAutomationService.setAutomationLocked(viewId, action === 'lock');
		return this.text(`Browser ${action}ed for tab ${viewId}`);
	}

	private async toolSnapshot(params: Record<string, unknown>): Promise<RawMCPToolCall> {
		const viewId = this.resolveViewId(params) ?? this.ensureActiveTab();
		// Default interactive:false (matches cursor-ide-browser): full
		// accessibility tree. Set interactive:true for a flat textbox-first list.
		const interactive = params.interactive === true;
		const snapshot = await this.browserAutomationService.captureAccessibilitySnapshot(viewId, {
			interactive,
			maxDepth: typeof params.maxDepth === 'number' ? params.maxDepth : (interactive ? 12 : 20),
			compact: params.compact === true || interactive,
			selector: typeof params.selector === 'string' ? params.selector : undefined,
		});
		this._lastInteractedViewId = viewId;
		// CRITICAL: return the full YAML with refs in `text` — not metadata-only.
		// (Cursor's snapshot bug returned only metadata, leaving the model unable
		// to click/type because it had no refs.)
		let text = snapshot.yaml;
		if (params.includeDiff === true && snapshot.removedRefs?.length) {
			text += `\n\n# Removed refs since last snapshot: ${snapshot.removedRefs.join(', ')}`;
		}
		// Spill very large snapshots to a temp file to stay within model context.
		const spilled = await this.browserAutomationService.spillLargeResponse(viewId, text, 'snapshot');
		if (spilled) {
			text = `${spilled.summary}\n\nFirst 4KB:\n${text.slice(0, 4096)}`;
		}
		// Prefer refs YAML; when take_screenshot_afterwards is set, attach the
		// image alongside the text so the model keeps actionable refs.
		return this.maybeScreenshotAfterwards(viewId, params, text);
	}

	private async toolScreenshot(params: Record<string, unknown>): Promise<RawMCPToolCall> {
		const viewId = this.resolveViewId(params) ?? this.ensureActiveTab();
		return this.takeScreenshot(viewId, params);
	}

	private async toolClick(params: Record<string, unknown>): Promise<RawMCPToolCall> {
		const viewId = this.resolveViewId(params) ?? this.ensureActiveTab();
		const ref = String(params.ref ?? '');
		if (!ref) {
			return this.error('browser_click requires a `ref` parameter from browser_snapshot.');
		}
		await this.browserAutomationService.clickByRef(viewId, ref, {
			button: params.button as 'left' | 'right' | 'middle' | undefined,
			doubleClick: params.doubleClick === true,
			modifiers: params.modifiers as any,
			holdDurationMs: typeof params.holdDurationMs === 'number' ? params.holdDurationMs : undefined,
			offsetX: typeof params.offsetX === 'number' ? params.offsetX : undefined,
			offsetY: typeof params.offsetY === 'number' ? params.offsetY : undefined,
		});
		this._lastInteractedViewId = viewId;
		return this.maybeScreenshotAfterwards(viewId, params, `Clicked element ${ref}`);
	}

	private async toolMouseClickXY(params: Record<string, unknown>): Promise<RawMCPToolCall> {
		const viewId = this.resolveViewId(params) ?? this.ensureActiveTab();
		const x = Number(params.x);
		const y = Number(params.y);
		if (!Number.isFinite(x) || !Number.isFinite(y)) {
			return this.error('browser_mouse_click_xy requires numeric `x` and `y`.');
		}
		await this.browserAutomationService.clickAt(viewId, x, y, {
			button: params.button as 'left' | 'right' | 'middle' | undefined,
			doubleClick: params.doubleClick === true,
		});
		this._lastInteractedViewId = viewId;
		return this.maybeScreenshotAfterwards(viewId, params, `Clicked at (${x}, ${y})`);
	}

	private async toolType(params: Record<string, unknown>): Promise<RawMCPToolCall> {
		const viewId = this.resolveViewId(params) ?? this.ensureActiveTab();
		const ref = String(params.ref ?? '');
		// Preserve empty string as a valid type payload; only reject missing text.
		if (!ref) {
			return this.error('browser_type requires a `ref` parameter from browser_snapshot.');
		}
		if (params.text === undefined || params.text === null) {
			return this.error('browser_type requires a `text` parameter.');
		}
		const text = String(params.text);
		// clear:true replaces the control's contents. fillByRef clears then sets the
		// value (with an empty string this just clears), so both the empty and
		// non-empty cases are the same single call.
		if (params.clear === true) {
			await this.browserAutomationService.fillByRef(viewId, ref, text);
			this._lastInteractedViewId = viewId;
			const submitted = params.submit === true ? ' and pressed Enter' : '';
			return this.maybeScreenshotAfterwards(viewId, params, `Cleared and typed ${JSON.stringify(text)} into ${ref}${submitted}. Verified the control contains the text.`);
		}
		// typeByRef throws if the text never lands in the control — that becomes
		// a tool error so the model cannot claim success on a silent no-op.
		await this.browserAutomationService.typeByRef(viewId, ref, text, {
			slowly: params.slowly === true,
			submit: params.submit === true,
		});
		this._lastInteractedViewId = viewId;
		const submitted = params.submit === true ? ' and pressed Enter' : '';
		return this.maybeScreenshotAfterwards(viewId, params, `Typed ${JSON.stringify(text)} into ${ref}${submitted}. Verified the control contains the text. Call browser_snapshot or browser_take_screenshot if you need visual confirmation.`);
	}

	private async toolFill(params: Record<string, unknown>): Promise<RawMCPToolCall> {
		const viewId = this.resolveViewId(params) ?? this.ensureActiveTab();
		const ref = String(params.ref ?? '');
		if (!ref) {
			return this.error('browser_fill requires a `ref` parameter from browser_snapshot.');
		}
		if (params.value === undefined || params.value === null) {
			return this.error('browser_fill requires a `value` parameter.');
		}
		const value = String(params.value);
		await this.browserAutomationService.fillByRef(viewId, ref, value);
		this._lastInteractedViewId = viewId;
		return this.maybeScreenshotAfterwards(viewId, params, `Filled ${ref} with ${JSON.stringify(value)}. Verified the control value matches. Call browser_snapshot if you need updated refs.`);
	}

	private async toolSelectOption(params: Record<string, unknown>): Promise<RawMCPToolCall> {
		const viewId = this.resolveViewId(params) ?? this.ensureActiveTab();
		const ref = String(params.ref ?? '');
		const values = Array.isArray(params.values) ? params.values.map(String) : [];
		if (!ref) {
			return this.error('browser_select_option requires a `ref` parameter.');
		}
		await this.browserAutomationService.selectOptionByRef(viewId, ref, values);
		this._lastInteractedViewId = viewId;
		return this.maybeScreenshotAfterwards(viewId, params, `Selected ${JSON.stringify(values)} in ${ref}`);
	}

	private async toolPressKey(params: Record<string, unknown>): Promise<RawMCPToolCall> {
		const viewId = this.resolveViewId(params) ?? this.ensureActiveTab();
		const key = String(params.key ?? '');
		if (!key) {
			return this.error('browser_press_key requires a `key` parameter.');
		}
		await this.browserAutomationService.pressKey(viewId, key, {
			modifiers: params.modifiers as any,
		});
		this._lastInteractedViewId = viewId;
		return this.maybeScreenshotAfterwards(viewId, params, `Pressed ${key}`);
	}

	private async toolScroll(params: Record<string, unknown>): Promise<RawMCPToolCall> {
		const viewId = this.resolveViewId(params) ?? this.ensureActiveTab();
		// scrollIntoView:true takes precedence — scroll the ref into view only.
		if (params.scrollIntoView === true && typeof params.ref === 'string') {
			await this.browserAutomationService.scroll(viewId, { ref: params.ref });
			this._lastInteractedViewId = viewId;
			return this.maybeScreenshotAfterwards(viewId, params, `Scrolled ${params.ref} into view`);
		}
		// Explicit deltaX/deltaY win over direction+amount.
		let deltaX = typeof params.deltaX === 'number' ? params.deltaX : 0;
		let deltaY = typeof params.deltaY === 'number' ? params.deltaY : 0;
		if (deltaX === 0 && deltaY === 0) {
			const amount = typeof params.amount === 'number' ? params.amount : 300;
			switch (params.direction) {
				case 'up': deltaY = -amount; break;
				case 'down': deltaY = amount; break;
				case 'left': deltaX = -amount; break;
				case 'right': deltaX = amount; break;
				default: break;
			}
		}
		await this.browserAutomationService.scroll(viewId, {
			deltaX,
			deltaY,
			ref: typeof params.ref === 'string' ? params.ref : undefined,
		});
		this._lastInteractedViewId = viewId;
		const dir = params.direction ? ` ${params.direction}` : '';
		return this.maybeScreenshotAfterwards(viewId, params, `Scrolled${dir}`);
	}

	private async toolDrag(params: Record<string, unknown>): Promise<RawMCPToolCall> {
		const viewId = this.resolveViewId(params) ?? this.ensureActiveTab();
		const sourceRef = String(params.sourceRef ?? '');
		if (!sourceRef) {
			return this.error('browser_drag requires a `sourceRef`.');
		}
		const targetRef = typeof params.targetRef === 'string' ? params.targetRef : undefined;
		const hasTargetXY = typeof params.targetX === 'number' && typeof params.targetY === 'number';
		if (!targetRef && !hasTargetXY) {
			return this.error('browser_drag requires either `targetRef` or (`targetX`, `targetY`).');
		}
		await this.browserAutomationService.dispatchDrag(viewId, {
			sourceRef,
			targetRef,
			targetX: hasTargetXY ? Number(params.targetX) : undefined,
			targetY: hasTargetXY ? Number(params.targetY) : undefined,
			intermediateRefs: Array.isArray(params.intermediateRefs) ? params.intermediateRefs.map(String) : undefined,
		});
		this._lastInteractedViewId = viewId;
		const targetDesc = targetRef ? targetRef : `(${params.targetX}, ${params.targetY})`;
		return this.maybeScreenshotAfterwards(viewId, params, `Dragged ${sourceRef} → ${targetDesc}`);
	}

	private async toolHover(params: Record<string, unknown>): Promise<RawMCPToolCall> {
		const viewId = this.resolveViewId(params) ?? this.ensureActiveTab();
		const ref = String(params.ref ?? '');
		if (!ref) {
			return this.error('browser_hover requires a `ref` parameter.');
		}
		await this.browserAutomationService.hoverByRef(viewId, ref);
		this._lastInteractedViewId = viewId;
		return this.maybeScreenshotAfterwards(viewId, params, `Hovered ${ref}`);
	}

	private async toolHighlight(params: Record<string, unknown>): Promise<RawMCPToolCall> {
		const viewId = this.resolveViewId(params) ?? this.ensureActiveTab();
		const ref = String(params.ref ?? '');
		if (!ref) {
			return this.error('browser_highlight requires a `ref` parameter.');
		}
		await this.browserAutomationService.highlightByRef(viewId, ref);
		this._lastInteractedViewId = viewId;
		// durationMs is honored best-effort: schedule a clear after the delay so
		// the highlight disappears on its own (matches cursor-ide-browser). A
		// subsequent highlight or navigation also clears it.
		const durationMs = typeof params.durationMs === 'number' ? params.durationMs : 2000;
		if (durationMs > 0) {
			setTimeout(() => {
				this.browserAutomationService.clearHighlight(viewId).catch(() => { /* ignore */ });
			}, durationMs);
		}
		return this.maybeScreenshotAfterwards(viewId, params, `Highlighted ${ref}`);
	}

	private async toolGetBoundingBox(params: Record<string, unknown>): Promise<RawMCPToolCall> {
		const viewId = this.resolveViewId(params) ?? this.ensureActiveTab();
		const ref = String(params.ref ?? '');
		if (!ref) {
			return this.error('browser_get_bounding_box requires a `ref` parameter.');
		}
		const bounds = await this.browserAutomationService.resolveRefBounds(viewId, ref);
		this._lastInteractedViewId = viewId;
		return this.text(`{ "x": ${bounds.x}, "y": ${bounds.y}, "width": ${bounds.width}, "height": ${bounds.height} }`);
	}

	private async toolCdp(params: Record<string, unknown>): Promise<RawMCPToolCall> {
		const viewId = this.resolveViewId(params) ?? this.ensureActiveTab();
		const method = String(params.method ?? '');
		if (!method) {
			return this.error('browser_cdp requires a `method` parameter.');
		}
		const cdpParams = (params.params && typeof params.params === 'object' ? params.params : {}) as Record<string, unknown>;
		const result = await this.browserAutomationService.sendCdpCommand(viewId, method, cdpParams);
		this._lastInteractedViewId = viewId;
		let text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
		// CDP responses (DOM trees, profiling traces) can be very large — spill
		// to a file and return a summary + head so the model context isn't blown.
		const spilled = await this.browserAutomationService.spillLargeResponse(viewId, text, `cdp-${method}`);
		if (spilled) {
			text = `${spilled.summary}\n\nFirst 4KB:\n${text.slice(0, 4096)}`;
		}
		return this.maybeScreenshotAfterwards(viewId, params, text);
	}

	// ----- helpers ----------------------------------------------------------

	/**
	 * When `take_screenshot_afterwards` is set, return an image event that also
	 * carries the textual result (refs / status). Vision models get pixels via
	 * the chat image path; the tool content keeps actionable text.
	 */
	private async maybeScreenshotAfterwards(
		viewId: string,
		params: Record<string, unknown>,
		text: string,
	): Promise<RawMCPToolCall> {
		if (params.take_screenshot_afterwards !== true) {
			return this.text(text);
		}
		return this.takeScreenshot(viewId, params, text);
	}

	private resolveViewId(params: Record<string, unknown>): string | undefined {
		if (typeof params.viewId === 'string' && params.viewId) {
			const tabs = this.browserAutomationService.listViews();
			if (!tabs.some(t => t.id === params.viewId)) {
				throw new Error(
					`Browser tab not found: ${params.viewId}. It may have been closed. ` +
					`Call browser_tabs with action "list", then browser_navigate to open a tab.`
				);
			}
			this._lastInteractedViewId = params.viewId;
			return params.viewId;
		}
		// Validate cached last-interacted id — a closed tab must not silently
		// route tools to a dead viewId (runExclusive would queue forever on a
		// ghost id, and CDP would throw cryptically).
		if (this._lastInteractedViewId) {
			const tabs = this.browserAutomationService.listViews();
			if (!tabs.some(t => t.id === this._lastInteractedViewId)) {
				this._lastInteractedViewId = undefined;
			}
		}
		return this._lastInteractedViewId;
	}

	private ensureActiveTab(): string {
		const tabs = this.browserAutomationService.listViews();
		if (this._lastInteractedViewId) {
			// Validate the cached tab is still open — closed tabs leave a stale id
			// that would make every subsequent tool fail with a cryptic error.
			if (tabs.some(t => t.id === this._lastInteractedViewId)) {
				return this._lastInteractedViewId;
			}
			this._lastInteractedViewId = undefined;
		}
		if (tabs.length === 0) {
			throw new Error('No browser tab is open. Call browser_navigate first to open one.');
		}
		this._lastInteractedViewId = tabs[0].id;
		return this._lastInteractedViewId;
	}

	private windowIdForView(viewId: string): number {
		const win = this.browserViewMainService.getWindowIdForView(viewId);
		if (win === undefined) {
			throw new Error(`Browser view ${viewId} has no owning window.`);
		}
		return win;
	}

	/**
	 * Resolves the Orbit window that owns a view, falling back to focused/last-active.
	 * Returns the minimal `BrowserAutomationTargetWindow` surface (id + win +
	 * sendWhenReady) so callers can dispatch tab-orchestration IPC. Both main
	 * `CodeWindow`s and auxiliary (pop-out) windows — including the standalone
	 * Agents window — satisfy it. Without the auxiliary fallback, browser tools
	 * driven from the Agents pop-out would route their `openTab`/`selectTab`/
	 * `closeTab` IPC to the main window, where the aux window's
	 * `BrowserTabRegistryService` never receives it and the call times out.
	 */
	private codeWindowForView(viewId?: string): BrowserAutomationTargetWindow | undefined {
		if (viewId) {
			const windowId = this.browserViewMainService.getWindowIdForView(viewId);
			if (windowId !== undefined) {
				const owned = this.windowsMainService.getWindowById(windowId);
				if (owned) {
					return owned;
				}
				// The view may live in an auxiliary window (e.g. the standalone Agents
				// pop-out) whose id is the aux webContents id, not a main-window id.
				// The concrete `AuxiliaryWindow` extends `BaseWindow` and thus has
				// `sendWhenReady`, even though the `IAuxiliaryWindow` interface omits it.
				for (const aux of this.auxiliaryWindowsMainService.getWindows()) {
					if (aux.id === windowId) {
						return aux as unknown as BrowserAutomationTargetWindow;
					}
				}
			}
		}
		// Prefer the focused auxiliary window (the Agents pop-out is typically focused
		// when the agent is driving the browser), then fall back to main windows.
		const focusedAux = this.auxiliaryWindowsMainService.getFocusedWindow();
		if (focusedAux) {
			return focusedAux as unknown as BrowserAutomationTargetWindow;
		}
		const lastAux = this.auxiliaryWindowsMainService.getLastActiveWindow();
		if (lastAux) {
			return lastAux as unknown as BrowserAutomationTargetWindow;
		}
		return this.windowsMainService.getFocusedWindow() ?? this.windowsMainService.getLastActiveWindow();
	}

	/**
	 * Dispatches a command to the renderer to open a browser tab. When
	 * `position` is omitted, the tab opens in the background (preserveFocus +
	 * inactive) so the user's current editor keeps focus.
	 */
	private async openTabInRenderer(url: string, position: 'active' | 'side' | undefined): Promise<string> {
		const codeWindow = this.codeWindowForView();
		if (!codeWindow) {
			throw new Error('No Orbit window available to open a browser tab.');
		}
		if (this.isAuxiliaryCodeWindow(codeWindow)) {
			return this.openAgentWindowBrowserTab(codeWindow, url);
		}
		const replyChannel = makeBrowserAutomationReplyChannel(BROWSER_AUTOMATION_IPC_CHANNELS.openTab, `${Date.now()}.${Math.random().toString(36).slice(2)}`);
		const result = new Promise<string>((resolve, reject) => {
			const win = codeWindow.win;
			if (!win) {
				reject(new Error('Orbit window has no BrowserWindow.'));
				return;
			}
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) {
					return;
				}
				settled = true;
				ipcMain.removeListener(replyChannel, onReply);
				reject(new Error('Timed out waiting for renderer to open browser tab.'));
			}, 10_000);
			// Renderer replies via `ipcRenderer.send(replyChannel, id)`, which is delivered to
			// `ipcMain` in the main process — NOT to `webContents.on(replyChannel)` (webContents
			// only emits its own lifecycle events). Using `ipcMain.once` is the correct receiver
			// for a renderer-originated message. The per-call unique replyChannel makes `once`
			// safe from cross-talk.
			const onReply = (_event: Electron.IpcMainEvent, id: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				ipcMain.removeListener(replyChannel, onReply);
				const idStr = typeof id === 'string' ? id : String(id ?? '');
				if (idStr) {
					resolve(idStr);
				} else {
					reject(new Error('Renderer returned no tab id for openTab.'));
				}
			};
			ipcMain.once(replyChannel, onReply);
		});
		const background = !position;
		codeWindow.sendWhenReady(BROWSER_AUTOMATION_IPC_CHANNELS.openTab, CancellationToken.None, {
			url,
			position,
			background,
			replyChannel,
		});
		return result;
	}

	private async awaitRendererBool(viewId: string, channel: typeof BROWSER_AUTOMATION_IPC_CHANNELS.selectTab | typeof BROWSER_AUTOMATION_IPC_CHANNELS.closeTab, id: string): Promise<void> {
		const codeWindow = this.codeWindowForView(viewId);
		if (!codeWindow) {
			throw new Error(`No Orbit window available for ${channel}.`);
		}
		const replyChannel = makeBrowserAutomationReplyChannel(channel, `${Date.now()}.${Math.random().toString(36).slice(2)}`);
		const result = new Promise<void>((resolve, reject) => {
			const win = codeWindow.win;
			if (!win) {
				reject(new Error('Orbit window has no BrowserWindow.'));
				return;
			}
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) {
					return;
				}
				settled = true;
				ipcMain.removeListener(replyChannel, onReply);
				reject(new Error(`Timed out waiting for renderer ${channel}.`));
			}, 10_000);
			// Renderer replies via `ipcRenderer.send(replyChannel, ok)` → received by `ipcMain`,
			// not `webContents.on` (see openTabInRenderer for the full rationale).
			const onReply = (_event: Electron.IpcMainEvent, ok: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				ipcMain.removeListener(replyChannel, onReply);
				if (ok) {
					resolve();
				} else {
					reject(new Error(`Renderer failed to ${channel === BROWSER_AUTOMATION_IPC_CHANNELS.closeTab ? 'close' : 'select'} tab ${id}.`));
				}
			};
			ipcMain.once(replyChannel, onReply);
		});
		codeWindow.sendWhenReady(channel, CancellationToken.None, { id, replyChannel });
		return result;
	}

	private async selectTabInRenderer(id: string): Promise<void> {
		if (this.isAuxiliaryBrowserView(id)) {
			await this.awaitAgentRendererBool(BROWSER_AUTOMATION_IPC_CHANNELS.agentSelectTab, id);
			return;
		}
		await this.awaitRendererBool(id, BROWSER_AUTOMATION_IPC_CHANNELS.selectTab, id);
	}

	private async closeTabInRenderer(id: string): Promise<void> {
		if (this.isAuxiliaryBrowserView(id)) {
			await this.browserViewMainService.close(this.windowIdForView(id), id);
			return;
		}
		await this.awaitRendererBool(id, BROWSER_AUTOMATION_IPC_CHANNELS.closeTab, id);
	}

	/** True when `viewId` is a native browser view owned by an auxiliary window. */
	private isAuxiliaryBrowserView(viewId: string): boolean {
		const windowId = this.browserViewMainService.getWindowIdForView(viewId);
		if (windowId === undefined) {
			return false;
		}
		return this.auxiliaryWindowsMainService.getWindows().some(aux => aux.id === windowId);
	}

	private isAuxiliaryCodeWindow(codeWindow: BrowserAutomationTargetWindow): boolean {
		return this.auxiliaryWindowsMainService.getWindows().some(aux => aux.id === codeWindow.id);
	}

	/**
	 * Renderer IPC for agents-window browser tabs is handled by
	 * `AgentWindowService` in the MAIN workbench renderer (the React bundle
	 * shares the main window's `ServicesAccessor`). Route there explicitly.
	 */
	private mainRendererCodeWindow(): BrowserAutomationTargetWindow | undefined {
		return this.windowsMainService.getFocusedWindow() ?? this.windowsMainService.getLastActiveWindow();
	}

	private async openAgentWindowBrowserTab(_auxWindow: BrowserAutomationTargetWindow, url: string): Promise<string> {
		const codeWindow = this.mainRendererCodeWindow();
		if (!codeWindow) {
			throw new Error('No Orbit main window available for agents-window browser tab.');
		}
		const replyChannel = makeBrowserAutomationReplyChannel(BROWSER_AUTOMATION_IPC_CHANNELS.agentOpenTab, `${Date.now()}.${Math.random().toString(36).slice(2)}`);
		const result = new Promise<string>((resolve, reject) => {
			const win = codeWindow.win;
			if (!win) {
				reject(new Error('Orbit window has no BrowserWindow.'));
				return;
			}
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) {
					return;
				}
				settled = true;
				ipcMain.removeListener(replyChannel, onReply);
				reject(new Error('Timed out waiting for agents-window browser tab.'));
			}, 10_000);
			const onReply = (_event: Electron.IpcMainEvent, id: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				ipcMain.removeListener(replyChannel, onReply);
				const idStr = typeof id === 'string' ? id : String(id ?? '');
				if (idStr) {
					resolve(idStr);
				} else {
					reject(new Error('Agents window returned no browser view id.'));
				}
			};
			ipcMain.once(replyChannel, onReply);
		});
		codeWindow.sendWhenReady(BROWSER_AUTOMATION_IPC_CHANNELS.agentOpenTab, CancellationToken.None, {
			url,
			replyChannel,
		});
		const id = await result;
		if (url && url !== 'about:blank') {
			await this.browserViewMainService.navigate(this.windowIdForView(id), id, url);
		}
		return id;
	}

	private async awaitAgentRendererBool(channel: typeof BROWSER_AUTOMATION_IPC_CHANNELS.agentSelectTab, id: string): Promise<void> {
		const codeWindow = this.mainRendererCodeWindow();
		if (!codeWindow) {
			throw new Error(`No Orbit main window available for ${channel}.`);
		}
		const replyChannel = makeBrowserAutomationReplyChannel(channel, `${Date.now()}.${Math.random().toString(36).slice(2)}`);
		const result = new Promise<void>((resolve, reject) => {
			const win = codeWindow.win;
			if (!win) {
				reject(new Error('Orbit window has no BrowserWindow.'));
				return;
			}
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) {
					return;
				}
				settled = true;
				ipcMain.removeListener(replyChannel, onReply);
				reject(new Error(`Timed out waiting for agents-window ${channel}.`));
			}, 10_000);
			const onReply = (_event: Electron.IpcMainEvent, ok: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				ipcMain.removeListener(replyChannel, onReply);
				if (ok) {
					resolve();
				} else {
					reject(new Error(`Agents window failed to ${channel === BROWSER_AUTOMATION_IPC_CHANNELS.agentSelectTab ? 'select' : 'handle'} tab ${id}.`));
				}
			};
			ipcMain.once(replyChannel, onReply);
		});
		codeWindow.sendWhenReady(channel, CancellationToken.None, { id, replyChannel });
		return result;
	}

	/**
	 * Captures a screenshot and wraps it as an image `RawMCPToolCall`.
	 *
	 * Viewport PNG (default) goes through native `capturePage` (Retina-correct).
	 * fullPage / element / jpeg go through CDP with CSS-pixel clips
	 * (`cssContentSize` / `cssVisualViewport`) — never the deprecated
	 * device-pixel `contentSize`, which caused the half-width white-space bug.
	 *
	 * Optional `caption` is attached as `text` so navigate/snapshot can return
	 * refs alongside pixels when `take_screenshot_afterwards` is set.
	 * Optional `filename` writes the PNG/JPEG under the spill directory for
	 * agent/user retrieval (Cursor parity).
	 */
	private async takeScreenshot(viewId: string, params: Record<string, unknown> = {}, caption?: string): Promise<RawMCPToolCall> {
		const format = params.type === 'jpeg' ? 'jpeg' : 'png';
		const fullPage = params.fullPage === true;
		const ref = typeof params.ref === 'string' ? params.ref : undefined;
		const captured = await this.browserAutomationService.captureScreenshot(viewId, {
			format,
			fullPage,
			ref,
		});
		let text = caption;
		if (typeof params.filename === 'string' && params.filename.trim()) {
			const saved = await this.browserAutomationService.saveScreenshotFile(
				viewId,
				captured.data,
				params.filename.trim(),
				captured.mimeType,
			);
			if (saved) {
				const note = `Screenshot saved to ${saved}`;
				text = text ? `${text}\n\n${note}` : note;
			}
		}
		return {
			event: 'image',
			image: { data: captured.data, mimeType: captured.mimeType },
			...(text ? { text } : {}),
			toolName: 'browser_take_screenshot',
			serverName: this.name,
		};
	}

	/**
	 * Polls until the native WebContentsView for `viewId` is registered in the
	 * main process. `openTabInRenderer` returns the editor input id as soon as
	 * `openEditor` resolves, but `BrowserEditorPane.setInput` / overlay preload
	 * create the view asynchronously — without this wait, navigate/snapshot
	 * hit "Browser view not found".
	 */
	private async waitForViewReady(viewId: string, timeoutMs = 15_000): Promise<void> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			try {
				const health = this.browserAutomationService.healthCheck(viewId);
				if (health.alive) {
					return;
				}
			} catch {
				// keep polling
			}
			// Also accept a successful listViews hit (healthCheck may throw if
			// getNavigationState fails before the entry exists).
			const tabs = this.browserAutomationService.listViews();
			if (tabs.some(t => t.id === viewId)) {
				return;
			}
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		throw new Error(
			`Timed out waiting for browser tab ${viewId} to become ready. ` +
			`The editor tab may have failed to open. Try browser_tabs with action "list", then browser_navigate again.`
		);
	}

	/**
	 * Polls navigation state until the main frame finishes loading or a timeout
	 * elapses. Prevents type/snapshot immediately after navigate from racing
	 * the destination document.
	 */
	private async waitForNavigationSettle(viewId: string, timeoutMs = 15_000): Promise<void> {
		const start = Date.now();
		// Brief grace period so isLoading can flip true after navigate() returns.
		await new Promise(resolve => setTimeout(resolve, 50));
		while (Date.now() - start < timeoutMs) {
			try {
				const nav = this.browserAutomationService.getNavigationState(viewId);
				if (!nav.isLoading) {
					// Extra tick for late DOM/script hydration after did-finish-load.
					await new Promise(resolve => setTimeout(resolve, 80));
					return;
				}
			} catch {
				return;
			}
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	}

	private text(text: string): RawMCPToolCall {
		return { event: 'text', text, toolName: '', serverName: this.name };
	}

	private error(text: string): RawMCPToolCall {
		return { event: 'error', text, toolName: '', serverName: this.name };
	}

	// The Orbit MCP channel prefixes external server tool names with a random
	// id to avoid collisions across servers. For built-in servers we use a
	// fixed prefix derived from the server name so tool names in chat history
	// stay stable across restarts (the channel's random prefix would otherwise
	// change on every launch and cause hallucinations when present in history).
	private toolNamePrefix(): string {
		// First 3 hex chars of a stable hash of the server name.
		let hash = 0;
		for (let i = 0; i < this.name.length; i++) {
			hash = ((hash << 5) - hash) + this.name.charCodeAt(i);
			hash |= 0;
		}
		const hex = (hash >>> 0).toString(16).padStart(8, '0');
		return hex.slice(0, 3);
	}

	private stripPrefix(toolName: string): string {
		const prefix = this.toolNamePrefix();
		if (toolName.startsWith(`${prefix}_`)) {
			return toolName.slice(prefix.length + 1);
		}
		return toolName;
	}
}
