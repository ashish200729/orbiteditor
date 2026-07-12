/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IBrowserViewBounds, IBrowserViewService } from '../../../../platform/browserView/common/browserView.js';
import { BROWSER_VIEW_REEVALUATE_VISIBILITY_EVENT, BrowserEditorPane } from './browserEditorPane.js';
import { BrowserEditorInput } from './browserEditorInput.js';

/**
 * Mirrors `HISTORY_DROPDOWN_VISIBILITY_EVENT` in `contrib/orbit/browser/historyDropdownService.ts`.
 * Declared as a literal here to avoid a cross-contribution import; the history dropdown is a
 * hand-rolled fixed-position overlay that bypasses every overlay service, so it announces its
 * visibility on `document` instead.
 */
const HISTORY_DROPDOWN_VISIBILITY_EVENT = 'void-history-dropdown-visibility-changed';

const NOTIFICATION_TOASTS_VISIBLE_KEY = 'notificationToastsVisible';
const NOTIFICATION_TOASTS_KEY_SET = new Set([NOTIFICATION_TOASTS_VISIBLE_KEY]);

type OverlaySource = 'contextView' | 'quickInput' | 'toasts' | 'historyDropdown';

/**
 * Live region covered by an active overlay: `'all'` hides every visible browser pane,
 * a rect getter hides only panes whose web-content area actually overlaps it.
 */
type OverlayRegion = 'all' | (() => DOMRect | undefined);

/**
 * The native `WebContentsView` composites above ALL workbench DOM, so any DOM overlay that
 * can overlap the editor area (context menus and dropdowns via the shared context view,
 * the quick input, notification toasts, the history dropdown) must temporarily hide the
 * browser or it would be invisible yet still swallow clicks.
 *
 * Two deliberate refinements keep this from flickering:
 * - Hovers/tooltips are excluded even though they render through the shared context view —
 *   hiding a full page for every tooltip produced constant blinking (tooltips anchor to
 *   chrome and essentially never overlap the browser content area).
 * - Where the overlay's geometry is knowable, panes are only hidden when the overlay rect
 *   actually intersects their content area, so e.g. a dropdown in the opposite editor group
 *   does not blank the browser.
 *
 * This contribution also owns the backing view's lifetime: it closes the main-process
 * `WebContentsView` when its `BrowserEditorInput` is disposed (the pane instance is shared
 * per editor group and therefore cannot own it).
 */
