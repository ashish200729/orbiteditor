/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as React from 'react';
import type { ComponentType } from 'react';

/**
 * Neutral empty body used by panels whose real implementation lands in a later
 * phase. Keeps the tab strip + host fully functional so the shell can ship
 * independently.
 */
export const PanelPlaceholder = ({
	icon: Icon,
	label,
	detail,
}: {
	icon: ComponentType<{ size?: number | string; strokeWidth?: number | string; className?: string }>;
	label: string;
	detail: string;
}) => {
	return (
		<div className="agent-workspace-placeholder">
			<Icon size={22} strokeWidth={1.5} className="agent-workspace-placeholder-icon" />
			<div className="agent-workspace-placeholder-label">{label}</div>
			<div className="agent-workspace-placeholder-detail">{detail}</div>
		</div>
	);
};
