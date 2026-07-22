/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { getDateBucket } from './chatHistoryHelpers.js';

/** Workspace scope for which threads appear in the Agents history list. */
export type AgentHistoryFilterMode = 'scoped' | 'all' | 'unassigned';

/** How section headers are formed in the Agents history list. */
export type AgentHistoryGrouping = 'updated' | 'created' | 'workspace' | 'none';

/** Sort key for threads within each group (always newest / A→Z first). */
export type AgentHistoryOrdering = 'updated' | 'created' | 'name';

export type AgentHistoryListPrefs = {
	filterMode: AgentHistoryFilterMode;
	grouping: AgentHistoryGrouping;
	ordering: AgentHistoryOrdering;
};

export const DEFAULT_AGENT_HISTORY_LIST_PREFS: AgentHistoryListPrefs = {
	filterMode: 'scoped',
	grouping: 'updated',
	ordering: 'updated',
};

export const DATE_BUCKET_ORDER = ['Today', 'Yesterday', 'Last 7 Days', 'Older'] as const;

export const WORKSPACE_BUCKET_NO_REPO = 'No Repo';
export const WORKSPACE_BUCKET_UNASSIGNED = 'Unassigned';

export function parseAgentHistoryListPrefs(raw: string | undefined | null): AgentHistoryListPrefs {
	if (!raw) {
		return { ...DEFAULT_AGENT_HISTORY_LIST_PREFS };
	}
	try {
		const parsed = JSON.parse(raw) as Partial<AgentHistoryListPrefs>;
		return {
			filterMode: isFilterMode(parsed.filterMode) ? parsed.filterMode : DEFAULT_AGENT_HISTORY_LIST_PREFS.filterMode,
			grouping: isGrouping(parsed.grouping) ? parsed.grouping : DEFAULT_AGENT_HISTORY_LIST_PREFS.grouping,
			ordering: isOrdering(parsed.ordering) ? parsed.ordering : DEFAULT_AGENT_HISTORY_LIST_PREFS.ordering,
		};
	} catch {
		return { ...DEFAULT_AGENT_HISTORY_LIST_PREFS };
	}
}

function isFilterMode(v: unknown): v is AgentHistoryFilterMode {
	return v === 'scoped' || v === 'all' || v === 'unassigned';
}

function isGrouping(v: unknown): v is AgentHistoryGrouping {
	return v === 'updated' || v === 'created' || v === 'workspace' || v === 'none';
}

function isOrdering(v: unknown): v is AgentHistoryOrdering {
	return v === 'updated' || v === 'created' || v === 'name';
}

export function getThreadTitle(thread: { messages: ReadonlyArray<{ role: string; displayContent?: string }> }): string {
	const firstUser = thread.messages.find(m => m.role === 'user');
	const content = firstUser && firstUser.role === 'user' ? (firstUser.displayContent || '') : '';
	return content.trim() || 'New Chat';
}

export function compareThreadsByOrdering<T extends {
	lastModified?: string;
	createdAt?: string;
	messages: ReadonlyArray<{ role: string; displayContent?: string }>;
}>(a: T, b: T, ordering: AgentHistoryOrdering): number {
	if (ordering === 'name') {
		const titleA = getThreadTitle(a).toLocaleLowerCase();
		const titleB = getThreadTitle(b).toLocaleLowerCase();
		const cmp = titleA.localeCompare(titleB);
		if (cmp !== 0) {
			return cmp;
		}
		// Stable secondary: newest updated first
		return timeDesc(a.lastModified, b.lastModified);
	}
	if (ordering === 'created') {
		return timeDesc(a.createdAt, b.createdAt);
	}
	return timeDesc(a.lastModified, b.lastModified);
}

function timeDesc(a: string | undefined, b: string | undefined): number {
	const ta = a ? new Date(a).getTime() : 0;
	const tb = b ? new Date(b).getTime() : 0;
	return tb - ta;
}

