/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { RunnerApprovalResponsePayload, RunnerTaskEventPayload } from '../common/runner/runnerProtocol.js';
import type {
	CreateRemoteTaskRequest,
	RemoteTaskLiveState,
	RemoteTaskPermissionRequest,
	RemoteTaskSummary,
} from '../common/runner/runnerTypes.js';

export interface IRemoteTaskService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeTasks: Event<void>;
	readonly onDidReceiveEvent: Event<{ taskId: string; event: RunnerTaskEventPayload }>;
	readonly onPermissionRequest: Event<RemoteTaskPermissionRequest>;
	listTasks(): RemoteTaskSummary[];
	getLiveState(taskId: string): RemoteTaskLiveState | undefined;
	createTask(request: CreateRemoteTaskRequest): Promise<{ ok: true; task: RemoteTaskSummary } | { ok: false; error: string; code?: string }>;
	cancelTask(taskId: string, reason?: string): Promise<void>;
	approvePermission(decision: RunnerApprovalResponsePayload): Promise<void>;
	reconnect(taskId?: string): Promise<void>;
	reconnectAllActive(): Promise<void>;
	cancelTasksForThread(editorThreadId: string): Promise<void>;
	/** Cancel active tasks and drop all persisted sessions for a deleted chat thread. */
	removeTasksForThread(editorThreadId: string): Promise<void>;
	reattachTaskToThread(taskId: string, editorMessageIndex: number, editorHistoryAnchor: string): Promise<void>;
}

export const IRemoteTaskService = createDecorator<IRemoteTaskService>('orbitRemoteTaskService');
