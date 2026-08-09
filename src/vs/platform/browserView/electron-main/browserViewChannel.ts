/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) Orbit Editor. All rights reserved.
 *  Licensed under the Apache License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { BrowserViewMainService } from './browserViewMainService.js';
import { BrowserAutomationMainService } from './browserAutomationMainService.js';
import { isModelCdpMethodAllowed } from '../common/browserAutomationPure.js';

/**
 * IPC channel that exposes `BrowserViewMainService` to the renderer process.
 *
 * The renderer-side proxy is created with `context: nativeHostService.windowId`. Calls verify
 * that untrusted method arguments match the authenticated IPC connection context, and events
 * are filtered to views owned by that connection's window.
 *
 * Automation commands (attachDebugger, sendCdpCommand, listViews, getNavigationState) are
 * routed to `BrowserAutomationMainService`, which owns the CDP sessions and ref maps. The
 * browser-view service remains the single owner of `WebContentsView` lifetimes.
 */
export class BrowserViewChannel implements IServerChannel {

	constructor(
		private readonly service: BrowserViewMainService,
		private readonly automationService: BrowserAutomationMainService,
	) { }

	listen<T>(ctx: unknown, event: string, _arg?: any): Event<T> {
		const windowId = this.toWindowId(ctx);
		let source: Event<unknown>;
		switch (event) {
			case 'onDidNavigate':
				source = this.service.onDidNavigate;
				break;
			case 'onDidTitleChange':
				source = this.service.onDidTitleChange;
				break;
			case 'onDidFaviconChange':
				source = this.service.onDidFaviconChange;
				break;
			case 'onDidLoadingStateChange':
				source = this.service.onDidLoadingStateChange;
				break;
			case 'onDidClose':
				source = this.service.onDidClose;
				break;
			case 'onDidFocusView':
				source = this.service.onDidFocusView;
				break;
			case 'onDidBrowserShortcut':
				source = this.service.onDidBrowserShortcut;
				break;
			case 'onDidAutomationLockChange':
				source = this.automationService.onDidAutomationLockChange;
				break;
			default:
				throw new Error(`Event not found: ${event}`);
		}
		return Event.filter(source, value => {
			const id = typeof value === 'string' ? value : (value as { id?: unknown } | null)?.id;
			return typeof id === 'string' && this.service.getWindowIdForView(id) === windowId;
		}) as Event<T>;
	}

	async call(ctx: unknown, command: string, arg?: any): Promise<any> {
		// ProxyChannel.toService sends `arg = [context, ...methodArgs]` when a context is
		// configured. We normalize both array and single-value shapes.
		const args: any[] = Array.isArray(arg) ? arg : [arg];
		const windowId = this.toWindowId(ctx);
		if (typeof args[0] !== 'number' || args[0] !== windowId) {
			throw new Error('BrowserView request window context does not match its IPC connection.');
		}
		// `a(0)` returns the first *method* arg (skipping the context at args[0]).
		const a = (i: number) => args[i + 1];
		if (command === 'open') {
			const owner = this.service.getWindowIdForView(String(a(0) ?? ''));
			if (owner !== undefined && owner !== windowId) throw new Error('Browser view belongs to another window.');
		} else if (command !== 'listViews') {
			this.assertViewOwnedByWindow(windowId, String(a(0) ?? ''));
		}
		switch (command) {
			case 'open': {
				const id = a(0) as string;
				const options = a(1) as any;
				return this.service.open(windowId, id, options);
			}
			case 'close':
				return this.service.close(windowId, a(0));
			case 'navigate':
				return this.service.navigate(windowId, a(0), a(1));
			case 'goBack':
				return this.service.goBack(windowId, a(0));
			case 'goForward':
				return this.service.goForward(windowId, a(0));
			case 'reload':
				return this.service.reload(windowId, a(0));
			case 'stop':
				return this.service.stop(windowId, a(0));
			case 'setZoomFactor':
				return this.service.setZoomFactor(windowId, a(0), a(1));
			case 'getZoomFactor':
				return this.service.getZoomFactor(windowId, a(0));
			case 'findInPage':
				return this.service.findInPage(windowId, a(0), a(1), a(2));
			case 'stopFindInPage':
				return this.service.stopFindInPage(windowId, a(0));
			case 'setBounds':
				return this.service.setBounds(windowId, a(0), a(1));
			case 'setVisible':
				return this.service.setVisible(windowId, a(0), a(1));
			case 'focus':
				return this.service.focus(windowId, a(0));
			case 'blur':
				return this.service.blur(windowId, a(0));
			case 'setIgnoreMenuShortcuts':
				return this.service.setIgnoreMenuShortcuts(windowId, a(0), a(1));
			case 'bringToFront':
				return this.service.bringToFront(windowId, a(0));
			case 'executeJavaScript': {
				// Renderer consumers only use this legacy method to synchronize the
				// page color-scheme hint. Never forward arbitrary renderer-authored JS
				// into a cross-origin authenticated browser tab.
				const match = /document\.documentElement\.style\.colorScheme\s*=\s*["'](dark|light)["']/.exec(String(a(1) ?? ''));
				if (!match) throw new Error('Arbitrary browser JavaScript is not available through renderer IPC.');
				const safeScript = `(() => { try { document.documentElement.style.colorScheme = ${JSON.stringify(match[1])}; } catch {} return true; })()`;
				return this.service.executeJavaScript(windowId, a(0), safeScript);
			}
			case 'screenshot':
				return this.service.screenshot(windowId, a(0));
			case 'runPicker':
				return this.service.runPicker(windowId, a(0));
			case 'teardownPicker':
				return this.service.teardownPicker(windowId, a(0));
			// --- Automation passthroughs, still restricted to this window's views ---
			case 'listViews':
				return this.automationService.listViews().filter(view => view.windowId === windowId);
			case 'getNavigationState':
				return this.automationService.getNavigationState(a(0));
			case 'attachDebugger':
				return this.automationService.attachDebugger(a(0));
			case 'detachDebugger':
				return this.automationService.detachDebugger(a(0));
			case 'sendCdpCommand':
				if (!isModelCdpMethodAllowed(String(a(1) ?? ''))) {
					throw new Error(`CDP method '${String(a(1) ?? '')}' is not available through renderer IPC.`);
				}
				return this.automationService.sendCdpCommand(a(0), a(1), a(2));
			case 'setAutomationLocked':
				return this.automationService.setAutomationLocked(a(0), a(1) === true);
			case 'isAutomationLocked':
				return this.automationService.isAutomationLocked(a(0));
			default:
				throw new Error(`Call not found: ${command}`);
		}
	}

	private toWindowId(ctx: unknown): number {
		if (typeof ctx === 'string' && /^window:\d+$/.test(ctx)) {
			return Number(ctx.slice('window:'.length));
		}
		throw new Error('BrowserViewChannel requires a numeric windowId context');
	}

	private assertViewOwnedByWindow(windowId: number, id: string): void {
		if (!id || this.service.getWindowIdForView(id) !== windowId) {
			throw new Error('Browser view does not belong to the calling window.');
		}
	}

	dispose(): void {
		// Services own their own disposables; nothing to do here.
	}
}
