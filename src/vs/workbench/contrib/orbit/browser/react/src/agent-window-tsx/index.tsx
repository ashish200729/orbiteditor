/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0 See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import { AgentWindowPortal, AgentWindowPortalTargets } from './AgentWindowPortal.js';
import { _registerServices } from '../util/services.js';
import { ServicesAccessor } from '../../../../../../../editor/browser/editorExtensions.js';

/**
 * Mount agent-window React UI into auxiliary-window DOM targets using portals
 * from a hidden host root in the main renderer document.
 *
 * The agent-window-tsx bundle has its own module scope (tsup bundles services.tsx
 * into every entry point), so `_registerServices` MUST be called in this bundle's
 * module scope before any React component that calls `useAccessor()` renders.
 * The caller passes a `ServicesAccessor` obtained via `instantiationService.invokeFunction`.
 */
export const mountAgentWindow = (targets: AgentWindowPortalTargets, accessor: ServicesAccessor) => {
	if (typeof document === 'undefined') {
		console.error('[AgentWindow] mountAgentWindow: document was undefined');
		return;
	}

	// Register services in this bundle's module scope so useAccessor() works.
	// _registerServices is idempotent-safe per-bundle: calling it again just
	// re-binds the accessor and re-subscribes listeners; we dispose the previous
	// set when the window closes.
	const disposables = _registerServices(accessor);

	const host = document.createElement('div');
	host.className = 'agent-window-react-host';
	host.style.display = 'none';
	document.body.appendChild(host);

	const root = ReactDOM.createRoot(host);
	root.render(
		<AgentWindowPortal
			sidebarEl={targets.sidebarEl}
			mainEl={targets.mainEl}
			tooltipEl={targets.tooltipEl}
			workspaceEl={targets.workspaceEl}
		/>
	);

	return {
		dispose: () => {
			root.unmount();
			host.remove();
			disposables.forEach(d => d.dispose());
		},
	};
};
