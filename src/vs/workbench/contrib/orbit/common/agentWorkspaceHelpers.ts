/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { isValidBasename } from '../../../../base/common/extpath.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, extUri, extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { tildify } from '../../../../base/common/labels.js';
import { OS } from '../../../../base/common/platform.js';
import {
	AGENT_WORKSPACE_MAX_RECENTS,
	AgentWorkspaceConfig,
	AgentWorkspaceFolder,
	AgentWorkspaceState,
	EMPTY_AGENT_WORKSPACE_STATE,
} from './agentProjectWorkspaceTypes.js';

/**
 * Normalize a URI string for dedupe comparisons. File paths follow the host
 * platform's casing rules: case-insensitive on Windows/macOS and case-sensitive
 * on Linux. Do NOT use for security checks — use {@link isUriInsideFolders}.
 */
export function normalizeFolderUriKey(uri: URI | string): string {
	const s = typeof uri === 'string' ? uri : uri.toString();
	try {
		const parsed = URI.parse(s);
		// Local file URIs follow the host casing rules. Keep non-file/remote
		// schemes conservative because their backing filesystem may be Linux.
		const identity = parsed.scheme === Schemas.file ? extUriBiasedIgnorePathCase : extUri;
		return identity.getComparisonKey(parsed);
	} catch {
		return s.toLowerCase();
	}
}

/**
 * Validate a single folder basename before it reaches a native file service.
 * The OS flag keeps this helper testable while callers can use their target OS.
 */
export function isValidWorkspaceFolderName(name: string, isWindowsOS: boolean): boolean {
	return !/[\u0000-\u001F\u007F]/.test(name) && isValidBasename(name, isWindowsOS);
}

export function folderNameFromUri(uri: URI): string {
	return basename(uri) || uri.path || 'Folder';
}

export function buildWorkspaceDisplayName(folders: AgentWorkspaceFolder[]): string {
	if (folders.length === 0) {
		return 'No Repo';
	}
	if (folders.length === 1) {
		return folders[0].name;
	}
	return `${folders[0].name} + ${folders.length - 1} more`;
}

export function resolveDisplayPath(uri: URI | string, userHomeFsPath?: string): string {
	let fsPath: string;
	try {
		fsPath = typeof uri === 'string' ? URI.parse(uri).fsPath : uri.fsPath;
	} catch {
		fsPath = typeof uri === 'string' ? uri : String(uri);
	}
	if (userHomeFsPath) {
		return tildify(fsPath, userHomeFsPath, OS);
	}
	return fsPath;
}

export function parseAgentWorkspaceState(raw: string | undefined): AgentWorkspaceState {
	if (!raw) {
		return { ...EMPTY_AGENT_WORKSPACE_STATE, workspaces: {}, recents: [] };
	}
	try {
		const parsed = JSON.parse(raw) as Partial<AgentWorkspaceState>;
		const workspaces: Record<string, AgentWorkspaceConfig> = {};
		if (parsed.workspaces && typeof parsed.workspaces === 'object') {
			for (const [id, ws] of Object.entries(parsed.workspaces)) {
				if (!ws || typeof ws !== 'object' || !Array.isArray(ws.folders)) {
					continue;
				}
				workspaces[id] = {
					id: typeof ws.id === 'string' ? ws.id : id,
					name: typeof ws.name === 'string' ? ws.name : 'Workspace',
					folders: ws.folders
						.filter((f): f is AgentWorkspaceFolder => !!f && typeof f.uri === 'string' && typeof f.name === 'string')
						.map(f => ({ uri: f.uri, name: f.name })),
					environment: 'local',
					createdAt: typeof ws.createdAt === 'string' ? ws.createdAt : new Date().toISOString(),
					lastUsedAt: typeof ws.lastUsedAt === 'string' ? ws.lastUsedAt : new Date().toISOString(),
				};
			}
		}
		const recents = Array.isArray(parsed.recents)
			? parsed.recents.filter((id): id is string => typeof id === 'string' && !!workspaces[id])
			: [];
		let activeWorkspaceId: string | null = null;
		if (typeof parsed.activeWorkspaceId === 'string' && workspaces[parsed.activeWorkspaceId]) {
			activeWorkspaceId = parsed.activeWorkspaceId;
		}
		return { activeWorkspaceId, workspaces, recents };
	} catch {
		return { ...EMPTY_AGENT_WORKSPACE_STATE, workspaces: {}, recents: [] };
	}
}

