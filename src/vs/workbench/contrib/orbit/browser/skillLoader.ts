/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Discovers skill definitions from disk and registers them:
 *   - ~/.orbit/skills/<name>/SKILL.md  (user-level, lower priority)
 *   - .orbit/skills/<name>/SKILL.md    (project-level, higher priority, overrides user)
 *
 * SKILL.md frontmatter format:
 * ---
 * name: my-skill
 * description: Third-person summary, used by the model to decide when to load the skill.
 * disableModelInvocation: false   (optional)
 * ---
 * Skill body (markdown) goes here...
 *
 * Registered as a WorkbenchContribution so user/project skills load at startup. The
 * exported `reloadOrbitSkills` lets the import service re-scan after import/delete.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { URI } from '../../../../base/common/uri.js';
import { SkillDefinition, SkillSource, normalizeSkillName, MAX_SKILL_DESCRIPTION_LENGTH } from '../common/orbitSkillTypes.js';
import { setProjectSkills, setUserSkills, setDisabledSkills } from '../common/skillRegistry.js';
import { parseSkillFrontmatter } from '../common/skillFrontmatter.js';
import { IVoidSettingsService } from '../common/orbitSettingsService.js';

// Re-exported for existing importers (e.g. skillImportService).
export { parseSkillFrontmatter };

// 1 MB cap per SKILL.md. A multi-MB file would otherwise be loaded into memory and (when
// the skill is invoked) concatenated into the prompt — a low-risk OOM / injection vector.
const MAX_SKILL_FILE_BYTES = 1_000_000;

/**
 * Scan a skills root directory for `<subdir>/SKILL.md` files and return parsed skills.
 * Never throws — missing directories and malformed files are skipped silently.
 */
export async function loadSkillsFromDir(
	dir: URI,
	source: SkillSource,
	fileService: IFileService,
	opts?: { external?: boolean },
): Promise<SkillDefinition[]> {
	const skills: SkillDefinition[] = [];
	let stat;
	try {
		stat = await fileService.resolve(dir);
	} catch {
		return skills; // directory doesn't exist — fine
	}
	if (!stat.children) return skills;

	for (const child of stat.children) {
		if (!child.isDirectory) continue;
		const skillFile = URI.joinPath(child.resource, 'SKILL.md');
		try {
			// Cheap existence + size check before reading.
			let fileStat;
			try {
				fileStat = await fileService.stat(skillFile);
			} catch {
				continue; // no SKILL.md in this folder
			}
			if (typeof fileStat.size === 'number' && fileStat.size > MAX_SKILL_FILE_BYTES) {
				console.warn(`[SkillLoader] Skipping ${skillFile.fsPath}: size ${fileStat.size} exceeds ${MAX_SKILL_FILE_BYTES} cap.`);
				continue;
			}
			const content = await fileService.readFile(skillFile);
			if (content.value.byteLength > MAX_SKILL_FILE_BYTES) {
				console.warn(`[SkillLoader] Skipping ${skillFile.fsPath}: byteLength ${content.value.byteLength} exceeds ${MAX_SKILL_FILE_BYTES} cap.`);
				continue;
			}

			const { meta, body } = parseSkillFrontmatter(content.value.toString());
			// Per the Agent Skills standard, a skill's identity is its FOLDER name (the
			// `name:` frontmatter is optional and must match the folder). Using the folder
			// name as canonical identity keeps things stable even if the frontmatter is
			// edited, and matches how Cursor/Claude Code resolve skills.
			const name = normalizeSkillName(child.name) ?? normalizeSkillName(meta.name);
			const description = (meta.description ?? '').trim();
			if (!name || !description || !body) continue;

			skills.push({
				name,
				description: description.slice(0, MAX_SKILL_DESCRIPTION_LENGTH),
				disableModelInvocation: meta.disableModelInvocation,
				metadata: Object.keys(meta.metadata).length > 0 ? meta.metadata : undefined,
				source,
				filePath: skillFile.fsPath,
				body,
				enabled: true, // actual enabled-state is computed in the registry from the disabled-set
				external: opts?.external,
			});
		} catch {
			// Skip invalid files silently — never crash the editor.
		}
	}

	return skills;
}

/** Returns the user-level skills root: ~/.orbit/skills */
export function userSkillsDir(environmentService: INativeEnvironmentService): URI {
	return URI.joinPath(environmentService.userHome, '.orbit', 'skills');
}

/**
 * Returns the global cross-tool Agent Skills registry root: ~/.agents/skills.
 * Skills here are shared with other agent tools (Cursor, Claude Code, …); Orbit reads them
 * in place and treats them as external (not deletable from Orbit).
 */
export function agentsSkillsDir(environmentService: INativeEnvironmentService): URI {
	return URI.joinPath(environmentService.userHome, '.agents', 'skills');
}

