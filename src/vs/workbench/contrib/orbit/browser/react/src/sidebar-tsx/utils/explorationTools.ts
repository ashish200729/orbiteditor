/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { ChatMessage } from '../../../../../common/chatThreadServiceTypes.js';
import { isABuiltinToolName } from '../../../../../common/prompt/prompts.js';
import { resolveLegacyToolName } from '../constants/legacyToolNameMap.js';

/** Built-in tools grouped into the Cursor-style "Exploring" scroll block. */
export const EXPLORATION_TOOL_NAMES = ['Read', 'Glob', 'Grep', 'CodebaseSearch', 'read_lint_errors'] as const;
export type ExplorationToolName = typeof EXPLORATION_TOOL_NAMES[number];

const EXPLORATION_TOOL_SET = new Set<string>(EXPLORATION_TOOL_NAMES);

export const resolveExplorationToolName = (name: string): ExplorationToolName | undefined => {
	const resolved = resolveLegacyToolName(name);
	if (EXPLORATION_TOOL_SET.has(resolved)) {
		return resolved as ExplorationToolName;
	}
	return undefined;
};

export const isExplorationToolMessage = (msg: ChatMessage): boolean => {
	return msg.role === 'tool'
		&& msg.type !== 'invalid_params'
		&& msg.type !== 'tool_request'
		&& isABuiltinToolName(msg.name)
		&& EXPLORATION_TOOL_SET.has(msg.name);
};

export const isExplorationToolName = (name: string): boolean => {
	return !!resolveExplorationToolName(name);
};

export type ExplorationToolStats = {
	files: number;
	searches: number;
	errors: number;
};

export const countExplorationToolStats = (
	messages: Array<{ index: number }>,
	previousMessages: ChatMessage[],
): ExplorationToolStats => {
	const stats: ExplorationToolStats = { files: 0, searches: 0, errors: 0 };

	for (const { index } of messages) {
		const msg = previousMessages[index];
		if (msg.role !== 'tool') continue;

		if (msg.name === 'Read' || msg.name === 'read_lint_errors') {
			stats.files++;
		} else if (msg.name === 'Glob' || msg.name === 'Grep' || msg.name === 'CodebaseSearch') {
			stats.searches++;
		}

		if (msg.type === 'tool_error' || msg.type === 'invalid_params') {
			stats.errors++;
		}
	}

	return stats;
};

export const formatExploredSummary = (stats: ExplorationToolStats, totalCount: number): string => {
	const parts: string[] = [];
	if (stats.files > 0) {
		parts.push(`${stats.files} file${stats.files !== 1 ? 's' : ''}`);
	}
	if (stats.searches > 0) {
		parts.push(`${stats.searches} search${stats.searches !== 1 ? 'es' : ''}`);
	}

	let summary = parts.length > 0
		? `Explored ${parts.join(', ')}`
		: `Explored ${totalCount} tool${totalCount !== 1 ? 's' : ''}`;

	if (stats.errors > 0) {
		summary += ` (${stats.errors} failed)`;
	}

	return summary;
};
