/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Service for managing user-level skills stored under ~/.orbit/skills.
 *
 * Scope: importing skills from Cursor, deleting installed skills, and scaffolding a new
 * skill. Imported skills are copied (whole folder) into ~/.orbit/skills/<name>/ so they
 * are picked up by the standard skill loader — there is no separate "imported" source.
 */

import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { URI } from '../../../../base/common/uri.js';
import { basename, dirname } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IVoidSettingsService } from '../common/orbitSettingsService.js';
import { normalizeSkillName } from '../common/orbitSkillTypes.js';
import { parseSkillFrontmatter, reloadOrbitSkills, userSkillsDir } from './skillLoader.js';

export type SkillImportResult = {
	imported: number;
	skipped: number;
	errors: string[];
};

export interface ISkillImportService {
	readonly _serviceBrand: undefined;
	/** Import the user's own Cursor skills (personal + project) into ~/.orbit/skills. */
	importFromCursor(): Promise<SkillImportResult>;
	/**
	 * Delete a skill, identified by the absolute path to its SKILL.md. Operating on the
	 * path (not the frontmatter name) keeps delete correct even when a skill's folder name
	 * differs from its `name:` field. Returns true if something was removed.
	 */
	deleteSkill(skillFilePath: string): Promise<boolean>;
	/** Create a new empty skill from a template and open it in the editor. Returns its name. */
	createNewSkill(): Promise<string | null>;
}

export const ISkillImportService = createDecorator<ISkillImportService>('SkillImportService');

const NEW_SKILL_TEMPLATE = `---
name: %NAME%
description: Describe in the third person what this skill does and WHEN to use it. The model reads this line to decide whether to load the skill.
---
# %NAME%

Write the skill instructions here. Use concrete, scannable steps.
`;

