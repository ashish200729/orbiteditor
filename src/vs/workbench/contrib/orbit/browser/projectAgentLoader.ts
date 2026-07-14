/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Loads custom sub-agent definitions from:
 *   - ~/.orbit/agents/*.md  (user-level, lower priority)
 *   - .orbit/agents/*.md    (project-level, higher priority, overrides user)
 *
 * Frontmatter format:
 * ---
 * agentType: my-agent
 * whenToUse: Description of when to use this agent
 * permissionMode: read_only | safe_write | full   (optional, preferred over disallowedTools)
 * disallowedTools: StrReplace, Write                 (optional, comma-separated)
 * maxTurns: 20                                     (optional)
 * ---
 * System prompt body goes here...
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { URI } from '../../../../base/common/uri.js';
import { SubAgentDefinition, SubAgentPermissionMode, setProjectAgents, setUserAgents, setDisabledAgentTypes } from '../common/subAgentRegistry.js';
import { BuiltinToolName, READ_ONLY_BUILTIN_TOOL_NAMES } from '../common/toolsServiceTypes.js';
import { IVoidSettingsService } from '../common/orbitSettingsService.js';

const VALID_PERMISSION_MODES = new Set<string>(['read_only', 'safe_write', 'full']);

const VALID_BUILTIN_TOOL_NAMES = new Set<string>([
	...READ_ONLY_BUILTIN_TOOL_NAMES,
	'StrReplace', 'Write', 'Shell', 'AwaitShell', 'TodoWrite',
]);

// Phase 2.16 (H21) fix: 1 MB cap on agent definition files. A multi-MB .orbitagent
// file would otherwise be loaded into memory and concatenated into the system
// prompt, which is a low-risk prompt-injection / OOM vector.
const MAX_AGENT_FILE_BYTES = 1_000_000;

const AGENT_TYPE_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/** Same parsing rules as `parseSkillFrontmatter` (CRLF normalization, quote stripping, YAML
 * block scalars for multi-line values like `whenToUse: >`), but generic over keys. */
export function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
	// Normalize CRLF up front so Windows-authored agent files don't leave a trailing \r on
	// values or on every body line.
	const lines = content.replace(/\r\n?/g, '\n').split('\n');
	if (lines[0]?.trim() !== '---') return { meta: {}, body: lines.join('\n') };
	const endIdx = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
	if (endIdx === -1) return { meta: {}, body: lines.join('\n') };
	const meta: Record<string, string> = {};
	let i = 1;
	while (i < endIdx) {
		const line = lines[i];
		i++;
		// Skip indented / list lines (children of a nested block we don't parse).
		if (/^\s/.test(line) || line.trimStart().startsWith('-')) continue;
		const colonIdx = line.indexOf(':');
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		if (!key) continue;
		let value = line.slice(colonIdx + 1).trim();

		// YAML block scalar (`>` folded / `|` literal, optional chomping indicator) — only when
		// an indented/blank continuation line actually follows.
		const blockMatch = value.match(/^([|>])([+-]?)\d*$/);
		if (blockMatch && i < endIdx && (lines[i].trim() === '' || /^\s/.test(lines[i]))) {
			const folded = blockMatch[1] === '>';
			const blockLines: string[] = [];
			while (i < endIdx && (lines[i].trim() === '' || /^\s/.test(lines[i]))) {
				blockLines.push(lines[i].replace(/^\s+/, ''));
				i++;
			}
			while (blockLines.length && blockLines[blockLines.length - 1] === '') blockLines.pop();
			value = (folded ? blockLines.join(' ') : blockLines.join('\n')).trim();
		} else if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
			value = value.slice(1, -1);
		}

		meta[key] = value;
	}
	return { meta, body: lines.slice(endIdx + 1).join('\n').trim() };
}

