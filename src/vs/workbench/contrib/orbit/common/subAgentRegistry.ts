/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { BuiltinToolName, READ_ONLY_BUILTIN_TOOL_NAMES } from './toolsServiceTypes.js';

const LLM_VISIBLE_READ_ONLY_BUILTIN_TOOL_NAMES = [...READ_ONLY_BUILTIN_TOOL_NAMES];

/**
 * Permission tiers for sub-agents.
 * - read_only: can only read files and search (no writes, no terminal)
 * - safe_write: can read and write files, but no terminal
 * - full: all tools including terminal
 */
export type SubAgentPermissionMode = 'read_only' | 'safe_write' | 'full';

const TERMINAL_TOOLS: BuiltinToolName[] = [
	'Shell', 'AwaitShell',
];

const WRITE_TOOLS: BuiltinToolName[] = [
	'StrReplace', 'Write',
];

const STATE_WRITE_TOOLS: BuiltinToolName[] = [
	'create_plan', 'TodoWrite', 'add_plan_todo', 'update_plan_section', 'mark_plan_item_complete',
];

export function disallowedToolsForPermissionMode(mode: SubAgentPermissionMode): BuiltinToolName[] {
	switch (mode) {
		case 'read_only': return [...WRITE_TOOLS, ...TERMINAL_TOOLS, ...STATE_WRITE_TOOLS];
		case 'safe_write': return [...TERMINAL_TOOLS, ...STATE_WRITE_TOOLS];
		case 'full': return [];
	}
}

export type SubAgentDefinition = {
	agentType: string;
	whenToUse: string;
	/** Permission tier — determines which tools are available. Overrides disallowedTools if set. */
	permissionMode?: SubAgentPermissionMode;
	/** Explicit deny-list (used when permissionMode is not set) */
	disallowedTools: BuiltinToolName[];
	/** Max LLM turns before stopping. Default: 30 */
	maxTurns?: number;
	/** Source: built-in or user-defined */
	source: 'built-in' | 'project' | 'user';
	/** Absolute path to the defining `.md` file (custom agents only; empty for built-ins). */
	filePath?: string;
	getSystemPrompt: () => string;
};

/** A SubAgentDefinition as returned by listSubAgents()/getSubAgent(), with disabled-state resolved. */
export type ResolvedSubAgentDefinition = SubAgentDefinition & { enabled: boolean };

/** Returns the effective disallowed tools for an agent, respecting permissionMode */
export function getEffectiveDisallowedTools(agent: SubAgentDefinition): BuiltinToolName[] {
	if (agent.permissionMode) return disallowedToolsForPermissionMode(agent.permissionMode);
	return agent.disallowedTools;
}

export const EXPLORE_AGENT: SubAgentDefinition = {
	agentType: 'explore',
	source: 'built-in',
	permissionMode: 'read_only',
	disallowedTools: [],
	whenToUse: 'Fast read-only codebase exploration. Use to find files, search code, map architecture, understand how something works. Specify thoroughness: "quick", "medium", or "thorough".',
	maxTurns: 40,
	getSystemPrompt: () => `You are a codebase exploration specialist for Orbit Editor. Your role is to search and analyze code — you do NOT modify files.

=== READ-ONLY MODE ===
You CANNOT create, edit, or delete files. You CANNOT run terminal commands.
Attempting to use write/terminal tools will fail — do not try.

Your available tools: ${LLM_VISIBLE_READ_ONLY_BUILTIN_TOOL_NAMES.join(', ')}.

Guidelines:
- Use Glob to find files by name or path patterns (e.g. \`src/**/*.ts\`). To explore a folder, set \`target_directory\` and use a pattern like \`*\` (becomes recursive \`**/*\` under the hood)
- Use Grep for content search. Search broadly first, then read specific files
- Use parallel tool calls whenever possible for speed
- Report findings with exact file paths and evidence
- Never invent or guess file paths — only report what you actually found
- If you cannot find something, say so clearly

When done, write a clear report with:
- Key files found (with paths)
- How they relate to each other
- Any important patterns or architecture notes`,
};

