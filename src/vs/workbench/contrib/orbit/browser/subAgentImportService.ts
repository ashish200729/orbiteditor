/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Service for managing custom sub-agent definitions stored as `.md` files under
 * ~/.orbit/agents (user) and <workspace>/.orbit/agents (project). Mirrors
 * skillImportService: scaffold a new agent, delete an Orbit-owned agent, and force
 * a registry reload so the Customize UI reflects changes without a restart.
 */

import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { URI } from '../../../../base/common/uri.js';
import { basename, dirname } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { reloadOrbitAgents } from './projectAgentLoader.js';

export type SubAgentScope = 'user' | 'project';

export interface ISubAgentImportService {
	readonly _serviceBrand: undefined;
	/** Scaffold a new agent `.md` in the given scope and open it. Returns its agentType. */
	createNewAgent(scope?: SubAgentScope): Promise<string | null>;
	/** Delete an Orbit-owned agent `.md`, identified by absolute path. Returns true if removed. */
	deleteAgent(agentFilePath: string): Promise<boolean>;
}

export const ISubAgentImportService = createDecorator<ISubAgentImportService>('SubAgentImportService');

const AGENT_TYPE_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

const NEW_AGENT_TEMPLATE = `---
agentType: %NAME%
whenToUse: Describe when the main agent should delegate to this sub-agent.
permissionMode: read_only
maxTurns: 30
---
You are the %NAME% sub-agent for Orbit Editor.

Describe the agent's role, process, and output format here.
`;

class SubAgentImportService implements ISubAgentImportService {
	readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly _workspaceTrust: IWorkspaceTrustManagementService,
		@ICommandService private readonly _commandService: ICommandService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@ILogService private readonly _logService: ILogService,
	) { }

	private _agentsDirForScope(scope: SubAgentScope): URI | null {
		if (scope === 'project') {
			const folders = this._workspaceContextService.getWorkspace().folders;
			if (folders.length === 0) return null;
			return URI.joinPath(folders[0].uri, '.orbit', 'agents');
		}
		return URI.joinPath(this._environmentService.userHome, '.orbit', 'agents');
	}

	private async _reload(): Promise<void> {
		await reloadOrbitAgents(this._fileService, this._environmentService, this._workspaceContextService, this._workspaceTrust.isWorkspaceTrusted());
	}

	async createNewAgent(scope: SubAgentScope = 'user'): Promise<string | null> {
		if (scope === 'project' && !this._workspaceTrust.isWorkspaceTrusted()) {
			this._logService.error('[SubAgentImportService] Refusing to create project agent in an untrusted workspace.');
			return null;
		}
		const root = this._agentsDirForScope(scope);
		if (!root) {
			this._logService.error('[SubAgentImportService] No workspace folder for project agent.');
			return null;
		}
		try {
			await this._fileService.createFolder(root);
		} catch (err) {
			this._logService.error(`[SubAgentImportService] Failed to create agents root: ${err}`);
			return null;
		}

		const name = await this._quickInputService.input({
			prompt: 'Agent type',
			placeHolder: 'my-agent (letters, numbers, hyphens, underscores)',
			ignoreFocusLost: true,
			validateInput: async (raw: string) => {
				const trimmed = raw.trim();
				if (!trimmed) return 'Enter an agent type.';
				if (!AGENT_TYPE_RE.test(trimmed)) return 'Use letters, numbers, hyphens, underscores; must start with a letter.';
				if (await this._fileService.exists(URI.joinPath(root, `${trimmed}.md`))) return `An agent named "${trimmed}" already exists.`;
				return null;
			},
		});

		const trimmed = (name ?? '').trim();
		if (!trimmed || !AGENT_TYPE_RE.test(trimmed)) return null;

		const agentFile = URI.joinPath(root, `${trimmed}.md`);
		try {
			const body = NEW_AGENT_TEMPLATE.replace(/%NAME%/g, trimmed);
			await this._fileService.writeFile(agentFile, VSBuffer.fromString(body), { atomic: { postfix: '.orbittmp' } });
			await this._reload();
			try { await this._commandService.executeCommand('vscode.open', agentFile); } catch { /* non-fatal */ }
			return trimmed;
		} catch (err) {
			this._logService.error(`[SubAgentImportService] Failed to create agent ${trimmed}: ${err}`);
			return null;
		}
	}

	async deleteAgent(agentFilePath: string): Promise<boolean> {
		if (!agentFilePath) return false;
		const agentFile = URI.file(agentFilePath);
		const agentsDir = dirname(agentFile);   // <root>/.orbit/agents
		const orbitDir = dirname(agentsDir);    // <root>/.orbit

		// Safety guard: only ever delete a `.md` directly inside a `.orbit/agents` directory.
		if (basename(agentsDir) !== 'agents' || basename(orbitDir) !== '.orbit' || !agentFilePath.endsWith('.md')) {
			this._logService.error(`[SubAgentImportService] Refusing to delete unexpected path: ${agentFilePath}`);
			return false;
		}

		try {
			if (!(await this._fileService.exists(agentFile))) return false;
			await this._fileService.del(agentFile, { useTrash: true });
			await this._reload();
			return true;
		} catch (err) {
			this._logService.error(`[SubAgentImportService] Failed to delete agent at ${agentFilePath}: ${err}`);
			return false;
		}
	}
}

registerSingleton(ISubAgentImportService, SubAgentImportService, InstantiationType.Delayed);