class SkillImportService implements ISkillImportService {
	readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
		@ICommandService private readonly _commandService: ICommandService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@ILogService private readonly _logService: ILogService,
	) { }

	/**
	 * Cursor skill roots that hold the USER's own skills:
	 *   - ~/.cursor/skills          (personal)
	 *   - <workspace>/.cursor/skills (project)
	 *
	 * Deliberately excludes ~/.cursor/skills-cursor, which holds Cursor's bundled built-in
	 * skills (automate, loop, review, sdk, …) — those are not the user's and must not be imported.
	 */
	private _cursorSkillDirs(): URI[] {
		const dirs: URI[] = [URI.joinPath(this._environmentService.userHome, '.cursor', 'skills')];
		for (const folder of this._workspaceContextService.getWorkspace().folders) {
			dirs.push(URI.joinPath(folder.uri, '.cursor', 'skills'));
		}
		return dirs;
	}

	private async _reload(): Promise<void> {
		await reloadOrbitSkills(this._fileService, this._environmentService, this._workspaceContextService, this._settingsService);
	}

	async importFromCursor(): Promise<SkillImportResult> {
		const result: SkillImportResult = { imported: 0, skipped: 0, errors: [] };
		const destRoot = userSkillsDir(this._environmentService);

		// Ensure the destination root exists.
		try {
			await this._fileService.createFolder(destRoot);
		} catch (err) {
			result.errors.push(`Could not create ${destRoot.fsPath}: ${err}`);
			return result;
		}

		let foundAny = false;
		for (const srcRoot of this._cursorSkillDirs()) {
			let stat;
			try {
				stat = await this._fileService.resolve(srcRoot);
			} catch {
				continue; // this Cursor dir doesn't exist
			}
			if (!stat.children) continue;
			foundAny = true;

			for (const child of stat.children) {
				if (!child.isDirectory) continue;
				const skillFile = URI.joinPath(child.resource, 'SKILL.md');
				try {
					if (!(await this._fileService.exists(skillFile))) continue;

					// A skill's identity is its folder name (Agent Skills standard). Preserve the
					// source folder name as the destination folder; fall back to frontmatter.
					const content = await this._fileService.readFile(skillFile);
					const { meta } = parseSkillFrontmatter(content.value.toString());
					const name = normalizeSkillName(child.name) ?? normalizeSkillName(meta.name);
					if (!name) {
						result.errors.push(`Skipped ${child.name}: invalid skill name`);
						continue;
					}

					const dest = URI.joinPath(destRoot, name);
					if (await this._fileService.exists(dest)) {
						result.skipped++;
						continue; // never clobber an existing skill
					}

					// Copy the whole skill folder (SKILL.md + any supporting files).
					await this._fileService.copy(child.resource, dest, /* overwrite */ false);
					result.imported++;
				} catch (err) {
					result.errors.push(`Failed to import ${child.name}: ${err}`);
				}
			}
		}

		if (!foundAny) {
			result.errors.push('No Cursor skills found. Add your own skills in ~/.cursor/skills or .cursor/skills first (Cursor\'s built-in skills are not imported).');
		}

		if (result.imported > 0) await this._reload();
		return result;
	}

	async deleteSkill(skillFilePath: string): Promise<boolean> {
		if (!skillFilePath) return false;
		const skillFile = URI.file(skillFilePath);
		const folder = dirname(skillFile);            // <root>/.orbit/skills/<name>
		const skillsDir = dirname(folder);            // <root>/.orbit/skills
		const orbitDir = dirname(skillsDir);          // <root>/.orbit

		// Safety guard: only ever delete a direct child folder of a `.orbit/skills` directory.
		// Prevents path-traversal / accidental deletion of arbitrary folders.
		if (basename(skillsDir) !== 'skills' || basename(orbitDir) !== '.orbit' || basename(folder) === 'skills') {
			this._logService.error(`[SkillImportService] Refusing to delete unexpected path: ${folder.fsPath}`);
			return false;
		}

		try {
			if (!(await this._fileService.exists(folder))) return false;
			await this._fileService.del(folder, { recursive: true, useTrash: true });
			await this._reload();
			return true;
		} catch (err) {
			this._logService.error(`[SkillImportService] Failed to delete skill at ${folder.fsPath}: ${err}`);
			return false;
		}
	}

	async createNewSkill(): Promise<string | null> {
		const root = userSkillsDir(this._environmentService);
		try {
			await this._fileService.createFolder(root);
		} catch (err) {
			this._logService.error(`[SkillImportService] Failed to create skills root: ${err}`);
			return null;
		}

		// Prompt the user for the skill name. The name IS the folder name (Agent Skills
		// standard), so we validate it up-front and never end up with a generic folder.
		const name = await this._quickInputService.input({
			prompt: 'Skill name',
			placeHolder: 'my-skill (lowercase letters, numbers, hyphens, underscores)',
			ignoreFocusLost: true,
			validateInput: async (raw: string) => {
				const trimmed = raw.trim();
				if (!trimmed) return 'Enter a name for the skill.';
				const normalized = normalizeSkillName(trimmed);
				if (!normalized) return 'Use lowercase letters, numbers, hyphens, and underscores (max 64 chars), starting with a letter or number.';
				if (await this._fileService.exists(URI.joinPath(root, normalized))) return `A skill named "${normalized}" already exists.`;
				return null;
			},
		});

		const normalized = normalizeSkillName((name ?? '').trim());
		if (!normalized) return null; // user cancelled or invalid

		const skillFile = URI.joinPath(root, normalized, 'SKILL.md');
		try {
			const body = NEW_SKILL_TEMPLATE.replace(/%NAME%/g, normalized);
			await this._fileService.writeFile(skillFile, VSBuffer.fromString(body));
			await this._reload();
			// Best-effort: open the new file for editing.
			try { await this._commandService.executeCommand('vscode.open', skillFile); } catch { /* non-fatal */ }
			return normalized;
		} catch (err) {
			this._logService.error(`[SkillImportService] Failed to create skill ${normalized}: ${err}`);
			return null;
		}
	}
}

registerSingleton(ISkillImportService, SkillImportService, InstantiationType.Delayed);
