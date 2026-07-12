/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as React from 'react';
import { PANEL_METAS, PanelKind } from './workspaceTypes.js';

/**
 * Shown when the workspace has no open tabs. A 2×2 launcher grid of the four
 * panel kinds (Changes / Terminal / File / Browser). File opens the Cursor-style
 * editor surface with the side explorer tree.
 */
export const WorkspaceEmptyState = ({ onOpen }: { onOpen: (kind: PanelKind) => void }) => {
	return (
		<div className="agent-workspace-empty">
			<div className="agent-workspace-empty-grid">
				{PANEL_METAS.map(meta => {
					const Icon = meta.icon;
					return (
						<button
							key={meta.kind}
							type="button"
							className="agent-workspace-launch-card"
							onClick={() => onOpen(meta.kind)}
							title={meta.hint}
						>
							<Icon size={20} strokeWidth={1.6} className="agent-workspace-launch-icon" />
							<span className="agent-workspace-launch-label">{meta.label}</span>
						</button>
					);
				})}
			</div>
		</div>
	);
};
