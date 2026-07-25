/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { $, addDisposableListener, EventHelper, EventType, sharedMutationObserver } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { IRectangle, hasNativeTitlebar, getTitleBarStyle } from '../../../../platform/window/common/window.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ResultKind } from '../../../../platform/keybinding/common/keybindingResolver.js';
import { AuxiliaryWindowMode, IAuxiliaryWindow, IAuxiliaryWindowService } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { isMacintosh, isWindows, isLinux } from '../../../../base/common/platform.js';
import { IChatThreadService } from './chatThreadService.js';
import { IAgentWindowTerminalStore } from './agentWindowTerminalStore.js';
import { ipcRenderer } from '../../../../base/parts/sandbox/electron-sandbox/globals.js';
import { BROWSER_AUTOMATION_IPC_CHANNELS, IBrowserViewService } from '../../../../platform/browserView/common/browserView.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IAgentWindowService, type WorkspacePanelKind } from './agentWindowService.interface.js';

export { IAgentWindowService, type WorkspacePanelKind } from './agentWindowService.interface.js';

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const STORAGE_BOUNDS = 'orbit.agentWindow.bounds';
const STORAGE_SIDEBAR_COLLAPSED = 'orbit.agentWindow.sidebarCollapsed';
const STORAGE_SIDEBAR_WIDTH = 'orbit.agentWindow.sidebarWidth';
const STORAGE_WORKSPACE_COLLAPSED = 'orbit.agentWindow.workspaceCollapsed';
const STORAGE_WORKSPACE_WIDTH = 'orbit.agentWindow.workspaceWidth';

// Commands that only make sense in the main IDE window. The standalone Agents
// window has no editor groups, activity/side/panel/status bars, views, terminal,
// etc., so dispatching one of these from the auxiliary window acts on the MAIN
// window's parts and yanks the user back into the IDE. We swallow their
// keybindings in the Agents window's capture phase before the shared workbench
// keybinding listener runs. Quick-access commands (Command Palette, Quick Open)
// are intentionally NOT listed: the quick input renders into the *active*
// window's container, so it opens inside the Agents window and does not redirect.
const AGENT_WINDOW_BLOCKED_COMMAND_IDS: ReadonlySet<string> = new Set<string>([
	// --- Part visibility / layout (main-window parts only) ---
	'workbench.action.togglePanel',
	'workbench.action.toggleMaximizedPanel',
	'workbench.action.closePanel',
	'workbench.action.toggleSidebarVisibility',
	'workbench.action.closeSidebar',
	'workbench.action.toggleSidebarPosition',
	'workbench.action.toggleAuxiliaryBar',
	'workbench.action.closeAuxiliaryBar',
	'workbench.action.toggleActivityBarVisibility',
	'workbench.action.toggleStatusbarVisibility',
	'workbench.action.toggleZenMode',
	'workbench.action.toggleCenteredLayout',
	'workbench.action.toggleEditorVisibility',
	'workbench.action.toggleAgentsPane',
	// --- Part focus (raises the main window) ---
	'workbench.action.focusSideBar',
	'workbench.action.focusPanel',
	'workbench.action.focusAuxiliaryBar',
	'workbench.action.focusActivityBar',
	'workbench.action.focusBanner',
	'workbench.action.focusStatusBar',
	'workbench.action.focusNextPart',
	'workbench.action.focusPreviousPart',
	// --- Editor group focus / navigation (main-window editors) ---
	'workbench.action.focusActiveEditorGroup',
	'workbench.action.focusFirstEditorGroup',
	'workbench.action.focusSecondEditorGroup',
	'workbench.action.focusThirdEditorGroup',
	'workbench.action.focusFourthEditorGroup',
	'workbench.action.focusFifthEditorGroup',
	'workbench.action.focusSixthEditorGroup',
	'workbench.action.focusSeventhEditorGroup',
	'workbench.action.focusEighthEditorGroup',
	'workbench.action.focusLastEditorGroup',
	'workbench.action.focusNextGroup',
	'workbench.action.focusPreviousGroup',
	'workbench.action.focusLeftGroup',
	'workbench.action.focusRightGroup',
	'workbench.action.focusAboveGroup',
	'workbench.action.focusBelowGroup',
	'workbench.action.focusFirstSideEditor',
	'workbench.action.focusSecondSideEditor',
	// --- Editor history navigation (acts on the main window's editors) ---
	'workbench.action.navigateBack',
	'workbench.action.navigateForward',
	'workbench.action.navigateBackInEditLocations',
	'workbench.action.navigateForwardInEditLocations',
	// --- Orbit chat surfaces that live in the main IDE window ---
	'workbench.action.toggleChatHistory',
	'workbench.action.focusChatHistory',
	'workbench.action.closeChatHistory',
	'void.sidebar.open',
]);

// Whole command families that only target main-window parts (views, panels,
// terminal, debug, tasks, problems, output, SCM, files explorer). Matched by
// prefix so custom/contributed views are covered too.
const AGENT_WINDOW_BLOCKED_COMMAND_PREFIXES: readonly string[] = [
	'workbench.view.',
	'workbench.panel.',
	'workbench.action.terminal.',
	'workbench.action.debug.',
	'workbench.action.tasks.',
	'workbench.action.problems.',
	'workbench.action.output.',
	'workbench.files.action.',
	'workbench.scm.',
];

// Commands whose keybinding should, in the Agents window, drive the window's own
// local chat-history sidebar instead of the main IDE's side bar / chat history.
const AGENT_WINDOW_LOCAL_SIDEBAR_COMMAND_IDS: ReadonlySet<string> = new Set<string>([
	'workbench.action.toggleChatHistory',
	'workbench.action.toggleAgentsPane',
	// Cmd/Ctrl+B is the canonical "toggle side bar" muscle-memory shortcut; drive
	// the Agents window's own local sidebar so it isn't a dead key in this window.
	'workbench.action.toggleSidebarVisibility',
]);

function shouldBlockCommandInAgentWindow(commandId: string | null | undefined): boolean {
	if (!commandId) {
		return false;
	}
	if (AGENT_WINDOW_BLOCKED_COMMAND_IDS.has(commandId)) {
		return true;
	}
	for (const prefix of AGENT_WINDOW_BLOCKED_COMMAND_PREFIXES) {
		if (commandId.startsWith(prefix)) {
			return true;
		}
	}
	return false;
}

