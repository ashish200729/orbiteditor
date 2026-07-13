/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, $ } from '../../../../base/browser/dom.js';
import { onDidChangeZoomLevel } from '../../../../base/browser/browser.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ColorScheme } from '../../../../platform/theme/common/theme.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IBrowserViewBounds, IBrowserViewService, BrowserShortcutAction, IElementPickData, INavigationState, resolveBrowserNavigationTarget } from '../../../../platform/browserView/common/browserView.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IContextKeyService, IContextKey, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { BrowserEditorInput } from './browserEditorInput.js';

const TOOLBAR_HEIGHT = 40;
const BROWSER_EDITOR_STYLES_ID = 'browser-editor-pane-styles';

/**
 * True when a {@link BrowserEditorPane} is the active editor pane. Browser-scoped keybindings
 * (Cmd+F find, Cmd+/-/0 zoom, Cmd+R reload, Cmd+L address, Alt+Left/Right back/forward) are gated
 * on this so they only fire while a browser tab is active. Note: these bindings cover the case
 * where the pane's CHROME (address bar, buttons) has focus and the DOM keydown reaches the
 * workbench keybinding system; when the native PAGE has focus the keystrokes are intercepted in
 * the main process and forwarded via `onDidBrowserShortcut`, bypassing the keybinding system.
 */
export const BrowserEditorActiveContext = new RawContextKey<boolean>('browserEditorActive', false);

/**
 * Dispatched on `document` after a browser pane force-shows its native view on open/reveal, so
 * the {@link BrowserViewOverlayManager} can immediately re-hide it if an overlay is already up.
 */
export const BROWSER_VIEW_REEVALUATE_VISIBILITY_EVENT = 'orbit-browser-view-reevaluate-visibility';

/**
 * Scoped stylesheet for the browser pane chrome. Injected once per document (supports aux
 * windows). All colors are VS Code theme tokens so it tracks light/dark automatically. The
 * flex layout (fixed-height toolbar + flex-fill content) is what keeps the content area's
 * measured bounds correct for positioning the native `WebContentsView`, so it must be preserved.
 */
const BROWSER_EDITOR_STYLES = `
.browser-editor-pane { display:flex; flex-direction:column; width:100%; height:100%; overflow:hidden; background:var(--vscode-editor-background); }
.browser-editor-toolbar { display:flex; flex:0 0 auto; align-items:center; gap:4px; height:${TOOLBAR_HEIGHT}px; padding:0 8px; background:var(--vscode-editor-background); border-bottom:1px solid var(--vscode-panel-border); position:relative; }
.browser-editor-btn { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; padding:0; border:none; border-radius:6px; background:transparent; color:var(--vscode-icon-foreground,var(--vscode-foreground)); cursor:pointer; flex:0 0 auto; transition:background .12s ease, opacity .12s ease, color .12s ease; }
.browser-editor-btn:hover:not(:disabled) { background:var(--vscode-toolbar-hoverBackground); }
.browser-editor-btn:active:not(:disabled) { background:var(--vscode-toolbar-activeBackground,var(--vscode-toolbar-hoverBackground)); }
.browser-editor-btn:disabled { opacity:.35; cursor:default; }
.browser-editor-btn:focus-visible { outline:1px solid var(--vscode-focusBorder); outline-offset:1px; }
.browser-editor-btn .codicon { font-size:16px; line-height:1; }
.browser-editor-btn.is-active { background:var(--vscode-inputOption-activeBackground); color:var(--vscode-inputOption-activeForeground); box-shadow:inset 0 0 0 1px var(--vscode-inputOption-activeBorder,transparent); }
.browser-editor-address { display:flex; align-items:center; gap:6px; flex:1 1 auto; min-width:0; height:30px; margin:0 4px; padding:0 10px; border-radius:15px; background:var(--vscode-input-background); border:1px solid var(--vscode-input-border,transparent); transition:border-color .12s ease, box-shadow .12s ease; }
.browser-editor-address:focus-within { border-color:var(--vscode-focusBorder); box-shadow:0 0 0 1px var(--vscode-focusBorder); }
.browser-editor-address.is-loading { border-color:var(--vscode-progressBar-background,#0078d4); }
.browser-editor-ssl { display:none; flex:0 0 auto; font-size:12px; color:var(--vscode-descriptionForeground); }
.browser-editor-ssl.is-secure { display:inline-flex; }
.browser-editor-ssl.is-insecure { display:inline-flex; color:var(--vscode-list-warningIconForeground,#cca700); }
.browser-editor-favicon { display:none; flex:0 0 auto; width:16px; height:16px; object-fit:contain; }
.browser-editor-favicon.is-present { display:inline-block; }
.browser-editor-url { flex:1 1 auto; min-width:0; height:100%; border:none; background:transparent; color:var(--vscode-input-foreground); outline:none; font-size:13px; font-family:var(--vscode-font-family); }
.browser-editor-url::placeholder { color:var(--vscode-input-placeholderForeground); }
.browser-editor-zoom-pill { display:inline-flex; align-items:center; justify-content:center; height:26px; min-width:46px; padding:0 10px; border-radius:13px; font-size:11px; font-weight:500; letter-spacing:.02em; color:var(--vscode-descriptionForeground); user-select:none; transition:background .12s ease, color .12s ease; }
.browser-editor-zoom-pill:hover:not(:disabled) { background:var(--vscode-toolbar-hoverBackground); color:var(--vscode-foreground); }
.browser-editor-zoom-pill.is-changed { color:var(--vscode-textLink-foreground,var(--vscode-foreground)); }
.browser-editor-zoom-label { pointer-events:none; }
.browser-editor-content { flex:1 1 auto; position:relative; overflow:hidden; background:var(--vscode-editor-background); }
.browser-editor-loading { position:absolute; left:0; right:0; bottom:0; height:2px; overflow:hidden; pointer-events:none; opacity:0; transition:opacity .18s ease; }
.browser-editor-loading.is-loading { opacity:1; }
.browser-editor-loading::before { content:''; position:absolute; top:0; bottom:0; left:0; width:35%; border-radius:2px; background:var(--vscode-progressBar-background,#0078d4); animation:browser-editor-progress 1.15s ease-in-out infinite; }
@keyframes browser-editor-progress { 0%{transform:translateX(-120%)} 60%{transform:translateX(230%)} 100%{transform:translateX(320%)} }
.browser-editor-paused { position:absolute; inset:0; display:none; flex-direction:column; align-items:center; justify-content:center; gap:10px; color:var(--vscode-descriptionForeground); font:13px var(--vscode-font-family); background:var(--vscode-editor-background); pointer-events:none; }
.browser-editor-paused.is-visible { display:flex; }
.browser-editor-paused .codicon { font-size:22px; }
.browser-editor-find { display:none; flex:0 0 auto; align-items:center; gap:6px; padding:4px 10px; background:var(--vscode-editorWidget-background); border-top:1px solid var(--vscode-panel-border); border-bottom:1px solid var(--vscode-panel-border); }
.browser-editor-find.is-visible { display:flex; }
.browser-editor-find-input { flex:1 1 auto; min-width:120px; height:24px; padding:0 8px; border:1px solid var(--vscode-input-border,transparent); border-radius:4px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); font:12px var(--vscode-font-family); outline:none; }
.browser-editor-find-input:focus { border-color:var(--vscode-focusBorder); box-shadow:0 0 0 1px var(--vscode-focusBorder); }
.browser-editor-find-count { flex:0 0 auto; min-width:60px; font-size:11px; color:var(--vscode-descriptionForeground); user-select:none; }
.browser-editor-find-btn { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; padding:0; border:none; border-radius:4px; background:transparent; color:var(--vscode-icon-foreground,var(--vscode-foreground)); cursor:pointer; }
.browser-editor-find-btn:hover:not(:disabled) { background:var(--vscode-toolbar-hoverBackground); }
.browser-editor-find-btn:disabled { opacity:.4; cursor:default; }
.browser-editor-find-btn .codicon { font-size:13px; line-height:1; }
.browser-editor-lock-badge { display:none; align-items:center; gap:6px; flex:0 0 auto; height:26px; padding:0 10px; margin-left:4px; border:1px solid var(--vscode-inputOption-activeBorder,var(--vscode-focusBorder)); border-radius:13px; background:var(--vscode-inputOption-activeBackground,transparent); color:var(--vscode-inputOption-activeForeground,var(--vscode-foreground)); font:11px/1 var(--vscode-font-family); cursor:pointer; white-space:nowrap; }
.browser-editor-lock-badge.is-visible { display:inline-flex; }
.browser-editor-lock-badge:hover { filter:brightness(1.08); }
.browser-editor-lock-badge .codicon { font-size:12px; line-height:1; }
`;

