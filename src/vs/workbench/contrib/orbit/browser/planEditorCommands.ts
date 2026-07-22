/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { localize2 } from '../../../../nls.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { URI } from '../../../../base/common/uri.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { PlanEditorPane } from './planEditorPane.js';
import { IChatThreadService } from './chatThreadService.js';
import { IPlanTodoSyncService } from './planTodoSyncService.js';
import { IVoidSettingsService } from '../common/orbitSettingsService.js';
import { parsePlanFile } from '../common/planTemplate.js';
import { syncPlanChecklistToThreadTodos } from '../common/planDraftHelpers.js';
import { buildPlanFromThread, savePlanDraftToWorkspace } from './planDraftActions.js';
import { CONTEXT_VOID_PLAN_EDITOR_ACTIVE, VOID_PLAN_EDITOR_ID } from './planEditorConstants.js';

/**
 * Pure predicate mirroring util/planBuildButtonState.tsx's canStartPlanBuild.
 * Duplicated here because browser/*.ts cannot import from the React bundle
 * (react/src); the predicate is trivial and the invariant is locked by tests
 * in test/common/planBuildButtonState.test.ts.
 */
function canStartPlanBuild(planBuildState: 'idle' | 'building' | 'built' | 'failed'): boolean {
	return planBuildState !== 'building';
}

export const ORBIT_PLAN_OPEN_DRAFT_COMMAND_ID = 'orbit.plan.openDraft';
export const ORBIT_PLAN_SAVE_TO_WORKSPACE_COMMAND_ID = 'orbit.plan.saveToWorkspace';
export const ORBIT_PLAN_BUILD_FROM_DRAFT_COMMAND_ID = 'orbit.plan.buildFromDraft';

function getThreadId(accessor: ServicesAccessor, threadId: unknown): string {
	if (typeof threadId === 'string' && threadId.length > 0) {
		return threadId;
	}
	const chatThreadService = accessor.get(IChatThreadService);
	const currentThreadId = chatThreadService.state.currentThreadId;
	if (!currentThreadId) {
		throw new Error('No active chat thread.');
	}
	return currentThreadId;
}

async function saveDraftForThread(accessor: ServicesAccessor, threadId: string, openEditor: boolean): Promise<{ planPath: string; planName: string; content: string }> {
	const chatThreadService = accessor.get(IChatThreadService);
	const draft = chatThreadService.getThreadPlanDraft(threadId);
	if (!draft) {
		throw new Error('No active plan draft for this thread.');
	}

	const folders = chatThreadService.getFolderUrisForThread(threadId);
	const thread = chatThreadService.state.allThreads[threadId];
	const workspaceRoot = thread && thread.agentWorkspaceId !== undefined
		? (folders[0] ?? null)
		: folders[0];

	return savePlanDraftToWorkspace({
		threadId,
		draft,
		fileService: accessor.get(IFileService),
		workspaceContextService: accessor.get(IWorkspaceContextService),
		chatThreadService,
		planTodoSyncService: accessor.get(IPlanTodoSyncService),
		settingsService: accessor.get(IVoidSettingsService),
		editorService: accessor.get(IEditorService),
		openEditor,
		workspaceRoot,
	});
}

async function openPlanPath(accessor: ServicesAccessor, planPath: string): Promise<void> {
	await accessor.get(IEditorService).openEditor({
		resource: URI.file(planPath),
		options: {
			override: VOID_PLAN_EDITOR_ID,
			preserveFocus: false,
			pinned: true,
		},
	});
}

async function getBuildInputForThread(accessor: ServicesAccessor, threadId: string): Promise<{ planPath: string; planTitle: string; overview: string; todos: ReturnType<typeof syncPlanChecklistToThreadTodos> }> {
	const chatThreadService = accessor.get(IChatThreadService);
	const fileService = accessor.get(IFileService);
	const draft = chatThreadService.getThreadPlanDraft(threadId);
	const thread = chatThreadService.state.allThreads[threadId];

	let planPath = draft?.savedPlanPath ?? thread?.linkedPlanPath;
	let content: string | undefined;

	if (draft && !planPath) {
		const saved = await saveDraftForThread(accessor, threadId, false);
		planPath = saved.planPath;
		content = saved.content;
	}

	if (!planPath) {
		throw new Error('No saved plan file is linked to this thread.');
	}

	if (!content) {
		const fileContent = await fileService.readFile(URI.file(planPath));
		content = fileContent.value.toString();
	}

	const parsed = parsePlanFile(content);
	const todos = syncPlanChecklistToThreadTodos(content);
	if (todos.length === 0) {
		throw new Error('Plan has no implementation todos to build.');
	}

	return {
		planPath,
		planTitle: parsed.metadata.title || draft?.name || 'Implementation Plan',
		overview: parsed.sections.overview || draft?.overview || '',
		todos,
	};
}