export const PLAN_AGENT: SubAgentDefinition = {
	agentType: 'plan',
	source: 'built-in',
	permissionMode: 'read_only',
	disallowedTools: [],
	whenToUse: 'Software architecture and implementation planning. Use to design a plan for a task, identify affected files, and outline steps. Returns a structured implementation plan.',
	maxTurns: 35,
	getSystemPrompt: () => `You are a software architect for Orbit Editor. Your role is to explore the codebase and design implementation plans — you do NOT modify files.

=== READ-ONLY MODE ===
You CANNOT create, edit, or delete files.
Attempting to use write tools will fail — do not try.

Process:
1. Explore the codebase to understand the current architecture
2. Identify the files and patterns relevant to the task
3. Design a step-by-step implementation plan

Required output format:
## Current Architecture
[What exists today]

## Implementation Plan
[Numbered steps]

## Files to Modify
[List with paths]

## Risks & Considerations
[What could go wrong]`,
};

export const GENERAL_AGENT: SubAgentDefinition = {
	agentType: 'general',
	source: 'built-in',
	permissionMode: 'full',
	disallowedTools: [],
	whenToUse: 'General-purpose agent for complex multi-step tasks requiring both research and implementation. Has access to all tools including file editing and terminal.',
	maxTurns: 50,
	getSystemPrompt: () => `You are a general-purpose coding agent for Orbit Editor. Complete the task fully using whatever tools are needed.

Guidelines:
- Be thorough but focused — complete the task, don't gold-plate it
- Use parallel tool calls when reading multiple files
- Report what was accomplished and any key findings when done`,
};

let _projectAgents: SubAgentDefinition[] = [];
let _userAgents: SubAgentDefinition[] = [];
let _disabledAgentTypes: Set<string> = new Set();

const _onChangeListeners = new Set<() => void>();

const _fireChange = (): void => {
	for (const listener of _onChangeListeners) {
		try { listener(); } catch { /* never let one listener break others */ }
	}
};

/** Subscribe to registry changes (agents added/removed, or disabled-state toggled). */
export function onSubAgentsChanged(listener: () => void): () => void {
	_onChangeListeners.add(listener);
	return () => { _onChangeListeners.delete(listener); };
}

export function setProjectAgents(agents: SubAgentDefinition[]): void {
	_projectAgents = agents;
	_fireChange();
}

export function setUserAgents(agents: SubAgentDefinition[]): void {
	_userAgents = agents;
	_fireChange();
}

/** Update which custom (user/project) agent types are disabled. Built-in agents can never be disabled. */
export function setDisabledAgentTypes(agentTypes: string[]): void {
	const next = new Set(agentTypes);
	if (next.size === _disabledAgentTypes.size && [...next].every(t => _disabledAgentTypes.has(t))) return;
	_disabledAgentTypes = next;
	_fireChange();
}

export const BUILTIN_SUBAGENTS: SubAgentDefinition[] = [EXPLORE_AGENT, PLAN_AGENT, GENERAL_AGENT];

/**
 * Returns all agents: built-ins + user-level + project-level.
 * Priority: project > user > built-in (later entries override earlier ones with same name).
 * Each entry carries a resolved `enabled` flag — built-in agents are always enabled; custom
 * (user/project) agents are enabled unless their agentType is in the disabled set.
 */
export function listSubAgents(): ResolvedSubAgentDefinition[] {
	const all = [...BUILTIN_SUBAGENTS];
	for (const ua of _userAgents) {
		const idx = all.findIndex(a => a.agentType === ua.agentType);
		if (idx >= 0) all[idx] = ua;
		else all.push(ua);
	}
	for (const pa of _projectAgents) {
		const idx = all.findIndex(a => a.agentType === pa.agentType);
		if (idx >= 0) all[idx] = pa;
		else all.push(pa);
	}
	return all.map(a => ({
		...a,
		enabled: a.source === 'built-in' ? true : !_disabledAgentTypes.has(a.agentType),
	}));
}

export function getSubAgent(name: string): ResolvedSubAgentDefinition | undefined {
	return listSubAgents().find(a => a.agentType === name);
}
