/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IChatThreadService } from './chatThreadService.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { normalizeTodoList, stableTodoListKey } from '../common/todoToolHelpers.js';
import { planFileLock } from '../common/planFileLock.js';
import { buildPlanContentFromTodos, getPlanChecklistIds, isFullTodoIdTurnover, shouldNotifyPlanSyncFailureOnce } from '../common/planTodoSyncHelpers.js';

export const IPlanTodoSyncService = createDecorator<IPlanTodoSyncService>('planTodoSyncService');

export interface IPlanTodoSyncService {
	readonly _serviceBrand: undefined;

	/**
	 * Syncs thread todos to plan file (one-way: thread -> plan)
	 */
	syncThreadToPlan(threadId: string): Promise<void>;

	/**
	 * Starts watching thread todos for changes and syncs to plan file
	 */
	watchThreadTodos(threadId: string, planPath: string): void;

	/**
	 * Stops watching thread todos
	 */
	unwatchThreadTodos(threadId: string): void;

	/**
	 * Checks if a thread is currently being watched
	 */
	isWatching(threadId: string): boolean;

	/**
	 * Fires after the service has written the plan file as part of syncing thread
	 * todos. Consumers (e.g. PlanEditorInput) can use this to suppress
	 * reload-on-self-write handling. The payload includes the written content so
	 * consumers can do a content-hash equality check instead of relying on a
	 * wall-clock ignore window.
	 */
	readonly onDidWritePlan: Event<{ planPath: string; content: string }>;
}

export class PlanTodoSyncService extends Disposable implements IPlanTodoSyncService {
	readonly _serviceBrand: undefined;

	private watchers = new Map<string, IDisposable>();
	private debounceTimers = new Map<string, NodeJS.Timeout>();
	private lastSyncedTodos = new Map<string, string>(); // threadId -> JSON string of todos
	// Per-thread consecutive sync-failure tracking for the notify-once-per-streak
	// plumbing (fix #3). Reset to 0 on a successful sync.
	private syncFailureCounts = new Map<string, number>();
	private syncFailureNotified = new Map<string, boolean>();
	// Phase 1.3/H2 fix: drop the single-slot `currentWatchedThreadId` global so multiple
	// threads can be watched concurrently. `this.watchers` Map is the source of truth.

