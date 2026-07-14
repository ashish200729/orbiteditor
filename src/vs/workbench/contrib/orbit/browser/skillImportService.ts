/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
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
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
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

/** Where a skill lives: user (~/.orbit/skills) or project (<workspace>/.orbit/skills). */
export type SkillScope = 'user' | 'project';

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
	/**
	 * Create a new empty skill from a template and open it in the editor. Returns its name.
	 * Scope defaults to 'user'. Project scope requires an open, trusted workspace folder.
	 */
	createNewSkill(scope?: SkillScope): Promise<string | null>;
	/**
	 * Install a skill from a marketplace pack: writes SKILL.md into the given scope's
	 * skills dir under `folderName`. Returns the installed folder name, or null on failure.
	 * If a skill with that folder name already exists and `overwrite` is false, returns
	 * 'exists' so the caller can prompt the user before clobbering their edits.
	 */
	installSkillFromPack(folderName: string, skillMd: string, scope: SkillScope, overwrite?: boolean): Promise<string | 'exists' | null>;
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
		@IWorkspaceTrustManagementService private readonly _workspaceTrust: IWorkspaceTrustManagementService,
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
		await reloadOrbitSkills(this._fileService, this._environmentService, this._workspaceContextService, this._settingsService, this._workspaceTrust.isWorkspaceTrusted());
	}

	private static readonly MAX_SKILL_IMPORT_BYTES = 50 * 1024 * 1024; // 50 MB — far above any real skill
	private static readonly MAX_SKILL_IMPORT_ENTRIES = 2000;

	/**
	 * Walk a skill folder before copying it wholesale. Rejects symlinks (a link inside the
	 * skill could point at credential dirs and get copied/followed) and folders that are
	 * unreasonably large for a skill (accidental node_modules, build output, …).
	 * Returns a human-readable reason to skip, or null when the folder is safe to copy.
	 */
	private async _unsafeSkillFolderReason(root: URI): Promise<string | null> {
		let totalBytes = 0;
		let entries = 0;
		const walk = async (uri: URI): Promise<string | null> => {
			const stat = await this._fileService.resolve(uri, { resolveMetadata: true });
			if (stat.isSymbolicLink) return `contains a symbolic link (${stat.resource.fsPath})`;
			for (const child of stat.children ?? []) {
				if (child.isSymbolicLink) return `contains a symbolic link (${child.resource.fsPath})`;
				if (++entries > SkillImportService.MAX_SKILL_IMPORT_ENTRIES) {
					return `has more than ${SkillImportService.MAX_SKILL_IMPORT_ENTRIES} files`;
				}
				if (child.isDirectory) {
					const reason = await walk(child.resource);
					if (reason) return reason;
				} else {
					totalBytes += child.size ?? 0;
					if (totalBytes > SkillImportService.MAX_SKILL_IMPORT_BYTES) {
						return `is larger than ${Math.round(SkillImportService.MAX_SKILL_IMPORT_BYTES / (1024 * 1024))} MB`;
					}
				}
			}
			return null;
		};
		return walk(root);
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

					// Guard before copying wholesale: no symlinks, no runaway folder sizes.
					const unsafeReason = await this._unsafeSkillFolderReason(child.resource);
					if (unsafeReason) {
						result.errors.push(`Skipped ${child.name}: folder ${unsafeReason}`);
						continue;
					}

					// Copy the whole skill folder (SKILL.md + any supporting files).
					await this._fileService.copy(child.resource, dest, /* overwrite */ false);
					// Post-copy re-verify: the source may have changed between check and
					// copy (TOCTOU). If the destination now looks unsafe, remove it and
					// report as an error instead of silently loading attacker-controlled data.
					const postCopyReason = await this._unsafeSkillFolderReason(dest);
					if (postCopyReason) {
						await this._fileService.del(dest, { recursive: true }).catch(() => { /* best-effort */ });
						result.errors.push(`Skipped ${child.name}: folder ${postCopyReason} (detected after copy)`);
						continue;
					}
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

	/** Returns the skills root for a scope, or null if project scope has no workspace folder. */
	private _skillsDirForScope(scope: SkillScope): URI | null {
		if (scope === 'project') {
			const folders = this._workspaceContextService.getWorkspace().folders;
			if (folders.length === 0) return null;
			return URI.joinPath(folders[0].uri, '.orbit', 'skills');
		}
		return userSkillsDir(this._environmentService);
	}

	async installSkillFromPack(folderName: string, skillMd: string, scope: SkillScope, overwrite = false): Promise<string | 'exists' | null> {
		const normalized = normalizeSkillName(folderName.trim());
		if (!normalized) {
			this._logService.error(`[SkillImportService] Invalid skill folder name: ${folderName}`);
			return null;
		}
		if (scope === 'project' && !this._workspaceTrust.isWorkspaceTrusted()) {
			this._logService.error('[SkillImportService] Refusing to install project skill in an untrusted workspace.');
			return null;
		}
		const root = this._skillsDirForScope(scope);
		if (!root) {
			this._logService.error('[SkillImportService] No workspace folder for project skill install.');
			return null;
		}
		try {
			await this._fileService.createFolder(root);
			const skillFile = URI.joinPath(root, normalized, 'SKILL.md');
			// Guard against clobbering a skill the user has already edited. The caller can
			// re-invoke with overwrite=true after confirming with the user.
			if (!overwrite && await this._fileService.exists(skillFile)) {
				return 'exists';
			}
			await this._fileService.writeFile(skillFile, VSBuffer.fromString(skillMd), { atomic: { postfix: '.orbittmp' } });
			await this._reload();
			return normalized;
		} catch (err) {
			this._logService.error(`[SkillImportService] Failed to install skill ${normalized}: ${err}`);
			return null;
		}
	}

	async createNewSkill(scope: SkillScope = 'user'): Promise<string | null> {
		if (scope === 'project' && !this._workspaceTrust.isWorkspaceTrusted()) {
			this._logService.error('[SkillImportService] Refusing to create project skill in an untrusted workspace.');
			return null;
		}
		const root = this._skillsDirForScope(scope);
		if (!root) {
			this._logService.error('[SkillImportService] No workspace folder for project skill.');
			return null;
		}
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
			await this._fileService.writeFile(skillFile, VSBuffer.fromString(body), { atomic: { postfix: '.orbittmp' } });
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
