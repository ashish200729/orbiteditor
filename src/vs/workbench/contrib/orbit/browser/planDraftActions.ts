/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { basename, dirname, extname } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IChatThreadService } from './chatThreadService.js';
import { IPlanTodoSyncService } from './planTodoSyncService.js';
import { IVoidSettingsService } from '../common/orbitSettingsService.js';
import { PlanDraft, PLAN_DIR, buildPlanContentFromDraft, preparePlanDraftSave, syncPlanChecklistToThreadTodos } from '../common/planDraftHelpers.js';
import { planFileLock } from '../common/planFileLock.js';
import { syncPlanStatus } from '../common/planTemplate.js';
import { buildPlanImplementationMessage } from '../common/planBuildMessage.js';
import { TodoItem } from '../common/chatThreadServiceTypes.js';
import { VOID_PLAN_EDITOR_ID } from './planEditorConstants.js';

export type SavePlanDraftResult = {
	planPath: string;
	planName: string;
	content: string;
};

async function getAvailablePlanUri(fileService: IFileService, proposedUri: URI): Promise<URI> {
	if (!(await fileService.exists(proposedUri))) {
		return proposedUri;
	}

	const parent = dirname(proposedUri);
	const fileName = basename(proposedUri);
	const extension = extname(proposedUri) || '.md';
	const stem = fileName.endsWith(extension)
		? fileName.slice(0, -extension.length)
		: fileName;

	for (let index = 2; index < 1000; index += 1) {
		const candidate = URI.joinPath(parent, `${stem}-${index}${extension}`);
		if (!(await fileService.exists(candidate))) {
			return candidate;
		}
	}

	throw new Error('Could not find an available plan filename.');
}

export async function savePlanDraftToWorkspace(deps: {
	threadId: string;
	draft: PlanDraft;
	fileService: IFileService;
	workspaceContextService: IWorkspaceContextService;
	chatThreadService: IChatThreadService;
	planTodoSyncService: IPlanTodoSyncService;
	settingsService: IVoidSettingsService;
	editorService: IEditorService;
	openEditor?: boolean;
}): Promise<SavePlanDraftResult> {
	const folders = deps.workspaceContextService.getWorkspace().folders;
	if (folders.length === 0) {
		throw new Error('No workspace folder open. Please open a folder to save the plan.');
	}

	const workspaceRoot = folders[0].uri;
	const model = deps.settingsService.state.modelSelectionOfFeature.Chat?.modelName;
	const { content, planUri: proposedPlanUri, planName } = preparePlanDraftSave(deps.draft, workspaceRoot, model);

	const plansDirUri = URI.joinPath(workspaceRoot, PLAN_DIR);
	try {
		await deps.fileService.createFolder(plansDirUri);
	} catch {
		// folder may already exist
	}

	// The lock key is the plans directory, NOT the chosen plan file. Two parallel drafts that
	// pick the same candidate filename would otherwise both pass `getAvailablePlanUri` and then
	// both write. By taking the lock at the directory level we serialize the entire
	// "find an unused name + write" sequence. (Phase 1.2 fix: move the existence check inside
	// the lock to eliminate the TOCTOU window between `getAvailablePlanUri` and `writeFile`.)
	let planUri: URI | undefined;
	await planFileLock.withLock(plansDirUri.fsPath, async () => {
		if (deps.draft.savedPlanPath) {
			planUri = URI.file(deps.draft.savedPlanPath);
		} else {
			planUri = await getAvailablePlanUri(deps.fileService, proposedPlanUri);
		}
		// Re-check existence inside the lock to defend against an external process creating
		// the same filename between our earlier `exists` and our `writeFile`. If the file
		// appeared concurrently (e.g. another workspace editor), pick a different name.
		// Note: `IFileService.writeFile` itself does not have an O_EXCL primitive, so this
		// re-check is a best-effort race mitigation; the directory-level lock above is the
		// primary defense.
		if (!deps.draft.savedPlanPath && planUri) {
			let attempt = 0;
			while (await deps.fileService.exists(planUri!) && attempt < 100) {
				attempt += 1;
				const parent = dirname(planUri!);
				const fileName = basename(planUri!);
				const extension = extname(planUri!) || '.md';
				const stem = fileName.endsWith(extension)
					? fileName.slice(0, -extension.length)
					: fileName;
				// strip any trailing -N
				const baseStem = stem.replace(/-\d+$/, '');
				planUri = URI.joinPath(parent, `${baseStem}-${attempt + 1000}${extension}`);
			}
		}
		if (!planUri) {
			throw new Error('Failed to determine a plan file path.');
		}
		await deps.fileService.writeFile(planUri, VSBuffer.fromString(content));
	});

	if (!planUri) {
		throw new Error('Failed to determine a plan file path.');
	}
	const finalPlanUri: URI = planUri;

	deps.chatThreadService.setLinkedPlanPath(deps.threadId, finalPlanUri.fsPath);
	const threadTodos = syncPlanChecklistToThreadTodos(content);
	deps.chatThreadService.setThreadTodoList(deps.threadId, threadTodos);
	deps.planTodoSyncService.watchThreadTodos(deps.threadId, finalPlanUri.fsPath);

	const savedDraft: PlanDraft = {
		...deps.draft,
		savedPlanPath: finalPlanUri.fsPath,
		updatedAt: new Date().toISOString(),
	};
	deps.chatThreadService.setThreadPlanDraft(deps.threadId, savedDraft);

	if (deps.openEditor !== false) {
		await deps.editorService.openEditor({
			resource: finalPlanUri,
			options: {
				override: VOID_PLAN_EDITOR_ID,
				preserveFocus: false,
				pinned: true,
			},
		});
	}

	return { planPath: finalPlanUri.fsPath, planName, content };
}