export function createWorkspaceFromFolders(
	uris: URI[],
	existing?: AgentWorkspaceState,
): { state: AgentWorkspaceState; workspace: AgentWorkspaceConfig } {
	const now = new Date().toISOString();
	const seen = new Set<string>();
	const folders: AgentWorkspaceFolder[] = [];
	for (const uri of uris) {
		const key = normalizeFolderUriKey(uri);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		folders.push({ uri: uri.toString(), name: folderNameFromUri(uri) });
	}

	// Reuse an existing workspace with the same folder set (same URIs, any order).
	if (existing && folders.length > 0) {
		const targetKeys = new Set(folders.map(f => normalizeFolderUriKey(f.uri)));
		for (const ws of Object.values(existing.workspaces)) {
			if (ws.folders.length !== folders.length) {
				continue;
			}
			const wsKeys = new Set(ws.folders.map(f => normalizeFolderUriKey(f.uri)));
			if (targetKeys.size === wsKeys.size && [...targetKeys].every(k => wsKeys.has(k))) {
				const updated: AgentWorkspaceConfig = { ...ws, lastUsedAt: now };
				const state = touchRecent(existing, updated);
				return { state, workspace: updated };
			}
		}
	}

	const workspace: AgentWorkspaceConfig = {
		id: generateUuid(),
		name: buildWorkspaceDisplayName(folders),
		folders,
		environment: 'local',
		createdAt: now,
		lastUsedAt: now,
	};
	const base = existing ?? { ...EMPTY_AGENT_WORKSPACE_STATE, workspaces: {}, recents: [] };
	const state = touchRecent(
		{
			...base,
			workspaces: { ...base.workspaces, [workspace.id]: workspace },
		},
		workspace,
	);
	return { state, workspace };
}

export function touchRecent(state: AgentWorkspaceState, workspace: AgentWorkspaceConfig): AgentWorkspaceState {
	const workspaces = { ...state.workspaces, [workspace.id]: workspace };
	const recents = [workspace.id, ...state.recents.filter(id => id !== workspace.id)].slice(0, AGENT_WORKSPACE_MAX_RECENTS);
	return {
		activeWorkspaceId: workspace.id,
		workspaces,
		recents,
	};
}

export function addFolderToWorkspace(
	state: AgentWorkspaceState,
	workspaceId: string,
	uri: URI,
): AgentWorkspaceState | null {
	const ws = state.workspaces[workspaceId];
	if (!ws) {
		return null;
	}
	const key = normalizeFolderUriKey(uri);
	if (ws.folders.some(f => normalizeFolderUriKey(f.uri) === key)) {
		return null; // already present — no-op, let the caller skip persist/events
	}
	const folders = [...ws.folders, { uri: uri.toString(), name: folderNameFromUri(uri) }];
	const updated: AgentWorkspaceConfig = {
		...ws,
		folders,
		name: buildWorkspaceDisplayName(folders),
		lastUsedAt: new Date().toISOString(),
	};
	return touchRecent(state, updated);
}

