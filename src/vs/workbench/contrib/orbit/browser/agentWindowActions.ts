/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { $, addDisposableListener } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IAgentWindowService } from './agentWindowService.js';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const OPEN_AGENTS_WINDOW_ACTION_ID = 'orbit.action.openAgentsWindow';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_AGENTS_WINDOW_ACTION_ID,
			title: { value: 'Open Agents Window', original: 'Open Agents Window' },
			f1: true,
			category: { value: 'Orbit', original: 'Orbit' },
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IAgentWindowService).open();
	}
});

// ---------------------------------------------------------------------------
// Main-window title-bar pill button
// ---------------------------------------------------------------------------

const TITLEBAR_RIGHT_SELECTOR = '.monaco-workbench .part.titlebar > .titlebar-container > .titlebar-right';

export class AgentWindowTitlebarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.agentWindowTitlebarPill';

	private pill: HTMLButtonElement | undefined;
	private observer: MutationObserver | undefined;
	private retryTimer: number | undefined;
	private readonly pillDisposables = this._register(new DisposableStore());

	constructor(
		@IAgentWindowService private readonly agentWindowService: IAgentWindowService,
	) {
		super();

		// Single state subscription for the lifetime of the contribution —
		// avoids re-registering listeners every time the pill is re-injected.
		this._register(this.agentWindowService.onDidChangeState(() => this.updateActiveState()));

		// One cleanup for the (reused) retry timer and observer — registering a
		// fresh toDisposable per retry tick / per titlebar recreation accumulated
		// dead wrappers on the permanent store for the workbench's lifetime.
		this._register(toDisposable(() => {
			if (this.retryTimer !== undefined) {
				mainWindow.clearTimeout(this.retryTimer);
				this.retryTimer = undefined;
			}
			this.observer?.disconnect();
			this.observer = undefined;
		}));

		this.tryInject(0);
	}

	private tryInject(attempt: number): void {
		if (this._store.isDisposed) {
			return;
		}

		const rightContent = mainWindow.document.querySelector(TITLEBAR_RIGHT_SELECTOR) as HTMLElement | null;
		if (!rightContent) {
			if (attempt < 60) {
				if (this.retryTimer !== undefined) {
					mainWindow.clearTimeout(this.retryTimer);
				}
				this.retryTimer = mainWindow.setTimeout(() => {
					this.retryTimer = undefined;
					this.tryInject(attempt + 1);
				}, 100);
			}
			return;
		}

		this.inject(rightContent);
		this.watchTitlebar(rightContent);
	}

	private inject(rightContent: HTMLElement): void {
		// Reset any previous pill bindings (e.g. after the pill was removed by VS Code
		// and we are about to re-create it).
		this.pillDisposables.clear();

		const existing = rightContent.querySelector(':scope > .agent-window-pill') as HTMLButtonElement | null;
		let pill: HTMLButtonElement;
		if (existing) {
			pill = existing;
		} else {
			pill = $('button.agent-window-pill') as HTMLButtonElement;
			pill.type = 'button';
			pill.title = 'Open the standalone Agents window';
			pill.setAttribute('aria-label', 'Open Agents Window');
			pill.appendChild($('span.agent-window-pill-label', undefined, 'Agents Window'));
			pill.appendChild($('span.codicon.codicon-link-external.agent-window-pill-icon'));
			this.placePill(rightContent, pill);
		}

		this.pill = pill;

		this.pillDisposables.add(addDisposableListener(pill, 'click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.agentWindowService.open();
		}));

		this.pillDisposables.add(toDisposable(() => {
			if (pill.parentElement) {
				pill.remove();
			}
		}));

		this.updateActiveState();
	}

	private placePill(rightContent: HTMLElement, pill: HTMLButtonElement): void {
		const windowControls = rightContent.querySelector(':scope > .window-controls-container');
		if (windowControls) {
			rightContent.insertBefore(pill, windowControls);
			return;
		}
		rightContent.appendChild(pill);
	}

	private watchTitlebar(rightContent: HTMLElement): void {
		// Disconnect any previous observer before creating a new one so we
		// don't leak observers when the titlebar is re-created.
		this.observer?.disconnect();

		const observer = new MutationObserver(() => {
			if (!rightContent.isConnected) {
				this.pill = undefined;
				this.pillDisposables.clear();
				this.tryInject(0);
				return;
			}
			if (!rightContent.querySelector(':scope > .agent-window-pill')) {
				this.pill = undefined;
				this.inject(rightContent);
			}
		});

		this.observer = observer;
		observer.observe(rightContent, { childList: true });
	}

	private updateActiveState(): void {
		this.pill?.classList.toggle('active', this.agentWindowService.isOpen());
	}
}

registerWorkbenchContribution2(AgentWindowTitlebarContribution.ID, AgentWindowTitlebarContribution, WorkbenchPhase.AfterRestored);
