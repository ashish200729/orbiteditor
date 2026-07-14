/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as React from 'react';
import {
	ArrowLeft, ArrowRight, ArrowUp, ArrowDown, RotateCw, X as StopX, X as CloseX,
	Home, Globe, Lock, AlertTriangle, ExternalLink, Search, MousePointerClick,
} from 'lucide-react';
import { ProxyChannel } from '../../../../../../../../base/parts/ipc/common/ipc.js';
import { DisposableStore } from '../../../../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../../../../base/common/uuid.js';
import { onDidChangeZoomLevel } from '../../../../../../../../base/browser/browser.js';
import { ColorScheme } from '../../../../../../../../platform/theme/common/theme.js';
import { URI } from '../../../../../../../../base/common/uri.js';
import {
	IBrowserViewService, INavigationState, IBrowserViewBounds, BrowserShortcutAction,
	IElementPickData,
	resolveBrowserNavigationTarget, shouldDisplayBrowserUrl,
} from '../../../../../../../../platform/browserView/common/browserView.js';
import { useAccessor } from '../../util/services.js';
import { getConnectedWindow } from '../../util/connectedWindow.js';
import type { WorkspacePanelProps } from './workspaceTypes.js';

const HOME_URL = 'https://www.google.com';

type ConnectedWindow = Window & typeof globalThis & { vscodeWindowId?: number };

