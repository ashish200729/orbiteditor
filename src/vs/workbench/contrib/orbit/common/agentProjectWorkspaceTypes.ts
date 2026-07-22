/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/** v1 only supports local folders. Cloud/SSH deferred. */
export type AgentEnvironment = 'local';

export type AgentWorkspaceFolder = {
	/** Serialized URI string (e.g. file:///Users/...). */
	uri: string;
	/** Display name (typically the folder basename). */
	name: string;
};

export type AgentWorkspaceConfig = {
	/** Stable UUID, persisted across sessions. */
	id: string;
	/** Display name: "orbit-editor" or "orbit-editor + 2 more". */
	name: string;
	folders: AgentWorkspaceFolder[];
	environment: AgentEnvironment;
	createdAt: string;
	lastUsedAt: string;
};

export type AgentWorkspaceState = {
	/** null = No Repo mode. */
	activeWorkspaceId: string | null;
	workspaces: Record<string, AgentWorkspaceConfig>;
	/** Workspace ids, most-recent-first. */
	recents: string[];
};

export const EMPTY_AGENT_WORKSPACE_STATE: AgentWorkspaceState = {
	activeWorkspaceId: null,
	workspaces: {},
	recents: [],
};

/** Max recent workspace entries kept in the picker. */
export const AGENT_WORKSPACE_MAX_RECENTS = 20;