export function removeFolderFromWorkspace(
	state: AgentWorkspaceState,
	workspaceId: string,
	uri: URI,
): AgentWorkspaceState | null {
	const ws = state.workspaces[workspaceId];
	if (!ws) {
		return null;
	}
	const key = normalizeFolderUriKey(uri);
	const folders = ws.folders.filter(f => normalizeFolderUriKey(f.uri) !== key);
	if (folders.length === ws.folders.length) {
		return null; // not present — no-op, let the caller skip persist/events
	}
	if (folders.length === 0) {
		// Removing the last folder → clear to No Repo for this workspace entry.
		const { [workspaceId]: _removed, ...rest } = state.workspaces;
		return {
			activeWorkspaceId: state.activeWorkspaceId === workspaceId ? null : state.activeWorkspaceId,
			workspaces: rest,
			recents: state.recents.filter(id => id !== workspaceId),
		};
	}
	const updated: AgentWorkspaceConfig = {
		...ws,
		folders,
		name: buildWorkspaceDisplayName(folders),
		lastUsedAt: new Date().toISOString(),
	};
	return {
		...state,
		workspaces: { ...state.workspaces, [workspaceId]: updated },
	};
}

export function setActiveWorkspaceId(state: AgentWorkspaceState, id: string | null): AgentWorkspaceState {
	if (id === null) {
		return { ...state, activeWorkspaceId: null };
	}
	const ws = state.workspaces[id];
	if (!ws) {
		return state;
	}
	const updated: AgentWorkspaceConfig = { ...ws, lastUsedAt: new Date().toISOString() };
	return touchRecent(state, updated);
}

export function getActiveFoldersAsUris(state: AgentWorkspaceState): URI[] {
	if (!state.activeWorkspaceId) {
		return [];
	}
	const ws = state.workspaces[state.activeWorkspaceId];
	if (!ws) {
		return [];
	}
	return ws.folders.map(f => {
		try {
			return URI.parse(f.uri);
		} catch {
			return null;
		}
	}).filter((u): u is URI => !!u);
}

/**
 * True when `candidate` is equal to or inside any of the given root URIs.
 * Uses OS-aware comparison (case-sensitive on Linux, insensitive on
 * macOS/Windows) — this backs path-approval security checks, so it must not
 * be more permissive than the platform's own workspace containment.
 */
export function isUriInsideFolders(candidate: URI, folders: URI[]): boolean {
	const identity = candidate.scheme === Schemas.file ? extUriBiasedIgnorePathCase : extUri;
	for (const folder of folders) {
		if (identity.isEqualOrParent(candidate, folder)) {
			return true;
		}
	}
	return false;
}

export function filterThreadsByWorkspaceId<T extends { agentWorkspaceId?: string | null }>(
	threads: T[],
	activeWorkspaceId: string | null,
	mode: 'scoped' | 'all' | 'unassigned',
): T[] {
	if (mode === 'all') {
		return threads;
	}
	if (mode === 'unassigned') {
		// Legacy/IDE threads only — explicit No Repo (`null`) is its own scoped bucket.
		return threads.filter(t => t.agentWorkspaceId === undefined);
	}
	// scoped: exact match only (legacy undefined threads are NOT No Repo)
	if (activeWorkspaceId === null) {
		return threads.filter(t => t.agentWorkspaceId === null);
	}
	return threads.filter(t => t.agentWorkspaceId === activeWorkspaceId);
}

export function findNewestThreadIdInExactScope<T extends { id: string; lastModified: string; agentWorkspaceId?: string | null }>(
	threads: Iterable<T | undefined>,
	agentWorkspaceId: string | null | undefined,
): string | undefined {
	let newest: T | undefined;
	for (const thread of threads) {
		if (!thread || thread.agentWorkspaceId !== agentWorkspaceId) continue;
		if (!newest || new Date(thread.lastModified).getTime() > new Date(newest.lastModified).getTime()) {
			newest = thread;
		}
	}
	return newest?.id;
}

export function canMigrateLegacyTerminalsToWorkspace<T extends { workspaceFolderUri?: string }>(
	entries: T[],
	activeWorkspaceId: string | null,
	activeFolderUris: Iterable<string>,
): boolean {
	if (!activeWorkspaceId || entries.length === 0) return false;
	const roots = new Set(activeFolderUris);
	return entries.every(entry => !!entry.workspaceFolderUri && roots.has(entry.workspaceFolderUri));
}
