/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrowserWindow, clipboard, Menu, MenuItemConstructorOptions, session, shell, View, WebContentsView } from 'electron';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../base/common/platform.js';
import { ILogService } from '../../log/common/log.js';
import { IWindowsMainService } from '../../windows/electron-main/windows.js';
import { IAuxiliaryWindowsMainService } from '../../auxiliaryWindow/electron-main/auxiliaryWindows.js';
import {
	BrowserViewId,
	IBrowserViewBounds,
	IBrowserViewNavigationEvent,
	IBrowserViewOpenOptions,
	IBrowserViewShortcutEvent,
	IElementPickData,
	INavigationState,
	shouldDisplayBrowserUrl,
} from '../common/browserView.js';
import { buildPickScript, buildPickerGuardScript, buildPickerOverlayScript, buildPickerTeardownScript } from '../common/pickerScripts.js';

function isWebUrl(url: string): boolean {
	return /^https?:\/\//i.test(url) || /^file:\/\//i.test(url);
}

let cachedBrowserTabUserAgent: string | undefined;
const configuredPartitions = new Set<string>();

/**
 * A plain desktop Chrome UA using this Electron build's actual bundled Chromium version
 * (so `Sec-CH-UA`/feature-detection stays consistent with what's really running), with
 * no "Electron/" or app-name token. See the `setUserAgent` call site in `open()`.
 */