export async function buildPlanFromThread(deps: {
	threadId: string;
	todos: TodoItem[];
	planPath: string;
	planTitle: string;
	overview: string;
	fileService: IFileService;
	chatThreadService: IChatThreadService;
	planTodoSyncService: IPlanTodoSyncService;
	settingsService: IVoidSettingsService;
}): Promise<void> {
	const planUri = URI.file(deps.planPath);

	deps.chatThreadService.setLinkedPlanPath(deps.threadId, deps.planPath);
	deps.planTodoSyncService.watchThreadTodos(deps.threadId, deps.planPath);
	deps.chatThreadService.setThreadTodoList(deps.threadId, deps.todos);
	deps.chatThreadService.clearThreadPlanDraft(deps.threadId);

	await deps.settingsService.setGlobalSetting('chatMode', 'agent');

	try {
		await planFileLock.withLock(deps.planPath, async () => {
			const currentContent = await deps.fileService.readFile(planUri);
			const statusUpdated = syncPlanStatus(currentContent.value.toString());
			if (statusUpdated !== currentContent.value.toString()) {
				await deps.fileService.writeFile(planUri, VSBuffer.fromString(statusUpdated));
			}
		});
	} catch (error) {
		console.warn('[PlanBuild] Failed to update plan status:', error);
	}

	const { displayContent, llmContent } = buildPlanImplementationMessage(deps.planTitle, deps.overview, deps.todos);

	await deps.chatThreadService.addUserMessageAndStreamResponse({
		userMessage: displayContent,
		llmInstructions: llmContent,
		threadId: deps.threadId,
	});
}

export function getActivePlanDraftForThread(chatThreadService: IChatThreadService, threadId: string): PlanDraft | undefined {
	return chatThreadService.getThreadPlanDraft(threadId);
}

export function getPlanContentForBuild(draft: PlanDraft, settingsService: IVoidSettingsService): string {
	return buildPlanContentFromDraft(
		draft,
		'approved',
		settingsService.state.modelSelectionOfFeature.Chat?.modelName,
	);
}