export async function loadAgentsFromDir(
	dir: URI,
	source: 'project' | 'user',
	fileService: IFileService,
): Promise<SubAgentDefinition[]> {
	const agents: SubAgentDefinition[] = [];
	try {
		const stat = await fileService.resolve(dir);
		if (!stat.children) return agents;
		for (const child of stat.children) {
			if (!child.name.endsWith('.md')) continue;
			try {
				// Phase 2.16 (H21) fix: enforce a 1 MB cap on agent files. Use the
				// directory entry's `size` (if present) to skip the read entirely
				// when the file is too large. Falls back to a length check on the
				// read content for filesystems that don't report a stat size.
				if (typeof child.size === 'number' && child.size > MAX_AGENT_FILE_BYTES) {
					console.warn(
						`[ProjectAgentLoader] Skipping ${child.resource.fsPath}: ` +
						`size ${child.size} bytes exceeds ${MAX_AGENT_FILE_BYTES} cap.`
					);
					continue;
				}
				const content = await fileService.readFile(child.resource);
				if (content.value.byteLength > MAX_AGENT_FILE_BYTES) {
					console.warn(
						`[ProjectAgentLoader] Skipping ${child.resource.fsPath}: ` +
						`content byteLength ${content.value.byteLength} exceeds ${MAX_AGENT_FILE_BYTES} cap.`
					);
					continue;
				}
				const { meta, body } = parseFrontmatter(content.value.toString());
				const agentType = meta['agentType']?.trim();
				const whenToUse = meta['whenToUse']?.trim();

				// A present-but-empty/invalid agentType is a malformed agent file, not a
				// non-agent .md — validate emptiness and the regex together and log why we
				// skip it, so it's debuggable instead of being dropped silently below.
				if (meta['agentType'] !== undefined && (!agentType || !AGENT_TYPE_RE.test(agentType))) {
					console.warn(
						`[ProjectAgentLoader] Skipping ${child.resource.fsPath}: ` +
						`invalid agentType "${agentType ?? ''}" (must match /^[a-zA-Z][a-zA-Z0-9_-]*$/).`
					);
					continue;
				}

				if (!agentType || !whenToUse || !body) continue;

				const permissionModeRaw = meta['permissionMode']?.trim();
				const permissionMode = permissionModeRaw && VALID_PERMISSION_MODES.has(permissionModeRaw)
					? permissionModeRaw as SubAgentPermissionMode
					: undefined;

				const disallowedTools: BuiltinToolName[] = [];
				if (!permissionMode && meta['disallowedTools']) {
					for (const t of meta['disallowedTools'].split(',')) {
						const name = t.trim();
						if (VALID_BUILTIN_TOOL_NAMES.has(name)) disallowedTools.push(name as BuiltinToolName);
					}
				}

				const maxTurnsRaw = meta['maxTurns'] ? parseInt(meta['maxTurns'], 10) : undefined;
				const systemPrompt = body;

				agents.push({
					agentType,
					whenToUse,
					permissionMode,
					disallowedTools,
					maxTurns: (maxTurnsRaw !== undefined && Number.isInteger(maxTurnsRaw) && maxTurnsRaw > 0) ? maxTurnsRaw : undefined,
					source,
					getSystemPrompt: () => systemPrompt,
				});
			} catch {
				// Skip invalid files silently — never crash the editor
			}
		}
	} catch {
		// Directory doesn't exist — that's fine
	}
	return agents;
}

class ProjectAgentLoader extends Disposable {
	static readonly ID = 'workbench.contrib.orbitProjectAgentLoader';

	constructor(
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
		@IWorkspaceTrustManagementService private readonly _workspaceTrust: IWorkspaceTrustManagementService,
	) {
		super();
		this._load();
	}

	private async _load(): Promise<void> {
		// Apply the persisted disabled-set immediately, and keep it in sync as settings change.
		await this._settingsService.waitForInitState;
		setDisabledAgentTypes(this._settingsService.state.globalSettings.disabledAgentTypes ?? []);
		this._register(this._settingsService.onDidChangeState(() => {
			setDisabledAgentTypes(this._settingsService.state.globalSettings.disabledAgentTypes ?? []);
		}));

		await this._scanAgents();
		// Re-scan when workspace trust changes so project agents appear/disappear accordingly.
		this._register(this._workspaceTrust.onDidChangeTrust(() => { void this._scanAgents(); }));
	}

	private async _scanAgents(): Promise<void> {
		// Load user-level agents from ~/.orbit/agents/
		const userAgentsDir = URI.joinPath(this._environmentService.userHome, '.orbit', 'agents');
		const userAgents = await loadAgentsFromDir(userAgentsDir, 'user', this._fileService);
		setUserAgents(userAgents); // unconditional so removing all user agents clears stale entries

		// Load project-level agents — gated on workspace trust (untrusted repos must not register
		// agent types whose system prompts get injected into the model context).
		const projectAgents: SubAgentDefinition[] = [];
		if (this._workspaceTrust.isWorkspaceTrusted()) {
			for (const folder of this._workspaceContextService.getWorkspace().folders) {
				const projectAgentsDir = URI.joinPath(folder.uri, '.orbit', 'agents');
				projectAgents.push(...await loadAgentsFromDir(projectAgentsDir, 'project', this._fileService));
			}
		}
		setProjectAgents(projectAgents);
	}
}

registerWorkbenchContribution2(ProjectAgentLoader.ID, ProjectAgentLoader, WorkbenchPhase.AfterRestored);