/**
 * Hosts the interactive native browser inside an editor pane. The actual web content
 * lives in a `WebContentsView` owned by the main process; this pane only renders the
 * toolbar (back/forward/reload/home/url/pick/open-external) and a placeholder content div
 * whose viewport-relative bounds are sent to the main process so it can position the
 * `WebContentsView` directly on top of it.
 */
export class BrowserEditorPane extends EditorPane {

	public static readonly ID = 'workbench.editors.browserEditor';

	private container!: HTMLElement;
	private toolbar!: HTMLElement;
	private urlInput!: HTMLInputElement;
	private content!: HTMLElement;
	private pausedOverlay!: HTMLElement;
	private loadingBar!: HTMLElement;
	private sslIcon!: HTMLElement;
	private faviconEl!: HTMLImageElement;
	private findBar!: HTMLElement;
	private findInput!: HTMLInputElement;
	private findCount!: HTMLElement;
	private zoomLabel!: HTMLElement;
	private zoomBtn!: HTMLButtonElement;
	private takeControlBtn!: HTMLButtonElement;
	private browserActiveKey: IContextKey<boolean>;

	private readonly paneListeners = this._register(new DisposableStore());
	private readonly viewListeners = this._register(new DisposableStore());

	private _pickerActive = false;
	private _disposed = false;
	private _urlInputFocused = false;
	private _isLoading = false;
	private _findVisible = false;
	private _zoomFactor = 1;
	private resizeObserver: ResizeObserver | undefined;
	private layoutScheduled = false;
	private lastSentBounds: IBrowserViewBounds | undefined;

