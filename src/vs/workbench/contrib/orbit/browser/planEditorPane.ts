/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService, IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { PlanEditorInput } from './planEditorInput.js';
import { CONTEXT_VOID_PLAN_EDITOR_ACTIVE, CONTEXT_VOID_PLAN_VIEW_MODE, VOID_PLAN_EDITOR_ID } from './planEditorConstants.js';
import { PlanEditorBreadcrumbActionsMount, PlanEditorTitleActionsState } from './planEditorBreadcrumbActions.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IChatThreadService } from './chatThreadService.js';
import { IPlanTodoSyncService } from './planTodoSyncService.js';
import { TodoItem } from '../common/chatThreadServiceTypes.js';
import { IVoidSettingsService } from '../common/orbitSettingsService.js';
import { convertPlanTodoToExecutionTodo, parseNumberedTodoMarkdown, syncPlanStatus, ParsedPlan } from '../common/planTemplate.js';
import { buildPlanImplementationMessage } from '../common/planBuildMessage.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../base/common/buffer.js';

export class PlanEditorPane extends EditorPane {
	static readonly ID = VOID_PLAN_EDITOR_ID;

	private _container: HTMLElement | undefined;
	private _reactDisposable: IDisposable | undefined;
	private _externalChangeDisposable: IDisposable | undefined;
	private _syncSelfWriteDisposable: IDisposable | undefined;
	private _externalConflictDisposable: IDisposable | undefined;
	private _breadcrumbReactivityDisposable: IDisposable | undefined;
	private _breadcrumbActions: PlanEditorBreadcrumbActionsMount | undefined;
	private _contextKeys: {
		editorActive: IContextKey<boolean>;
		viewMode: IContextKey<string>;
	};
	private _currentViewMode: 'preview' | 'markdown' = 'preview';

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@INotificationService private readonly notificationService: INotificationService,
		@IChatThreadService private readonly chatThreadService: IChatThreadService,
		@IPlanTodoSyncService private readonly planTodoSyncService: IPlanTodoSyncService,
		@IVoidSettingsService private readonly settingsService: IVoidSettingsService,
		@IFileService private readonly fileService: IFileService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService
	) {
		super(PlanEditorPane.ID, group, telemetryService, themeService, storageService);

		// Bind context keys
		this._contextKeys = {
			editorActive: CONTEXT_VOID_PLAN_EDITOR_ACTIVE.bindTo(contextKeyService),
			viewMode: CONTEXT_VOID_PLAN_VIEW_MODE.bindTo(contextKeyService)
		};
	}

	// Create DOM container for React
	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('plan-editor-container');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.overflow = 'hidden';
		parent.appendChild(this._container);
	}

	// Handle Build button click
	private async handleBuild(todos: TodoItem[], input: PlanEditorInput): Promise<void> {
		let buildThreadId: string | undefined;
		try {
			// Validate plan before building
			const planContent = await input.loadPlan();

			// Check 1: Valid metadata
			if (!planContent.metadata || !planContent.metadata.title) {
				this.notificationService.error('Plan file has invalid frontmatter. Please check the file format.');
				return;
			}

			// Check 2: Has checklist section
			if (!planContent.sections.checklist || planContent.sections.checklist.trim().length === 0) {
				this.notificationService.error('Plan has no checklist section. Add todos before building.');
				return;
			}

			// Check 3: Todos are parseable
			if (!todos || todos.length === 0) {
				this.notificationService.error('Could not parse any todos from the plan. Check checklist format.');
				return;
			}

			// 1. Get current thread
			const thread = this.chatThreadService.getCurrentThread();
			if (!thread) {
				this.notificationService.error('No active chat thread. Please open a chat first.');
				return;
			}
			// Re-entrancy guard: mirrors BuildPlanDraftAction's canStartPlanBuild check
			// (planEditorCommands.ts) so a rapid double-click on the breadcrumb Build
			// button cannot kick off a second concurrent agent run for this thread.
			if (this.chatThreadService.getPlanBuildState(thread.id) === 'building') {
				return;
			}
			buildThreadId = thread.id;
			this.chatThreadService.setPlanBuildState(thread.id, 'building');

			// 2. Link the saved plan and initialize execution todos.
			// Phase 2.5 (H5) fix: install the sync watcher BEFORE the state mutations.
			// The watcher subscribes to onDidChangeThreadTodoList, so installing it
			// first ensures the first todo change is observed.
			this.planTodoSyncService.watchThreadTodos(thread.id, input.resource.fsPath);
			this.chatThreadService.setLinkedPlanPath(thread.id, input.resource.fsPath);
			this.chatThreadService.setThreadTodoList(thread.id, todos);
			// Match buildPlanFromThread: clear the ephemeral plan draft now that the
			// saved plan file is the source of truth. Previously handleBuild skipped
			// this, leaving a stale draft pinned to the thread.
			this.chatThreadService.clearThreadPlanDraft(thread.id);

			// 5. Switch to agent mode
			await this.settingsService.setGlobalSetting('chatMode', 'agent');

			// 5.5. Auto-update plan status to in-progress.
			// Phase 2.3 (H3) fix: explicitly verify the plan file still exists before
			// the read; previously a missing file would throw inside the read and the
			// error was swallowed, leading the build to proceed with stale `content`
			// and a watcher pointing at a missing file.
			try {
				const exists = await this.fileService.exists(input.resource);
				if (!exists) {
					this.notificationService.error(
						`Plan file no longer exists at ${input.resource.fsPath}. Cannot build.`
					);
					this.chatThreadService.setPlanBuildState(thread.id, 'failed');
					return;
				}
				const currentContent = await this.fileService.readFile(input.resource);
				const statusUpdated = syncPlanStatus(currentContent.value.toString());
				if (statusUpdated !== currentContent.value.toString()) {
					await this.fileService.writeFile(input.resource, VSBuffer.fromString(statusUpdated));
				}
			} catch (error) {
				console.warn('[PlanEditor] Failed to update plan status:', error);
				// Don't block Build on a transient status update failure, but log it.
			}

			// 7. Send plan summary as user message (optimized - not full content).
			// Shared with buildPlanFromThread so both Build paths produce identical
			// LLM instructions (incl. the todo-id reuse directive) and display text.
			const { displayContent, llmContent } = buildPlanImplementationMessage(
				planContent.metadata.title,
				planContent.sections.overview,
				todos,
			);

			await this.chatThreadService.addUserMessageAndStreamResponse({
				userMessage: displayContent,
				llmInstructions: llmContent,
				threadId: thread.id
			});
			await this.chatThreadService.waitForThreadAgentRunEnd(thread.id);
			this.chatThreadService.setPlanBuildState(thread.id, 'built');

			// 8. Build complete (no notification per user request)
			console.log(`[PlanEditor] Build initiated for plan: ${input.resource.fsPath}`);
		} catch (error) {
			if (buildThreadId) {
				this.chatThreadService.setPlanBuildState(buildThreadId, 'failed');
			}
			console.error('[PlanEditor] Build failed:', error);
			this.notificationService.error(`Failed to build plan: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async _buildFromInput(input: PlanEditorInput): Promise<void> {
		const planContent = await input.loadPlan();
		const todos = parseNumberedTodoMarkdown(planContent.sections.checklist)
			.map(todo => convertPlanTodoToExecutionTodo(todo));
		await this.handleBuild(todos, input);
	}

	private _getThreadIdForPlanPath(planPath: string): string | undefined {
		// Phase 3 (M21) fix: when no thread is found matching this plan path, return
		// undefined rather than the current thread id. The previous fallback would
		// return the wrong thread's id, causing the title-bar Build button to operate
		// on the wrong thread.
		const currentThreadId = this.chatThreadService.state.currentThreadId;
		const currentThread = this.chatThreadService.state.allThreads[currentThreadId];
		if (currentThread?.linkedPlanPath === planPath || currentThread?.planDraft?.savedPlanPath === planPath) {
			return currentThreadId;
		}
		for (const [threadId, thread] of Object.entries(this.chatThreadService.state.allThreads)) {
			if (thread?.linkedPlanPath === planPath || thread?.planDraft?.savedPlanPath === planPath) {
				return threadId;
			}
		}
		return undefined;
	}

	// Load editor input and mount React
	override async setInput(
		input: EditorInput,
		options: any | undefined,
		context: IEditorOpenContext,
		token: CancellationToken
	): Promise<void> {
		await super.setInput(input, options, context, token);

		if (!(input instanceof PlanEditorInput)) {
			throw new Error('PlanEditorPane requires PlanEditorInput');
		}

		// Load plan content
		const parsedPlan = await input.loadPlan();

		// Listen for external file changes and remount React
		this._externalChangeDisposable?.dispose();
		this._externalChangeDisposable = input.onDidChangeExternalContent(async () => {
			console.log('[PlanEditorPane] External content changed, remounting...');
			// Reload plan and remount React component
			const updatedPlan = await input.loadPlan();
			if (this._container && this._reactDisposable) {
				this._reactDisposable.dispose();
				await this._mountReactComponent(input, updatedPlan);
			}
		});

		// Phase 1.5 (C4) fix: when the sync service writes the plan (todo list sync),
		// notify the editor input so its file-watcher ignores the resulting file-changed
		// event as a self-write rather than a no-op reload. The payload carries the
		// written content so the input can match on a content hash (certainty) instead
		// of only a wall-clock ignore window.
		this._syncSelfWriteDisposable?.dispose();
		this._syncSelfWriteDisposable = this.planTodoSyncService.onDidWritePlan((e) => {
			if (e.planPath === input.resource.fsPath) {
				input.notifySelfWrite(e.content);
			}
		});

		// Phase 2.6 (H6) fix: surface an external-file-changed-while-dirty conflict.
		this._externalConflictDisposable?.dispose();
		this._externalConflictDisposable = input.onDidDetectExternalConflict(() => {
			this.notificationService.warn(
				'Plan file was changed on disk while you had unsaved edits. Reload the plan to see external changes, or save your edits first to keep them.'
			);
		});

		// Mount React component
		await this._mountReactComponent(input, parsedPlan);

		// Update context keys
		this._contextKeys.editorActive.set(true);
		this._contextKeys.viewMode.set(this._currentViewMode);
	}

	// Helper to mount React component
	private async _mountReactComponent(input: PlanEditorInput, parsedPlan: ParsedPlan): Promise<void> {
		if (!this._container) {
			return;
		}

		const { mountPlanEditor } = await import('./react/out/plan-editor-tsx/index.js');

		// Resolve the linked thread once so both the editor body and the breadcrumb
		// mount see the same threadId/isDraft.
		const threadId = this._getThreadIdForPlanPath(input.resource.fsPath);
		const thread = threadId ? this.chatThreadService.state.allThreads[threadId] : undefined;

		this._reactDisposable = this.instantiationService.invokeFunction(
			accessor => {
			const disposeFn = mountPlanEditor(this._container!, accessor, {
				plan: parsedPlan,
				resource: input.resource,
				threadId,
				isDraft: thread?.planDraft !== undefined,
				initialViewMode: this._currentViewMode,
				onSave: async (content: string) => {
					input.updateContent(content);
					const result = await input.save(this.group.id);
					if (!result) {
						this.notificationService.error('Failed to save plan file');
					}
					// Removed success notification per user request
				},
				onSaveError: (error: unknown) => {
					this.notificationService.error(`Failed to save plan: ${error instanceof Error ? error.message : String(error)}`);
				},
				onContentChange: (content: string) => {
					input.updateContent(content);
				},
				onBuild: async (todos: TodoItem[]) => {
					await this.handleBuild(todos, input);
				}
			})?.dispose;
				return toDisposable(() => disposeFn?.());
			}
		);

		this._breadcrumbActions ??= new PlanEditorBreadcrumbActionsMount(this.instantiationService);
		const breadcrumbState: PlanEditorTitleActionsState = {
			threadId,
			// Phase 1.6 (C5) fix: compute isDraft from the linked thread's planDraft.
			// The previous hard-coded `false` made the title bar's "Save to Workspace"
			// button unreachable.
			isDraft: thread?.planDraft !== undefined,
			isDirty: input.isDirty(),
			isSaving: false,
			isStarting: false,
			onBuild: () => {
				void this._buildFromInput(input);
			},
			onSaveToWorkspace: thread?.planDraft ? () => this._saveDraftToWorkspace(threadId!, input) : undefined,
		};
		this._breadcrumbActions.scheduleMount(this._container, input, breadcrumbState);

		// Breadcrumb reactivity: updateState() exists on the mount but was only ever
		// called once (on setInput). Subscribe to the three thread events that affect
		// the breadcrumb's Build/Save buttons so a build started from the sidebar card
		// (or a draft saved elsewhere) reactively updates the breadcrumb while the Plan
		// Editor tab is open. All three events already exist on IChatThreadService.
		this._breadcrumbReactivityDisposable?.dispose();
		this._breadcrumbReactivityDisposable = undefined;
		if (threadId) {
			const refreshBreadcrumb = () => {
				const t = this.chatThreadService.state.allThreads[threadId];
				this._breadcrumbActions?.updateState({
					threadId,
					isDraft: t?.planDraft !== undefined,
					isDirty: input.isDirty(),
					isSaving: false,
					isStarting: false,
					onBuild: () => {
						void this._buildFromInput(input);
					},
					onSaveToWorkspace: t?.planDraft ? () => this._saveDraftToWorkspace(threadId, input) : undefined,
				});
			};
			const handler = (e: { threadId: string }) => {
				if (e.threadId === threadId) {
					refreshBreadcrumb();
				}
			};
			const d1 = this.chatThreadService.onDidChangeThreadPlanDraft(handler);
			const d2 = this.chatThreadService.onDidChangeThreadTodoList(handler);
			const d3 = this.chatThreadService.onDidChangePlanBuildState(handler);
			this._breadcrumbReactivityDisposable = { dispose: () => { d1.dispose(); d2.dispose(); d3.dispose(); } };
		}
	}

	// Phase 1.6 (C5) fix: handler for the title bar's "Save to Workspace" button.
	// Persists the in-memory plan draft to the workspace's plans directory and opens
	// the resulting file in the editor.
	private async _saveDraftToWorkspace(threadId: string, input: PlanEditorInput): Promise<void> {
		const thread = this.chatThreadService.state.allThreads[threadId];
		const draft = thread?.planDraft;
		if (!draft) {
			this.notificationService.warn('No plan draft to save.');
			return;
		}
		try {
			// Lazy import to avoid a circular dependency at module load.
			const { savePlanDraftToWorkspace } = await import('./planDraftActions.js');
			const result = await savePlanDraftToWorkspace({
				threadId,
				draft,
				fileService: this.fileService,
				workspaceContextService: this.workspaceContextService,
				chatThreadService: this.chatThreadService,
				planTodoSyncService: this.planTodoSyncService,
				settingsService: this.settingsService,
				editorService: this.editorService,
				openEditor: false, // current editor already shows the draft
			});
			this.notificationService.info(`Saved plan to ${result.planName}`);
		} catch (error) {
			console.error('[PlanEditor] Failed to save draft to workspace:', error);
			this.notificationService.error(`Failed to save plan: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// Clear input on editor close
	override clearInput(): void {
		this._reactDisposable?.dispose();
		this._reactDisposable = undefined;
		this._externalChangeDisposable?.dispose();
		this._externalChangeDisposable = undefined;
		this._syncSelfWriteDisposable?.dispose();
		this._syncSelfWriteDisposable = undefined;
		this._externalConflictDisposable?.dispose();
		this._externalConflictDisposable = undefined;
		this._breadcrumbReactivityDisposable?.dispose();
		this._breadcrumbReactivityDisposable = undefined;
		this._breadcrumbActions?.dispose();
		this._breadcrumbActions = undefined;
		this._contextKeys.editorActive.set(false);
		this._contextKeys.viewMode.set('preview');
		super.clearInput();
	}

	// Handle layout changes
	override layout(dimension: Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}

	// Focus management
	override focus(): void {
		this._container?.focus();
	}

	// Public API for commands
	setViewMode(mode: 'preview' | 'markdown'): void {
		if (this._currentViewMode === mode) return;

		// Phase 1.4 (C3) fix: if the input is dirty, the in-memory React content is
		// authoritative and reloading from disk would silently discard user edits.
		// Notify the user and bail out (existing VS Code pattern for dirty editors
		// across view changes); the user can save first and then switch view mode.
		if (this.input instanceof PlanEditorInput && this.input.isDirty()) {
			this.notificationService.warn(
				'Cannot switch plan view mode while there are unsaved changes. Please save the plan first.'
			);
			return;
		}

		this._currentViewMode = mode;
		this._contextKeys.viewMode.set(mode);

		// Remount React with new view mode
		if (this._reactDisposable && this.input instanceof PlanEditorInput) {
			this._reactDisposable.dispose();
			this.setInput(this.input, undefined, { newInGroup: false }, CancellationToken.None);
		}
	}

	getViewMode(): 'preview' | 'markdown' {
		return this._currentViewMode;
	}

	// Cleanup
	override dispose(): void {
		this._reactDisposable?.dispose();
		this._externalChangeDisposable?.dispose();
		this._breadcrumbActions?.dispose();
		super.dispose();
	}
}
