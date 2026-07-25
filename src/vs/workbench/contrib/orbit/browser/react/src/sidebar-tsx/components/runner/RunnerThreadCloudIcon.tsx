/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Server } from 'lucide-react';

/** Visual badge for threads/messages that ran on a Self-hosted Runner (matches ExecutionTargetPicker). */
export const RunnerThreadCloudIcon = ({
	size = 12,
	className = '',
	title,
}: {
	size?: number;
	className?: string;
	/** Defaults to Self-hosted Runner; optional runner name appended. */
	title?: string;
}) => (
	<Server
		size={size}
		strokeWidth={1.75}
		className={`flex-shrink-0 opacity-60 ${className}`}
		data-tooltip-id="void-tooltip"
		data-tooltip-place="top"
		data-tooltip-content={title ?? 'Self-hosted Runner'}
	/>
);