/**
 * Re-scan all skill directories and update the registry. Safe to call repeatedly (e.g.
 * after an import or delete). Applies the disabled-set from settings as well.
 *
 * Reloads are serialized module-wide: overlapping calls (a file-watcher burst plus an
 * import/delete) never run concurrently, so setUserSkills/setProjectSkills can't interleave
 * and leave stale state. A call that arrives while one is in flight coalesces into a single
 * trailing re-run and resolves when the registry reflects the latest disk state.
 */
let _reloadInFlight: Promise<void> | null = null;
let _reloadQueued = false;

export function reloadOrbitSkills(
	fileService: IFileService,
	environmentService: INativeEnvironmentService,
	workspaceContextService: IWorkspaceContextService,
	settingsService?: IVoidSettingsService,
): Promise<void> {
	if (_reloadInFlight) {
		_reloadQueued = true;
		return _reloadInFlight;
	}
	const run = (async () => {
		try {
			do {
				_reloadQueued = false;
				await _doReloadOrbitSkills(fileService, environmentService, workspaceContextService, settingsService);
			} while (_reloadQueued);
		} finally {
			_reloadInFlight = null;
		}
	})();
	_reloadInFlight = run;
	return run;
}

async function _doReloadOrbitSkills(
	fileService: IFileService,
	environmentService: INativeEnvironmentService,
	workspaceContextService: IWorkspaceContextService,
	settingsService?: IVoidSettingsService,
): Promise<void> {
	// User-level: the global ~/.agents registry first (external), then Orbit's own
	// ~/.orbit/skills, so an Orbit-owned skill can intentionally shadow a global one.
	const userSkills = [
		...await loadSkillsFromDir(agentsSkillsDir(environmentService), 'user', fileService, { external: true }),
		...await loadSkillsFromDir(userSkillsDir(environmentService), 'user', fileService, { external: false }),
	];
	setUserSkills(userSkills);

	// Project-level (each workspace folder): project .agents/skills then .orbit/skills.
	const projectSkills: SkillDefinition[] = [];
	for (const folder of workspaceContextService.getWorkspace().folders) {
		projectSkills.push(...await loadSkillsFromDir(URI.joinPath(folder.uri, '.agents', 'skills'), 'project', fileService, { external: true }));
		projectSkills.push(...await loadSkillsFromDir(URI.joinPath(folder.uri, '.orbit', 'skills'), 'project', fileService, { external: false }));
	}
	setProjectSkills(projectSkills);

	// Apply disabled-set from settings, if available.
	const disabled = settingsService?.state.globalSettings.disabledSkills;
	if (disabled) setDisabledSkills(disabled);
}

class SkillLoader extends Disposable {
	static readonly ID = 'workbench.contrib.orbitSkillLoader';

	/** Debounced re-scan so a burst of file events triggers a single reload. */
	private readonly _reloadScheduler = this._register(new RunOnceScheduler(() => { void this._reload(); }, 300));

	constructor(
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
	) {
		super();
		this._init();
	}

	/** Directories whose changes should trigger a skill re-scan. */
	private _watchedDirs(): URI[] {
		const dirs = [userSkillsDir(this._environmentService), agentsSkillsDir(this._environmentService)];
		for (const folder of this._workspaceContextService.getWorkspace().folders) {
			dirs.push(URI.joinPath(folder.uri, '.orbit', 'skills'));
			dirs.push(URI.joinPath(folder.uri, '.agents', 'skills'));
		}
		return dirs;
	}

	private async _reload(): Promise<void> {
		await reloadOrbitSkills(this._fileService, this._environmentService, this._workspaceContextService, this._settingsService);
	}

	private async _init(): Promise<void> {
		// Apply the persisted disabled-set immediately so built-in skills reflect it even
		// before disk scanning finishes.
		await this._settingsService.waitForInitState;
		setDisabledSkills(this._settingsService.state.globalSettings.disabledSkills ?? []);

		await this._reload();

		// Keep the disabled-set in sync when the user toggles skills in settings.
		this._register(this._settingsService.onDidChangeState(() => {
			setDisabledSkills(this._settingsService.state.globalSettings.disabledSkills ?? []);
		}));

		// Watch skill directories so the list stays in sync when skills are added, edited,
		// or removed on disk (by the agent's file tools, the user, or an import).
		const watchedDirs = this._watchedDirs();
		for (const dir of watchedDirs) {
			try {
				this._register(this._fileService.watch(dir, { recursive: true, excludes: [] }));
			} catch {
				// Watching a non-existent dir can throw on some backends — non-fatal.
			}
		}
		this._register(this._fileService.onDidFilesChange(e => {
			if (watchedDirs.some(dir => e.affects(dir))) {
				this._reloadScheduler.schedule();
			}
		}));
	}
}

registerWorkbenchContribution2(SkillLoader.ID, SkillLoader, WorkbenchPhase.AfterRestored);