export function getWorkspaceGroupLabel(
	agentWorkspaceId: string | null | undefined,
	workspaceNames: Readonly<Record<string, { name?: string } | undefined>>,
): string {
	if (agentWorkspaceId === undefined) {
		return WORKSPACE_BUCKET_UNASSIGNED;
	}
	if (agentWorkspaceId === null) {
		return WORKSPACE_BUCKET_NO_REPO;
	}
	return workspaceNames[agentWorkspaceId]?.name?.trim() || 'Workspace';
}

export function getThreadGroupKey<T extends {
	lastModified?: string;
	createdAt?: string;
	agentWorkspaceId?: string | null;
}>(
	thread: T,
	grouping: AgentHistoryGrouping,
	workspaceNames: Readonly<Record<string, { name?: string } | undefined>>,
): string {
	if (grouping === 'none') {
		return '';
	}
	if (grouping === 'workspace') {
		return getWorkspaceGroupLabel(thread.agentWorkspaceId, workspaceNames);
	}
	const iso = grouping === 'created' ? thread.createdAt : thread.lastModified;
	const ts = iso ? new Date(iso).getTime() : 0;
	return getDateBucket(ts);
}

/**
 * Returns group keys in display order for the current grouping mode.
 * Date buckets use fixed chronology; workspace groups are A→Z with No Repo / Unassigned last.
 */
export function orderGroupKeys(keys: Iterable<string>, grouping: AgentHistoryGrouping): string[] {
	const unique = [...new Set(keys)].filter(k => k !== undefined && k !== null) as string[];
	if (grouping === 'none') {
		return unique.includes('') ? [''] : [];
	}
	if (grouping === 'updated' || grouping === 'created') {
		return DATE_BUCKET_ORDER.filter(b => unique.includes(b));
	}
	// workspace
	const special = new Set([WORKSPACE_BUCKET_NO_REPO, WORKSPACE_BUCKET_UNASSIGNED]);
	const named = unique
		.filter(k => k && !special.has(k))
		.sort((a, b) => a.localeCompare(b));
	const ordered = [...named];
	if (unique.includes(WORKSPACE_BUCKET_NO_REPO)) {
		ordered.push(WORKSPACE_BUCKET_NO_REPO);
	}
	if (unique.includes(WORKSPACE_BUCKET_UNASSIGNED)) {
		ordered.push(WORKSPACE_BUCKET_UNASSIGNED);
	}
	return ordered;
}

export function groupThreads<T extends {
	lastModified?: string;
	createdAt?: string;
	agentWorkspaceId?: string | null;
}>(
	threads: T[],
	grouping: AgentHistoryGrouping,
	workspaceNames: Readonly<Record<string, { name?: string } | undefined>>,
): { order: string[]; groups: Record<string, T[]> } {
	const groups: Record<string, T[]> = {};
	for (const thread of threads) {
		const key = getThreadGroupKey(thread, grouping, workspaceNames);
		if (!groups[key]) {
			groups[key] = [];
		}
		groups[key].push(thread);
	}
	return {
		order: orderGroupKeys(Object.keys(groups), grouping),
		groups,
	};
}

export const GROUPING_LABELS: Record<AgentHistoryGrouping, string> = {
	updated: 'Updated',
	created: 'Created',
	workspace: 'Workspace',
	none: 'None',
};

export const ORDERING_LABELS: Record<AgentHistoryOrdering, string> = {
	updated: 'Updated',
	created: 'Created',
	name: 'Name',
};

export const SHOW_LABELS: Record<AgentHistoryFilterMode, string> = {
	scoped: 'Current workspace',
	all: 'All workspaces',
	unassigned: 'Unassigned',
};

/** Compact labels for the parent Organize menu value column. */
export const SHOW_SHORT_LABELS: Record<AgentHistoryFilterMode, string> = {
	scoped: 'Current',
	all: 'All',
	unassigned: 'Unassigned',
};