export class BrowserViewOverlayManager extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.browserViewOverlayManager';

	private readonly activeOverlays = new Map<OverlaySource, OverlayRegion>();
	private readonly trackedInputs = new WeakSet<BrowserEditorInput>();
	private readonly appliedPaused = new WeakMap<BrowserEditorPane, boolean>();
	private overlayUpdateTimer: ReturnType<typeof setTimeout> | undefined;
	private forceNextUpdate = false;
	private resizeSweepTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IQuickInputService quickInputService: IQuickInputService,
		@IEditorService private readonly editorService: IEditorService,
		@IBrowserViewService private readonly browserViewService: IBrowserViewService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
	) {
		super();

		// Context menus, select boxes, action dropdowns, breadcrumb pickers etc. all render
		// through the single shared ContextView. Hovers do too — they are filtered out.
		this._register(this.contextViewService.onDidShow(() => this.onContextViewShown()));
		this._register(this.contextViewService.onDidHide(() => this.setOverlay('contextView', undefined)));

		this._register(quickInputService.onShow(() => this.setOverlay('quickInput', 'all')));
		this._register(quickInputService.onHide(() => this.setOverlay('quickInput', undefined)));

		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(NOTIFICATION_TOASTS_KEY_SET)) {
				const visible = !!this.contextKeyService.getContextKeyValue<boolean>(NOTIFICATION_TOASTS_VISIBLE_KEY);
				this.setOverlay('toasts', visible ? () => toastsRect() : undefined);
			}
		}));

		const historyListener = (e: Event) => {
			const visible = !!(e as CustomEvent<boolean>).detail;
			this.setOverlay('historyDropdown', visible ? 'all' : undefined);
		};
		document.addEventListener(HISTORY_DROPDOWN_VISIBILITY_EVENT, historyListener);
		this._register(toDisposable(() => document.removeEventListener(HISTORY_DROPDOWN_VISIBILITY_EVENT, historyListener)));

		// A browser pane force-shows its view on open/reveal; re-apply the overlay state on top.
		const reevaluateListener = () => {
			this.forceNextUpdate = true;
			this.updateVisibility();
		};
		document.addEventListener(BROWSER_VIEW_REEVALUATE_VISIBILITY_EVENT, reevaluateListener);
		this._register(toDisposable(() => document.removeEventListener(BROWSER_VIEW_REEVALUATE_VISIBILITY_EVENT, reevaluateListener)));

		this._register(this.editorService.onDidEditorsChange(() => this.trackBrowserInputs()));
		this.trackBrowserInputs();

		// Safety net: a background browser tab's native view must never stay visible
		// after restore races (setInput in flight while the active editor changes).
		this._register(this.editorService.onDidActiveEditorChange(() => this.hideInactiveBrowserViews()));
		this.hideInactiveBrowserViews();
		this.scheduleRestoreVisibilitySweeps();

		this._register(addDisposableListener(mainWindow, 'resize', () => this.scheduleResizeSweep()));

		this._register(toDisposable(() => {
			if (this.overlayUpdateTimer) {
				clearTimeout(this.overlayUpdateTimer);
				this.overlayUpdateTimer = undefined;
			}
			if (this.resizeSweepTimer) {
				clearTimeout(this.resizeSweepTimer);
				this.resizeSweepTimer = undefined;
			}
		}));
	}

	/** Re-hide background browser tabs during the first seconds after restore. */
	private scheduleRestoreVisibilitySweeps(): void {
		void this.lifecycleService.when(LifecyclePhase.Restored).then(() => {
			const sweep = () => this.hideInactiveBrowserViews();
			sweep();
			mainWindow.requestAnimationFrame(() => {
				sweep();
				setTimeout(sweep, 100);
				setTimeout(sweep, 500);
				setTimeout(sweep, 2000);
				setTimeout(sweep, 5000);
			});
		});
	}

	private scheduleResizeSweep(): void {
		if (this.resizeSweepTimer) {
			clearTimeout(this.resizeSweepTimer);
		}
		this.resizeSweepTimer = setTimeout(() => {
			this.resizeSweepTimer = undefined;
			this.hideInactiveBrowserViews();
		}, 50);
	}

	private onContextViewShown(): void {
		const element = this.contextViewService.getContextViewElement();
		// Never hide the page for hovers/tooltips: they anchor to workbench chrome that
		// practically never overlaps the browser content, and hiding produced a full-page
		// blink on every unrelated tooltip.
		if (element.querySelector('.monaco-hover')) {
			this.setOverlay('contextView', undefined);
			return;
		}
		this.setOverlay('contextView', () => {
			const rect = element.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0 ? rect : undefined;
		});
	}

	/** Hide native views for browser tabs that are not the active editor (restore-race safety). */
	private hideInactiveBrowserViews(): void {
		const active = this.editorService.activeEditor;
		const activeId = active instanceof BrowserEditorInput ? active.id : undefined;
		for (const editor of this.editorService.editors) {
			if (!(editor instanceof BrowserEditorInput)) {
				continue;
			}
			if (editor.id === activeId) {
				continue;
			}
			this.browserViewService.setVisible(editor.id, false).catch(() => { /* ignore */ });
		}
	}

	private trackBrowserInputs(): void {
		for (const editor of this.editorService.editors) {
			if (!(editor instanceof BrowserEditorInput) || this.trackedInputs.has(editor)) {
				continue;
			}
			this.trackedInputs.add(editor);
			const id = editor.id;
			const store = new DisposableStore();
			store.add(editor.onWillDispose(() => {
				this.browserViewService.teardownPicker(id).catch(() => { /* ignore */ });
				this.browserViewService.close(id).catch(() => { /* ignore */ });
				store.dispose();
			}));
			this._register(store);
			// Eagerly create the native WebContentsView for inactive / restored tabs.
			// VS Code only calls BrowserEditorPane.setInput for the *active* editor in a
			// group, so without this preload agents cannot drive background tabs until
			// the user switches to each one.
			void this.preloadBrowserView(editor);
		}
	}

	/**
	 * Creates (or reuses) the main-process WebContentsView for a browser editor input
	 * without revealing it. Safe to call when the pane has already opened the view —
	 * `open()` is idempotent for an existing id.
	 */
	private async preloadBrowserView(editor: BrowserEditorInput): Promise<void> {
		try {
			const isActiveNow = () => {
				const active = this.editorService.activeEditor;
				return active instanceof BrowserEditorInput && active.id === editor.id;
			};
			if (isActiveNow()) {
				// Active pane owns visibility via setInput; don't fight it.
				return;
			}
			const bounds = this.estimatePreloadBounds();
			if (!bounds) {
				// No laid-out browser pane yet — skip preload. Opening at a guessed (0,0)
				// full-window rect leaves a native WebContentsView covering the workbench
				// if it ever becomes visible (restore race), producing a blank white window.
				return;
			}
			await this.browserViewService.open(editor.id, {
				url: editor.url,
				homeUrl: editor.homeUrl,
				bounds,
				keepHidden: true,
			});
			if (isActiveNow()) {
				return;
			}
		} catch {
			// Best-effort — pane setInput will create the view when the user selects the tab.
		}
	}

	/** Bounds from a laid-out browser pane, or `undefined` when none is ready yet. */
	private estimatePreloadBounds(): IBrowserViewBounds | undefined {
		for (const pane of visibleBrowserPanes(this.editorService)) {
			const b = pane.getContentBounds();
			if (b && b.width > 0 && b.height > 0) {
				return {
					x: Math.round(b.x),
					y: Math.round(b.y),
					width: Math.round(b.width),
					height: Math.round(b.height),
				};
			}
		}
		return undefined;
	}

	private setOverlay(source: OverlaySource, region: OverlayRegion | undefined): void {
		if (region) {
			this.activeOverlays.set(source, region);
			// Hiding must be immediate — a menu that opens above a still-visible native view
			// is invisible to the user for as long as we debounce.
			if (this.overlayUpdateTimer) {
				clearTimeout(this.overlayUpdateTimer);
				this.overlayUpdateTimer = undefined;
			}
			this.updateVisibility();
		} else {
			if (!this.activeOverlays.delete(source)) {
				return; // nothing changed
			}
			// Restores are debounced to coalesce rapid hide/show pairs (menu → submenu,
			// quick input page switches) into a single repaint.
			this.scheduleUpdateVisibility();
		}
	}

	private scheduleUpdateVisibility(): void {
		if (this.overlayUpdateTimer) {
			clearTimeout(this.overlayUpdateTimer);
		}
		this.overlayUpdateTimer = setTimeout(() => {
			this.overlayUpdateTimer = undefined;
			this.updateVisibility();
		}, 50);
	}

	private updateVisibility(): void {
		const regions = Array.from(this.activeOverlays.values());
		const hideAll = regions.includes('all');
		const rectGetters = regions.filter((r): r is () => DOMRect | undefined => r !== 'all');

		for (const pane of visibleBrowserPanes(this.editorService)) {
			const input = pane.input;
			if (!(input instanceof BrowserEditorInput)) {
				continue;
			}
			let shouldHide = hideAll;
			if (!shouldHide && rectGetters.length > 0) {
				const paneBounds = pane.getContentBounds();
				shouldHide = !!paneBounds && rectGetters.some(getRect => {
					const rect = getRect();
					return !!rect && intersects(rect, paneBounds);
				});
			}
			if (!this.forceNextUpdate && this.appliedPaused.get(pane) === shouldHide) {
				continue;
			}
			this.appliedPaused.set(pane, shouldHide);
			const id = input.id;
			pane.setNativeViewPaused(shouldHide);
			if (shouldHide) {
				this.browserViewService.blur(id).catch(() => { /* ignore */ });
				this.browserViewService.setVisible(id, false).catch(() => { /* ignore */ });
			} else {
				this.browserViewService.setVisible(id, true).catch(() => { /* ignore */ });
				pane.relayout();
			}
		}
		this.forceNextUpdate = false;
	}
}

function toastsRect(): DOMRect | undefined {
	const el = document.querySelector('.notifications-toasts.visible');
	if (!el) {
		return undefined;
	}
	const rect = el.getBoundingClientRect();
	return rect.width > 0 && rect.height > 0 ? rect : undefined;
}

function intersects(rect: DOMRect, bounds: IBrowserViewBounds): boolean {
	return rect.left < bounds.x + bounds.width
		&& rect.left + rect.width > bounds.x
		&& rect.top < bounds.y + bounds.height
		&& rect.top + rect.height > bounds.y;
}

function visibleBrowserPanes(editorService: IEditorService): BrowserEditorPane[] {
	const panes = editorService.visibleEditorPanes as ReadonlyArray<unknown>;
	const result: BrowserEditorPane[] = [];
	for (const pane of panes) {
		if (pane instanceof BrowserEditorPane) {
			result.push(pane);
		}
	}
	return result;
}