	private readonly _onDidPickerActiveChange = this._register(new Emitter<boolean>());
	readonly onDidPickerActiveChange: Event<boolean> = this._onDidPickerActiveChange.event;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IBrowserViewService private readonly browserViewService: IBrowserViewService,
		@ICommandService private readonly commandService: ICommandService,
		@IOpenerService private readonly openerService: IOpenerService,
		@INotificationService private readonly notificationService: INotificationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
	@IEditorService private readonly editorService: IEditorService,
	@IContextKeyService contextKeyService: IContextKeyService,
) {
	super(BrowserEditorPane.ID, group, telemetryService, themeService, storageService);
	this.browserActiveKey = BrowserEditorActiveContext.bindTo(contextKeyService);
}

	protected createEditor(parent: HTMLElement): void {
		this.ensureStyles(parent.ownerDocument);

		this.container = append(parent, $('.browser-editor-pane'));
		this.toolbar = append(this.container, $('.browser-editor-toolbar'));

		const makeBtn = (icon: HTMLElement, title: string, onClick: () => void, modifier?: string): HTMLButtonElement => {
			const btn = append(this.toolbar, $(`button.browser-editor-btn${modifier ? '.' + modifier : ''}`)) as HTMLButtonElement;
			btn.type = 'button';
			btn.title = title;
			btn.setAttribute('aria-label', title);
			append(btn, icon);
			// Keep native-view focus off while operating chrome so the click lands on the button.
			btn.addEventListener('mousedown', () => this.blurBrowser());
			btn.addEventListener('click', onClick);
			return btn;
		};

		this.backBtn = makeBtn(renderIcon(Codicon.arrowLeft), 'Back (Alt+Left)', () => this.goBack());
		this.forwardBtn = makeBtn(renderIcon(Codicon.arrowRight), 'Forward (Alt+Right)', () => this.goForward());
		this.reloadBtn = makeBtn(renderIcon(Codicon.refresh), 'Reload (Cmd+R)', () => this.toggleReloadOrStop());
		makeBtn(renderIcon(Codicon.home), 'Home', () => this.goHome());

		const address = append(this.toolbar, $('.browser-editor-address'));
		this.sslIcon = append(address, $('span.browser-editor-ssl.codicon.codicon-lock')) as HTMLElement;
		this.sslIcon.title = 'Connection security';

		this.faviconEl = append(address, $('img.browser-editor-favicon')) as HTMLImageElement;
		this.faviconEl.alt = '';
		this.faviconEl.addEventListener('error', () => {
			this.faviconEl.classList.remove('is-present');
		});

		this.urlInput = append(address, $('input.browser-editor-url')) as HTMLInputElement;
		this.urlInput.type = 'text';
		this.urlInput.placeholder = 'Search or enter address';
		this.urlInput.setAttribute('aria-label', 'Address and search bar');
		this.urlInput.spellcheck = false;
		this.urlInput.autocapitalize = 'off';
		// Select-all on focus (browser convention) needs care for mouse focus: the browser
		// places the caret on mouseup, which would immediately clear a selection made in the
		// focus handler — so for clicks the select-all runs on mouseup instead (and only if
		// the user clicked rather than drag-selected).
		let selectAllOnMouseUp = false;
		this.urlInput.addEventListener('mousedown', () => {
			this.blurBrowser();
			selectAllOnMouseUp = this.urlInput.ownerDocument.activeElement !== this.urlInput;
		});
		this.urlInput.addEventListener('mouseup', () => {
			if (selectAllOnMouseUp) {
				selectAllOnMouseUp = false;
				if (this.urlInput.selectionStart === this.urlInput.selectionEnd) {
					this.urlInput.select();
				}
			}
		});
		this.urlInput.addEventListener('focus', () => {
			this._urlInputFocused = true;
			this.blurBrowser();
			if (!selectAllOnMouseUp) {
				// Keyboard/programmatic focus: select immediately.
				this.urlInput.select();
			}
		});
		this.urlInput.addEventListener('blur', () => {
			this._urlInputFocused = false;
			selectAllOnMouseUp = false;
		});
		this.urlInput.addEventListener('keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.navigateFromUrlInput();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				const current = this.currentInput();
				if (current) {
					this.urlInput.value = current.url;
				}
				this.urlInput.blur();
				this.focusBrowser();
			}
		});

		// Zoom indicator: a single compact pill showing the current zoom. Click resets to 100%.
		// The real zoom interaction is the keyboard (Cmd +/- / Cmd+0), matching real browsers
		// where zoom lives in the menu/keyboard, not as prominent toolbar chrome.
		const zoomBtn = append(this.toolbar, $('button.browser-editor-btn.browser-editor-zoom-pill')) as HTMLButtonElement;
		zoomBtn.type = 'button';
		zoomBtn.title = 'Zoom: 100% (click to reset, Cmd +/- to zoom)';
		zoomBtn.setAttribute('aria-label', 'Zoom level');
		this.zoomLabel = append(zoomBtn, $('span.browser-editor-zoom-label'));
		this.zoomLabel.textContent = '100%';
		zoomBtn.addEventListener('mousedown', () => this.blurBrowser());
		zoomBtn.addEventListener('click', () => this.setZoom(1));
		this.zoomBtn = zoomBtn;

		this.pickBtn = makeBtn(renderIcon(Codicon.target), 'Pick element for chat', () => this.togglePicker());
		makeBtn(renderIcon(Codicon.linkExternal), 'Open in external browser', () => this.openExternal());

		// Shown while an agent holds browser_lock on this tab. Lives in the
		// toolbar chrome (above the native WebContentsView) so it stays clickable.
		this.takeControlBtn = append(this.toolbar, $('button.browser-editor-lock-badge')) as HTMLButtonElement;
		this.takeControlBtn.type = 'button';
		this.takeControlBtn.title = 'Agent is controlling this tab. Click to unlock and take over.';
		this.takeControlBtn.setAttribute('aria-label', 'Take control of browser from agent');
		append(this.takeControlBtn, renderIcon(Codicon.lock));
		append(this.takeControlBtn, $('span')).textContent = 'Take Control';
		this.takeControlBtn.addEventListener('mousedown', () => this.blurBrowser());
		this.takeControlBtn.addEventListener('click', () => this.takeAutomationControl());

		this.loadingBar = append(this.toolbar, $('.browser-editor-loading')) as HTMLElement;

		// Find-in-page bar (Cmd+F to open, Esc to close). Sits between toolbar and content.
		this.findBar = append(this.container, $('.browser-editor-find'));
		this.findInput = append(this.findBar, $('input.browser-editor-find-input')) as HTMLInputElement;
		this.findInput.type = 'text';
		this.findInput.placeholder = 'Find in page';
		this.findInput.setAttribute('aria-label', 'Find in page');
		this.findInput.spellcheck = false;
		this.findInput.addEventListener('input', () => this.onFindInput());
		this.findInput.addEventListener('keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.findNext(e.shiftKey);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				this.closeFind();
			}
		});
		this.findCount = append(this.findBar, $('.browser-editor-find-count'));
		this.findCount.textContent = '';
		const findPrevBtn = append(this.findBar, $('button.browser-editor-find-btn')) as HTMLButtonElement;
		findPrevBtn.type = 'button';
		findPrevBtn.title = 'Previous match (Shift+Enter)';
		findPrevBtn.setAttribute('aria-label', 'Previous match');
		append(findPrevBtn, renderIcon(Codicon.arrowUp));
		findPrevBtn.addEventListener('click', () => this.findNext(true));
		const findNextBtn = append(this.findBar, $('button.browser-editor-find-btn')) as HTMLButtonElement;
		findNextBtn.type = 'button';
		findNextBtn.title = 'Next match (Enter)';
		findNextBtn.setAttribute('aria-label', 'Next match');
		append(findNextBtn, renderIcon(Codicon.arrowDown));
		findNextBtn.addEventListener('click', () => this.findNext(false));
		const findCloseBtn = append(this.findBar, $('button.browser-editor-find-btn')) as HTMLButtonElement;
		findCloseBtn.type = 'button';
		findCloseBtn.title = 'Close (Escape)';
		findCloseBtn.setAttribute('aria-label', 'Close find');
		append(findCloseBtn, renderIcon(Codicon.close));
		findCloseBtn.addEventListener('click', () => this.closeFind());

		this.content = append(this.container, $('.browser-editor-content'));
		this.content.addEventListener('mousedown', () => {
			// When the native view is visible, route the click into the page.
			this.focusBrowser();
		});

		this.pausedOverlay = append(this.content, $('.browser-editor-paused'));
		append(this.pausedOverlay, $(`span.codicon.codicon-${Codicon.debugPause.id}`));
		append(this.pausedOverlay, $('span')).textContent = 'Browser paused';

		if (typeof ResizeObserver !== 'undefined') {
			this.resizeObserver = new ResizeObserver(() => this.scheduleLayoutBrowserView());
			this.resizeObserver.observe(this.content);
		}

		this.paneListeners.add(Event.fromDOMEventEmitter(mainWindow, 'resize')(() => this.scheduleLayoutBrowserView()));
		this.paneListeners.add(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('window.zoomLevel')) {
				this.lastSentBounds = undefined;
				this.scheduleLayoutBrowserView();
			}
		}));
		// Per-window zoom (Cmd +/-) does not necessarily change the setting — track it too,
		// since the CSS px → DIP conversion of the native view bounds depends on the factor.
		this.paneListeners.add(onDidChangeZoomLevel(() => {
			this.lastSentBounds = undefined;
			this.scheduleLayoutBrowserView();
		}));
		this.paneListeners.add(this.themeService.onDidColorThemeChange(() => this.syncBrowserTheme()));

		// Pane-scoped keyboard shortcuts (Cmd/Ctrl based, matching platform conventions).
		// These only fire when focus is inside the browser pane, so they don't clash with
		// global editor keybindings. The native page gets first crack at keystrokes when it
		// has focus, so these effectively act on chrome-focused state.
		this.paneListeners.add(Event.fromDOMEventEmitter(this.container, 'keydown')((e: unknown) => {
			const ev = e as KeyboardEvent;
			const mod = ev.metaKey || ev.ctrlKey;
			if (!mod) {
				// Alt+Left / Alt+Right for back/forward (browser convention).
				if (ev.altKey && ev.key === 'ArrowLeft') {
					ev.preventDefault();
					this.goBack();
					return;
				}
				if (ev.altKey && ev.key === 'ArrowRight') {
					ev.preventDefault();
					this.goForward();
					return;
				}
				return;
			}
			switch (ev.key) {
				case 'r':
					ev.preventDefault();
					this.toggleReloadOrStop();
					break;
				case 'l':
					ev.preventDefault();
					this.urlInput.focus();
					this.urlInput.select();
					break;
				case 'f':
					ev.preventDefault();
					this.openFind();
					break;
				case 'g':
					ev.preventDefault();
					this.findNext(ev.shiftKey);
					break;
				case '=':
				case '+':
					ev.preventDefault();
					this.zoomBy(0.1);
					break;
				case '-':
					ev.preventDefault();
					this.zoomBy(-0.1);
					break;
				case '0':
					ev.preventDefault();
					this.setZoom(1);
					break;
			}
		}));
	}

	/** Injects the pane stylesheet once per document (handles aux windows). */
	private ensureStyles(doc: Document): void {
		if (doc.getElementById(BROWSER_EDITOR_STYLES_ID)) {
			return;
		}
		const style = doc.createElement('style');
		style.id = BROWSER_EDITOR_STYLES_ID;
		style.textContent = BROWSER_EDITOR_STYLES;
		doc.head.appendChild(style);
	}

	private backBtn!: HTMLButtonElement;
	private forwardBtn!: HTMLButtonElement;
	private reloadBtn!: HTMLButtonElement;
	private pickBtn!: HTMLButtonElement;

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof BrowserEditorInput)) {
			return;
		}
		if (token.isCancellationRequested) {
			return;
		}

		this.viewListeners.clear();
		this.urlInput.value = input.url;
		this.updateSslIcon(input.url);
		this.updateFavicon(input.favicon);
		this.setLoadingState(false);
		this.closeFind();

		const id = input.id;
		this.viewListeners.add(this.browserViewService.onDidNavigate(e => {
			if (e.id !== id) { return; }
			if (!this._urlInputFocused) {
				this.urlInput.value = e.url;
			}
			input.setUrl(e.url);
			this.updateSslIcon(e.url);
			this.updateNavButtons(e.canGoBack, e.canGoForward);
			this.scheduleLayoutBrowserView();
			// The injected color-scheme hint is per-document — re-apply for the new page.
			this.syncBrowserTheme();
		}));
		this.viewListeners.add(this.browserViewService.onDidTitleChange(e => {
			if (e.id !== id) { return; }
			input.setTitle(e.title);
		}));
		this.viewListeners.add(this.browserViewService.onDidFaviconChange(e => {
			if (e.id !== id) { return; }
			input.setFavicon(e.favicon);
			this.updateFavicon(e.favicon);
		}));
		this.viewListeners.add(this.browserViewService.onDidLoadingStateChange(e => {
			if (e.id !== id) { return; }
			this.setLoadingState(e.isLoading);
		}));
		this.viewListeners.add(this.browserViewService.onDidFocusView(e => {
			if (e !== id) { return; }
			// A click into the native page never reaches the workbench DOM — activate the
			// owning group so tab highlighting and editor-scoped commands track reality.
			// (activateGroup does not move DOM focus, so this cannot steal focus back.)
			if (this.editorGroupsService.activeGroup !== this.group) {
				this.editorGroupsService.activateGroup(this.group);
			}
		// The page now has focus — route menu shortcuts (Cmd+A/C/F/…) to it, not the menu bar.
		this.setMenuShortcutsEnabled(true);
		this.browserActiveKey.set(true);
	}));
		this.viewListeners.add(this.browserViewService.onDidClose(e => {
			if (e !== id) { return; }
			this.viewListeners.clear();
		}));
		// Browser-chrome shortcuts (Cmd+F/R/L/±/0, Alt+←/→) typed while the page has focus are
		// intercepted in the main process (the WebContentsView's key events never reach this
		// renderer's DOM) and forwarded here. Run the matching pane action.
		this.viewListeners.add(this.browserViewService.onDidBrowserShortcut(e => {
			if (e.id !== id) { return; }
			this.runBrowserShortcut(e.action);
		}));
		// Agent lock/unlock: show the Take Control badge in the toolbar chrome.
		this.viewListeners.add(this.browserViewService.onDidAutomationLockChange(e => {
			if (e.id !== id) { return; }
			this.setAutomationLockedUi(e.locked);
		}));
		// Restore lock badge if this tab was already locked when the pane remounted.
		this.browserViewService.isAutomationLocked(id).then(locked => {
			if (!this._disposed && this.currentInput()?.id === id) {
				this.setAutomationLockedUi(locked);
			}
		}).catch(() => { /* ignore */ });

		// Ensure the content area is laid out before open() so initial bounds are non-zero.
		this.layoutBrowserView();
		await new Promise<void>(resolve => {
			mainWindow.requestAnimationFrame(() => mainWindow.requestAnimationFrame(() => resolve()));
		});
		// Fall back to a usable default when the content area is still zero-size (new window,
		// mid-split, pane just created) so the native view gets real bounds and can composite
		// a first frame. The real bounds arrive via scheduleLayoutBrowserView() below; without
		// a fallback the page loads hidden at zero size and stays blank until a manual reload.
		const realBounds = this.contentBounds();
		const openBounds = realBounds ?? this.estimatedOpenBounds();
		// When the content area is not laid out yet, open hidden so the native view does
		// not flash at a guessed (0,0) full-window rect on top of the workbench.
		let state: INavigationState;
		try {
			state = await this.browserViewService.open(id, {
				url: input.url,
				homeUrl: input.homeUrl,
				bounds: openBounds,
				keepHidden: !realBounds,
			});
		} catch (e) {
			// An unguarded rejection here (e.g. the main-process channel racing service
			// init during startup restore) used to escape setInput entirely. Fail this one
			// tab, not the editor restore around it.
			if (!token.isCancellationRequested && this.currentInput()?.id === id) {
				this.notificationService.error(`Failed to open browser tab: ${e instanceof Error ? e.message : String(e)}`);
			}
			return;
		}
		if (token.isCancellationRequested || this.currentInput()?.id !== id) {
			// The user already switched to another editor while open() was in flight; open()
			// may have sized the view, so hide it or it floats on top of whatever replaced
			// this tab — the classic "blank white window" restore race.
			this.browserViewService.setVisible(id, false).catch(() => { /* ignore */ });
			return;
		}
		this.applyNavigationState(state);
		this.lastSentBounds = undefined;
		this.scheduleLayoutBrowserView();
		// Wait one frame so layoutBrowserView can apply real bounds before revealing.
		await new Promise<void>(resolve => {
			mainWindow.requestAnimationFrame(() => mainWindow.requestAnimationFrame(() => resolve()));
		});
		if (token.isCancellationRequested || this.currentInput()?.id !== id) {
			this.browserViewService.setVisible(id, false).catch(() => { /* ignore */ });
			return;
		}
		if (!this.isAuthoritativeForNativeView()) {
			this.browserViewService.setVisible(id, false).catch(() => { /* ignore */ });
			// During workspace restore the editor grid may not be laid out yet — retry
			// once layout settles instead of leaving a restored browser tab permanently hidden.
			const retryReveal = () => {
				if (token.isCancellationRequested || this.currentInput()?.id !== id) {
					return;
				}
				void this.pushBoundsAndReveal().then(ok => {
					if (ok) {
						this.syncBrowserTheme();
						mainWindow.requestAnimationFrame(() => this.reevaluateOverlayVisibility());
					}
				});
			};
			mainWindow.requestAnimationFrame(() => mainWindow.requestAnimationFrame(retryReveal));
			return;
		}
		void this.pushBoundsAndReveal().then(ok => {
			if (!ok) {
				return;
			}
			this.syncBrowserTheme();
			// Defer overlay pass so setVisible(true) is not immediately undone by a stale overlay flag.
			mainWindow.requestAnimationFrame(() => this.reevaluateOverlayVisibility());
		});
	}

	/**
	 * Tells the overlay manager to re-run its visibility pass now that this pane has force-shown
	 * its native view, so it is re-hidden immediately if an overlay (e.g. a toast) is already up.
	 */
	private reevaluateOverlayVisibility(): void {
		// NOTE: `Event` is shadowed in this module by the VS Code event namespace import, so use
		// `CustomEvent` (the DOM global) to dispatch the plain notification.
		mainWindow.document.dispatchEvent(new CustomEvent(BROWSER_VIEW_REEVALUATE_VISIBILITY_EVENT));
	}

	/** Shows or hides the placeholder when the native view is suppressed (e.g. by an overlay). */
	setNativeViewPaused(paused: boolean): void {
		this.pausedOverlay?.classList.toggle('is-visible', paused);
		// When an overlay suppresses the native view, the page can no longer receive keystrokes,
		// so release menu-shortcut routing back to the workbench. The pane's own focus/blur
		// handlers re-enable it when the page regains focus.
		this.setMenuShortcutsEnabled(!paused);
	}

	override clearInput(): void {
		const input = this.input;
		if (input instanceof BrowserEditorInput) {
			this.setMenuShortcutsEnabled(false);
			this.browserActiveKey.set(false);
			this.browserViewService.teardownPicker(input.id).catch(() => { /* ignore */ });
			this.browserViewService.setVisible(input.id, false).catch(() => { /* ignore */ });
		}
		this.setAutomationLockedUi(false);
		this.setNativeViewPaused(false);
		this.closeFind();
		this.setLoadingState(false);
		this.urlInput.value = '';
		this.updateFavicon(null);
		this.viewListeners.clear();
		super.clearInput();
	}

	protected override setEditorVisible(visible: boolean): void {
		const input = this.input;
		if (input instanceof BrowserEditorInput) {
		if (visible) {
		if (!this.isAuthoritativeForNativeView()) {
			this.browserViewService.setVisible(input.id, false).catch(() => { /* ignore */ });
			return;
		}
		this.browserActiveKey.set(true);
		this.lastSentBounds = undefined;
		void this.pushBoundsAndReveal().then(ok => {
			if (ok) {
				mainWindow.requestAnimationFrame(() => {
					this.scheduleLayoutBrowserView();
					this.reevaluateOverlayVisibility();
				});
			}
		});
		} else {
			this.setMenuShortcutsEnabled(false);
			this.browserActiveKey.set(false);
			this.browserViewService.teardownPicker(input.id).catch(() => { /* ignore */ });
			this.browserViewService.setVisible(input.id, false).catch(() => { /* ignore */ });
		}
		}
	}

	override layout(dimension: { width: number; height: number }): void {
		if (this.container) {
			this.container.style.width = `${dimension.width}px`;
			this.container.style.height = `${dimension.height}px`;
		}
		this.scheduleLayoutBrowserView();
	}

	private scheduleLayoutBrowserView(): void {
		if (this.layoutScheduled) {
			return;
		}
		this.layoutScheduled = true;
		mainWindow.requestAnimationFrame(() => {
			this.layoutScheduled = false;
			this.layoutBrowserView();
		});
	}

	private layoutBrowserView(): void {
		const input = this.input;
		if (!(input instanceof BrowserEditorInput) || !this.content) {
			return;
		}
		const bounds = this.contentBounds();
		if (!bounds) {
			return;
		}
		if (this.lastSentBounds
			&& Math.round(this.lastSentBounds.x) === Math.round(bounds.x)
			&& Math.round(this.lastSentBounds.y) === Math.round(bounds.y)
			&& Math.round(this.lastSentBounds.width) === Math.round(bounds.width)
			&& Math.round(this.lastSentBounds.height) === Math.round(bounds.height)) {
			return;
		}
		this.lastSentBounds = bounds;
		this.browserViewService.setBounds(input.id, bounds).catch(() => { /* ignore layout races */ });
	}

	/** Viewport-relative bounds of the web-content area (used by the overlay manager for overlap tests). */
	getContentBounds(): IBrowserViewBounds | undefined {
		return this.contentBounds();
	}

	/** True when this pane owns the globally active browser tab and the content area is laid out. */
	private isAuthoritativeForNativeView(): boolean {
		const input = this.currentInput();
		if (!input || this.editorService.activeEditor !== input) {
			return false;
		}
		const bounds = this.contentBounds();
		return !!bounds && bounds.width > 0 && bounds.height > 0;
	}

	/**
	 * Push measured content bounds to the main process, then reveal the native view.
	 * Bounds MUST land before setVisible(true) or a stale full-window rect blanks the workbench.
	 */
	private async pushBoundsAndReveal(): Promise<boolean> {
		const input = this.input;
		if (!(input instanceof BrowserEditorInput) || !this.content) {
			return false;
		}
		if (!this.isAuthoritativeForNativeView()) {
			await this.browserViewService.setVisible(input.id, false).catch(() => { /* ignore */ });
			return false;
		}
		const bounds = this.contentBounds();
		if (!bounds) {
			return false;
		}
		this.lastSentBounds = bounds;
		await this.browserViewService.setBounds(input.id, bounds);
		await this.browserViewService.setVisible(input.id, true);
		await this.browserViewService.bringToFront(input.id);
		return true;
	}

	/** Current viewport-relative bounds of the content area, or `undefined` if not laid out yet. */
	private contentBounds(): IBrowserViewBounds | undefined {
		if (!this.content) {
			return undefined;
		}
		const rect = this.content.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) {
			return undefined;
		}
		// During startup restore the content host can momentarily measure as the entire
		// viewport at (0,0). Sending that rect to the main process would position a
		// native WebContentsView over the whole workbench — the white-screen bug.
		const vw = mainWindow.innerWidth;
		const vh = mainWindow.innerHeight;
		if (rect.x <= 8 && rect.y <= 8 && rect.width >= vw * 0.92 && rect.height >= vh * 0.86) {
			return undefined;
		}
		// Sidebar-offset bootstrap rects can slip past the (0,0) check above.
		if (rect.y < 80 && rect.width >= vw * 0.90 && rect.height >= vh * 0.86) {
			return undefined;
		}
		return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
	}

	/**
	 * Best-effort non-zero bounds used when {@link contentBounds} is undefined at `open()` time
	 * (content area not yet laid out). Sizes the view against the editor container or the window
	 * so Chromium can composite a first frame; the real bounds are applied shortly after via
	 * {@link scheduleLayoutBrowserView}. Without this, a brand-new tab loads hidden at zero size
	 * and renders blank until a manual reload.
	 */
	private estimatedOpenBounds(): IBrowserViewBounds {
		const node = this.content ?? this.container;
		if (node) {
			const hostRect = node.getBoundingClientRect();
			if (hostRect.width > 0 && hostRect.height > 0) {
				const vw = mainWindow.innerWidth;
				const vh = mainWindow.innerHeight;
				if (hostRect.x <= 8 && hostRect.y <= 8 && hostRect.width >= vw * 0.92 && hostRect.height >= vh * 0.86) {
					return { x: 0, y: 0, width: 1, height: 1 };
				}
				return { x: hostRect.left, y: hostRect.top, width: hostRect.width, height: hostRect.height };
			}
		}
		// Last-resort fallback: tiny hidden rect at the origin. Never use a large (0,0)
		// viewport — a visible native WebContentsView at that rect covers the workbench.
		return { x: 0, y: 0, width: 1, height: 1 };
	}

	private applyNavigationState(state: INavigationState): void {
		if (!this._urlInputFocused) {
			this.urlInput.value = state.url;
		}
		this.updateSslIcon(state.url);
		this.updateNavButtons(state.canGoBack, state.canGoForward);
		this.setLoadingState(state.isLoading);
		if (state.title) {
			const input = this.input;
			if (input instanceof BrowserEditorInput) {
				input.setTitle(state.title);
			}
		}
	}

	private updateNavButtons(canGoBack: boolean, canGoForward: boolean): void {
		this.backBtn.disabled = !canGoBack;
		this.forwardBtn.disabled = !canGoForward;
	}

	private updateSslIcon(url: string): void {
		const lower = String(url ?? '').toLowerCase();
		const secure = lower.startsWith('https://') && lower.length > 8;
		const insecure = lower.startsWith('http://') && lower.length > 7;
		this.sslIcon.classList.toggle('is-secure', secure);
		this.sslIcon.classList.toggle('is-insecure', insecure);
		this.sslIcon.classList.remove('codicon-lock', 'codicon-warning', 'codicon-unlock');
		if (secure) {
			this.sslIcon.classList.add('codicon-lock');
			this.sslIcon.title = 'Secure HTTPS connection';
		} else if (insecure) {
			this.sslIcon.classList.add('codicon-warning');
			this.sslIcon.title = 'Not secure — HTTP connection';
		} else {
			this.sslIcon.classList.add('codicon-lock');
			this.sslIcon.title = 'Connection security';
		}
	}

	private updateFavicon(favicon: string | null | undefined): void {
		if (favicon) {
			this.faviconEl.src = favicon;
			this.faviconEl.classList.add('is-present');
		} else {
			this.faviconEl.classList.remove('is-present');
			this.faviconEl.removeAttribute('src');
		}
	}

	private setLoadingState(isLoading: boolean): void {
		this._isLoading = isLoading;
		this.loadingBar.classList.toggle('is-loading', isLoading);
		// Tint the address bar border while loading for an extra visual cue.
		this.urlInput.parentElement?.classList.toggle('is-loading', isLoading);
		this.reloadBtn.replaceChildren(renderIcon(isLoading ? Codicon.close : Codicon.refresh));
		this.reloadBtn.title = isLoading ? 'Stop (Cmd+R)' : 'Reload (Cmd+R)';
		this.reloadBtn.setAttribute('aria-label', isLoading ? 'Stop' : 'Reload');
	}

	private currentInput(): BrowserEditorInput | undefined {
		return this.input instanceof BrowserEditorInput ? this.input : undefined;
	}

	private blurBrowser(): void {
		const input = this.currentInput();
		if (input) {
			this.setMenuShortcutsEnabled(false);
			this.browserViewService.blur(input.id).catch(() => { /* ignore */ });
		}
	}

	focusBrowser(): void {
		const input = this.currentInput();
		if (input) {
			this.browserViewService.focus(input.id).catch(() => { /* ignore */ });
			this.setMenuShortcutsEnabled(true);
			this.browserActiveKey.set(true);
		}
	}

	/**
	 * Toggles whether application menu shortcuts (Cmd+A/C/F/…) route to the browser page (true)
	 * or the workbench menu bar (false). Must be enabled when the page has focus so editing and
	 * search shortcuts work inside the page, and disabled when focus returns to the workbench
	 * chrome so the workbench's own shortcuts resume.
	 */
	private setMenuShortcutsEnabled(enabled: boolean): void {
		const input = this.currentInput();
		if (input) {
			this.browserViewService.setIgnoreMenuShortcuts(input.id, enabled).catch(() => { /* ignore */ });
		}
	}

	/**
	 * Runs a browser-chrome shortcut forwarded from the main process (see
	 * `onDidBrowserShortcut`). The action names match the internal `_browserView.*` commands so
	 * the behavior stays identical whether the shortcut is triggered from the keyboard (page has
	 * focus) or from a workbench keybinding (chrome has focus).
	 */
	private runBrowserShortcut(action: BrowserShortcutAction): void {
		switch (action) {
			case 'findInPage': this.openFind(); break;
			case 'closeFindInPage': this.closeFind(); break;
			case 'zoomIn': this.zoomBy(0.1); break;
			case 'zoomOut': this.zoomBy(-0.1); break;
			case 'zoomReset': this.setZoom(1); break;
			case 'reload': this.toggleReloadOrStop(); break;
			case 'focusAddressBar': this.focusAddressBar(); break;
			case 'goBack': this.goBack(); break;
			case 'goForward': this.goForward(); break;
		}
	}

	focusAddressBar(): void {
		this.urlInput.focus();
		this.urlInput.select();
	}

	/** Shows/hides the agent-lock badge in the toolbar chrome. */
	private setAutomationLockedUi(locked: boolean): void {
		this.takeControlBtn?.classList.toggle('is-visible', locked);
	}

	/** Unlocks the tab so the user can interact freely again. */
	private takeAutomationControl(): void {
		const input = this.currentInput();
		if (!input) {
			return;
		}
		this.browserViewService.setAutomationLocked(input.id, false).then(() => {
			this.setAutomationLockedUi(false);
			this.notificationService.info('You have control of the browser tab.');
		}).catch(err => {
			this.notificationService.error(`Failed to unlock browser tab: ${err instanceof Error ? err.message : String(err)}`);
		});
	}

	async zoomBy(delta: number): Promise<void> {
		const input = this.currentInput();
		if (!input) { return; }
		const next = Math.round((this._zoomFactor + delta) * 100) / 100;
		await this.setZoom(next);
	}

	async setZoom(zoom: number): Promise<void> {
		const input = this.currentInput();
		if (!input) { return; }
		const clamped = Math.max(0.25, Math.min(5, zoom));
		this._zoomFactor = clamped;
		const pct = Math.round(clamped * 100);
		this.zoomLabel.textContent = `${pct}%`;
		const changed = Math.abs(clamped - 1) > 0.001;
		this.zoomBtn.classList.toggle('is-changed', changed);
		this.zoomBtn.title = changed
			? `Zoom: ${pct}% (click to reset, Cmd +/- to zoom)`
			: 'Zoom (Cmd +/- to zoom, Cmd+0 to reset)';
		try {
			await this.browserViewService.setZoomFactor(input.id, clamped);
		} catch { /* ignore */ }
	}

	openFind(): void {
		this._findVisible = true;
		this.findBar.classList.add('is-visible');
		this.findInput.value = '';
		this.findCount.textContent = '';
		this.findInput.focus();
	}

	closeFind(): void {
		if (!this._findVisible) { return; }
		this._findVisible = false;
		this.findBar.classList.remove('is-visible');
		this.findInput.value = '';
		this.findCount.textContent = '';
		const input = this.currentInput();
		if (input) {
			this.browserViewService.stopFindInPage(input.id).catch(() => { /* ignore */ });
		}
		this.focusBrowser();
	}

	private onFindInput(): void {
		const input = this.currentInput();
		if (!input) { return; }
		const query = this.findInput.value;
		if (!query) {
			this.browserViewService.stopFindInPage(input.id).catch(() => { /* ignore */ });
			this.findCount.textContent = '';
			return;
		}
		this.browserViewService.findInPage(input.id, query).catch(() => { /* ignore */ });
	}

	private async findNext(backward: boolean): Promise<void> {
		const input = this.currentInput();
		if (!input || !this._findVisible) { return; }
		const query = this.findInput.value;
		if (!query) { return; }
		try {
			await this.browserViewService.findInPage(input.id, query, { forward: !backward });
		} catch { /* ignore */ }
	}

	override focus(): void {
		super.focus();
		// Route keyboard focus into the live page (matching the webview editor and a real
		// browser) so typing works immediately, unless the user is editing the address bar.
		if (!this._urlInputFocused) {
			this.focusBrowser();
		}
	}

	async goBack(): Promise<void> {
		const input = this.currentInput();
		if (!input) { return; }
		try {
			const state = await this.browserViewService.goBack(input.id);
			this.applyNavigationState(state);
		} catch (e) {
			this.notificationService.error(e instanceof Error ? e.message : String(e));
		}
	}

	async goForward(): Promise<void> {
		const input = this.currentInput();
		if (!input) { return; }
		try {
			const state = await this.browserViewService.goForward(input.id);
			this.applyNavigationState(state);
		} catch (e) {
			this.notificationService.error(e instanceof Error ? e.message : String(e));
		}
	}

	async toggleReloadOrStop(): Promise<void> {
		const input = this.currentInput();
		if (!input) { return; }
		try {
			if (this._isLoading) {
				const state = await this.browserViewService.stop(input.id);
				this.applyNavigationState(state);
			} else {
				this.setLoadingState(true);
				await this.browserViewService.reload(input.id);
			}
		} catch (e) {
			this.notificationService.error(e instanceof Error ? e.message : String(e));
		}
	}

	private async goHome(): Promise<void> {
		const input = this.currentInput();
		if (!input) { return; }
		try {
			const state = await this.browserViewService.navigate(input.id, input.homeUrl);
			this.applyNavigationState(state);
		} catch (e) {
			this.notificationService.error(e instanceof Error ? e.message : String(e));
		}
	}

	private async navigateFromUrlInput(): Promise<void> {
		const input = this.currentInput();
		if (!input) { return; }
		const raw = this.urlInput.value.trim();
		if (!raw) { return; }
		const url = resolveBrowserNavigationTarget(raw);
		// Blur the address bar before navigating so it re-syncs to the resolved/committed URL
		// (a bare search term becomes a full search URL) and keyboard focus can return to the page.
		this.urlInput.blur();
		try {
			const state = await this.browserViewService.navigate(input.id, url);
			this.applyNavigationState(state);
			this.focusBrowser();
		} catch (e) {
			this.notificationService.error(e instanceof Error ? e.message : String(e));
		}
	}

	private async openExternal(): Promise<void> {
		const input = this.currentInput();
		if (!input) { return; }
		try {
			await this.openerService.open(URI.parse(input.url), { openExternal: true });
		} catch (e) {
			this.notificationService.error(e instanceof Error ? e.message : String(e));
		}
	}

	private async togglePicker(): Promise<void> {
		const input = this.currentInput();
		if (!input) { return; }
		if (this._pickerActive) {
			await this.browserViewService.teardownPicker(input.id);
			this.setPickerActive(false);
			return;
		}
		this.setPickerActive(true);
		try {
			const result = await this.browserViewService.runPicker(input.id);
			if (result.picked && result.data) {
				await this.dispatchPickToChat(result.data);
			}
		} catch (e) {
			this.notificationService.error(e instanceof Error ? e.message : String(e));
		} finally {
			this.setPickerActive(false);
		}
	}

	private setPickerActive(active: boolean): void {
		this._pickerActive = active;
		this.pickBtn.classList.toggle('is-active', active);
		this._onDidPickerActiveChange.fire(active);
	}

	private async dispatchPickToChat(data: IElementPickData): Promise<void> {
		let screenshot: string | null = null;
		try {
			const input = this.currentInput();
			if (input) {
				screenshot = await this.browserViewService.screenshot(input.id);
			}
		} catch { /* screenshot is best-effort */ }

		const payload = {
			type: 'BrowserElement',
			pageUrl: data.pageUrl,
			selector: data.selector,
			selectorChain: data.selectorChain,
			elementData: data.elementData,
			screenshot,
			timestamp: Date.now(),
		};

		try {
			await this.commandService.executeCommand('void.addBrowserElementSelection', payload);
		} catch (e) {
			this.notificationService.error(`Failed to add element to chat selections: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private syncBrowserTheme(): void {
		const input = this.currentInput();
		if (!input) {
			return;
		}
		const isDark = this.themeService.getColorTheme().type === ColorScheme.DARK;
		const scheme = isDark ? 'dark' : 'light';
		this.browserViewService.executeJavaScript(input.id, `(() => {
			try { document.documentElement.style.colorScheme = ${JSON.stringify(scheme)}; } catch {}
			return true;
		})()`).catch(() => { /* ignore */ });
	}

	getPickerActive(): boolean {
		return this._pickerActive;
	}

	relayout(): void {
		this.lastSentBounds = undefined;
		this.scheduleLayoutBrowserView();
	}

	/**
	 * Safely reveal this pane's native browser view. Used by the overlay manager
	 * when an overlay (toast/menu/quick input) dismisses and the page must be
	 * re-shown. Delegates through the pane so the same authority + bounds guards
	 * that protect `setInput`/`setEditorVisible` run here too — the overlay
	 * manager must NEVER call `setVisible(true)` directly, because a view parked
	 * at stale full-window bounds would blank the entire workbench. Returns true
	 * when the view was actually shown, false when it was suppressed.
	 */
	revealNativeView(): boolean {
		const input = this.input;
		if (!(input instanceof BrowserEditorInput)) {
			return false;
		}
		if (!this.isAuthoritativeForNativeView()) {
			// Not the active editor, or the content area isn't laid out yet.
			// Showing the native view now would either float over the wrong tab
			// or paint at a guessed rect — keep it hidden.
			this.browserViewService.setVisible(input.id, false).catch(() => { /* ignore */ });
			return false;
		}
		this.lastSentBounds = undefined;
		void this.pushBoundsAndReveal();
		return true;
	}

	override dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this.resizeObserver?.disconnect();
	// Release menu-shortcut routing back to the workbench menu bar before the pane goes away.
	this.setMenuShortcutsEnabled(false);
	this.browserActiveKey.set(false);
		// The backing WebContentsView is owned by BrowserViewOverlayManager (closed on input dispose),
		// NOT here — a single pane instance is shared by every editor in the group.
		super.dispose();
	}
}