function getBrowserTabUserAgent(): string {
	if (cachedBrowserTabUserAgent) {
		return cachedBrowserTabUserAgent;
	}
	const chromeVersion = process.versions.chrome || '128.0.0.0';
	const platformToken = process.platform === 'darwin'
		? 'Macintosh; Intel Mac OS X 10_15_7'
		: process.platform === 'win32'
			? 'Windows NT 10.0; Win64; x64'
			: 'X11; Linux x86_64';
	cachedBrowserTabUserAgent = `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
	return cachedBrowserTabUserAgent;
}

/**
 * Web permissions the integrated browser grants. Electron's default is to GRANT every
 * permission request (camera, geolocation, notifications, ...) — unacceptable for a
 * browser surface. Everything not listed here is denied.
 */
const GRANTED_WEB_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);

function configureBrowserSession(partition: string): void {
	if (configuredPartitions.has(partition)) {
		return;
	}
	configuredPartitions.add(partition);
	const ses = session.fromPartition(partition);
	ses.setUserAgent(getBrowserTabUserAgent());
	ses.setPermissionRequestHandler((_wc, permission, callback) => {
		callback(GRANTED_WEB_PERMISSIONS.has(permission));
	});
	ses.setPermissionCheckHandler((_wc, permission) => GRANTED_WEB_PERMISSIONS.has(permission));
}

interface IBrowserViewEntry {
	readonly id: BrowserViewId;
	readonly view: WebContentsView;
	readonly disposables: DisposableStore;
	windowId: number;
	/** Last committed main-frame URL shown in the address bar. */
	url: string;
	/** URL currently being loaded; used when committed URL is not yet available. */
	pendingUrl: string;
	homeUrl: string;
	title: string;
	favicon: string | null;
	isLoading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	/** Desired visibility as requested by the renderer (active pane + overlay state). */
	visible: boolean;
	/**
	 * Preload/background opens keep the native view hidden until the owning pane
	 * explicitly calls `setVisible(true)`. Prevents restore races where a sized but
	 * inactive tab's white `about:blank` surface composites over the workbench.
	 */
	holdHidden: boolean;
	/**
	 * True once DevTools is open for this entry's window. Docked DevTools resizes the
	 * *inspected page's own* viewport without moving the window-relative coordinate
	 * space our sibling `WebContentsView` is positioned in, so bounds computed from the
	 * page's (shrunk) layout end up wrong relative to the whole window — the native view
	 * visually bleeds into where DevTools now sits. There's no public Electron API to
	 * query the exact devtools inset, so instead of drawing at a wrong position, we
	 * suppress native visibility entirely for the duration and let the renderer's
	 * resize-triggered relayout naturally resync bounds once DevTools closes.
	 */
	devToolsSuppressed: boolean;
	/** Becomes true after the first `setBounds()` call with non-zero dimensions. */
	initialLayoutDone: boolean;
	lastBounds: IBrowserViewBounds | undefined;
	/** Last bounds actually applied to the native view (for deduplication). */
	lastAppliedBounds: IBrowserViewBounds | undefined;
	/** Zoom factor used for {@link lastAppliedBounds} — a zoom change invalidates the dedupe. */
	lastAppliedZoom: number | undefined;
	/** Clears stuck loading UI if did-finish-load never arrives. */
	loadingSafetyTimer: ReturnType<typeof setTimeout> | undefined;
	/**
	 * Pending surface-recreation after a navigation commit (see {@link refreshCompositor}).
	 * Coalesces rapid commits (redirect chains) into a single hide/show cycle.
	 */
	compositorNudgeTimer: ReturnType<typeof setTimeout> | undefined;
	pickerActive: boolean;
	/**
	 * True while an agent holds the automation lock on this tab. The browser
	 * toolbar shows a "Take Control" affordance when this is set. We deliberately
	 * do NOT swallow keyboard via `before-input-event` here — CDP input from the
	 * agent shares that pipeline, and blocking it would break browser_type/fill
	 * while locked.
	 */
	automationLocked: boolean;
	/**
	 * Mirrors the last value passed to {@link setIgnoreMenuShortcuts}. When true, the page has
	 * focus and application menu shortcuts must NOT fire — but on macOS the Edit-menu roles
	 * (`copy`, `selectAll`, `paste`, …) consume Cmd+C/A/V/X/Z *before* Chromium can synthesize
	 * the corresponding events in the page, even with `setIgnoreMenuShortcuts(true)`. The
	 * `before-input-event` handler uses this flag to detect those keystrokes and let them
	 * through to the page (via `event.preventDefault` on the menu side), restoring editing
	 * shortcuts inside the browser tab. See Electron #14514 and the matching Positron fix.
	 */
	menuShortcutsIgnored: boolean;
	/**
	 * The root `View` (the window's `contentView`) the browser `WebContentsView` is attached to
	 * as a SIBLING of the workbench's main WebContentsView. Never attach a `WebContentsView` as a
	 * child of another `WebContentsView`: on macOS the parent's `NativeViewHost` intercepts the
	 * views hit-test and swallows all pointer events, so the page renders but cannot be clicked,
	 * scrolled, or typed in (Electron #47536 / #47990 — maintainer guidance is "add them both as
	 * children of mainWindow.contentView"). The macOS `content_view_` hit-test transparency fix
	 * (Electron #51617) then routes clicks inside our bounds to us and outside to the workbench.
	 */
	parentView: View | undefined;
}

/**
 * Owns one `electron.WebContentsView` per browser tab and attaches it to the VS Code
 * window that opened it. All tabs share one persistent session partition (like a browser
 * profile) so logins survive restarts and links opened in new tabs stay authenticated.
 *
 * All methods receive `windowId` as the IPC context (set by the renderer proxy via
 * `ProxyChannel.toService(..., { context: nativeHostService.windowId })`). Methods that
 * need to resolve the window (`open`, `setBounds`, `setVisible`, `focus`) use it to attach
 * or move the view; per-id methods operate purely on the view identified by `id`.
 */
export class BrowserViewMainService extends Disposable {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidNavigate = this._register(new Emitter<IBrowserViewNavigationEvent>());
	readonly onDidNavigate = this._onDidNavigate.event;

	private readonly _onDidTitleChange = this._register(new Emitter<{ id: BrowserViewId; title: string }>());
	readonly onDidTitleChange = this._onDidTitleChange.event;

	private readonly _onDidFaviconChange = this._register(new Emitter<{ id: BrowserViewId; favicon: string | null }>());
	readonly onDidFaviconChange = this._onDidFaviconChange.event;

	private readonly _onDidLoadingStateChange = this._register(new Emitter<{ id: BrowserViewId; isLoading: boolean }>());
	readonly onDidLoadingStateChange = this._onDidLoadingStateChange.event;

	private readonly _onDidClose = this._register(new Emitter<BrowserViewId>());
	readonly onDidClose = this._onDidClose.event;

	private readonly _onDidFocusView = this._register(new Emitter<BrowserViewId>());
	readonly onDidFocusView = this._onDidFocusView.event;

	private readonly _onDidBrowserShortcut = this._register(new Emitter<IBrowserViewShortcutEvent>());
	readonly onDidBrowserShortcut = this._onDidBrowserShortcut.event;

	private readonly views = new Map<BrowserViewId, IBrowserViewEntry>();
	private readonly windowDevToolsTracking = new Map<number, DisposableStore>();
	/**
	 * Windows we've already attached a native `closed` reaper to (see
	 * {@link ensureWindowCloseTracking}). `onDidDestroyWindow` above only
	 * covers MAIN windows — `IAuxiliaryWindowsMainService` exposes no destroy
	 * event, so without this, closing the Agents pop-out while a Browser panel
	 * is open leaks its `WebContentsView` (and the renderer process behind it):
	 * cleanup relied entirely on the renderer's `close(id)` IPC call landing
	 * before the aux window's webContents were torn down, which teardown
	 * ordering does not guarantee.
	 */
	private readonly closeTrackedWindows = new Set<number>();

	constructor(
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@ILogService private readonly logService: ILogService,
		@IAuxiliaryWindowsMainService private readonly auxiliaryWindowsMainService: IAuxiliaryWindowsMainService,
	) {
		super();
		this._register(this.windowsMainService.onDidDestroyWindow(window => {
			const windowId = window.id;
			for (const entry of Array.from(this.views.values())) {
				if (entry.windowId === windowId) {
					entry.disposables.dispose();
				}
			}
		}));
	}

	/**
	 * Returns true when `wc` is the webContents of one of this service's browser tabs.
	 * Used by the main app's global security handler to exempt integrated-browser tabs from
	 * the "block all in-page navigation" rule that protects the workbench renderer — without
	 * this, clicking a link in the browser (e.g. a Google search result) is prevented and the
	 * page can never navigate.
	 */
	ownsWebContents(wc: { id: number }): boolean {
		for (const entry of this.views.values()) {
			if (!entry.view.webContents.isDestroyed() && entry.view.webContents.id === wc.id) {
				return true;
			}
		}
		return false;
	}

	async open(windowId: number, id: BrowserViewId, options: IBrowserViewOpenOptions): Promise<INavigationState> {
		const existing = this.views.get(id);
		if (existing) {
			// NOTE: this branch deliberately never toggles `visible` for an already-visible
			// tab. A background preload may set `holdHidden` so the view stays suppressed
			// until the active pane calls `setVisible(true)`.
			if (options.keepHidden === true && !existing.visible) {
				existing.holdHidden = true;
				this.applyVisibility(existing);
			}
			if (existing.windowId !== windowId) {
				this.detachFromWindow(existing);
				existing.windowId = windowId;
				this.attachToWindow(existing);
			}
			if (options.homeUrl) {
				existing.homeUrl = options.homeUrl;
			}
			if (options.bounds) {
				await this.setBounds(windowId, id, options.bounds);
			}
			const target = this.sanitizeUrl(options.url);
			if (target !== existing.url && target !== existing.pendingUrl) {
				await this.doNavigate(existing, target);
			} else {
				this.bringToFrontInternal(existing, true);
			}
			return this.toNavState(existing);
		}

		const url = this.sanitizeUrl(options.url);
		// One shared, persistent session for every browser tab (like a regular browser
		// profile): logins/cookies survive restarts and are shared across tabs. Per-tab
		// ephemeral partitions made users re-authenticate on every tab and every launch.
		const partition = 'persist:orbit-browser';
		configureBrowserSession(partition);

		const view = new WebContentsView({
			webPreferences: {
				partition,
				contextIsolation: true,
				sandbox: true,
				javascript: true,
				plugins: false,
				webSecurity: true,
				allowRunningInsecureContent: false,
				backgroundThrottling: false,
			},
		});

		view.setBackgroundColor('#ffffffff');
		view.setVisible(false); // hidden until renderer calls setVisible
		view.webContents.setUserAgent(getBrowserTabUserAgent());

		const disposables = new DisposableStore();
		const entry: IBrowserViewEntry = {
			id,
			view,
			disposables,
			windowId,
			url,
			pendingUrl: url,
			homeUrl: options.homeUrl ?? url,
			title: '',
			favicon: null,
			isLoading: false,
			canGoBack: false,
			canGoForward: false,
			visible: false,
			holdHidden: options.keepHidden === true,
			devToolsSuppressed: false,
			initialLayoutDone: false,
			lastBounds: undefined,
			lastAppliedBounds: undefined,
		lastAppliedZoom: undefined,
		loadingSafetyTimer: undefined,
		compositorNudgeTimer: undefined,
		pickerActive: false,
		automationLocked: false,
		menuShortcutsIgnored: false,
		parentView: undefined,
		};
		this.views.set(id, entry);

		this.attachToWindow(entry);
		this.registerWebContentsListeners(entry, disposables);
		this.applyInitialBounds(entry, options.bounds, options.keepHidden === true);

		// Workaround for Electron #47351: a WebContentsView that hasn't painted content yet
		// is placed below already-loaded WebContentsViews (e.g. the workbench's main view) in
		// the macOS compositor stacking order, so a brand-new browser tab appears blank until
		// its target URL finishes loading and paints — even though the view is attached and
		// on top in the child-view order. Loading `about:blank` first forces an immediate
		// background paint at the RenderWidgetHostViewCocoa level, giving the new view a real
		// composited frame so it covers the workbench view while the target URL loads.
		await this.preloadBlankFrame(entry);
		await this.doNavigate(entry, url);
		// Drop the `about:blank` preload entry from session history so a freshly opened
		// tab has history [targetUrl] (Back disabled), not [about:blank, targetUrl] which
		// would leave Back enabled and navigate to a blank page. Only safe here on the
		// initial open, before the user/agent has built any real back-forward history.
		this.clearNavigationHistory(entry);
		this.refreshHistoryFlags(entry);
		return this.toNavState(entry);
	}

	/** Clears the tab's back/forward history (used to erase the about:blank preload entry). */
	private clearNavigationHistory(entry: IBrowserViewEntry): void {
		const wc = entry.view.webContents;
		if (wc.isDestroyed()) {
			return;
		}
		try {
			if (wc.navigationHistory && typeof wc.navigationHistory.clear === 'function') {
				wc.navigationHistory.clear();
			} else if (typeof (wc as unknown as { clearHistory?: () => void }).clearHistory === 'function') {
				(wc as unknown as { clearHistory: () => void }).clearHistory();
			}
		} catch { /* best-effort — history API varies across Electron versions */ }
	}

	/**
	 * Loads `about:blank` and waits for the frame to commit, so the WebContentsView has a
	 * painted surface before the real navigation. This is the documented workaround for
	 * Electron #47351 (new WebContentsView doesn't cover existing views until its first
	 * page load finishes). Without it, a new browser tab shows blank on macOS because the
	 * workbench's main WebContentsView (already loaded) stays on top in the compositor.
	 */
	private async preloadBlankFrame(entry: IBrowserViewEntry): Promise<void> {
		const wc = entry.view.webContents;
		if (wc.isDestroyed()) {
			return;
		}
		try {
			await wc.loadURL('about:blank');
		} catch (e) {
			// about:blank can be aborted by an immediate subsequent navigation; treat as benign.
			if (!this.isBenignAbortError(e)) {
				this.logService.warn('[browserView] preloadBlankFrame failed', e);
			}
		}
	}

	/**
	 * Sizes and shows the view *before* the first navigation starts, when the caller already
	 * knows the target bounds (the editor pane always does by the time it calls `open()`).
	 * Without this, a brand-new tab navigates and finishes loading entirely while hidden at
	 * zero size, and Chromium never composites a frame for it — the pane then shows blank
	 * until something else (a manual reload) forces a fresh, now-visible paint.
	 */
	private applyInitialBounds(entry: IBrowserViewEntry, bounds: IBrowserViewBounds | undefined, keepHidden = false): void {
		if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
			return;
		}
		const win = this.getWindow(entry.windowId);
		if (!win) {
			return;
		}
		entry.lastBounds = bounds;
		// Preload path: size the surface so Chromium can composite, but stay hidden
		// until the editor pane reveals this tab. Visible path: show immediately so
		// the first navigation paints live (avoids blank-until-reload).
		entry.holdHidden = keepHidden;
		entry.visible = !keepHidden;
		this.applyBoundsToView(entry, bounds);
		entry.initialLayoutDone = true;
		this.applyVisibility(entry);
		if (!keepHidden) {
			this.bringToFrontInternal(entry, true);
		}
	}

	private registerWebContentsListeners(entry: IBrowserViewEntry, disposables: DisposableStore): void {
		const { id, view } = entry;
		const wc = view.webContents;

		view.webContents.setWindowOpenHandler(({ url }) => {
			if (isWebUrl(url)) {
				void this.doNavigate(entry, url);
			} else {
				void shell.openExternal(url).catch(() => { /* ignore */ });
			}
			return { action: 'deny' };
		});

		disposables.add(Event.fromNodeEventEmitter<boolean>(wc, 'did-start-navigation', (_e, _url, _inPlace, isMainFrame) => !!isMainFrame)(isMainFrame => {
			if (!isMainFrame) {
				return;
			}
			this.setMainFrameLoading(entry, id, true);
			this.ensureViewInteractive(entry);
			if (entry.pickerActive) {
				void this.teardownPickerInternal(entry);
			}
		}));

		disposables.add(Event.fromNodeEventEmitter<boolean>(wc, 'did-frame-finish-load', (_e, isMainFrame) => !!isMainFrame)(isMainFrame => {
			if (!isMainFrame) {
				return;
			}
			this.syncCommittedUrl(entry);
			// Reconcile against the authoritative main-frame loading flag rather than a counter:
			// redirect chains (very common on Google search) fire did-start-navigation multiple
			// times but did-frame-finish-load once for the final doc, which strands a naive
			// counter and keeps the loading bar stuck until the safety timer.
			this.reconcileMainFrameLoading(entry, id);
		}));

		disposables.add(Event.fromNodeEventEmitter<void>(wc, 'did-start-loading')(e => {
			void e;
			// Subframe/subresource loads must NOT drive the toolbar loading indicator — sites
			// like Google keep background requests open indefinitely via did-start/stop-loading.
			if (entry.pickerActive) {
				void this.teardownPickerInternal(entry);
			}
		}));

		disposables.add(Event.fromNodeEventEmitter<void>(wc, 'did-stop-loading')(e => {
			void e;
			// did-stop-loading fires when ALL loading (main + subframes) ceases — the most
			// reliable "definitely done" signal. Use it to clear any stranded loading state.
			this.reconcileMainFrameLoading(entry, id);
		}));

		disposables.add(Event.fromNodeEventEmitter<string>(wc, 'did-navigate', (_e, url) => String(url))(url => {
			this.onNavigated(entry, url, false);
			this.maybeHandleOAuthRejection(entry, url);
		}));

		disposables.add(Event.fromNodeEventEmitter<string>(wc, 'did-navigate-in-page', (_e, url) => String(url))(url => {
			this.onNavigated(entry, url, true);
		}));

		disposables.add(Event.fromNodeEventEmitter<{ errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean }>(wc, 'did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => ({ errorCode, errorDescription, validatedURL, isMainFrame }))(({ errorCode, errorDescription, validatedURL, isMainFrame }) => {
			if (!isMainFrame) {
				// A blocked/failed subresource or subframe (ad, tracker pixel, CSP-blocked
				// iframe, etc.) is extremely common on real-world pages and does NOT mean
				// the page itself failed to load — replacing the whole page with an error
				// screen here would break otherwise-working sites on every blocked pixel.
				return;
			}
			if (errorCode === -3 /* ERR_ABORTED */) {
				// Aborted by a new navigation/redirect: let the new load drive loading state.
				this.reconcileMainFrameLoading(entry, id);
				return;
			}
			this.setMainFrameLoading(entry, id, false);
			this.ensureViewInteractive(entry);
			this.logService.warn(`[browserView] Navigation to ${validatedURL} failed: ${errorDescription} (${errorCode})`);
			void this.showErrorPage(entry, validatedURL, errorDescription, errorCode);
		}));

		disposables.add(Event.fromNodeEventEmitter<string>(wc, 'will-navigate', (_e, url) => String(url))(url => {
			entry.pendingUrl = url;
			this.fireUrlBarUpdate(entry);
			this.ensureViewInteractive(entry);
			if (entry.pickerActive) {
				void this.teardownPickerInternal(entry);
			}
		}));

		disposables.add(Event.fromNodeEventEmitter<string>(wc, 'page-title-updated', (_e, title) => String(title ?? ''))(title => {
			entry.title = title;
			this._onDidTitleChange.fire({ id, title: entry.title });
		}));

		disposables.add(Event.fromNodeEventEmitter<string[]>(wc, 'page-favicon-updated', (_e, favicons) => Array.isArray(favicons) ? favicons.map(String) : [])(favicons => {
			const fav = favicons.length ? favicons[0] : null;
			entry.favicon = fav;
			this._onDidFaviconChange.fire({ id, favicon: fav });
		}));

		// Clicking into the page focuses the native view directly — the workbench renderer
		// never sees that click, so it must be told to activate the owning editor group.
		disposables.add(Event.fromNodeEventEmitter<void>(wc, 'focus')(() => {
			this._onDidFocusView.fire(id);
		}));

		disposables.add(Event.fromNodeEventEmitter<Electron.ContextMenuParams>(wc, 'context-menu', (_e, params) => params)(params => {
			this.showPageContextMenu(entry, params);
		}));

		// The native `WebContentsView` is a separate OS surface, so its key events never reach the
		// workbench renderer's DOM — the workbench keybinding system cannot see keystrokes typed
		// while the page has focus. We intercept `before-input-event` here and split them:
		//
		//  - Editing shortcuts (Cmd/Ctrl + A/C/V/X/Z/Y): on macOS the Edit-menu roles consume
		//    these before Chromium can synthesize the page events (Electron #14514), so we invoke
		//    the matching `webContents` editing command directly and preventDefault. On Win/Linux
		//    these route through Chromium natively and need no help.
		//  - Browser-chrome shortcuts (Cmd/Ctrl + F/R/L/=/-/0, Alt + Left/Right): we preventDefault
		//    (so the page doesn't also handle them) and forward to the renderer via
		//    `onDidBrowserShortcut`; the owning pane runs the command (find / reload / zoom / …).
		disposables.add(Event.fromNodeEventEmitter<{ event: Electron.Event | undefined; input: Electron.Input | undefined }>(wc, 'before-input-event', (event, input) => ({ event: event as Electron.Event | undefined, input: input as Electron.Input | undefined }))(({ event, input }) => {
			if (!entry.menuShortcutsIgnored || !event || !input) {
				return;
			}
			const key = (input.key || '').toLowerCase();
			const shift = !!input.shift;
			const alt = !!input.alt;
			const cmd = !!input.meta;
			const ctrl = !!input.control;
			// Primary accelerator: Cmd on macOS, Ctrl elsewhere. Alt is reserved (Alt+Left/Right
			// for history nav below); combinations with Alt other than those are left to the page.
			const primary = isMacintosh ? cmd : ctrl;

			// --- Browser-chrome shortcuts → forward to the renderer pane ---
			let chromeAction: IBrowserViewShortcutEvent['action'] | undefined;
			if (alt && !shift && !cmd && !ctrl) {
				if (key === 'arrowleft') { chromeAction = 'goBack'; }
				else if (key === 'arrowright') { chromeAction = 'goForward'; }
			} else if (primary && !alt) {
				switch (key) {
					case 'f': if (!shift) { chromeAction = 'findInPage'; } break;
					case 'r': if (!shift) { chromeAction = 'reload'; } break;
					case 'l': if (!shift) { chromeAction = 'focusAddressBar'; } break;
					case 'equal': case '+': if (!shift) { chromeAction = 'zoomIn'; } break;
					case '-': case 'minus': if (!shift) { chromeAction = 'zoomOut'; } break;
					case '0': if (!shift) { chromeAction = 'zoomReset'; } break;
					case 'escape': if (shift) { chromeAction = 'closeFindInPage'; } break;
				}
			}
			if (chromeAction) {
				event.preventDefault();
				this._onDidBrowserShortcut.fire({ id, action: chromeAction });
				return;
			}

			// --- Editing shortcuts → run in the page (macOS-only workaround) ---
			if (!isMacintosh || !cmd) {
				return;
			}
			let handled = false;
			try {
				switch (key) {
					case 'a':
						if (!shift) { wc.selectAll(); handled = true; }
						break;
					case 'c':
						if (!shift) { wc.copy(); handled = true; }
						break;
					case 'v':
						if (!shift) { wc.paste(); handled = true; }
						break;
					case 'x':
						if (!shift) { wc.cut(); handled = true; }
						break;
					case 'z':
						if (shift) { wc.redo(); } else { wc.undo(); }
						handled = true;
						break;
					case 'y':
						if (!shift) { wc.redo(); handled = true; }
						break;
				}
			} catch { /* page may not support the command — ignore */ }
			if (handled) {
				// Stop the macOS menu role (selectAll:/copy:/…) from also firing.
				event.preventDefault();
			}
		}));

		disposables.add(toDisposable(() => {
			if (entry.loadingSafetyTimer) {
				clearTimeout(entry.loadingSafetyTimer);
				entry.loadingSafetyTimer = undefined;
			}
			if (entry.compositorNudgeTimer) {
				clearTimeout(entry.compositorNudgeTimer);
				entry.compositorNudgeTimer = undefined;
			}
		}));

		disposables.add(toDisposable(() => {
			try { wc.closeDevTools(); } catch { /* noop */ }
			wc.close();
		}));

		disposables.add(toDisposable(() => {
			// Fire while the entry is still in the map — the IPC channel resolves the event's
			// window via getWindowIdForView, so deleting first would silently drop the event.
			this._onDidClose.fire(id);
			this.views.delete(id);
		}));
	}

	async close(_windowId: number, id: BrowserViewId): Promise<void> {
		const entry = this.views.get(id);
		if (!entry) {
			return;
		}
		// No picker teardown script here: the web contents is about to be destroyed anyway,
		// and awaiting executeJavaScript on a wedged page would block the close forever.
		entry.pickerActive = false;
		this.detachFromWindow(entry);
		entry.disposables.dispose();
	}

	async navigate(_windowId: number, id: BrowserViewId, url: string): Promise<INavigationState> {
		const entry = this.views.get(id);
		if (!entry) {
			throw new Error(`Browser view not found: ${id}`);
		}
		await this.doNavigate(entry, this.sanitizeUrl(url));
		return this.toNavState(entry);
	}

	async goBack(_windowId: number, id: BrowserViewId): Promise<INavigationState> {
		const entry = this.views.get(id);
		if (!entry) {
			throw new Error(`Browser view not found: ${id}`);
		}
		const wc = entry.view.webContents;
		if (wc.navigationHistory && typeof wc.navigationHistory.canGoBack === 'function') {
			if (!wc.navigationHistory.canGoBack()) {
				return this.toNavState(entry);
			}
			await wc.navigationHistory.goBack();
		} else if (wc.canGoBack?.()) {
			await wc.goBack();
		}
		return this.toNavState(entry);
	}

	async goForward(_windowId: number, id: BrowserViewId): Promise<INavigationState> {
		const entry = this.views.get(id);
		if (!entry) {
			throw new Error(`Browser view not found: ${id}`);
		}
		const wc = entry.view.webContents;
		if (wc.navigationHistory && typeof wc.navigationHistory.canGoForward === 'function') {
			if (!wc.navigationHistory.canGoForward()) {
				return this.toNavState(entry);
			}
			await wc.navigationHistory.goForward();
		} else if (wc.canGoForward?.()) {
			await wc.goForward();
		}
		return this.toNavState(entry);
	}

	async reload(_windowId: number, id: BrowserViewId): Promise<INavigationState> {
		const entry = this.views.get(id);
		if (!entry) {
			throw new Error(`Browser view not found: ${id}`);
		}
		const wc = entry.view.webContents;
		this.ensureViewInteractive(entry);
		await new Promise<void>((resolve) => {
			let settled = false;
			const done = () => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				resolve();
			};
			const onFrameFinish = (_e: unknown, isMainFrame: boolean) => {
				if (isMainFrame) {
					done();
				}
			};
			const onFailLoad = (_e: unknown, _code: number, _desc: string, _url: string, isMainFrame: boolean) => {
				if (isMainFrame) {
					done();
				}
			};
			const timer = setTimeout(done, 30_000);
			const cleanup = () => {
				clearTimeout(timer);
				wc.removeListener('did-frame-finish-load', onFrameFinish);
				wc.removeListener('did-fail-load', onFailLoad);
			};
			wc.on('did-frame-finish-load', onFrameFinish);
			wc.on('did-fail-load', onFailLoad);
			wc.reload();
		});
		return this.toNavState(entry);
	}

	async stop(_windowId: number, id: BrowserViewId): Promise<INavigationState> {
		const entry = this.views.get(id);
		if (!entry) {
			throw new Error(`Browser view not found: ${id}`);
		}
		entry.view.webContents.stop();
		this.setMainFrameLoading(entry, id, false);
		return this.toNavState(entry);
	}

	async setZoomFactor(_windowId: number, id: BrowserViewId, zoomFactor: number): Promise<void> {
		const entry = this.views.get(id);
		if (!entry) {
			return;
		}
		const clamped = Math.max(0.25, Math.min(5, Number(zoomFactor) || 1));
		try {
			entry.view.webContents.setZoomFactor(clamped);
			// A zoom change invalidates the CSS-px→DIP conversion of the native bounds, so
			// re-apply the last bounds with force to reposition the view for the new factor.
			entry.lastAppliedZoom = undefined;
			if (entry.lastBounds) {
				this.applyBoundsToView(entry, entry.lastBounds, true);
			}
		} catch { /* ignore */ }
	}

	async getZoomFactor(_windowId: number, id: BrowserViewId): Promise<number> {
		const entry = this.views.get(id);
		if (!entry) {
			return 1;
		}
		try {
			return entry.view.webContents.getZoomFactor() ?? 1;
		} catch {
			return 1;
		}
	}

	async findInPage(_windowId: number, id: BrowserViewId, query: string, options?: { forward?: boolean; matchCase?: boolean }): Promise<void> {
		const entry = this.views.get(id);
		if (!entry) {
			return;
		}
		const wc = entry.view.webContents;
		if (!query) {
			wc.stopFindInPage('clearSelection');
			return;
		}
		wc.findInPage(query, {
			forward: options?.forward ?? true,
			matchCase: options?.matchCase ?? false,
		});
	}

	async stopFindInPage(_windowId: number, id: BrowserViewId): Promise<void> {
		const entry = this.views.get(id);
		if (!entry) {
			return;
		}
		entry.view.webContents.stopFindInPage('clearSelection');
	}

	async setBounds(windowId: number, id: BrowserViewId, bounds: IBrowserViewBounds): Promise<void> {
		const entry = this.views.get(id);
		if (!entry) {
			return;
		}
		if (entry.windowId !== windowId) {
			this.detachFromWindow(entry);
			entry.windowId = windowId;
			this.attachToWindow(entry);
		}
		entry.lastBounds = bounds;
		if (!this.applyBoundsToView(entry, bounds)) {
			return;
		}
		// First real bounds on a view that navigated hidden/zero-size: mark layout done
		// AND force a compositor refresh so the already-loaded page paints a frame.
		// Without this, a brand-new active tab that opened with undefined bounds (zero-size
		// content area at open() time) loads fully while hidden, then setBounds resizes the
		// native view but never composites — the tab stays blank until a manual reload.
		if (!entry.initialLayoutDone && bounds.width > 0 && bounds.height > 0) {
			entry.initialLayoutDone = true;
			this.refreshCompositor(entry);
		}
		if (entry.visible) {
			// Non-forced: reordering child views detaches/reattaches the native surface, which
			// flickers — only restack when the view is genuinely not on top. Bounds changes
			// arrive continuously during window resizes, so this path must stay cheap.
			this.bringToFrontInternal(entry);
		}
	}

	async setVisible(_windowId: number, id: BrowserViewId, visible: boolean): Promise<void> {
		const entry = this.views.get(id);
		if (!entry) {
			return;
		}
		if (visible) {
			if (entry.holdHidden && this.isUnsafeFullscreenBounds(entry)) {
				this.logService.warn(`[browserView] Suppressed unsafe fullscreen show for ${id} (awaiting editor layout)`);
				return;
			}
			entry.holdHidden = false;
		}
		const wasVisible = entry.visible && !entry.devToolsSuppressed && !entry.holdHidden;
		entry.visible = visible;
		this.applyVisibility(entry);
		const isVisible = entry.visible && !entry.devToolsSuppressed && !entry.holdHidden;
		if (isVisible && !wasVisible) {
			this.bringToFrontInternal(entry, true);
			if (entry.lastBounds) {
				this.applyBoundsToView(entry, entry.lastBounds, true);
			}
			// A page that finished loading while hidden does NOT composite a fresh frame on
			// `setVisible(true)` on macOS with `backgroundThrottling: false` (Electron #41276:
			// `DelegatedFrameHost::WasShown` is not called). Force a compositor nudge so the
			// revealed tab paints immediately instead of staying blank until a reload/nav.
			this.refreshCompositor(entry);
		}
	}

	private applyVisibility(entry: IBrowserViewEntry): void {
		entry.view.setVisible(entry.visible && !entry.devToolsSuppressed && !entry.holdHidden);
	}

	/**
	 * Detects a native view parked at the window origin covering nearly the entire
	 * content area — the signature of a restore race / guessed-bounds preload.
	 */
	private isUnsafeFullscreenBounds(entry: IBrowserViewEntry): boolean {
		const bounds = entry.lastBounds;
		if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
			return false;
		}
		const win = this.getWindow(entry.windowId);
		if (!win) {
			return false;
		}
		const content = win.getContentBounds();
		if (content.width <= 0 || content.height <= 0) {
			return false;
		}
		const atOrigin = bounds.x <= 8 && bounds.y <= 8;
		const coversWindow = bounds.width >= content.width * 0.9 && bounds.height >= content.height * 0.9;
		return atOrigin && coversWindow && content.width > 480 && content.height > 320;
	}

	async focus(_windowId: number, id: BrowserViewId): Promise<void> {
		const entry = this.views.get(id);
		if (!entry) {
			return;
		}
		this.ensureViewInteractive(entry);
		entry.view.webContents.focus();
	}

	async blur(_windowId: number, id: BrowserViewId): Promise<void> {
		const entry = this.views.get(id);
		if (!entry) {
			return;
		}
		const win = this.getWindow(entry.windowId);
		if (win) {
			win.webContents.focus();
		}
	}

	async setIgnoreMenuShortcuts(_windowId: number, id: BrowserViewId, enabled: boolean): Promise<void> {
		const entry = this.views.get(id);
		if (!entry) {
			return;
		}
		entry.menuShortcutsIgnored = enabled;
		const wc = entry.view.webContents;
		if (wc.isDestroyed()) {
			return;
		}
		try {
			wc.setIgnoreMenuShortcuts(enabled);
		} catch { /* ignore — not supported on all platforms */ }
	}

	async bringToFront(_windowId: number, id: BrowserViewId): Promise<void> {
		const entry = this.views.get(id);
		if (!entry) {
			return;
		}
		this.bringToFrontInternal(entry);
	}

	private bringToFrontInternal(entry: IBrowserViewEntry, force = false): void {
		const win = this.getWindow(entry.windowId);
		if (!win) {
			return;
		}
		const parent = entry.parentView ?? win.contentView;
		if (!parent) {
			return;
		}
		const children = this.getChildViews(parent);
		if (!force && children.length > 0 && children[children.length - 1] === entry.view) {
			return;
		}
		try {
			parent.removeChildView(entry.view);
			parent.addChildView(entry.view);
		} catch (e) {
			this.logService.warn(`[browserView] bringToFront failed for ${entry.id}`, e);
		}
	}

	/**
	 * Returns the window's root content view. Browser tabs MUST be attached as direct children
	 * of this (siblings of the workbench's main `WebContentsView`), NOT as children of the
	 * workbench `WebContentsView` itself. Nesting `WebContentsView` inside another
	 * `WebContentsView` breaks hit-testing on macOS so the page renders but no clicks/keys reach
	 * it (Electron #47536, #47990). The macOS `content_view_` transparency fix (Electron #51617)
	 * routes events inside our bounds to us and outside to the workbench.
	 */
	private getChildViews(parent: View): View[] {
		return parent.children ?? [];
	}

	async executeJavaScript(_windowId: number, id: BrowserViewId, script: string): Promise<unknown> {
		const entry = this.views.get(id);
		if (!entry) {
			throw new Error(`Browser view not found: ${id}`);
		}
		return entry.view.webContents.executeJavaScript(script, true);
	}

	async screenshot(_windowId: number, id: BrowserViewId): Promise<string> {
		const entry = this.views.get(id);
		if (!entry) {
			throw new Error(`Browser view not found: ${id}`);
		}
		const wc = entry.view.webContents;
		if (wc.isDestroyed()) {
			throw new Error(`Browser view webContents destroyed: ${id}`);
		}

		// Ensure the native view is painted before capture. A hidden or
		// zero-sized WebContentsView returns a blank white NativeImage, which
		// is exactly the "empty browser" screenshot agents were seeing.
		if (entry.lastBounds && entry.lastBounds.width > 0 && entry.lastBounds.height > 0) {
			this.applyBoundsToView(entry, entry.lastBounds, true);
		}
		if (!entry.visible || entry.devToolsSuppressed) {
			// Temporarily reveal for capture so the compositor has a frame.
			// We restore the previous visibility afterwards.
			const wasVisible = entry.visible;
			const wasSuppressed = entry.devToolsSuppressed;
			entry.visible = true;
			entry.devToolsSuppressed = false;
			this.applyVisibility(entry);
			this.bringToFrontInternal(entry, true);
			try {
				return await this.capturePageAsBase64Png(wc);
			} finally {
				entry.visible = wasVisible;
				entry.devToolsSuppressed = wasSuppressed;
				this.applyVisibility(entry);
			}
		}

		// Nudge the compositor: invalidate + brief settle so capturePage does
		// not return a stale/blank frame after a recent navigation.
		try {
			wc.invalidate?.();
		} catch { /* invalidate is best-effort */ }
		await new Promise(resolve => setTimeout(resolve, 32));
		return this.capturePageAsBase64Png(wc);
	}

	/**
	 * Captures the WebContents surface as a base64 PNG. Rejects empty /
	 * zero-size images so callers fall back to CDP instead of shipping a
	 * blank white rectangle to the model.
	 */
	private async capturePageAsBase64Png(wc: Electron.WebContents): Promise<string> {
		const image = await wc.capturePage();
		if (!image || image.isEmpty()) {
			throw new Error('Native capturePage returned an empty image.');
		}
		const size = image.getSize();
		if (!size.width || !size.height) {
			throw new Error(`Native capturePage returned a zero-size image (${size.width}x${size.height}).`);
		}
		return image.toPNG().toString('base64');
	}

	async runPicker(windowId: number, id: BrowserViewId): Promise<{ picked: boolean; data?: IElementPickData }> {
		const entry = this.views.get(id);
		if (!entry) {
			throw new Error(`Browser view not found: ${id}`);
		}
		const callbackName = `__orbitPickerCb_${id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
		const wc = entry.view.webContents;
		entry.pickerActive = true;

		let removeConsoleListener: (() => void) | undefined;
		const first = new Promise<{ picked: boolean; data?: IElementPickData }>(resolve => {
			const onConsoleMessage = (_e: unknown, _level: number, message: string) => {
				if (typeof message !== 'string') {
					return;
				}
				const prefix = `__orbit_picker__:`;
				if (!message.startsWith(prefix)) {
					return;
				}
				try {
					const payload = JSON.parse(message.slice(prefix.length));
					if (!payload || typeof payload !== 'object') {
						return;
					}
					if (payload.type === 'cancel') {
						resolve({ picked: false });
					} else if (payload.type === 'pick') {
						const x = Number(payload.x) || 0;
						const y = Number(payload.y) || 0;
						entry.view.webContents.executeJavaScript(buildPickScript(x, y), true)
							.then(data => resolve({ picked: true, data: data as IElementPickData }))
							.catch(() => resolve({ picked: false }));
					}
				} catch {
					// ignore malformed payloads
				}
			};
			wc.on('console-message', onConsoleMessage);
			removeConsoleListener = () => wc.removeListener('console-message', onConsoleMessage);
		});

		try {
			await wc.executeJavaScript(`(() => {
				if (window.__orbitPickerCleanup) { try { window.__orbitPickerCleanup(); } catch {} }
				const cb = (payload) => {
					try { console.log('__orbit_picker__:' + JSON.stringify(payload)); } catch {}
				};
				window[${JSON.stringify(callbackName)}] = cb;
				window.__orbitPickerCleanup = () => {
					try { delete window[${JSON.stringify(callbackName)}]; } catch {}
					window.__orbitPickerCleanup = undefined;
				};
				return true;
			})()`, true);

			await wc.executeJavaScript(buildPickerOverlayScript(callbackName), true);
			return await first;
		} finally {
			removeConsoleListener?.();
			entry.pickerActive = false;
			try {
				await wc.executeJavaScript(buildPickerTeardownScript(), true);
			} catch { /* page may have navigated */ }
			try {
				await wc.executeJavaScript(`(() => { try { window.__orbitPickerCleanup && window.__orbitPickerCleanup(); } catch {} return true; })()`, true);
			} catch { /* ignore */ }
		}
	}

	async teardownPicker(_windowId: number, id: BrowserViewId): Promise<void> {
		const entry = this.views.get(id);
		if (!entry) {
			return;
		}
		await this.teardownPickerInternal(entry);
	}

	private async teardownPickerInternal(entry: IBrowserViewEntry): Promise<void> {
		entry.pickerActive = false;
		try {
			await entry.view.webContents.executeJavaScript(buildPickerTeardownScript(), true);
		} catch { /* ignore */ }
	}

	private async runPickerGuard(entry: IBrowserViewEntry): Promise<void> {
		if (entry.pickerActive) {
			return;
		}
		try {
			await entry.view.webContents.executeJavaScript(buildPickerGuardScript(), true);
		} catch { /* ignore */ }
	}

	// ----- helpers ---------------------------------------------------------

	private sanitizeUrl(raw: string): string {
		const candidate = String(raw ?? '').trim();
		if (!isWebUrl(candidate)) {
			throw new Error(`Refusing to open non-web URL: ${raw}`);
		}
		return candidate;
	}

	private getWindow(windowId: number): BrowserWindow | undefined {
		const main = this.windowsMainService.getWindowById(windowId)?.win;
		if (main) {
			return main;
		}
		// The standalone Agents window is an auxiliary window (its own BrowserWindow) that
		// hosts browser tabs. Its `vscodeWindowId` is the aux webContents id — the same key
		// AuxiliaryWindowsMainService uses — so resolve it here so `attachToWindow` can add
		// the WebContentsView to the pop-out's contentView instead of failing to find it.
		for (const aux of this.auxiliaryWindowsMainService.getWindows()) {
			if (aux.id === windowId) {
				return aux.win ?? undefined;
			}
		}
		return undefined;
	}

	private ensureWindowCloseTracking(win: BrowserWindow, windowId: number): void {
		if (this.closeTrackedWindows.has(windowId)) {
			return;
		}
		this.closeTrackedWindows.add(windowId);
		win.once('closed', () => {
			this.closeTrackedWindows.delete(windowId);
			for (const entry of Array.from(this.views.values())) {
				if (entry.windowId === windowId) {
					entry.disposables.dispose();
				}
			}
		});
	}

	private attachToWindow(entry: IBrowserViewEntry): void {
		const win = this.getWindow(entry.windowId);
		if (!win) {
			this.logService.warn(`[browserView] Cannot attach ${entry.id}: window ${entry.windowId} not found`);
			return;
		}
		this.ensureWindowCloseTracking(win, entry.windowId);
		if (entry.parentView) {
			this.detachFromWindow(entry);
		}
		// Attach as a direct child of the window's contentView (a sibling of the workbench's
		// main WebContentsView), NOT as a child of that main WebContentsView. Nesting
		// WebContentsView inside WebContentsView breaks macOS hit-testing (Electron #47536,
		// #47990): the page renders but no pointer/keyboard events reach it.
		const parent = win.contentView;
		try {
			parent.addChildView(entry.view);
			entry.parentView = parent;
			this.bringToFrontInternal(entry, true);
		} catch (e) {
			this.logService.error(`[browserView] Failed to attach view ${entry.id}`, e);
		}

		this.ensureDevToolsTracking(win, entry.windowId);
		entry.devToolsSuppressed = win.webContents.isDevToolsOpened();
		this.applyVisibility(entry);
	}

	private ensureDevToolsTracking(win: BrowserWindow, windowId: number): void {
		if (this.windowDevToolsTracking.has(windowId)) {
			return;
		}

		const store = new DisposableStore();
		const setSuppressed = (suppressed: boolean) => {
			for (const entry of this.views.values()) {
				if (entry.windowId !== windowId) {
					continue;
				}
				entry.devToolsSuppressed = suppressed;
				this.applyVisibility(entry);
				if (!suppressed && entry.visible && entry.lastBounds) {
					this.applyBoundsToView(entry, entry.lastBounds, true);
					this.bringToFrontInternal(entry, true);
				}
			}
		};

		store.add(Event.fromNodeEventEmitter<void>(win.webContents, 'devtools-opened')(() => setSuppressed(true)));
		store.add(Event.fromNodeEventEmitter<void>(win.webContents, 'devtools-closed')(() => setSuppressed(false)));
		store.add(toDisposable(() => this.windowDevToolsTracking.delete(windowId)));
		this.windowDevToolsTracking.set(windowId, store);

		win.once('closed', () => store.dispose());
	}

	private detachFromWindow(entry: IBrowserViewEntry): void {
		const win = this.getWindow(entry.windowId);
		if (!win) {
			return;
		}
		const parent = entry.parentView ?? win.contentView;
		try {
			parent.removeChildView(entry.view);
		} catch { /* window may already be gone */ }
		entry.parentView = undefined;
	}

	/**
	 * Tracks main-frame loading state for the toolbar indicator.
	 */
	private setMainFrameLoading(entry: IBrowserViewEntry, id: BrowserViewId, loading: boolean): void {
		if (entry.loadingSafetyTimer) {
			clearTimeout(entry.loadingSafetyTimer);
			entry.loadingSafetyTimer = undefined;
		}
		if (loading) {
			// Safety net for a did-finish-load that never arrives. Must be generous: heavy
			// real-world pages routinely take >10s and clearing the spinner mid-load reads
			// as "the page silently stopped loading".
			entry.loadingSafetyTimer = setTimeout(() => {
				entry.loadingSafetyTimer = undefined;
				if (entry.isLoading) {
					this.setMainFrameLoading(entry, id, false);
					this.ensureViewInteractive(entry);
				}
			}, 15_000);
		}
		if (entry.isLoading === loading) {
			return;
		}
		entry.isLoading = loading;
		this._onDidLoadingStateChange.fire({ id, isLoading: loading });
	}

	private onMainFrameLoadFinished(entry: IBrowserViewEntry, _id: BrowserViewId): void {
		this.setMainFrameLoading(entry, _id, false);
		this.syncCommittedUrl(entry);
		this.ensureViewInteractive(entry);
		void this.runPickerGuard(entry);
	}

	/**
	 * Reconciles the toolbar loading indicator with the main frame's authoritative loading flag.
	 * Used in place of a manually-incremented counter that strands on redirect chains (Google
	 * search fires did-start-navigation 2-3x for one final document).
	 */
	private reconcileMainFrameLoading(entry: IBrowserViewEntry, id: BrowserViewId): void {
		if (entry.view.webContents.isDestroyed()) {
			this.setMainFrameLoading(entry, id, false);
			return;
		}
		const stillLoading = !!entry.view.webContents.isLoadingMainFrame();
		if (stillLoading) {
			this.setMainFrameLoading(entry, id, true);
		} else {
			this.onMainFrameLoadFinished(entry, id);
		}
	}

	/** Keeps the native view visible and laid out. Cheap: every step deduplicates. No reorder. */
	private ensureViewInteractive(entry: IBrowserViewEntry): void {
		if (!entry.visible || entry.devToolsSuppressed) {
			return;
		}
		this.applyVisibility(entry);
		// Do NOT call bringToFrontInternal here: it runs on every load event and the
		// removeChildView/addChildView reorder causes a brief visibility gap = flicker.
		// The view is already on top after attach/setVisible; only the bounds may need a refresh.
		if (entry.lastBounds) {
			this.applyBoundsToView(entry, entry.lastBounds);
		}
	}

	/**
	 * Forces Chromium to composite a fresh frame after a navigation commit. After an in-place
	 * navigation (address bar / link / back-forward) Chromium often does NOT composite the new
	 * frame — the page stays blank until an external repaint (Electron #28255/#1110/#27353).
	 *
	 * We previously used a hide/show cycle here, but on macOS with `backgroundThrottling: false`
	 * (which we set), `setVisible(true)` does NOT call `DelegatedFrameHost::WasShown`, so the
	 * frame is never regenerated after hide — the hide/show cycle makes the blank-screen bug
	 * WORSE, not better (Electron #41276). Instead we force a repaint by re-applying the bounds
	 * (a 1px nudge then restore) and calling `invalidate()`, which schedules a fresh composite
	 * without ever dropping the surface. Rapid commits (redirect chains) coalesce into one nudge.
	 *
	 * For hidden (preloaded / background) tabs we still invalidate so CDP/automation sees a
	 * real frame without flashing the view on top of the user's editor.
	 */
	private refreshCompositor(entry: IBrowserViewEntry): void {
		if (entry.devToolsSuppressed || !entry.initialLayoutDone) {
			return;
		}
		if (entry.compositorNudgeTimer) {
			return;
		}
		entry.compositorNudgeTimer = setTimeout(() => {
			entry.compositorNudgeTimer = undefined;
			const wc = entry.view.webContents;
			if (wc.isDestroyed()) {
				return;
			}
			if (entry.devToolsSuppressed) {
				return;
			}
			const bounds = entry.lastBounds ?? entry.lastAppliedBounds;
			if (entry.visible && bounds && bounds.width > 0 && bounds.height > 0) {
				// Visible: 1px nudge then restore (forces DelegatedFrameHost refresh).
				this.applyBoundsToView(entry, { ...bounds, width: Math.max(1, bounds.width - 1) }, true);
				this.applyBoundsToView(entry, bounds, true);
			} else if (bounds && bounds.width > 0 && bounds.height > 0) {
				// Hidden preload: re-apply bounds without becoming visible.
				this.applyBoundsToView(entry, bounds, true);
			}
			try {
				wc.invalidate();
			} catch { /* invalidate is best-effort */ }
			// NOTE: no bringToFrontInternal here — reordering causes flicker, and the view
			// is already on top after attach when visible.
		}, 16);
	}

	private syncCommittedUrl(entry: IBrowserViewEntry): void {
		const wc = entry.view.webContents;
		if (wc.isDestroyed()) {
			return;
		}
		const committed = wc.getURL();
		if (shouldDisplayBrowserUrl(committed)) {
			this.onNavigated(entry, committed, false);
		}
	}

	/** Pushes the in-flight URL to the address bar before the navigation commits. */
	private fireUrlBarUpdate(entry: IBrowserViewEntry): void {
		const display = shouldDisplayBrowserUrl(entry.pendingUrl)
			? entry.pendingUrl
			: (shouldDisplayBrowserUrl(entry.url) ? entry.url : undefined);
		if (!display) {
			return;
		}
		this.refreshHistoryFlags(entry);
		this._onDidNavigate.fire({
			id: entry.id,
			url: display,
			canGoBack: entry.canGoBack,
			canGoForward: entry.canGoForward,
		});
	}

	/** Applies bounds to the native view. Returns false when unchanged (no-op). */
	private applyBoundsToView(entry: IBrowserViewEntry, bounds: IBrowserViewBounds, force = false): boolean {
		const win = this.getWindow(entry.windowId);
		if (!win) {
			return false;
		}
		// Renderer bounds are CSS px in the (zoomed) workbench page; native view bounds are
		// window DIPs. With zoom factor z, one CSS px occupies z DIPs on screen, so convert
		// by MULTIPLYING (dividing shrinks/mis-places the view whenever the UI is zoomed).
		const zoom = win.webContents.getZoomFactor?.() ?? 1;
		if (!force && entry.lastAppliedBounds && entry.lastAppliedZoom === zoom && boundsEqual(entry.lastAppliedBounds, bounds)) {
			return false;
		}
		const native = {
			x: Math.round(bounds.x * zoom),
			y: Math.round(bounds.y * zoom),
			width: Math.round(bounds.width * zoom),
			height: Math.round(bounds.height * zoom),
		};
		entry.view.setBounds(native);
		entry.lastAppliedBounds = { ...bounds };
		entry.lastAppliedZoom = zoom;
		return true;
	}

	/** Builds and pops a native context menu for the page (native menus composite above the view). */
	private showPageContextMenu(entry: IBrowserViewEntry, params: Electron.ContextMenuParams): void {
		const win = this.getWindow(entry.windowId);
		if (!win) {
			return;
		}
		const wc = entry.view.webContents;
		const template: MenuItemConstructorOptions[] = [];

		if (params.linkURL && isWebUrl(params.linkURL)) {
			const linkURL = params.linkURL;
			template.push(
				{ label: 'Open Link', click: () => void this.doNavigate(entry, linkURL) },
				{ label: 'Open Link in External Browser', click: () => void shell.openExternal(linkURL).catch(() => { /* ignore */ }) },
				{ label: 'Copy Link Address', click: () => clipboard.writeText(linkURL) },
				{ type: 'separator' },
			);
		}
		if (params.hasImageContents && params.srcURL) {
			const srcURL = params.srcURL;
			template.push(
				{ label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) },
				{ label: 'Copy Image Address', click: () => clipboard.writeText(srcURL) },
				{ type: 'separator' },
			);
		}
		if (params.isEditable) {
			template.push(
				{ label: 'Undo', enabled: params.editFlags.canUndo, click: () => wc.undo() },
				{ label: 'Redo', enabled: params.editFlags.canRedo, click: () => wc.redo() },
				{ type: 'separator' },
				{ label: 'Cut', enabled: params.editFlags.canCut, click: () => wc.cut() },
				{ label: 'Copy', enabled: params.editFlags.canCopy, click: () => wc.copy() },
				{ label: 'Paste', enabled: params.editFlags.canPaste, click: () => wc.paste() },
				{ label: 'Select All', enabled: params.editFlags.canSelectAll, click: () => wc.selectAll() },
				{ type: 'separator' },
			);
		} else if (params.selectionText.trim()) {
			const selection = params.selectionText.trim();
			const shortened = selection.length > 40 ? `${selection.slice(0, 40)}…` : selection;
			template.push(
				{ label: 'Copy', click: () => wc.copy() },
				{ label: `Search Google for “${shortened}”`, click: () => void this.doNavigate(entry, `https://www.google.com/search?q=${encodeURIComponent(selection)}`) },
				{ type: 'separator' },
			);
		}
		template.push(
			{ label: 'Back', enabled: entry.canGoBack, click: () => void this.goBack(entry.windowId, entry.id).catch(() => { /* ignore */ }) },
			{ label: 'Forward', enabled: entry.canGoForward, click: () => void this.goForward(entry.windowId, entry.id).catch(() => { /* ignore */ }) },
			{ label: 'Reload', click: () => void this.reload(entry.windowId, entry.id).catch(() => { /* ignore */ }) },
			{ type: 'separator' },
			{
				label: 'Inspect Element', click: () => {
					try {
						wc.inspectElement(params.x, params.y);
						if (!wc.isDevToolsOpened()) {
							wc.openDevTools({ mode: 'detach' });
						}
					} catch { /* ignore */ }
				}
			},
		);

		Menu.buildFromTemplate(template).popup({ window: win });
	}

	/**
	 * Google (and Apple/Microsoft) block OAuth sign-in inside embedded browsers as a security
	 * policy: the host app could intercept keystrokes/cookies. When we detect a Google sign-in
	 * rejection page, open the same URL in a real top-level `BrowserWindow` (which Google treats
	 * as a normal browser) sharing the same `persist:orbit-browser` session, so cookies carry
	 * over. Once the user leaves the accounts domain, close the helper window and reload the
	 * embedded view so it picks up the now-authenticated session.
	 */
	private maybeHandleOAuthRejection(entry: IBrowserViewEntry, url: string): void {
		try {
			const u = new URL(url);
			const isGoogleRejection =
				u.hostname === 'accounts.google.com' &&
				(u.pathname.includes('/signin/rejected') ||
					u.pathname.includes('/signin/disallowed') ||
					u.searchParams.get('disallowed_useragent') === '1');
			if (!isGoogleRejection) {
				return;
			}
		} catch {
			return;
		}
		const win = this.getWindow(entry.windowId);
		if (!win) {
			return;
		}
		// Avoid opening multiple helper windows for the same rejection.
		if (entry.disposables instanceof DisposableStore && (entry as any)._signInWin && !(entry as any)._signInWin.isDestroyed()) {
			return;
		}
		const signInWin = new BrowserWindow({
			parent: win,
			width: 900,
			height: 700,
			title: 'Sign in — Orbit Browser',
			webPreferences: {
				partition: 'persist:orbit-browser',
				contextIsolation: true,
				sandbox: true,
			},
		});
		(entry as any)._signInWin = signInWin;
		void signInWin.loadURL(url);
		const onNav = (_e: unknown, postUrl: string) => {
			try {
				const postHost = new URL(postUrl).hostname;
				if (postHost.includes('accounts.google') || postHost.includes('myaccount.google') || postHost.includes('accounts.youtube')) {
					return; // still signing in
				}
				// Left the accounts domain — sign-in complete.
				setTimeout(() => {
					if (!signInWin.isDestroyed()) {
						signInWin.close();
					}
					const wc = entry.view.webContents;
					if (!wc.isDestroyed()) {
						wc.reload();
					}
				}, 1200);
			} catch { /* ignore */ }
		};
		signInWin.webContents.on('did-navigate', onNav);
		signInWin.once('closed', () => {
			signInWin.webContents.removeListener('did-navigate', onNav);
		});
	}

	private async showErrorPage(entry: IBrowserViewEntry, validatedURL: string, errorDescription: string, errorCode: number): Promise<void> {
		const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
		const safeUrl = escape(validatedURL);
		const safeDesc = escape(errorDescription);
		// `retryHref` lands in a JS string inside the data: page — JSON-encode it so quotes
		// and backslashes in the URL cannot break out of the literal.
		const retryHref = JSON.stringify(validatedURL);
		const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Page not available</title>
<style>
:root{color-scheme:light dark}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;color:#333;background:#fff}
@media (prefers-color-scheme:dark){body{color:#ccc;background:#1e1e1e}code{background:#2a2a2a}button{background:#2a2a2a;color:#ccc;border-color:#444}}
main{max-width:560px;padding:32px;text-align:center}
h1{font-size:20px;margin:0 0 12px}p{margin:0 0 8px;opacity:.75;font-size:14px;word-break:break-all}
code{background:#f4f4f4;padding:2px 6px;border-radius:4px}
button{margin-top:16px;padding:6px 18px;font-size:13px;border:1px solid #ccc;border-radius:6px;background:#f8f8f8;cursor:pointer}
</style></head>
<body><main><h1>This site can&rsquo;t be reached</h1><p><code>${safeUrl}</code></p><p>${safeDesc} (${errorCode})</p>
<button onclick="location.href=${escape(retryHref)}">Try again</button></main></body></html>`;
		try {
			await entry.view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
		} catch {
			// ignore secondary load failures
		}
	}

	private async doNavigate(entry: IBrowserViewEntry, url: string): Promise<void> {
		entry.pendingUrl = url;
		try {
			// UA is set on the session via `configureBrowserSession`/`setUserAgent`; passing it
			// per-request is redundant and some servers ignore the per-request override.
			await entry.view.webContents.loadURL(url);
		} catch (e) {
			if (!this.isBenignAbortError(e)) {
				throw e;
			}
		}
		const committed = entry.view.webContents.getURL();
		if (shouldDisplayBrowserUrl(committed)) {
			this.onNavigated(entry, committed, false);
		} else if (shouldDisplayBrowserUrl(url)) {
			this.onNavigated(entry, url, false);
		}
	}

	private isBenignAbortError(e: unknown): boolean {
		const err = e as { code?: string; errno?: number } | undefined;
		return err?.code === 'ERR_ABORTED' || err?.errno === -3;
	}

	private onNavigated(entry: IBrowserViewEntry, url: string, inPage: boolean): void {
		// Only cross-document navigations risk a stale compositor surface; in-page navigations
		// (URL fragment / history.pushState) do NOT replace the frame and need no nudge, which
		// is one fewer reorder/repaint that would otherwise flicker the page.
		if (!inPage) {
			this.refreshCompositor(entry);
		}
		if (!shouldDisplayBrowserUrl(url)) {
			return;
		}
		entry.url = url;
		entry.pendingUrl = url;
		this.refreshHistoryFlags(entry);
		this._onDidNavigate.fire({
			id: entry.id,
			url: entry.url,
			canGoBack: entry.canGoBack,
			canGoForward: entry.canGoForward,
			inPage,
		});
	}

	private refreshHistoryFlags(entry: IBrowserViewEntry): void {
		const wc = entry.view.webContents;
		try {
			if (wc.navigationHistory && typeof wc.navigationHistory.canGoBack === 'function') {
				entry.canGoBack = !!wc.navigationHistory.canGoBack();
				entry.canGoForward = !!wc.navigationHistory.canGoForward();
			} else {
				entry.canGoBack = !!wc.canGoBack?.();
				entry.canGoForward = !!wc.canGoForward?.();
			}
		} catch { /* ignore */ }
	}

	private toNavState(entry: IBrowserViewEntry): INavigationState {
		this.refreshHistoryFlags(entry);
		const displayUrl = shouldDisplayBrowserUrl(entry.url)
			? entry.url
			: (shouldDisplayBrowserUrl(entry.pendingUrl) ? entry.pendingUrl : entry.homeUrl);
		return {
			url: displayUrl,
			canGoBack: entry.canGoBack,
			canGoForward: entry.canGoForward,
			isLoading: entry.isLoading,
			title: entry.title,
		};
	}

	// --- Automation support (Phase 1 of the built-in browser MCP) ------------
	// These accessors are used by BrowserAutomationMainService to enumerate
	// tabs, fetch webContents for CDP, and apply the automation lock. They are
	// intentionally not on IBrowserViewService — they're main-process-internal.

	/** Returns metadata for every open browser tab across all windows. */
	listViewsForAutomation(): ReadonlyArray<{ id: BrowserViewId; url: string; title: string; isLoading: boolean; windowId: number }> {
		return Array.from(this.views.values()).map(entry => ({
			id: entry.id,
			url: entry.url,
			title: entry.title,
			isLoading: entry.isLoading,
			windowId: entry.windowId,
		}));
	}

	/** Returns the window id that owns a view, or undefined if the view is gone. */
	getWindowIdForView(id: BrowserViewId): number | undefined {
		return this.views.get(id)?.windowId;
	}

	/** Returns the live webContents for a view, or undefined if the view is gone/destroyed. */
	getWebContentsForAutomation(id: BrowserViewId): Electron.WebContents | undefined {
		const entry = this.views.get(id);
		if (!entry || entry.view.webContents.isDestroyed()) {
			return undefined;
		}
		return entry.view.webContents;
	}

	/** Returns the full navigation state for a tab (richer than the `navigate()` return). */
	getNavigationStateForAutomation(id: BrowserViewId): { url: string; title: string; isLoading: boolean; canGoBack: boolean; canGoForward: boolean; favicon: string | null } {
		const entry = this.views.get(id);
		if (!entry) {
			throw new Error(`Browser view not found: ${id}`);
		}
		this.refreshHistoryFlags(entry);
		const displayUrl = shouldDisplayBrowserUrl(entry.url)
			? entry.url
			: (shouldDisplayBrowserUrl(entry.pendingUrl) ? entry.pendingUrl : entry.homeUrl);
		return {
			url: displayUrl,
			title: entry.title,
			isLoading: entry.isLoading,
			canGoBack: entry.canGoBack,
			canGoForward: entry.canGoForward,
			favicon: entry.favicon,
		};
	}

	/**
	 * Records the automation lock flag on the view entry so the renderer can
	 * show a "Take Control" toolbar control. Does not intercept keyboard —
	 * CDP agent input shares the same input pipeline and must keep working
	 * while locked (that is the whole point of the lock).
	 */
	setAutomationLockedForAutomation(id: BrowserViewId, locked: boolean): void {
		const entry = this.views.get(id);
		if (!entry) {
			return;
		}
		entry.automationLocked = locked;
	}

	override dispose(): void {
		for (const entry of Array.from(this.views.values())) {
			entry.disposables.dispose();
		}
		super.dispose();
	}
}

function boundsEqual(a: IBrowserViewBounds, b: IBrowserViewBounds): boolean {
	return Math.round(a.x) === Math.round(b.x)
		&& Math.round(a.y) === Math.round(b.y)
		&& Math.round(a.width) === Math.round(b.width)
		&& Math.round(a.height) === Math.round(b.height);
}
