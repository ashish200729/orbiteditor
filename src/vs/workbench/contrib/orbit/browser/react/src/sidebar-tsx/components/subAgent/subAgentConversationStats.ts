/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

// Kept dependency-free (no `useAccessor`/tool-description imports) so this is directly
// unit-testable from test/common without pulling react-jsx-only modules into the plain-tsc
// test project. subAgentConversationHelpers.ts re-exports these for existing consumers.

import type React from 'react';
import { ChatMessage } from '../../../../../../common/chatThreadServiceTypes.js';

export type SubAgentExplorationStats = {
	fileCount: number;
	searchCount: number;
	toolCount: number;
};

export const computeSubAgentExplorationStats = (messages: readonly ChatMessage[]): SubAgentExplorationStats => {
	let fileCount = 0;
	let searchCount = 0;
	let toolCount = 0;

	for (const msg of messages) {
		if (msg.role !== 'tool') continue;
		if (msg.type === 'invalid_params' || msg.type === 'tool_request') continue;
		if (msg.name === 'task') continue;
		toolCount++;
		if (msg.name === 'Read') fileCount++;
		if (msg.name === 'Grep' || msg.name === 'Glob' || msg.name === 'CodebaseSearch') searchCount++;
	}

	return { fileCount, searchCount, toolCount };
};

export const formatExplorationStatsLine = (stats: SubAgentExplorationStats): string | undefined => {
	if (stats.toolCount === 0) return undefined;
	const parts: string[] = [];
	if (stats.fileCount > 0) {
		parts.push(`Explored ${stats.fileCount} file${stats.fileCount !== 1 ? 's' : ''}`);
	}
	if (stats.searchCount > 0) {
		parts.push(`${stats.searchCount} search${stats.searchCount !== 1 ? 'es' : ''}`);
	}
	if (parts.length === 0) {
		parts.push(`${stats.toolCount} tool${stats.toolCount !== 1 ? 's' : ''} used`);
	}
	return parts.join(', ');
};

export const desc1ToString = (desc1: React.ReactNode): string => {
	if (typeof desc1 === 'string') return desc1;
	if (desc1 === null || desc1 === undefined || typeof desc1 === 'boolean') return '';
	if (typeof desc1 === 'number') return String(desc1);
	if (Array.isArray(desc1)) return desc1.map(desc1ToString).join('');
	return String(desc1);
};