	// Emitted after a successful sync write so PlanEditorInput can suppress its
	// reload-on-self-write handling. The content is included so consumers can do
	// a content-hash equality check, not just a wall-clock ignore window.
	private readonly _onDidWritePlan = new Emitter<{ planPath: string; content: string }>();
	readonly onDidWritePlan: Event<{ planPath: string; content: string }> = this._onDidWritePlan.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IChatThreadService private readonly chatThreadService: IChatThreadService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
	}

	/**
	 * Syncs thread todos to plan file
	 */
	async syncThreadToPlan(threadId: string): Promise<void> {
		try {
			// Get thread from state
			const thread = this.chatThreadService.state.allThreads[threadId];
			if (!thread) {
				console.warn(`[PlanTodoSync] Thread ${threadId} not found`);
				return;
			}

			// Check if plan is linked
			if (!thread.linkedPlanPath) {
				console.warn(`[PlanTodoSync] Thread ${threadId} has no linked plan`);
				return;
			}

			const normalizedTodos = normalizeTodoList(thread.todoList ?? []);

			// Check if todos changed since last sync (avoid unnecessary writes)
			const currentTodosJson = stableTodoListKey(normalizedTodos);
			const lastSynced = this.lastSyncedTodos.get(threadId);
			if (lastSynced === currentTodosJson) {
				console.log(`[PlanTodoSync] Todos unchanged for thread ${threadId}, skipping sync`);
				return;
			}

			const planUri = URI.file(thread.linkedPlanPath);
			const planPath = planUri.fsPath;

			// Phase 2.1 (H1) fix: wrap the read-modify-write in planFileLock so concurrent
			// add_plan_todo / mark_plan_item_complete tool calls cannot race and overwrite
			// each other's writes.
			let turnoverNotified = false;
			await planFileLock.withLock(planPath, async () => {
				const fileContent = await this.fileService.readFile(planUri);
				const planContent = fileContent.value.toString();
				// Safety net for the todo-id reconciliation fix: if the incoming ids have
				// zero overlap with the ids currently in the plan file's checklist, the
				// agent most likely ignored the reuse-id instruction. Still write (never
				// discard the LLM's intent) but surface a one-shot notification so the user
				// can review the plan file.
				const onDiskIds = getPlanChecklistIds(planContent);
				if (isFullTodoIdTurnover(onDiskIds, normalizedTodos)) {
					turnoverNotified = true;
				}
				// Phase 3 (M18) fix: use the shared helper rather than the previous inline
				// implementation, so this service cannot drift from the helper's behavior.
				const updatedContent = buildPlanContentFromTodos(planContent, normalizedTodos);
				if (updatedContent === planContent) {
					// Already in sync on disk: memoize so future syncs for this same
					// todo state short-circuit at the lastSyncedTodos check instead of
					// re-acquiring the lock and re-reading the file.
					this.lastSyncedTodos.set(threadId, currentTodosJson);
					return; // nothing actually changed
				}
				await this.fileService.writeFile(planUri, VSBuffer.fromString(updatedContent), { atomic: { postfix: '.orbittmp' } });
				// Update last synced state only after a successful write
				this.lastSyncedTodos.set(threadId, currentTodosJson);
				// Notify subscribers (e.g. PlanEditorInput) that we just wrote the plan
				// so they can suppress their own reload-on-self-write handling. Include
				// the content so they can match on a hash, not just a time window.
				this._onDidWritePlan.fire({ planPath, content: updatedContent });
				console.log(`[PlanTodoSync] Synced ${normalizedTodos.length} todos to plan: ${planPath}`);
			});

			// Success: reset the per-thread failure streak.
			this.syncFailureCounts.set(threadId, 0);
			this.syncFailureNotified.set(threadId, false);

			if (turnoverNotified) {
				this.notificationService.warn(
					'The assistant used new task ids while building this plan that do not match the original checklist. The plan file was updated with the assistant\'s task list — review it to confirm the work items still match your intent.'
				);
			}
		} catch (error) {
			console.error(`[PlanTodoSync] Failed to sync thread ${threadId} to plan:`, error);
			// Per-thread notify-once-per-streak plumbing (fix #3). The helpers were
			// already defined in planTodoSyncHelpers.ts but never called; wire them up
			// here so repeated silent sync failures finally surface to the user.
			const prevCount = this.syncFailureCounts.get(threadId) ?? 0;
			const nextCount = prevCount + 1;
			this.syncFailureCounts.set(threadId, nextCount);
			const alreadyNotified = this.syncFailureNotified.get(threadId) ?? false;
			if (shouldNotifyPlanSyncFailureOnce(nextCount, alreadyNotified)) {
				this.notificationService.warn(
					`Failed to sync plan progress after ${nextCount} attempts. The plan file may be out of sync with the assistant's task list — check the plan file and your workspace for conflicts.`
				);
				this.syncFailureNotified.set(threadId, true);
			}
		}
	}

	/**
	 * Starts watching thread todos for changes
	 */
	watchThreadTodos(threadId: string, planPath: string): void {
		// Don't watch if already watching this thread
		if (this.watchers.has(threadId)) {
			console.log(`[PlanTodoSync] Already watching thread ${threadId}`);
			return;
		}

		console.log(`[PlanTodoSync] Starting watch for thread ${threadId} -> plan ${planPath}`);

		// Store current todoList state to detect actual changes
		const thread = this.chatThreadService.state.allThreads[threadId];
		let lastTodoListJson = stableTodoListKey(normalizeTodoList(thread?.todoList ?? []));

		// Phase 1.3 (C2) fix: subscribe to the dedicated todo-list event instead of
		// onDidChangeCurrentThread. This avoids running the JSON-diff on every state change
		// (which fires on stream chunks, tool progress, etc.) and ensures the sync fires
		// only when the todo list actually changes.
		const disposable = this.chatThreadService.onDidChangeThreadTodoList((e) => {
			if (e.threadId !== threadId) {
				return; // event for a different thread
			}
			const currentThread = this.chatThreadService.state.allThreads[threadId];
			if (!currentThread) {
				console.log(`[PlanTodoSync] Thread ${threadId} no longer exists, stopping watch`);
				this.unwatchThreadTodos(threadId);
				return;
			}
			const currentTodoListJson = stableTodoListKey(normalizeTodoList(currentThread.todoList ?? []));
			if (currentTodoListJson === lastTodoListJson) {
				return;
			}
			lastTodoListJson = currentTodoListJson;
			console.log(`[PlanTodoSync] TodoList changed for thread ${threadId}, triggering sync`);

			// Debounce sync to avoid excessive file writes
			const existingTimer = this.debounceTimers.get(threadId);
			if (existingTimer) {
				clearTimeout(existingTimer);
			}

			const timer = setTimeout(() => {
				this.syncThreadToPlan(threadId);
				this.debounceTimers.delete(threadId);
			}, 500); // 500ms debounce

			this.debounceTimers.set(threadId, timer);
		});

		this.watchers.set(threadId, disposable);
	}

	/**
	 * Stops watching thread todos
	 */
	unwatchThreadTodos(threadId: string): void {
		const watcher = this.watchers.get(threadId);
		if (watcher) {
			watcher.dispose();
			this.watchers.delete(threadId);
			console.log(`[PlanTodoSync] Stopped watching thread ${threadId}`);
		}

		// Clear debounce timer
		const timer = this.debounceTimers.get(threadId);
		if (timer) {
			clearTimeout(timer);
			this.debounceTimers.delete(threadId);
		}

		// Clear last synced state
		this.lastSyncedTodos.delete(threadId);
		// Clear per-thread sync-failure tracking so a thread that's re-watched
		// later starts with a clean failure streak.
		this.syncFailureCounts.delete(threadId);
		this.syncFailureNotified.delete(threadId);
	}

	/**
	 * Checks if a thread is currently being watched
	 */
	isWatching(threadId: string): boolean {
		return this.watchers.has(threadId);
	}

	override dispose(): void {
		// Stop all watchers
		for (const [threadId] of this.watchers) {
			this.unwatchThreadTodos(threadId);
		}
		super.dispose();
	}
}

// Register the service
registerSingleton(IPlanTodoSyncService, PlanTodoSyncService, InstantiationType.Delayed);
