/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React from 'react';
import { RunnerExecutionChrome } from './RunnerExecutionChrome.js';

/**
 * Compact "Run on" control for the main IDE agent sidebar (above the composer).
 * The Agents pop-out uses {@link AgentWorkspaceHeader} which includes workspace + run target.
 * Shown on the empty-thread landing page only — hidden after the first message.
 */
export const AgentChatRunHeader = ({ isAgentWindow = false }: { isAgentWindow?: boolean }) => (
	<RunnerExecutionChrome isAgentWindow={isAgentWindow} />
);
