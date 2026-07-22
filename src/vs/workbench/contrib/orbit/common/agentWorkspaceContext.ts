/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceContextService, IWorkspaceFolder, WorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { basename } from '../../../../base/common/resources.js';

/** Minimal surface needed by effective-folder helpers (avoids circular imports). */
export type AgentWorkspaceFolderResolver = {
	getActiveFolders(): URI[];
	getWorkspaceFolders(workspaceId: string): URI[];
};

/**
 * Resolve the folder roots the agent should use.
 *
 * - `'ide'` → main IDE `IWorkspaceContextService` (unchanged).
 * - `'agent'` → independent agent project workspace (may be empty = No Repo).
 */
export function getEffectiveWorkspaceFolderUris(
	context: 'agent' | 'ide',
	agentWorkspaceService: AgentWorkspaceFolderResolver,
	workspaceContextService: Pick<IWorkspaceContextService, 'getWorkspace'>,
): URI[] {
	if (context === 'ide') {
		return workspaceContextService.getWorkspace().folders.map(f => f.uri);
	}
	return agentWorkspaceService.getActiveFolders();
}

export function getEffectiveWorkspaceFolders(
	context: 'agent' | 'ide',
	agentWorkspaceService: AgentWorkspaceFolderResolver,
	workspaceContextService: Pick<IWorkspaceContextService, 'getWorkspace'>,
): IWorkspaceFolder[] {
	if (context === 'ide') {
		return workspaceContextService.getWorkspace().folders;
	}
	return urisToWorkspaceFolders(agentWorkspaceService.getActiveFolders());
}

/** Build lightweight IWorkspaceFolder wrappers from agent folder URIs. */
export function urisToWorkspaceFolders(uris: URI[]): IWorkspaceFolder[] {
	return uris.map((uri, index) => new WorkspaceFolder({
		uri,
		name: basename(uri) || uri.path || 'Folder',
		index,
	}));
}

/**
 * Resolve folder URIs for a chat thread's `agentWorkspaceId`.
 * - `null` → No Repo (empty)
 * - string id → that workspace's folders (empty if unknown)
 * - `undefined` → active agent workspace folders
 */
export function resolveFoldersForThread(
	agentWorkspaceId: string | null | undefined,
	agentWorkspaceService: AgentWorkspaceFolderResolver,
): URI[] {
	if (agentWorkspaceId === null) {
		return [];
	}
	if (typeof agentWorkspaceId === 'string' && agentWorkspaceId.length > 0) {
		return agentWorkspaceService.getWorkspaceFolders(agentWorkspaceId);
	}
	return agentWorkspaceService.getActiveFolders();
}