const DEFAULT_BOUNDS: Partial<IRectangle> = { width: 1100, height: 760 };
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 460;
const SIDEBAR_DEFAULT = 280;
const WORKSPACE_MIN = 360;
const WORKSPACE_MAX = 1000;
const WORKSPACE_DEFAULT = 520;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class AgentWindowService extends Disposable implements IAgentWindowService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<void>());
	readonly onDidChangeState: Event<void> = this._onDidChangeState.event;

	private readonly _onDidRequestWorkspacePanel = this._register(new Emitter<{ kind: WorkspacePanelKind; resource?: string }>());
	readonly onDidRequestWorkspacePanel: Event<{ kind: WorkspacePanelKind; resource?: string }> = this._onDidRequestWorkspacePanel.event;

	private readonly _onDidRequestSelectBrowserView = this._register(new Emitter<{ browserViewId: string; workspaceTabId: string }>());
	readonly onDidRequestSelectBrowserView = this._onDidRequestSelectBrowserView.event;

	private auxWindow: IAuxiliaryWindow | undefined;
	private windowDisposables: DisposableStore | undefined;
	private mountDisposeFns: Array<() => void> = [];
	/**
	 * Set synchronously at the top of {@link open} and cleared when it settles.
	 * `this.auxWindow` is only assigned AFTER the async native open resolves, so
	 * without this a second open() call in that window opens a second real OS
	 * window (immediately disposed, but it still flashes).
	 */
	private _openInFlight: Promise<void> | undefined;
	/**
	 * Workspace-panel requests fired before the React workspace subscribed
	 * (it mounts via an async import after the window opens). Drained by
	 * {@link consumePendingWorkspacePanelRequests}; cleared on window close.
	 */
	private _pendingPanelRequests: { kind: WorkspacePanelKind; resource?: string }[] = [];
	/** >0 while a divider drag is active — pane clamping must not fight the drag. */
	private _dividerDragActive = 0;
	private _saveBoundsTimer: ReturnType<typeof setTimeout> | undefined;

	/** Native browser view id → agents workspace tab id. */
	private readonly _browserViews = new Map<string, string>();
	private _pendingOpenTab: { resolve: (id: string) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
	/**
	 * Serializes {@link handleAgentOpenTab} calls. Without this, two concurrent
	 * MCP "open tab" requests arriving before either resolves would both pass
	 * the "no existing browser tab" check (creating two tabs instead of one)
	 * and the second would clobber `_pendingOpenTab`, permanently losing the
	 * first request's resolve/reject (it would just hang until its own 10s
	 * timeout, and that timeout's cleanup could then wipe out the second
	 * request's still-pending slot too).
	 */
	private _openTabChain: Promise<void> = Promise.resolve();
	/** True while a live vscode-tokens-styles observer is attached for the open Agents window. */
	private _editorTokenStylesSynced = false;

	// Local shell references (valid only while a window is open).
	private shellEl: HTMLElement | undefined;
	private sidebarToggleEl: HTMLButtonElement | undefined;
	private sidebarToggleAltEl: HTMLButtonElement | undefined;
	private workspaceToggleEl: HTMLButtonElement | undefined;
	private chatTitleEl: HTMLElement | undefined;

	constructor(
		@IAuxiliaryWindowService private readonly auxiliaryWindowService: IAuxiliaryWindowService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IStorageService private readonly storageService: IStorageService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@ILogService private readonly logService: ILogService,
		@IChatThreadService private readonly chatThreadService: IChatThreadService,
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
		@IAgentWindowTerminalStore private readonly terminalStore: IAgentWindowTerminalStore,
	) {
		super();

		this._register(this.lifecycleService.onWillShutdown(() => this.closeWindow()));
	}

	isOpen(): boolean {
		return !!this.auxWindow;
	}

	getAuxiliaryWindowId(): number | undefined {
		return this.auxWindow?.window.vscodeWindowId;
	}

	getAuxiliaryDomWindow(): Window | undefined {
		return this.auxWindow?.window;
	}

	registerBrowserView(browserViewId: string, workspaceTabId: string): IDisposable {
		this._browserViews.set(browserViewId, workspaceTabId);
		if (this._pendingOpenTab) {
			clearTimeout(this._pendingOpenTab.timer);
			const pending = this._pendingOpenTab;
			this._pendingOpenTab = undefined;
			// The window can be torn down between the open request and this
			// registration; resolving with a browser view whose window is already
			// gone would hand the caller a dead id. Reject instead.
			if (this.auxWindow) {
				pending.resolve(browserViewId);
			} else {
				pending.reject(new Error('Agents window closed before browser view registered.'));
			}
		}
		return toDisposable(() => {
			this._browserViews.delete(browserViewId);
		});
	}

	findWorkspaceTabForBrowserView(browserViewId: string): string | undefined {
		return this._browserViews.get(browserViewId);
	}

	// ----- open / focus -----------------------------------------------------

	async open(): Promise<void> {
		if (this.auxWindow) {
			try {
				await this.nativeHostService.focusWindow({ targetWindowId: this.auxWindow.window.vscodeWindowId, force: true });
			} catch (err) {
				this.logService.error('[AgentWindow] focus existing window failed', err);
			}
			return;
		}

		// A second open() while the first is still awaiting the native window
		// (e.g. double-clicking the pill) must not open a second OS window.
		if (this._openInFlight) {
			return this._openInFlight;
		}
		const run = this._doOpen();
		this._openInFlight = run.then(() => undefined, () => undefined);
		try {
			await run;
		} finally {
			this._openInFlight = undefined;
		}
	}

	private async _doOpen(): Promise<void> {
		let aux: IAuxiliaryWindow;
		try {
			// Use a custom title bar (nativeTitlebar: false) so we can render our
			// own title bar that matches the main IDE's look. The OS still renders
			// window controls as an overlay:
			//   - macOS: traffic lights (close, minimize, zoom) overlay the top-left
			//   - Windows/Linux: native min/max/close buttons overlay the top-right
			//     via Window Controls Overlay (WCO), or VS Code's custom buttons
			// We never render our own min/max/close buttons — the OS/WCO handles it.
			// If the user has explicitly set `window.titleBarStyle: native`, we
			// respect that and use a native title bar instead.
			const useNativeTitlebar = hasNativeTitlebar(this.configurationService, getTitleBarStyle(this.configurationService));
			aux = await this.auxiliaryWindowService.open({
				mode: AuxiliaryWindowMode.Normal,
				bounds: this.readBounds(),
				nativeTitlebar: useNativeTitlebar,
				disableFullscreen: false,
				// Open hidden; reveal only after shell + React mount so Chromium never
				// presents a stale white compositor frame on first paint.
				deferShow: true,
			});
		} catch (err) {
			this.logService.error('[AgentWindow] failed to open auxiliary window', err);
			return;
		}

		if (this.auxWindow) {
			// Another open call raced ahead of us; discard the duplicate.
			aux.dispose();
			return;
		}
		this.auxWindow = aux;

		const disposables = new DisposableStore();
		this.windowDisposables = disposables;

		// Register the unload handler IMMEDIATELY so we don't miss a close event
		// that happens while we are awaiting `whenStylesHaveLoaded`.
		disposables.add(aux.onUnload(() => this.handleClosed()));

		// Guard main-window-only shortcuts from the moment the window exists — not
		// after styles load — so a Cmd+J pressed during the brief style-load window
		// can't slip through and pull the user back to the IDE.
		this.registerMainWorkbenchCommandGuard(aux, disposables);
		this.registerBrowserAutomationHandlers(disposables);

		try {
			await aux.whenStylesHaveLoaded;

			// The window may have been closed while styles were loading.
			if (this.auxWindow !== aux) {
				return;
			}

			aux.window.document.title = 'Agents';

			// CRITICAL: delegate the aux window's node factories to the MAIN window.
			// `BrowserAuxiliaryWindowService.createContainer` overrides
			// `auxWindow.document.createElement` to THROW (a guard so VS Code code
			// doesn't create child-window-class elements and break
			// `instanceof HTMLElement`). React's `createPortal(<X/>, auxEl)` creates
			// its children via `auxEl.ownerDocument.createElement` — and because our
			// shell nodes get adopted into the aux document on `appendChild`, that
			// resolves to the aux document and hits the throwing guard, crashing the
			// entire portal render (both panes go blank).
			//
			// Rebinding the factories to the main document keeps every React node a
			// main-window element (the invariant VS Code actually wants) while
			// letting React create nodes. See memory `orbit-aux-window-react-mount`.
			this.delegateNodeFactories(aux);

			try { aux.layout(); } catch { /* prime dimensions before shell mount */ }

			await this.buildShellAndMount(aux, disposables);

			// Debounced: onDidLayout fires on every resize tick; a storage write per
			// tick is wasteful. 500ms after the last layout is plenty.
			disposables.add(aux.onDidLayout(() => {
				if (this._saveBoundsTimer !== undefined) {
					clearTimeout(this._saveBoundsTimer);
				}
				this._saveBoundsTimer = setTimeout(() => {
					this._saveBoundsTimer = undefined;
					this.saveBounds();
				}, 500);
			}));
			disposables.add(toDisposable(() => {
				if (this._saveBoundsTimer !== undefined) {
					clearTimeout(this._saveBoundsTimer);
					this._saveBoundsTimer = undefined;
				}
				// Persist the final bounds at close (the debounce may still be pending).
				this.saveBounds();
			}));

			this._onDidChangeState.fire();
		} catch (err) {
			this.logService.error('[AgentWindow] failed to build agent window', err);
			this.closeWindow();
			this.handleClosed();
		}
	}

	async focusMainWindow(): Promise<void> {
		try {
			await this.nativeHostService.focusWindow({ targetWindowId: this.nativeHostService.windowId, force: true });
		} catch (err) {
			this.logService.error('[AgentWindow] focus main window failed', err);
		}
	}

	// ----- shell + mounts ---------------------------------------------------

	private async buildShellAndMount(aux: IAuxiliaryWindow, disposables: DisposableStore): Promise<void> {
		const container = aux.container;
		const auxWin = aux.window;
		const nativeTitlebar = hasNativeTitlebar(this.configurationService, getTitleBarStyle(this.configurationService));

		const shell = $('.agent-window.agent-window-shell');
		this.shellEl = shell;

		// Mark the shell with the title bar kind so CSS can adjust layout.
		shell.classList.toggle('native-titlebar', nativeTitlebar);

		// Restore the previously persisted sidebar collapsed state.
		if (this.readSidebarCollapsed()) {
			shell.classList.add('sidebar-collapsed');
		} else {
			shell.classList.remove('sidebar-collapsed');
		}

		// Restore the previously persisted workspace collapsed state.
		if (this.readWorkspaceCollapsed()) {
			shell.classList.add('workspace-collapsed');
		} else {
			shell.classList.remove('workspace-collapsed');
		}

		// --- Per-column headers (Cursor layout) --------------------------------
		// No separate full-width title band. Each column owns a header row flush at
		// the very top of the window, so the vertical dividers run the full height
		// and the sidebar reads as one continuous surface with its own header. The
		// OS still draws the window controls as an overlay (traffic lights top-left
		// on macOS, WCO min/max/close top-right on Windows/Linux); we only RESERVE
		// space for them with `.agent-window-controls-spacer` + CSS.
		//
		// Each `.agent-window-pane-header` is a `-webkit-app-region: drag` surface
		// (set in CSS) so the window is draggable by any empty header area; the
		// interactive controls inside re-assert `no-drag`.
		const reserveMac = !nativeTitlebar && isMacintosh;
		const reserveWco = !nativeTitlebar && (isWindows || isLinux);
		if (reserveWco) {
			shell.classList.add('reserve-wco');
		}

		const body = $('.agent-window-body');

		// ----- Sidebar column (chat history) -----
		const sidebarPane = $('.agent-window-sidebar');
		const sidebarHeader = $('.agent-window-pane-header.agent-window-sidebar-header');
		if (reserveMac) {
			// Reserve the macOS traffic-light corner (top-left) inside the sidebar header.
			sidebarHeader.appendChild($('.window-controls-container.agent-window-controls-spacer'));
		}
		const sidebarToggle = $('button.agent-window-titlebar-icon.agent-window-sidebar-toggle') as HTMLButtonElement;
		sidebarToggle.type = 'button';
		sidebarToggle.setAttribute('aria-controls', 'orbit-agent-window-history');
		sidebarToggle.classList.add(...ThemeIcon.asClassNameArray(Codicon.layoutSidebarLeft));
		disposables.add(this.onClick(sidebarToggle, () => this.toggleSidebar()));
		this.sidebarToggleEl = sidebarToggle;
		sidebarHeader.appendChild(sidebarToggle);
		const sidebarContent = $('.agent-window-sidebar-content');
		sidebarContent.id = 'orbit-agent-window-history';
		sidebarPane.appendChild(sidebarHeader);
		sidebarPane.appendChild(sidebarContent);

		const divider = $('.agent-window-divider');
		divider.setAttribute('role', 'separator');
		divider.setAttribute('aria-orientation', 'vertical');
		divider.tabIndex = 0;

		// ----- Main column (chat) -----
		const mainPane = $('.agent-window-main');
		const mainHeader = $('.agent-window-pane-header.agent-window-main-header');
		// Alt sidebar toggle — only shown when the sidebar is collapsed (CSS), so the
		// control never disappears together with its column.
		const sidebarToggleAlt = $('button.agent-window-titlebar-icon.agent-window-sidebar-toggle.agent-window-sidebar-toggle-alt') as HTMLButtonElement;
		sidebarToggleAlt.type = 'button';
		sidebarToggleAlt.setAttribute('aria-controls', 'orbit-agent-window-history');
		sidebarToggleAlt.classList.add(...ThemeIcon.asClassNameArray(Codicon.layoutSidebarLeft));
		disposables.add(this.onClick(sidebarToggleAlt, () => this.toggleSidebar()));
		this.sidebarToggleAltEl = sidebarToggleAlt;
		mainHeader.appendChild(sidebarToggleAlt);
		// Live thread title.
		const chatTitle = $('span.agent-window-chat-title');
		this.chatTitleEl = chatTitle;
		mainHeader.appendChild(chatTitle);
		mainHeader.appendChild($('.agent-window-header-spacer'));
		// IDE button (return focus to the main IDE window).
		const ideBtn = $('button.agent-window-ide-btn') as HTMLButtonElement;
		ideBtn.type = 'button';
		ideBtn.title = 'Focus IDE window';
		ideBtn.setAttribute('aria-label', 'Focus IDE window');
		ideBtn.appendChild($('span.agent-window-ide-label', undefined, 'IDE'));
		ideBtn.appendChild($('span.codicon.codicon-link-external'));
		disposables.add(this.onClick(ideBtn, () => this.focusMainWindow()));
		mainHeader.appendChild(ideBtn);
		// Workspace toggle (show/hide the Changes/Terminal/File/Browser column).
		const workspaceToggle = $('button.agent-window-titlebar-icon.agent-window-workspace-toggle') as HTMLButtonElement;
		workspaceToggle.type = 'button';
		workspaceToggle.setAttribute('aria-controls', 'orbit-agent-window-workspace');
		workspaceToggle.classList.add(...ThemeIcon.asClassNameArray(Codicon.layoutSidebarRight));
		disposables.add(this.onClick(workspaceToggle, () => this.toggleWorkspace()));
		this.workspaceToggleEl = workspaceToggle;
		mainHeader.appendChild(workspaceToggle);
		const mainContent = $('.agent-window-main-content');
		mainPane.appendChild(mainHeader);
		mainPane.appendChild(mainContent);

		const workspaceDivider = $('.agent-window-divider.agent-window-workspace-divider');
		workspaceDivider.setAttribute('role', 'separator');
		workspaceDivider.setAttribute('aria-orientation', 'vertical');
		workspaceDivider.tabIndex = 0;

		// ----- Workspace column (its React tab strip IS the header) -----
		const workspacePane = $('.agent-window-workspace');
		workspacePane.id = 'orbit-agent-window-workspace';

		const width = this.readSidebarWidth();
		sidebarPane.style.width = `${width}px`;
		workspacePane.style.width = `${this.readWorkspaceWidth()}px`;

		body.appendChild(sidebarPane);
		body.appendChild(divider);
		body.appendChild(mainPane);
		body.appendChild(workspaceDivider);
		body.appendChild(workspacePane);

		const tooltipContainer = $('.void-tooltip-container');

		shell.appendChild(body);
		shell.appendChild(tooltipContainer);
		container.appendChild(shell);

		this.updateSidebarToggleState();
		this.updateWorkspaceToggleState();
		this.updateChatTitle();
		disposables.add(this.chatThreadService.onDidChangeCurrentThread(() => this.updateChatTitle()));
		disposables.add(this.chatThreadService.onDidChangeStreamState(() => this.updateChatTitle()));

		// Explicitly size the shell + body on every layout pass. The CSS uses
		// `height: 100%` + flex, but the aux window's container is absolutely
		// positioned and some platforms don't propagate `100%` height through
		// flex children reliably. Setting explicit pixel dimensions guarantees
		// the sidebar and main panes get real, non-zero height. There is no longer
		// a separate title band — the per-column headers live inside the body — so
		// the body fills the whole content area.
		let lastShellWidth = 0;
		let lastShellHeight = 0;
		const sizeShell = (width: number, height: number) => {
			// A child window can briefly report a zero-sized client area while it is
			// being created, hidden, or moved between displays. Do not turn that
			// transient measurement into an inline `0px` size: CSS then faithfully
			// collapses every pane and leaves a completely white Agents window until
			// another resize happens. Keep the last valid size instead; the next real
			// layout event will replace it normally.
			if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
				if (lastShellWidth > 0 && lastShellHeight > 0) {
					width = lastShellWidth;
					height = lastShellHeight;
				} else {
					return;
				}
			}
			lastShellWidth = width;
			lastShellHeight = height;
			shell.style.width = `${width}px`;
			shell.style.height = `${height}px`;
			body.style.width = `${width}px`;
			body.style.height = `${height}px`;

			// Keep the chat column usable: the side panes have fixed pixel widths
			// and `.agent-window-main` is the flex filler, so persisted widths from
			// a larger window (up to 460 + 1000) can crush the chat pane to 0 on a
			// narrower one. Shrink workspace first, then sidebar, down to their
			// mins; widths grow back toward the persisted values as the window
			// widens (we never persist the clamped values). Skipped mid-drag so it
			// can't fight the user's pointer.
			if (this._dividerDragActive === 0) {
				const MAIN_MIN = 320;
				const sidebarCollapsed = shell.classList.contains('sidebar-collapsed');
				const workspaceCollapsed = shell.classList.contains('workspace-collapsed');
				let sidebarW = sidebarCollapsed ? 0 : this.readSidebarWidth();
				let workspaceW = workspaceCollapsed ? 0 : this.readWorkspaceWidth();
				let over = sidebarW + workspaceW - (width - MAIN_MIN);
				if (over > 0 && !workspaceCollapsed) {
					const shrink = Math.min(over, workspaceW - WORKSPACE_MIN);
					if (shrink > 0) { workspaceW -= shrink; over -= shrink; }
				}
				if (over > 0 && !sidebarCollapsed) {
					const shrink = Math.min(over, sidebarW - SIDEBAR_MIN);
					if (shrink > 0) { sidebarW -= shrink; over -= shrink; }
				}
				if (!sidebarCollapsed) { sidebarPane.style.width = `${sidebarW}px`; }
				if (!workspaceCollapsed) { workspacePane.style.width = `${workspaceW}px`; }
			}
		};
		disposables.add(aux.onDidLayout(({ width, height }) => sizeShell(width, height)));

		// Size the shell synchronously right now, before the async React import
		// resolves. Otherwise the shell depends purely on CSS `height:100%`
		// propagating through the flex chain until the first `onDidLayout` fires —
		// which can be delayed on a cold/slow dynamic import or if the OS opens the
		// window already at its target size (no RESIZE event) — leaving every pane at
		// 0 height (an all-white "blank" window). Reading the container's own box
		// gives a correct size immediately; fall back to persisted/default bounds when
		// the container still reports 0 during the first paint.
		{
			const rect = container.getBoundingClientRect();
			const fallback = this.readBounds();
			const w = rect.width || auxWin.innerWidth || fallback.width || DEFAULT_BOUNDS.width || 1100;
			const h = rect.height || auxWin.innerHeight || fallback.height || DEFAULT_BOUNDS.height || 760;
			if (w > 0 && h > 0) {
				sizeShell(w, h);
			}
		}
		try { aux.layout(); } catch { /* best-effort — onDidLayout will correct sizing */ }

		// Some platforms report 0×0 on first paint, then never fire onDidLayout until
		// the user resizes. Watch the container and apply the first real measurement.
		if (typeof ResizeObserver === 'function') {
			let sawNonZero = lastShellWidth > 0 && lastShellHeight > 0;
			const ro = new ResizeObserver((entries) => {
				for (const entry of entries) {
					const { width, height } = entry.contentRect;
					if (width <= 0 || height <= 0) {
						continue;
					}
					sizeShell(width, height);
					try { aux.layout(); } catch { /* best-effort */ }
					if (!sawNonZero) {
						sawNonZero = true;
						this.invalidateNativeWindow(aux);
					}
				}
			});
			ro.observe(container);
			disposables.add(toDisposable(() => ro.disconnect()));
		}

		disposables.add(this.registerDividerDrag(aux, divider, sidebarPane, {
			min: SIDEBAR_MIN,
			max: SIDEBAR_MAX,
			save: (w) => this.saveSidebarWidth(w),
			read: () => this.readSidebarWidth(),
		}));
		disposables.add(this.registerDividerDrag(aux, workspaceDivider, workspacePane, {
			min: WORKSPACE_MIN,
			max: WORKSPACE_MAX,
			invert: true,
			save: (w) => this.saveWorkspaceWidth(w),
			read: () => this.readWorkspaceWidth(),
		}));

		// Track focus/blur of the auxiliary window so the headers can render in an
		// "inactive" style when the window is not focused.
		disposables.add(addDisposableListener(auxWin, 'blur', () => shell.classList.add('inactive')));
		disposables.add(addDisposableListener(auxWin, 'focus', () => shell.classList.remove('inactive')));

		// Remove the shell from the container when the window closes.
		disposables.add(toDisposable(() => {
			shell.remove();
		}));

		// React portals mount into the pane CONTENT nodes (below each header), not
		// the column shells — the headers are shell-owned DOM the portals must not
		// overwrite. Await mount so the first compositor repaint runs after content
		// is in the tree — repainting before React resolves leaves a stale white frame.
		await this.mountReact(aux, sidebarContent, mainContent, tooltipContainer, workspacePane, disposables);

		this.scheduleContentReadyRepaint(aux, disposables);

		// Safety net: never leave a deferred window hidden if reveal failed.
		const fallbackReveal = setTimeout(() => {
			if (this.auxWindow === aux) {
				this.revealAuxiliaryWindow(aux);
			}
		}, 3000);
		disposables.add(toDisposable(() => clearTimeout(fallbackReveal)));
	}

	/**
	 * Listen for main-process browser MCP tab orchestration targeted at the
	 * agents-window workspace browser panel. Uses dedicated channels so we do
	 * not race `BrowserTabRegistryService` (which only knows editor tabs).
	 */
	private registerBrowserAutomationHandlers(disposables: DisposableStore): void {
		const openHandler = (_e: unknown, payload: { url: string; replyChannel: string }) => {
			void this.handleAgentOpenTab(String(payload.url ?? ''), payload.replyChannel);
		};
		const selectHandler = (_e: unknown, payload: { id: string; replyChannel?: string }) => {
			const workspaceTabId = this._browserViews.get(payload.id);
			if (!workspaceTabId) {
				if (payload.replyChannel) {
					ipcRenderer.send(payload.replyChannel, false);
				}
				return;
			}
			this._onDidRequestSelectBrowserView.fire({ browserViewId: payload.id, workspaceTabId });
			if (payload.replyChannel) {
				ipcRenderer.send(payload.replyChannel, true);
			}
		};
		ipcRenderer.on(BROWSER_AUTOMATION_IPC_CHANNELS.agentOpenTab, openHandler);
		ipcRenderer.on(BROWSER_AUTOMATION_IPC_CHANNELS.agentSelectTab, selectHandler);
		disposables.add({
			dispose: () => {
				ipcRenderer.removeListener(BROWSER_AUTOMATION_IPC_CHANNELS.agentOpenTab, openHandler);
				ipcRenderer.removeListener(BROWSER_AUTOMATION_IPC_CHANNELS.agentSelectTab, selectHandler);
			},
		});
	}

	private handleAgentOpenTab(url: string, replyChannel: string): Promise<void> {
		const run = this._openTabChain.then(() => this._doHandleAgentOpenTab(url, replyChannel));
		// Swallow here so one failed request doesn't break the chain for the
		// next queued one; the caller's own `run` promise still carries the error.
		this._openTabChain = run.then(() => undefined, () => undefined);
		return run;
	}

	private async _doHandleAgentOpenTab(url: string, replyChannel: string): Promise<void> {
		try {
			// The window may have closed while this request sat queued behind the
			// chain — don't re-arm a pending-open slot handleClosed already flushed.
			if (!this.auxWindow) {
				ipcRenderer.send(replyChannel, '');
				return;
			}
			const existing = this._browserViews.keys().next().value as string | undefined;
			if (existing) {
				const workspaceTabId = this._browserViews.get(existing)!;
				this._onDidRequestSelectBrowserView.fire({ browserViewId: existing, workspaceTabId });
				ipcRenderer.send(replyChannel, existing);
				return;
			}
			const id = await new Promise<string>((resolve, reject) => {
				const timer = setTimeout(() => {
					this._pendingOpenTab = undefined;
					reject(new Error('Timed out waiting for agents-window browser view.'));
				}, 10_000);
				this._pendingOpenTab = { resolve, reject, timer };
				this.requestWorkspacePanel('browser', url);
			});
			ipcRenderer.send(replyChannel, id);
		} catch (e) {
			this.logService.warn('[AgentWindow] agentOpenTab failed:', e);
			ipcRenderer.send(replyChannel, '');
		}
	}

	/**
	 * The shared workbench keybinding listener is attached to every VS Code
	 * auxiliary window, so a shortcut pressed in the Agents window is dispatched
	 * against the main IDE's singletons. Most Orbit commands are safe (they act on
	 * shared chat state), but workbench layout/navigation commands — Toggle Panel,
	 * Focus Side Bar, Open Terminal, editor-group focus, etc. — only know about the
	 * main window's parts and pull the user back into the IDE.
	 *
	 * We resolve the incoming event with `softDispatch` (a pure, side-effect-free
	 * resolve that honors the target's `when` context, user remaps and non-US
	 * keyboard layouts) and, if it maps to a blocked command, consume the event in
	 * the capture phase before the shared listener (which runs in the bubble phase
	 * on this same window) can dispatch it.
	 */
	private registerMainWorkbenchCommandGuard(aux: IAuxiliaryWindow, disposables: DisposableStore): void {
		disposables.add(addDisposableListener(aux.window, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			// Don't bail on `defaultPrevented`: the shared workbench listener runs in
			// the bubble phase and does NOT skip prevented events, so an earlier
			// capture-phase listener that only called preventDefault() (without
			// stopping propagation) would otherwise let a blocked command leak
			// through to the main window. IME composition still gets a pass.
			if (event.isComposing) {
				return;
			}

			// Never intercept the second key of a multi-key chord. `softDispatch` is
			// chord-aware, so mid-chord it can resolve to a blocked command; consuming
			// it with stopImmediatePropagation would prevent the shared listener from
			// clearing its chord state, wedging the (singleton) keybinding service in
			// chord mode for ~5s and swallowing subsequent shortcuts in BOTH windows.
			// Blocked commands are single-chord layout shortcuts anyway, so letting a
			// rare chord-bound one through is far cheaper than corrupting chord state.
			if (this.keybindingService.inChordMode) {
				return;
			}

			// Hot-path fast-out: plain character typing (no Ctrl/Meta/Alt, single
			// printable key) can never map to a blocked workbench command, so skip the
			// keybinding resolution entirely while the user types into the chat input.
			// Function keys ('F6'), arrows, Escape, etc. have multi-char `key` values
			// and modified combos still carry a modifier, so both remain intercepted.
			if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
				return;
			}

			const keyEvent = new StandardKeyboardEvent(event);
			const resolution = this.keybindingService.softDispatch(keyEvent, keyEvent.target);
			if (resolution.kind !== ResultKind.KbFound) {
				return;
			}

			const commandId = resolution.commandId;
			if (!shouldBlockCommandInAgentWindow(commandId)) {
				return;
			}

			// The shared keybinding listener is attached to this same window. A
			// normal stopPropagation() would not prevent that sibling listener, so
			// use stopImmediatePropagation() after preventing the browser default.
			event.preventDefault();
			event.stopImmediatePropagation();

			// A few "toggle the side list" shortcuts have a natural analog in the
			// Agents window: instead of a dead no-op, drive its own local chat-history
			// sidebar so the shortcut still feels responsive.
			if (commandId && AGENT_WINDOW_LOCAL_SIDEBAR_COMMAND_IDS.has(commandId)) {
				this.toggleSidebar();
			}
		}, true));
	}

	private async mountReact(aux: IAuxiliaryWindow, sidebarPane: HTMLElement, mainPane: HTMLElement, tooltipContainer: HTMLElement, workspacePane: HTMLElement, disposables: DisposableStore): Promise<void> {
		try {
			const agentWindowMod = await import('./react/out/agent-window-tsx/index.js');

			// Window was closed while we were dynamically importing.
			if (this.auxWindow !== aux) {
				return;
			}

			// The agent-window-tsx bundle calls `styleInject(css)` on import, which
			// appends a <style> with the `.void-scope` Tailwind utilities to the MAIN
			// window's <head>. The aux window's MutationObserver should clone it, but
			// there can be a race between the observer callback and the React render.
			// To guarantee the styles are available in the aux window before React
			// renders, we explicitly clone any new <style> elements that contain
			// `.void-scope` rules from the main window into the aux window's <head>.
			this.ensureVoidScopeStyles(aux);
			this.ensureEditorTokenStyles(aux, disposables);

		// _registerServices must be called with a ServicesAccessor so the
		// agent-window-tsx bundle's module-level accessor/state get bound.
		const mountDisposeFn = this.instantiationService.invokeFunction((accessor: ServicesAccessor) => {
			try {
				const mount = agentWindowMod.mountAgentWindow(
					{
						sidebarEl: sidebarPane,
						mainEl: mainPane,
						tooltipEl: tooltipContainer,
						workspaceEl: workspacePane,
					},
					accessor,
				);
				return mount && typeof mount.dispose === 'function' ? mount.dispose : undefined;
			} catch (err) {
				this.logService.error('[AgentWindow] mountAgentWindow threw during mount', err);
				console.error('[AgentWindow] mountAgentWindow threw during mount', err);
				// Never leave a silently-blank window: surface the failure in the pane
				// so it's visible and diagnosable instead of an all-white window.
				try {
					mainPane.textContent = '';
					const msg = mainPane.ownerDocument.createElement('div');
					msg.className = 'agent-window-mount-error';
					msg.textContent = `The agents view failed to load. ${String((err as Error)?.message ?? err)}`;
					mainPane.appendChild(msg);
				} catch { /* ignore */ }
				return undefined;
			}
		});

			if (mountDisposeFn) {
				// If the window closed during the synchronous invokeFunction above,
				// dispose the mount immediately to avoid a leak.
				if (this.auxWindow !== aux) {
					try { mountDisposeFn(); } catch (err) { this.logService.error('[AgentWindow] mount dispose after close failed', err); }
				} else {
					this.mountDisposeFns.push(mountDisposeFn);
				}
			}

			// Trigger a layout so the React components can measure their containers.
			aux.layout();

			// Re-clone styles after a microtask — the styleInject from the dynamic
			// import may have added new <style> nodes to the main window's <head>
			// AFTER our initial clone above ran (the import() promise resolves,
			// then the synchronous styleInject calls execute). This second pass
			// catches any that were missed.
			setTimeout(() => {
				if (this.auxWindow !== aux) {
					return;
				}
				this.ensureVoidScopeStyles(aux);
				this.ensureEditorTokenStyles(aux, disposables);
				aux.layout();
			}, 0);
		} catch (err) {
			this.logService.error('[AgentWindow] failed to mount React bundles', err);
			this.closeWindow();
			this.handleClosed();
		}
	}

	/**
	 * Force the auxiliary window to re-rasterize the whole agents shell once,
	 * after both the (synchronous) shell DOM and the (async) React portals are
	 * mounted.
	 *
	 * WHY THIS IS NEEDED: `delegateNodeFactories` makes every node in this window
	 * — the shell headers AND all four React portal subtrees — an element created
	 * by the MAIN window's `document` that is then adopted into the auxiliary
	 * window's render tree. Chromium routinely misses the *initial compositor
	 * raster* for such cross-document adopted nodes: layout is correct and the
	 * nodes are hit-testable (so hovering "reveals" them), but the window shows a
	 * stale white frame until some later invalidation (a hover, a resize) dirties
	 * each tile. The existing `aux.layout()` / `sizeShell` calls only dirty
	 * *layout*, not the compositor raster, so they do not clear it.
	 *
	 * Detaching and immediately re-attaching the shell subtree (display none →
	 * back, with a forced reflow in between so the toggle is actually observed)
	 * pulls the subtree out of the aux render tree and re-inserts it, which forces
	 * a fresh full paint. Run on the aux window's own animation frame so it lands
	 * after the current commit.
	 */
	private forceShellRepaint(aux: IAuxiliaryWindow): void {
		if (this.auxWindow !== aux) {
			return;
		}
		const win = aux.window;

		// Renderer-side toggle: detach + re-attach the shell subtree so Chromium
		// re-rasters the adopted nodes. This clears the stale white in most cases,
		// but is NOT sufficient alone — the aux window's ROOT compositor layer keeps
		// its already-presented white backing store, and toggling a child subtree
		// does not always dirty it. Double rAF: the first frame lets the just-mounted
		// React commit flush; the toggle runs at the start of the next frame.
		win.requestAnimationFrame(() => {
			win.requestAnimationFrame(() => {
				const shell = this.shellEl;
				if (this.auxWindow !== aux || !shell || !shell.isConnected) {
					return;
				}
				try {
					const prev = shell.style.display;
					shell.style.display = 'none';
					// Read a layout property to force the "display: none" state to
					// flush before we revert it — otherwise the browser coalesces
					// both writes and never detaches the subtree.
					void shell.offsetHeight;
					shell.style.display = prev;
					void shell.offsetHeight;
				} catch (err) {
					this.logService.error('[AgentWindow] forceShellRepaint failed', err);
				}
				// After the renderer toggle, force a native full repaint of the whole
				// window so the ROOT compositor layer re-rasters too.
				this.invalidateNativeWindow(aux);
			});
		});

		// Throttle-proof fallback: `requestAnimationFrame` can be starved while the
		// child window is still being shown/composited for the first time — exactly
		// when the white first-paint happens — so the rAF chain above may not run
		// until the user interacts. Native repaints are scheduled separately via
		// `scheduleNativeRepaints` once content is ready.
	}

	/**
	 * After shell + React portals are mounted, run a coordinated layout + repaint
	 * pass so the aux window paints on first open without requiring a manual resize.
	 */
	private scheduleContentReadyRepaint(aux: IAuxiliaryWindow, disposables: DisposableStore): void {
		if (this.auxWindow !== aux) {
			return;
		}

		this.ensureVoidScopeStyles(aux);
		this.ensureEditorTokenStyles(aux, disposables);
		try { aux.layout(); } catch { /* best-effort */ }

		try {
			const win = aux.window;
			win.dispatchEvent(new win.Event('resize'));
		} catch {
			// ignore
		}

		this.forceShellRepaint(aux);
		this.revealAuxiliaryWindow(aux);
		this.scheduleNativeRepaints(aux, disposables);

		// One more repaint once layout reports real dimensions (covers the case where
		// innerWidth is valid but the container rect was still 0 on the first pass).
		const layoutRepaint = aux.onDidLayout(({ width, height }) => {
			if (width > 0 && height > 0) {
				layoutRepaint.dispose();
				this.forceShellRepaint(aux);
				this.revealAuxiliaryWindow(aux);
			}
		});
		disposables.add(layoutRepaint);

		// Late styleInject from the dynamic import can land after the first repaint.
		const lateStyleTimer = setTimeout(() => {
			if (this.auxWindow !== aux) {
				return;
			}
			this.ensureVoidScopeStyles(aux);
			this.ensureEditorTokenStyles(aux, disposables);
			try { aux.layout(); } catch { /* best-effort */ }
			this.forceShellRepaint(aux);
			this.revealAuxiliaryWindow(aux);
		}, 0);
		disposables.add(toDisposable(() => clearTimeout(lateStyleTimer)));
	}

	/** Stagger native 1px-resize invalidations to survive slow cold-start compositing. */
	private scheduleNativeRepaints(aux: IAuxiliaryWindow, disposables: DisposableStore): void {
		for (const delay of [0, 50, 150, 400, 800, 1500]) {
			const timer = setTimeout(() => this.invalidateNativeWindow(aux), delay);
			disposables.add(toDisposable(() => clearTimeout(timer)));
		}
	}

	/**
	 * Reveal a deferred auxiliary window and force a native compositor repaint.
	 */
	private revealAuxiliaryWindow(aux: IAuxiliaryWindow): void {
		if (this.auxWindow !== aux) {
			return;
		}
		const targetWindowId = aux.window.vscodeWindowId;
		if (typeof targetWindowId !== 'number') {
			return;
		}
		this.nativeHostService.showAuxiliaryWindow({ targetWindowId }).catch(err => {
			this.logService.error('[AgentWindow] showAuxiliaryWindow failed', err);
		});
	}

	/**
	 * Ask the main process to schedule a full native repaint of the aux window,
	 * clearing the stale white first-paint that Chromium leaves for cross-document
	 * adopted node subtrees.
	 */
	private invalidateNativeWindow(aux: IAuxiliaryWindow): void {
		if (this.auxWindow !== aux) {
			return;
		}
		const targetWindowId = aux.window.vscodeWindowId;
		if (typeof targetWindowId !== 'number') {
			return;
		}
		this.nativeHostService.invalidateWindow({ targetWindowId }).catch(err => {
			this.logService.error('[AgentWindow] invalidateNativeWindow failed', err);
		});
	}

	/**
	 * Re-point the auxiliary document's node-creation methods at the MAIN
	 * document. `createContainer` in the aux-window service replaces
	 * `createElement` with a function that throws; React (via `createPortal`)
	 * calls `ownerDocument.createElement` when committing children into the aux
	 * panes, so without this delegation the portal render throws and both panes
	 * render blank. Binding to the main document makes every created node a
	 * main-window element, preserving the `instanceof HTMLElement` invariant the
	 * guard was protecting while letting React build its trees.
	 */
	private delegateNodeFactories(aux: IAuxiliaryWindow): void {
		const auxDoc = aux.window.document as Document;
		const mainDoc = mainWindow.document;
		auxDoc.createElement = mainDoc.createElement.bind(mainDoc);
		auxDoc.createElementNS = mainDoc.createElementNS.bind(mainDoc) as Document['createElementNS'];
		auxDoc.createTextNode = mainDoc.createTextNode.bind(mainDoc);
		auxDoc.createComment = mainDoc.createComment.bind(mainDoc);
		auxDoc.createDocumentFragment = mainDoc.createDocumentFragment.bind(mainDoc);
	}

	/**
	 * Clone any `<style>` elements from the main window's `<head>` that contain
	 * `.void-scope` CSS rules into the aux window's `<head>`, if they haven't
	 * been cloned already. This guarantees the Tailwind-scoped styles that
	 * ChatHistory/Sidebar depend on are available in the aux window.
	 */
	private ensureVoidScopeStyles(aux: IAuxiliaryWindow): void {
		const auxDoc = aux.window.document;
		const mainHead = mainWindow.document.head;

		// Collect existing style text in the aux window to detect duplicates.
		const existingAuxStyles = new Set<string>();
		for (const style of auxDoc.head.querySelectorAll('style')) {
			if (style.textContent) {
				existingAuxStyles.add(style.textContent.trim().slice(0, 200));
			}
		}

		for (const style of mainHead.querySelectorAll('style')) {
			const text = style.textContent;
			if (!text || !text.includes('.void-scope')) {
				continue;
			}
			// Skip if this style is already cloned in the aux window.
			const fingerprint = text.trim().slice(0, 200);
			if (existingAuxStyles.has(fingerprint)) {
				continue;
			}
			const clone = auxDoc.createElement('style');
			clone.type = 'text/css';
			clone.textContent = text;
			auxDoc.head.appendChild(clone);
		}
	}

	/**
	 * Ensure Monaco TextMate token color rules (`.mtkN { color: ... }`) are present
	 * and kept in sync in the Agents auxiliary window.
	 *
	 * Why this is required: React/Monaco nodes are created via the main document
	 * and then adopted into the aux render tree, so computed styles come from the
	 * *aux* document. VS Code clones global stylesheets on aux open, but the
	 * `vscode-tokens-styles` sheet (written via `textContent` by
	 * TextMateTokenizationFeature) has historically been missing or stale in this
	 * window — leaving the workspace file editor monochrome while the main IDE
	 * editor highlights correctly. We forcibly mirror the sheet and observe it for
	 * theme changes for the lifetime of the Agents window.
	 */
	private ensureEditorTokenStyles(aux: IAuxiliaryWindow, disposables: DisposableStore): void {
		const TOKEN_STYLE_CLASS = 'vscode-tokens-styles';
		const ORBIT_TOKEN_STYLE_CLASS = 'orbit-agent-tokens-styles';
		const auxDoc = aux.window.document;
		const mainDoc = mainWindow.document;

		const readMainTokenCss = (): string => {
			const mainStyle = mainDoc.head.querySelector(`style.${TOKEN_STYLE_CLASS}`) as HTMLStyleElement | null;
			return mainStyle?.textContent ?? '';
		};

		const apply = (): void => {
			const css = readMainTokenCss();
			if (!css) {
				return;
			}

			// Prefer updating VS Code's own cloned sheet when present.
			let target = auxDoc.head.querySelector(`style.${TOKEN_STYLE_CLASS}`) as HTMLStyleElement | null;
			if (!target) {
				target = auxDoc.head.querySelector(`style.${ORBIT_TOKEN_STYLE_CLASS}`) as HTMLStyleElement | null;
			}
			if (!target) {
				// After delegateNodeFactories, aux createElement is bound to the main
				// document; appending into aux head adopts the node into the aux tree
				// so the rules style Monaco content painted there.
				target = auxDoc.createElement('style');
				target.type = 'text/css';
				target.className = `${TOKEN_STYLE_CLASS} ${ORBIT_TOKEN_STYLE_CLASS}`;
				auxDoc.head.appendChild(target);
			}
			if (target.textContent !== css) {
				target.textContent = css;
			}
		};

		apply();

		// Idempotent: only attach one live sync observer per Agents window lifetime.
		if (this._editorTokenStylesSynced) {
			return;
		}
		this._editorTokenStylesSynced = true;
		disposables.add(toDisposable(() => { this._editorTokenStylesSynced = false; }));

		const mainStyle = mainDoc.head.querySelector(`style.${TOKEN_STYLE_CLASS}`);
		if (mainStyle) {
			disposables.add(sharedMutationObserver.observe(mainStyle, disposables, { childList: true, characterData: true, subtree: true })(() => {
				if (this.auxWindow === aux) {
					apply();
				}
			}));
		}

		// Also catch the rare case where the token style node is replaced entirely.
		disposables.add(sharedMutationObserver.observe(mainDoc.head, disposables, { childList: true })(mutations => {
			if (this.auxWindow !== aux) {
				return;
			}
			for (const mutation of mutations) {
				for (const node of mutation.addedNodes) {
					if (node instanceof HTMLStyleElement && node.classList.contains(TOKEN_STYLE_CLASS)) {
						apply();
						disposables.add(sharedMutationObserver.observe(node, disposables, { childList: true, characterData: true, subtree: true })(() => {
							if (this.auxWindow === aux) {
								apply();
							}
						}));
					}
				}
			}
		}));
	}

	toggleSidebar(): void {
		if (!this.shellEl) {
			return;
		}
		const collapsed = this.shellEl.classList.toggle('sidebar-collapsed');
		this.updateSidebarToggleState();
		this.storageService.store(STORAGE_SIDEBAR_COLLAPSED, collapsed, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this.auxWindow?.layout();
	}

	toggleWorkspace(): void {
		if (!this.shellEl) {
			return;
		}
		const collapsed = this.shellEl.classList.toggle('workspace-collapsed');
		this.updateWorkspaceToggleState();
		this.storageService.store(STORAGE_WORKSPACE_COLLAPSED, collapsed, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this.auxWindow?.layout();
	}

	requestWorkspacePanel(kind: WorkspacePanelKind, resource?: string): void {
		if (!this.shellEl) {
			// Window not open — nothing to route to. (Callers only invoke this from
			// inside the agents window, so this is a defensive no-op.)
			return;
		}
		// Make sure the workspace column is visible so the opened panel is seen.
		if (this.shellEl.classList.contains('workspace-collapsed')) {
			this.shellEl.classList.remove('workspace-collapsed');
			this.updateWorkspaceToggleState();
			this.storageService.store(STORAGE_WORKSPACE_COLLAPSED, false, StorageScope.APPLICATION, StorageTarget.MACHINE);
			this.auxWindow?.layout();
		}
		if (this._onDidRequestWorkspacePanel.hasListeners()) {
			this._onDidRequestWorkspacePanel.fire({ kind, resource });
		} else {
			// The React workspace hasn't subscribed yet (async mount). Queue the
			// request; AgentWorkspace drains the queue right after subscribing.
			this._pendingPanelRequests.push({ kind, resource });
		}
	}

	consumePendingWorkspacePanelRequests(): { kind: WorkspacePanelKind; resource?: string }[] {
		const pending = this._pendingPanelRequests;
		this._pendingPanelRequests = [];
		return pending;
	}

	// ----- divider drag -----------------------------------------------------

	private registerDividerDrag(
		aux: IAuxiliaryWindow,
		divider: HTMLElement,
		pane: HTMLElement,
		opts: { min: number; max: number; invert?: boolean; save: (width: number) => void; read: () => number },
	): IDisposable {
		const store = new DisposableStore();
		const win = aux.window;
		const { min, max, invert = false, save } = opts;
		// A right-edge pane (workspace) grows when the divider is dragged LEFT, so the
		// pointer delta is negated. The sidebar (left-edge pane) grows dragging right.
		const sign = invert ? -1 : 1;

		let dragging = false;
		let startX = 0;
		let startWidth = 0;

		const clamp = (n: number) => Math.max(min, Math.min(max, n));

		const onMove = (e: PointerEvent) => {
			if (!dragging) {
				return;
			}
			const delta = (e.clientX - startX) * sign;
			const next = clamp(startWidth + delta);
			pane.style.width = `${next}px`;
			this.updateDividerAriaValue(divider, next, min, max);
		};
		const endDrag = () => {
			if (!dragging) {
				return;
			}
			dragging = false;
			this._dividerDragActive = Math.max(0, this._dividerDragActive - 1);
			divider.classList.remove('dragging');
			save(pane.getBoundingClientRect().width);
		};

		const onDown = (e: PointerEvent) => {
			if (e.button !== 0) {
				return;
			}
			dragging = true;
			this._dividerDragActive++;
			startX = e.clientX;
			startWidth = pane.getBoundingClientRect().width;
			divider.classList.add('dragging');
			// Best-effort: capture the pointer for a consistent cursor/hover state while
			// dragging. Wrapped in try/catch because if this throws or is a no-op in some
			// Electron/Chromium build, the window-level pointermove/pointerup listeners
			// below (not element-scoped) still track and end the drag correctly regardless
			// — unlike depending on capture alone, which would strand the divider in
			// 'dragging' state if the pointer slips off the thin strip before release.
			try { divider.setPointerCapture(e.pointerId); } catch { /* ignore */ }
			e.preventDefault();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			const current = pane.getBoundingClientRect().width;
			const step = e.shiftKey ? 40 : 20;
			let next: number | undefined;
			switch (e.key) {
				// Arrow keys grow/shrink the pane; invert them for a right-edge pane so
				// the direction matches the visual edge the divider sits on.
				case 'ArrowLeft': next = current + (invert ? step : -step); break;
				case 'ArrowRight': next = current + (invert ? -step : step); break;
				case 'Home': next = min; break;
				case 'End': next = max; break;
			}
			if (next === undefined) {
				return;
			}
			next = clamp(next);
			pane.style.width = `${next}px`;
			this.updateDividerAriaValue(divider, next, min, max);
			save(next);
			EventHelper.stop(e, true);
		};
		divider.addEventListener('pointerdown', onDown);
		// pointermove/pointerup are attached at the window level (not the divider) so the
		// drag keeps tracking and ENDS correctly even if setPointerCapture above throws,
		// is a no-op, or the pointer simply outruns the thin divider strip — mirroring the
		// old window-scoped mousemove/mouseup behavior instead of depending on capture.
		win.addEventListener('pointermove', onMove);
		win.addEventListener('pointerup', endDrag);
		win.addEventListener('pointercancel', endDrag);
		divider.addEventListener('lostpointercapture', endDrag);
		divider.addEventListener('keydown', onKeyDown);
		// Safety net: end the drag if the window deactivates mid-drag (Cmd+Tab).
		win.addEventListener('blur', endDrag);
		this.updateDividerAriaValue(divider, opts.read(), min, max);

		store.add(toDisposable(() => {
			divider.removeEventListener('pointerdown', onDown);
			win.removeEventListener('pointermove', onMove);
			win.removeEventListener('pointerup', endDrag);
			win.removeEventListener('pointercancel', endDrag);
			divider.removeEventListener('lostpointercapture', endDrag);
			divider.removeEventListener('keydown', onKeyDown);
			win.removeEventListener('blur', endDrag);
		}));
		return store;
	}

	// ----- lifecycle / cleanup ---------------------------------------------

	private closeWindow(): void {
		try {
			this.auxWindow?.dispose();
		} catch {
			// ignore
		}
	}

	private handleClosed(): void {
		if (!this.auxWindow && this.mountDisposeFns.length === 0 && !this.windowDisposables) {
			return;
		}

		void this.teardownAuxBrowserViews();

		if (this._pendingOpenTab) {
			clearTimeout(this._pendingOpenTab.timer);
			this._pendingOpenTab.reject(new Error('Agents window closed.'));
			this._pendingOpenTab = undefined;
		}
		this._browserViews.clear();
		this._pendingPanelRequests = [];
		this._openTabChain = Promise.resolve();

		// React unmount (below) runs every panel's effect cleanup. Without this
		// flag the TerminalPanel cleanups would treat window teardown like a tab
		// close — killing each pty (or orphaning it, unreattachably, when it has
		// children) and dropping its store entry, so terminals never survived a
		// window close/reopen or a graceful IDE quit. With the flag they detach
		// and KEEP the entry; resetReattachSession() then allows the next window
		// open to reattach the still-alive shells.
		this.terminalStore.setWindowTeardown(true);
		try {
			for (const dispose of this.mountDisposeFns) {
				try { dispose(); } catch (err) { this.logService.error('[AgentWindow] mount dispose failed', err); }
			}
		} finally {
			this.terminalStore.setWindowTeardown(false);
			this.terminalStore.resetReattachSession();
		}
		this.mountDisposeFns = [];

		this.windowDisposables?.dispose();
		this.windowDisposables = undefined;

		this.auxWindow = undefined;
		this.shellEl = undefined;
		this.sidebarToggleEl = undefined;
		this.sidebarToggleAltEl = undefined;
		this.workspaceToggleEl = undefined;
		this.chatTitleEl = undefined;

		this._onDidChangeState.fire();
	}

	/** Close native browser views owned by the agents pop-out so they cannot leak. */
	private async teardownAuxBrowserViews(): Promise<void> {
		const auxId = this.getAuxiliaryWindowId();
		if (auxId === undefined || this._browserViews.size === 0) {
			return;
		}
		const bv = ProxyChannel.toService<IBrowserViewService>(
			this.mainProcessService.getChannel('browserView'),
			{ context: auxId },
		);
		const count = this._browserViews.size;
		for (const id of [...this._browserViews.keys()]) {
			try {
				await bv.setVisible(id, false);
				await bv.close(id);
			} catch (err) {
				this.logService.warn(`[AgentWindow] failed to close browser view ${id}`, err);
			}
		}
		this.logService.trace(`[AgentWindow] teardownAuxBrowserViews closed ${count} browser view(s).`);
	}

	override dispose(): void {
		this.handleClosed();
		super.dispose();
	}

	// ----- helpers ----------------------------------------------------------

	private onClick(el: HTMLElement, handler: () => void): IDisposable {
		return addDisposableListener(el, 'click', (e) => {
			EventHelper.stop(e);
			handler();
		});
	}

	private updateSidebarToggleState(): void {
		const collapsed = this.shellEl?.classList.contains('sidebar-collapsed') ?? false;
		for (const el of [this.sidebarToggleEl, this.sidebarToggleAltEl]) {
			if (!el) {
				continue;
			}
			el.setAttribute('aria-pressed', String(!collapsed));
			el.title = collapsed ? 'Show chat history' : 'Hide chat history';
			el.setAttribute('aria-label', el.title);
		}
	}

	/** Reflect the active thread's title in the chat header (matches the history list). */
	private updateChatTitle(): void {
		if (!this.chatTitleEl) {
			return;
		}
		let title = 'New Chat';
		try {
			const threadId = this.chatThreadService.getSelectedThreadId(true);
			const thread = threadId ? this.chatThreadService.getThread(threadId) : undefined;
			const firstUser = thread?.messages?.find(m => m.role === 'user');
			const content = firstUser && firstUser.role === 'user' ? firstUser.displayContent : undefined;
			if (content && content.trim()) {
				title = content.trim();
			}
		} catch { /* best-effort */ }
		this.chatTitleEl.textContent = title;
		this.chatTitleEl.title = title;
	}


	private updateWorkspaceToggleState(): void {
		const collapsed = this.shellEl?.classList.contains('workspace-collapsed') ?? false;
		this.workspaceToggleEl?.setAttribute('aria-pressed', String(!collapsed));
		if (this.workspaceToggleEl) {
			this.workspaceToggleEl.title = collapsed ? 'Show workspace' : 'Hide workspace';
			this.workspaceToggleEl.setAttribute('aria-label', this.workspaceToggleEl.title);
		}
	}

	private updateDividerAriaValue(divider: HTMLElement, width: number, min: number, max: number): void {
		const isWorkspace = divider.classList.contains('agent-window-workspace-divider');
		divider.setAttribute('aria-valuemin', String(min));
		divider.setAttribute('aria-valuemax', String(max));
		divider.setAttribute('aria-valuenow', String(Math.round(width)));
		divider.setAttribute('aria-valuetext', `${isWorkspace ? 'Workspace' : 'Chat history'} width: ${Math.round(width)} pixels`);
	}

	// ----- persistence ------------------------------------------------------

	private readBounds(): Partial<IRectangle> {
		const raw = this.storageService.get(STORAGE_BOUNDS, StorageScope.APPLICATION);
		if (raw) {
			try {
				const parsed = JSON.parse(raw) as IRectangle;
				if (typeof parsed.width === 'number' && typeof parsed.height === 'number') {
					return parsed;
				}
			} catch {
				// fall through
			}
		}
		return DEFAULT_BOUNDS;
	}

	private saveBounds(): void {
		const win = this.auxWindow?.window;
		if (!win) {
			return;
		}
		const bounds: IRectangle = {
			x: win.screenX,
			y: win.screenY,
			width: win.outerWidth,
			height: win.outerHeight,
		};
		if (bounds.width <= 0 || bounds.height <= 0) {
			return;
		}
		this.storageService.store(STORAGE_BOUNDS, JSON.stringify(bounds), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private readSidebarWidth(): number {
		const n = this.storageService.getNumber(STORAGE_SIDEBAR_WIDTH, StorageScope.APPLICATION, SIDEBAR_DEFAULT);
		return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, n));
	}

	private saveSidebarWidth(width: number): void {
		const clamped = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(width)));
		this.storageService.store(STORAGE_SIDEBAR_WIDTH, clamped, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private readSidebarCollapsed(): boolean {
		return this.storageService.getBoolean(STORAGE_SIDEBAR_COLLAPSED, StorageScope.APPLICATION, false);
	}

	private readWorkspaceWidth(): number {
		const n = this.storageService.getNumber(STORAGE_WORKSPACE_WIDTH, StorageScope.APPLICATION, WORKSPACE_DEFAULT);
		return Math.max(WORKSPACE_MIN, Math.min(WORKSPACE_MAX, n));
	}

	private saveWorkspaceWidth(width: number): void {
		const clamped = Math.max(WORKSPACE_MIN, Math.min(WORKSPACE_MAX, Math.round(width)));
		this.storageService.store(STORAGE_WORKSPACE_WIDTH, clamped, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private readWorkspaceCollapsed(): boolean {
		// Default: workspace visible (shows the empty-state launcher) so the pop-out
		// reads as a full agent workspace, matching the reference design.
		return this.storageService.getBoolean(STORAGE_WORKSPACE_COLLAPSED, StorageScope.APPLICATION, false);
	}
}

registerSingleton(IAgentWindowService, AgentWindowService, InstantiationType.Delayed);