// Single Toggle Command with Perfect Visual Button
registerAction2(class TogglePlanViewAction extends Action2 {
	constructor() {
		super({
			id: 'void.plan.toggleView',
			title: localize2('voidPlanToggleView', 'Toggle Plan View: Preview ↔ Markdown'),
			f1: true,
			menu: {
				id: MenuId.EditorTitle,
				when: CONTEXT_VOID_PLAN_EDITOR_ACTIVE,
				group: 'navigation',
				order: 1
			},
			icon: Codicon.splitHorizontal, // Perfect toggle icon
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyV,
				weight: KeybindingWeight.EditorContrib,
				when: CONTEXT_VOID_PLAN_EDITOR_ACTIVE
			},
			toggled: ContextKeyExpr.equals('voidPlanViewMode', 'markdown')
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const activePane = editorService.activeEditorPane;

		if (activePane instanceof PlanEditorPane) {
			const currentMode = activePane.getViewMode();
			const newMode = currentMode === 'preview' ? 'markdown' : 'preview';
			activePane.setViewMode(newMode);
		}
	}
});

registerAction2(class OpenPlanDraftAction extends Action2 {
	constructor() {
		super({
			id: ORBIT_PLAN_OPEN_DRAFT_COMMAND_ID,
			title: localize2('orbitPlanOpenDraft', 'Orbit: Open Plan Draft'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, threadIdArg?: unknown): Promise<void> {
		const notificationService = accessor.get(INotificationService);
		try {
			const threadId = getThreadId(accessor, threadIdArg);
			const chatThreadService = accessor.get(IChatThreadService);
			const draft = chatThreadService.getThreadPlanDraft(threadId);
			const linkedPlanPath = chatThreadService.state.allThreads[threadId]?.linkedPlanPath;

			if (draft) {
				await saveDraftForThread(accessor, threadId, true);
				return;
			}

			if (linkedPlanPath) {
				await openPlanPath(accessor, linkedPlanPath);
				return;
			}

			throw new Error('No plan draft or saved plan is linked to this thread.');
		} catch (error) {
			notificationService.error(error instanceof Error ? error.message : String(error));
		}
	}
});

registerAction2(class SavePlanDraftAction extends Action2 {
	constructor() {
		super({
			id: ORBIT_PLAN_SAVE_TO_WORKSPACE_COMMAND_ID,
			title: localize2('orbitPlanSaveToWorkspace', 'Orbit: Save Plan to Workspace'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, threadIdArg?: unknown): Promise<void> {
		const notificationService = accessor.get(INotificationService);
		try {
			const threadId = getThreadId(accessor, threadIdArg);
			await saveDraftForThread(accessor, threadId, true);
		} catch (error) {
			notificationService.error(error instanceof Error ? error.message : String(error));
		}
	}
});

registerAction2(class BuildPlanDraftAction extends Action2 {
	constructor() {
		super({
			id: ORBIT_PLAN_BUILD_FROM_DRAFT_COMMAND_ID,
			title: localize2('orbitPlanBuildFromDraft', 'Orbit: Build Plan'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, threadIdArg?: unknown): Promise<void> {
		const notificationService = accessor.get(INotificationService);
		const chatThreadService = accessor.get(IChatThreadService);
		let threadId: string | null = null;
		// Track whether the build actually started (i.e. validation/input succeeded).
		// Pre-build failures (no draft, no plan file, no todos) must not mark the
		// thread as 'failed' — that would surface a misleading red badge on a
		// brand-new plan that was never actually built.
		let buildStarted = false;
		try {
			threadId = getThreadId(accessor, threadIdArg);
			// Re-entrancy guard: a rapid double-click (or a stale breadcrumb button
			// firing while the sidebar card already started a build) must not kick off
			// a second agent run for the same thread. The state machine already tracks
			// "building" as the in-flight signal; canStartPlanBuild encodes the policy.
			const currentState = chatThreadService.getPlanBuildState(threadId);
			if (!canStartPlanBuild(currentState)) {
				notificationService.info('A build for this plan is already in progress.');
				return;
			}
			chatThreadService.setPlanBuildState(threadId, 'building');
			const buildInput = await getBuildInputForThread(accessor, threadId);
			buildStarted = true;
			await buildPlanFromThread({
				threadId,
				...buildInput,
				fileService: accessor.get(IFileService),
				chatThreadService,
				planTodoSyncService: accessor.get(IPlanTodoSyncService),
				settingsService: accessor.get(IVoidSettingsService),
			});
			await chatThreadService.waitForThreadAgentRunEnd(threadId);
			chatThreadService.setPlanBuildState(threadId, 'built');
		} catch (error) {
			if (threadId) {
				chatThreadService.setPlanBuildState(threadId, buildStarted ? 'failed' : 'idle');
			}
			notificationService.error(error instanceof Error ? error.message : String(error));
		}
	}
});