export const BrowserPanel = ({ tab, isActive, overlayOpen = false, setTitle, close }: WorkspacePanelProps) => {
	const accessor = useAccessor();
	const mainProcessService = accessor.get('IMainProcessService');
	const themeService = accessor.get('IThemeService');
	const notificationService = accessor.get('INotificationService');
	const openerService = accessor.get('IOpenerService');
	const configurationService = accessor.get('IConfigurationService');
	const chatThreadService = accessor.get('IChatThreadService');
	const agentWindowService = accessor.get('IAgentWindowService');

	const hostRef = React.useRef<HTMLDivElement | null>(null);
	const urlInputRef = React.useRef<HTMLInputElement | null>(null);
	const findInputRef = React.useRef<HTMLInputElement | null>(null);
	const proxyRef = React.useRef<IBrowserViewService | null>(null);
	const idRef = React.useRef<string>('');
	const lastBoundsRef = React.useRef<IBrowserViewBounds | null>(null);
	const isActiveRef = React.useRef(isActive);
	const overlayOpenRef = React.useRef(overlayOpen);
	const urlFocusedRef = React.useRef(false);
	const findVisibleRef = React.useRef(false);
	const zoomRef = React.useRef(1);
	// Refs that mirror React state so the effect-internal helpers (which close over
	// the mount-time scope) always read the CURRENT value instead of a stale snapshot.
	const isLoadingRef = React.useRef(false);
	const findQueryRef = React.useRef('');
	const pickerActiveRef = React.useRef(false);
	isActiveRef.current = isActive;
	overlayOpenRef.current = overlayOpen;

	const [urlInput, setUrlInput] = React.useState(tab.resource || '');
	const [canGoBack, setCanGoBack] = React.useState(false);
	const [canGoForward, setCanGoForward] = React.useState(false);
	const [isLoading, setIsLoading] = React.useState(false);
	const [favicon, setFavicon] = React.useState<string | null>(null);
	const [zoomPct, setZoomPct] = React.useState(100);
	const [zoomChanged, setZoomChanged] = React.useState(false);
	const [findVisible, setFindVisible] = React.useState(false);
	const [findQuery, setFindQuery] = React.useState('');
	const [automationLocked, setAutomationLocked] = React.useState(false);
	const [pickerActive, setPickerActive] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);

	// Mirror state into refs AFTER the useState declarations above so the
	// effect-internal helpers always read the current value. (Assigning before
	// the `const` declarations would throw a temporal-dead-zone error.)
	isLoadingRef.current = isLoading;
	findQueryRef.current = findQuery;
	pickerActiveRef.current = pickerActive;

	const updateSslIcon = (url: string) => {
		const lower = String(url ?? '').toLowerCase();
		if (lower.startsWith('https://') && lower.length > 8) return 'secure';
		if (lower.startsWith('http://') && lower.length > 7) return 'insecure';
		return 'neutral';
	};
	const sslState = updateSslIcon(urlInput);

	const applyState = React.useCallback((s: INavigationState) => {
		if (!urlFocusedRef.current && shouldDisplayBrowserUrl(s.url)) {
			setUrlInput(s.url);
		}
		setCanGoBack(s.canGoBack);
		setCanGoForward(s.canGoForward);
		setIsLoading(s.isLoading);
		if (s.title) {
			setTitle(s.title);
		}
	}, [setTitle]);

	// Refs that hold the navigation helpers created inside the mount effect. The
	// toolbar buttons and find-bar handlers (declared outside the effect) read these
	// so they can call the effect-internal closures without re-running the effect,
	// and so the keyboard-shortcut path always uses the current isLoading/findQuery
	// (via the mirrored refs above) instead of a stale mount-time snapshot.
	const shortcutHelpersRef = React.useRef<{
		goBack: () => void; goForward: () => void; reloadOrStop: () => void;
		focusAddressBar: () => void; setZoom: (z: number) => void; zoomBy: (d: number) => void;
		openFind: () => void; closeFind: () => void; findNext: (backward: boolean) => void;
		togglePicker: () => void;
	} | null>(null);

	// Create the native browser view, attach it to THIS (auxiliary) window, keep it
	// aligned over the content placeholder, and tear it down on unmount.
	React.useEffect(() => {
		const host = hostRef.current;
		if (!host) {
			return;
		}
		let disposed = false;
		const win = getConnectedWindow(host) as ConnectedWindow;
		const windowId = win.vscodeWindowId;
		if (typeof windowId !== 'number') {
			setError('Could not resolve the pop-out window id.');
			return;
		}

		// Build a proxy whose IPC context is the AUX window id (the shared singleton is
		// bound to the main window). Main-process getWindow() resolves aux windows too.
		const bv = ProxyChannel.toService<IBrowserViewService>(
			mainProcessService.getChannel('browserView'),
			{
				context: windowId,
				properties: (() => { const m = new Map<string, unknown>(); m.set('toJSON', () => ({})); return m; })(),
			},
		);
		proxyRef.current = bv;
		const id = generateUuid();
		idRef.current = id;

		const store = new DisposableStore();
		store.add(agentWindowService.registerBrowserView(id, tab.id));
		let rafHandle = 0;
		let layoutReadyForOpen = false;

		const readRect = (): IBrowserViewBounds => {
			const r = host.getBoundingClientRect();
			return { x: r.left, y: r.top, width: r.width, height: r.height };
		};
		const sameRounded = (a: IBrowserViewBounds, b: IBrowserViewBounds) =>
			Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y) &&
			Math.round(a.width) === Math.round(b.width) && Math.round(a.height) === Math.round(b.height);
		// Before auxiliary-window styles settle, a portal host may momentarily
		// measure as the entire window at (0, 0). A native WebContentsView is above
		// all renderer DOM, so accepting that rectangle would turn the whole Agents
		// Window white. The real browser content always sits below its toolbar.
		const isSafeHostRect = (rect: IBrowserViewBounds) => {
			if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) {
				return false;
			}
			const coversWindow = rect.width >= win.innerWidth * 0.9 && rect.height >= win.innerHeight * 0.9;
			return !(rect.x <= 8 && rect.y <= 8 && coversWindow);
		};

		const syncView = async () => {
			const inst = proxyRef.current;
			if (!inst || disposed) {
				return;
			}
			const rect = readRect();
			// Hidden when:
			//  - the tab is inactive, or
			//  - an HTML popover is open over the workspace (e.g. the "+" menu —
			//    Electron WebContentsViews always paint above the HTML layer, so
			//    the only way to show the menu is to hide the native view), or
			//  - the host has zero size (collapsed workspace).
			if (!isActiveRef.current || overlayOpenRef.current || !isSafeHostRect(rect)) {
				inst.setVisible(id, false).catch(() => { });
				return;
			}
			if (!lastBoundsRef.current || !sameRounded(lastBoundsRef.current, rect)) {
				// The main process deliberately requires a post-open measurement before
				// showing a WebContentsView. Await it so visibility cannot overtake the
				// bounds update on IPC and expose a stale full-window surface.
				try {
					await inst.setBounds(id, rect);
					if (disposed || proxyRef.current !== inst) {
						return;
					}
					lastBoundsRef.current = rect;
				} catch {
					return;
				}
			}
			// The async bounds round-trip may outlive a tab switch or popover open.
			// Re-check ownership before revealing so an inactive browser never paints
			// over the panel that replaced it.
			if (disposed || proxyRef.current !== inst || !isActiveRef.current || overlayOpenRef.current || !isSafeHostRect(readRect())) {
				await inst.setVisible(id, false).catch(() => { });
				return;
			}
			await inst.setVisible(id, true).catch(() => { });
		};
		const scheduleSync = () => {
			if (rafHandle) {
				return;
			}
			rafHandle = win.requestAnimationFrame(() => { rafHandle = 0; void syncView(); });
		};

		// Events (unfiltered across windows — always filter by our id).
		store.add(bv.onDidNavigate(e => {
			if (e.id !== id) return;
			if (!urlFocusedRef.current && shouldDisplayBrowserUrl(e.url)) {
				setUrlInput(e.url);
			}
			setCanGoBack(e.canGoBack);
			setCanGoForward(e.canGoForward);
			// Navigation tears down the in-page picker overlay (the overlay script
			// is gone with the old document). Reset our chrome state to match so the
			// toolbar button doesn't stay "active" with no overlay underneath.
			if (pickerActiveRef.current) {
				pickerActiveRef.current = false;
				setPickerActive(false);
			}
			scheduleSync();
		}));
		store.add(bv.onDidTitleChange(e => { if (e.id === id) setTitle(e.title || 'Browser'); }));
		store.add(bv.onDidFaviconChange(e => { if (e.id === id) setFavicon(e.favicon ?? null); }));
		store.add(bv.onDidLoadingStateChange(e => { if (e.id === id) setIsLoading(e.isLoading); }));
		store.add(bv.onDidFocusView(e => {
			if (e !== id) return;
			// The native page got focus (user clicked into it). Route menu shortcuts to it
			// so editing/search commands work inside the page.
			bv.setIgnoreMenuShortcuts(id, true).catch(() => { });
		}));
		store.add(bv.onDidClose(e => {
			if (e !== id) return;
			// The backing view was closed (e.g. crashed). Close the tab to avoid a blank,
			// unresponsive panel — the user can reopen from the launcher.
			close();
		}));
		// Browser-chrome shortcuts (Cmd+F/R/L/±/0, Alt+←/→) typed while the page has
		// focus are intercepted in the main process (the WebContentsView's key events
		// never reach this renderer's DOM) and forwarded here. Run the matching action.
		store.add(bv.onDidBrowserShortcut(e => {
			if (e.id !== id) return;
			runShortcut(e.action);
		}));
		// Agent lock/unlock: show the Take Control badge in the toolbar chrome.
		store.add(bv.onDidAutomationLockChange(e => {
			if (e.id !== id) return;
			setAutomationLocked(e.locked);
		}));
		// Restore lock badge if this tab was already locked when the panel mounted.
		bv.isAutomationLocked(id).then(locked => {
			if (!disposed) setAutomationLocked(locked);
		}).catch(() => { /* ignore */ });

		// Keep the page's color-scheme hint in sync with the workbench theme so the
		// embedded page renders with the matching dark/light defaults.
		const syncTheme = () => {
			const themeType = themeService.getColorTheme().type;
			const isDark = themeType === ColorScheme.DARK || themeType === ColorScheme.HIGH_CONTRAST_DARK;
			const scheme = isDark ? 'dark' : 'light';
			bv.executeJavaScript(id, `(() => { try { document.documentElement.style.colorScheme = ${JSON.stringify(scheme)}; } catch {} return true; })()`).catch(() => { });
		};
		store.add(themeService.onDidColorThemeChange(() => syncTheme()));

		const runShortcut = (action: BrowserShortcutAction) => {
			switch (action) {
				case 'findInPage': openFind(); break;
				case 'closeFindInPage': closeFind(); break;
				case 'zoomIn': zoomBy(0.1); break;
				case 'zoomOut': zoomBy(-0.1); break;
				case 'zoomReset': setZoom(1); break;
				case 'reload': reloadOrStop(); break;
				case 'focusAddressBar': focusAddressBar(); break;
				case 'goBack': goBack(); break;
				case 'goForward': goForward(); break;
			}
		};

		// --- Navigation helpers (mirror BrowserEditorPane actions) ---
		const goBack = () => { bv.goBack(id).then(applyState).catch(e => notificationService.error(String((e as Error)?.message ?? e))); };
		const goForward = () => { bv.goForward(id).then(applyState).catch(e => notificationService.error(String((e as Error)?.message ?? e))); };
		const reloadOrStop = () => {
			if (isLoadingRef.current) {
				bv.stop(id).then(applyState).catch(() => { });
			} else {
				setIsLoading(true);
				bv.reload(id).then(applyState).catch(e => notificationService.error(String((e as Error)?.message ?? e)));
			}
		};
		const focusAddressBar = () => {
			const el = urlInputRef.current;
			if (el) { el.focus(); el.select(); }
		};
		const setZoom = (zoom: number) => {
			const clamped = Math.max(0.25, Math.min(5, zoom));
			zoomRef.current = clamped;
			const pct = Math.round(clamped * 100);
			setZoomPct(pct);
			setZoomChanged(Math.abs(clamped - 1) > 0.001);
			bv.setZoomFactor(id, clamped).catch(() => { });
		};
		const zoomBy = (delta: number) => setZoom(Math.round((zoomRef.current + delta) * 100) / 100);

		const openFind = () => {
			findVisibleRef.current = true;
			setFindVisible(true);
			setFindQuery('');
			win.requestAnimationFrame(() => findInputRef.current?.focus());
		};
		const closeFind = () => {
			if (!findVisibleRef.current) return;
			findVisibleRef.current = false;
			setFindVisible(false);
			setFindQuery('');
			bv.stopFindInPage(id).catch(() => { });
		};
		const findNext = (backward: boolean) => {
			const q = findQueryRef.current;
			if (!q) return;
			bv.findInPage(id, q, { forward: !backward }).catch(() => { });
		};

		// --- Element picker (reuses IBrowserViewService.runPicker/teardownPicker) ---
		// The in-page overlay (crosshair cursor, blue highlight box, Esc-to-cancel)
		// is implemented in pickerScripts.ts and injected by the main process. We
		// just toggle it and handle the pick result by dispatching to chat staging.
		let pickerInFlight: Promise<void> | null = null;
		const setPickerChrome = (active: boolean) => {
			pickerActiveRef.current = active;
			setPickerActive(active);
		};
		const dispatchPickToChat = async (data: IElementPickData): Promise<void> => {
			let screenshot: string | null = null;
			try {
				screenshot = await bv.screenshot(id);
			} catch { /* screenshot is best-effort */ }
			chatThreadService.addNewStagingSelection({
				type: 'BrowserElement',
				selector: data.selector,
				selectorChain: data.selectorChain,
				pageUrl: data.pageUrl,
				elementData: {
					tagName: data.elementData.tagName,
					id: data.elementData.id,
					classes: data.elementData.classes,
					attributes: data.elementData.attributes,
					text: data.elementData.text,
					html: data.elementData.html,
				},
				screenshot: screenshot && screenshot.startsWith('data:')
					? (screenshot.match(/^data:image\/[^;]+;base64,(.+)$/)?.[1] ?? null)
					: screenshot,
				timestamp: Date.now(),
			});
		};
		const togglePicker = () => {
			// If a pick is already in flight, tearing down will cause runPicker to
			// resolve with { picked: false } and the finally block resets chrome.
			if (pickerActiveRef.current) {
				bv.teardownPicker(id).catch(() => { });
				return;
			}
			setPickerChrome(true);
			pickerInFlight = (async () => {
				try {
					const result = await bv.runPicker(id);
					if (result.picked && result.data) {
						await dispatchPickToChat(result.data);
						notificationService.info('Element added to chat. Switch to the chat to reference it.');
					}
				} catch (e) {
					if (!disposed) {
						notificationService.error(`Element picker failed: ${String((e as Error)?.message ?? e)}`);
					}
				} finally {
					// The pick can resolve after the tab closed (unmount tears down the
					// picker) — don't setState on an unmounted component.
					if (!disposed) {
						setPickerChrome(false);
					} else {
						pickerActiveRef.current = false;
					}
					pickerInFlight = null;
				}
			})();
		};

		// Expose the helpers to the runShortcut closure (defined above) via refs so the
		// keyboard-shortcut path can call them without going through React state.
		shortcutHelpersRef.current = { goBack, goForward, reloadOrStop, focusAddressBar, setZoom, zoomBy, openFind, closeFind, findNext, togglePicker };

		let viewOpened = false;
		const tryOpen = async () => {
			if (viewOpened || disposed || !layoutReadyForOpen) {
				return;
			}
			const rect = readRect();
			if (!isSafeHostRect(rect)) {
				return;
			}
			viewOpened = true;
			try {
				const state = await bv.open(id, {
					url: resolveBrowserNavigationTarget(tab.resource || HOME_URL),
					bounds: rect,
					keepHidden: !isActiveRef.current || overlayOpenRef.current,
				});
				if (disposed) {
					bv.close(id).catch(() => { });
					return;
				}
				// Bootstrap bounds only size the hidden native surface. Force the next
				// sync to send a freshly measured post-open rectangle before reveal.
				lastBoundsRef.current = null;
				applyState(state);
				syncTheme();
				scheduleSync();
			} catch (e: unknown) {
				viewOpened = false;
				if (!disposed) {
					setError(String((e as { message?: string })?.message ?? e));
				}
			}
		};
		// ResizeObserver + window resize keep the native view aligned with the
		// placeholder through workspace divider drags, window resizes, and zoom changes.
		let ro: ResizeObserver | undefined;
		if (typeof win.ResizeObserver === 'function') {
			ro = new win.ResizeObserver(() => {
				void tryOpen();
				// While the tab is hidden the native view is already setVisible(false),
				// so syncView would only re-hide it. Skip the IPC churn on hidden
				// resizes; the activation effect re-measures and re-syncs bounds on show.
				if (isActiveRef.current && !overlayOpenRef.current) {
					scheduleSync();
				}
			});
			ro.observe(host);
		}
		const onWinResize = () => scheduleSync();
		win.addEventListener('resize', onWinResize);

		// The portal host can exist for a frame before the auxiliary window has
		// copied its scoped CSS. Opening during that transient layout yields a
		// full-window rectangle; wait for two frames so the first native bounds are
		// the browser panel's real, settled bounds.
		win.requestAnimationFrame(() => {
			win.requestAnimationFrame(() => {
				if (disposed) {
					return;
				}
				layoutReadyForOpen = true;
				void tryOpen();
			});
		});

		// Per-window zoom (Cmd +/-) and the `window.zoomLevel` setting both change the
		// CSS px → DIP conversion of the native view bounds, so re-sync on either.
		const onZoomLevel = () => { lastBoundsRef.current = null; scheduleSync(); };
		store.add(onDidChangeZoomLevel(onZoomLevel));
		const configSub = configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('window.zoomLevel')) {
				lastBoundsRef.current = null;
				scheduleSync();
			}
		});
		store.add(configSub);

		// Pane-scoped keyboard shortcuts (Cmd/Ctrl based). These fire when the chrome
		// (address bar, buttons) has focus and the DOM keydown reaches React. When the
		// native page has focus, the main-process `before-input-event` handler forwards
		// chrome shortcuts via `onDidBrowserShortcut` instead (see above).
		const onKeyDown = (ev: KeyboardEvent) => {
			const mod = ev.metaKey || ev.ctrlKey;
			if (!mod) {
				if (ev.altKey && ev.key === 'ArrowLeft') { ev.preventDefault(); goBack(); return; }
				if (ev.altKey && ev.key === 'ArrowRight') { ev.preventDefault(); goForward(); return; }
				return;
			}
			switch (ev.key) {
				case 'r': ev.preventDefault(); reloadOrStop(); break;
				case 'l': ev.preventDefault(); focusAddressBar(); break;
				case 'f': ev.preventDefault(); openFind(); break;
				case 'g': ev.preventDefault(); findNext(ev.shiftKey); break;
				case '=':
				case '+': ev.preventDefault(); zoomBy(0.1); break;
				case '-': ev.preventDefault(); zoomBy(-0.1); break;
				case '0': ev.preventDefault(); setZoom(1); break;
			}
		};
		host.addEventListener('keydown', onKeyDown);

		return () => {
			disposed = true;
			if (rafHandle) {
				win.cancelAnimationFrame(rafHandle);
			}
			ro?.disconnect();
			win.removeEventListener('resize', onWinResize);
			host.removeEventListener('keydown', onKeyDown);
			store.dispose();
			const inst = proxyRef.current;
			proxyRef.current = null;
			// Best-effort: tear down the picker overlay before closing the view so
			// the in-page listeners don't leak if the view is reused/revived.
			if (pickerActiveRef.current) {
				inst?.teardownPicker(id).catch(() => { });
			}
			inst?.close(id).catch(() => { });
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Show/hide + reposition when this tab becomes active/inactive, or when an
	// HTML overlay (e.g. the "+" menu) opens/closes over the native browser view.
	React.useEffect(() => {
		const inst = proxyRef.current;
		const host = hostRef.current;
		const id = idRef.current;
		if (!inst || !host || !id) {
			return;
		}
		const win = getConnectedWindow(host) as ConnectedWindow;
		// Native view is only composited when the tab is the active one AND no
		// HTML popover needs to paint above it.
	const shouldShow = isActive && !overlayOpen;
	if (shouldShow) {
		const r = host.getBoundingClientRect();
		if (r.width > 0 && r.height > 0) {
			const rect = { x: r.left, y: r.top, width: r.width, height: r.height };
			// Guard against a full-window (0,0) rect — a native WebContentsView
			// at that rect covers the entire Agents window and blanks it. The
			// host can momentarily measure as the full window before the
			// workspace layout settles.
			const coversWindow = rect.width >= win.innerWidth * 0.9 && rect.height >= win.innerHeight * 0.9;
			const unsafeOrigin = rect.x <= 8 && rect.y <= 8 && coversWindow;
			if (unsafeOrigin) {
				inst.setVisible(id, false).catch(() => { });
				return;
			}
			lastBoundsRef.current = rect;
			void (async () => {
				try {
					await inst.setBounds(id, rect);
					// The tab may have been switched away (or the view swapped/closed)
					// during the IPC round-trip — revealing then would composite the
					// native view OVER whatever panel replaced it and steal its
					// clicks, with nothing to re-hide it until the next layout event.
					if (proxyRef.current !== inst || !isActiveRef.current || overlayOpenRef.current) {
						await inst.setVisible(id, false);
						return;
					}
					await inst.setVisible(id, true);
					await inst.bringToFront(id);
					if (proxyRef.current !== inst || !isActiveRef.current || overlayOpenRef.current) {
						await inst.setVisible(id, false);
					}
				} catch { /* view torn down mid-flight */ }
			})();
		}
	} else {
			inst.setVisible(id, false).catch(() => { });
			// Only fully tear down chrome state when the TAB is inactive — not
			// merely when a transient overlay (the "+" menu) is open. That way
			// closing the menu restores the browser without losing picker/menu-
			// shortcut routing mid-session.
			if (!isActive) {
				// Release menu-shortcut routing back to the workbench menu bar while inactive.
				inst.setIgnoreMenuShortcuts(id, false).catch(() => { });
				// Cancel an in-flight element picker when the tab is hidden so the
				// crosshair overlay doesn't linger on a page the user can't see.
				if (pickerActiveRef.current) {
					inst.teardownPicker(id).catch(() => { });
				}
			}
		}
	}, [isActive, overlayOpen]);

	const nav = React.useCallback((fn: (bv: IBrowserViewService, id: string) => Promise<INavigationState>) => {
		const inst = proxyRef.current;
		const id = idRef.current;
		if (inst && id) {
			fn(inst, id).then(applyState).catch(e => notificationService.error(String((e as Error)?.message ?? e)));
		}
	}, [applyState, notificationService]);

	const submitUrl = React.useCallback((e: React.FormEvent) => {
		e.preventDefault();
		const raw = urlInput.trim();
		if (!raw) return;
		const url = resolveBrowserNavigationTarget(raw);
		// Blur the address bar before navigating so it re-syncs to the resolved URL
		// (a bare search term becomes a full search URL) and focus returns to the page.
		urlInputRef.current?.blur();
		nav((bv, id) => bv.navigate(id, url));
	}, [urlInput, nav]);

	const onUrlFocus = () => {
		urlFocusedRef.current = true;
		// Release menu-shortcut routing so address-bar typing uses workbench shortcuts.
		const inst = proxyRef.current; const id = idRef.current;
		if (inst && id) inst.setIgnoreMenuShortcuts(id, false).catch(() => { });
	};
	const onUrlBlur = () => {
		urlFocusedRef.current = false;
	};
	const onUrlKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			submitUrl(e as unknown as React.FormEvent);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			const inst = proxyRef.current; const id = idRef.current;
			if (inst && id) inst.getNavigationState(id).then(s => { if (shouldDisplayBrowserUrl(s.url)) setUrlInput(s.url); }).catch(() => { });
			urlInputRef.current?.blur();
		}
	};

	const onFindInput = (e: React.ChangeEvent<HTMLInputElement>) => {
		const q = e.target.value;
		setFindQuery(q);
		const inst = proxyRef.current; const id = idRef.current;
		if (!inst || !id) return;
		if (!q) { inst.stopFindInPage(id).catch(() => { }); return; }
		inst.findInPage(id, q).catch(() => { });
	};
	const onFindKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter') { e.preventDefault(); shortcutHelpersRef.current?.findNext(e.shiftKey); }
		else if (e.key === 'Escape') { e.preventDefault(); shortcutHelpersRef.current?.closeFind(); }
	};

	const openExternal = () => {
		const inst = proxyRef.current; const id = idRef.current;
		if (!inst || !id) return;
		inst.getNavigationState(id).then(s => {
			if (s.url) openerService.open(URI.parse(s.url), { openExternal: true }).catch(() => { });
		}).catch(() => { });
	};

	const takeControl = () => {
		const inst = proxyRef.current; const id = idRef.current;
		if (!inst || !id) return;
		inst.setAutomationLocked(id, false).then(() => {
			setAutomationLocked(false);
			notificationService.info('You have control of the browser tab.');
		}).catch(e => notificationService.error(`Failed to unlock browser tab: ${String((e as Error)?.message ?? e)}`));
	};

	if (error) {
		return (
			<div className="agent-workspace-placeholder">
				<Globe size={22} strokeWidth={1.5} className="agent-workspace-placeholder-icon" />
				<div className="agent-workspace-placeholder-label">Browser unavailable</div>
				<div className="agent-workspace-placeholder-detail">{error}</div>
			</div>
		);
	}

	return (
		<div className="agent-workspace-browser">
			<div className="agent-workspace-browser-toolbar">
				<button type="button" className="agent-workspace-browser-navbtn" disabled={!canGoBack} title="Back (Alt+Left)" aria-label="Back" onClick={() => nav((bv, id) => bv.goBack(id))}>
					<ArrowLeft size={15} strokeWidth={1.9} />
				</button>
				<button type="button" className="agent-workspace-browser-navbtn" disabled={!canGoForward} title="Forward (Alt+Right)" aria-label="Forward" onClick={() => nav((bv, id) => bv.goForward(id))}>
					<ArrowRight size={15} strokeWidth={1.9} />
				</button>
				<button
					type="button"
					className="agent-workspace-browser-navbtn"
					title={isLoading ? 'Stop (Cmd+R)' : 'Reload (Cmd+R)'}
					aria-label={isLoading ? 'Stop' : 'Reload'}
					onClick={() => { if (isLoading) { nav((bv, id) => bv.stop(id)); } else { setIsLoading(true); nav((bv, id) => bv.reload(id)); } }}
				>
					{isLoading ? <StopX size={15} strokeWidth={1.9} /> : <RotateCw size={14} strokeWidth={1.9} />}
				</button>
				<button type="button" className="agent-workspace-browser-navbtn" title="Home" aria-label="Home" onClick={() => nav((bv, id) => bv.navigate(id, tab.resource || HOME_URL))}>
					<Home size={15} strokeWidth={1.9} />
				</button>

				<form className="agent-workspace-browser-address" data-loading={isLoading || undefined} onSubmit={submitUrl}>
				<span className={`agent-workspace-browser-ssl @@is-${sslState}`} title={sslState === 'secure' ? 'Secure HTTPS connection' : sslState === 'insecure' ? 'Not secure — HTTP connection' : 'Connection security'}>
					{sslState === 'insecure' ? <AlertTriangle size={13} /> : <Lock size={13} />}
				</span>
				{favicon && <img className="agent-workspace-browser-favicon @@is-present" src={favicon} alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).classList.remove('is-present'); }} />}
					<input
						ref={urlInputRef}
						className="agent-workspace-browser-url"
						value={urlInput}
						onChange={(e) => setUrlInput(e.target.value)}
						onFocus={onUrlFocus}
						onBlur={onUrlBlur}
						onKeyDown={onUrlKeyDown}
						placeholder="Search or enter address"
						spellCheck={false}
						autoCorrect="off"
						autoCapitalize="off"
						aria-label="Address and search bar"
					/>
				</form>

			<button
				type="button"
				className={`agent-workspace-browser-zoom-pill${zoomChanged ? ' @@is-changed' : ''}`}
				title={`Zoom: ${zoomPct}% (click to reset, Cmd +/- to zoom)`}
				aria-label="Zoom level"
				onClick={() => shortcutHelpersRef.current?.setZoom(1)}
			>
					<span className="agent-workspace-browser-zoom-label">{zoomPct}%</span>
				</button>

			<button type="button" className="agent-workspace-browser-navbtn" title="Open in external browser" aria-label="Open in external browser" onClick={openExternal}>
				<ExternalLink size={15} strokeWidth={1.9} />
			</button>
			<button
				type="button"
				className={`agent-workspace-browser-navbtn agent-workspace-browser-pickbtn${pickerActive ? ' @@is-active' : ''}`}
				title={pickerActive ? 'Cancel element picker (Esc)' : 'Pick an element to add to chat'}
				aria-label={pickerActive ? 'Cancel element picker' : 'Pick element for chat'}
				aria-pressed={pickerActive}
				disabled={isLoading}
				onClick={() => shortcutHelpersRef.current?.togglePicker()}
			>
				<MousePointerClick size={15} strokeWidth={1.9} />
			</button>

			{automationLocked && (
				<button type="button" className="agent-workspace-browser-lock-badge @@is-visible" title="Agent is controlling this tab. Click to unlock and take over." aria-label="Take control of browser from agent" onClick={takeControl}>
					<Lock size={12} strokeWidth={2} />
					<span>Take Control</span>
				</button>
			)}

				<div className={`agent-workspace-browser-loading${isLoading ? ' @@is-loading' : ''}`} />
			</div>

		{findVisible && (
			<div className="agent-workspace-browser-find @@is-visible">
					<Search size={13} strokeWidth={1.9} className="agent-workspace-browser-find-icon" />
					<input
						ref={findInputRef}
						className="agent-workspace-browser-find-input"
						value={findQuery}
						onChange={onFindInput}
						onKeyDown={onFindKeyDown}
						placeholder="Find in page"
						spellCheck={false}
						aria-label="Find in page"
					/>
					<button type="button" className="agent-workspace-browser-find-btn" title="Previous match (Shift+Enter)" aria-label="Previous match" onClick={() => shortcutHelpersRef.current?.findNext(true)}>
						<ArrowUp size={13} strokeWidth={1.9} />
					</button>
					<button type="button" className="agent-workspace-browser-find-btn" title="Next match (Enter)" aria-label="Next match" onClick={() => shortcutHelpersRef.current?.findNext(false)}>
						<ArrowDown size={13} strokeWidth={1.9} />
					</button>
					<button type="button" className="agent-workspace-browser-find-btn" title="Close (Escape)" aria-label="Close find" onClick={() => shortcutHelpersRef.current?.closeFind()}>
						<CloseX size={13} strokeWidth={1.9} />
					</button>
				</div>
			)}

			{/* The native WebContentsView is positioned by the main process directly over
			    this placeholder; it must stay empty (clicks/keys go to the page). */}
			<div className="agent-workspace-browser-content" ref={hostRef} />
		</div>
	);
};
