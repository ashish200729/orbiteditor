/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IEncryptionService } from '../../../../platform/encryption/common/encryptionService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { REMOTE_TASKS_STORAGE_KEY } from '../common/storageKeys.js';
import { safeForLog } from '../common/helpers/sanitizeForLog.js';
import { assertNoUnsupportedCapabilities, defaultRemoteTaskCapabilities } from '../common/runner/capabilityNegotiation.js';
import {
	createRunnerEnvelope,
	formatRunnerError,
	parseRunnerWireJson,
	RUNNER_HEARTBEAT_INTERVAL_MS,
	RUNNER_V1_CAPABILITIES,
	validateRunnerWelcome,
	type RunnerApprovalResponsePayload,
	type RunnerEnvelope,
	type RunnerTaskEventPayload,
	type RunnerTaskState,
	type RunnerWelcomePayload,
} from '../common/runner/runnerProtocol.js';
import { applyTaskStateTransition, isTerminalTaskState } from '../common/runner/taskStateMachine.js';
import type {
	CreateRemoteTaskRequest,
	RemoteTaskLiveState,
	RemoteTaskPermissionRequest,
	RemoteTaskSummary,
} from '../common/runner/runnerTypes.js';
import { parseArtifactBranch } from '../common/runner/remoteHandoffArtifacts.js';
import { IRunnerService } from './runnerService.js';
import { IChatThreadService } from './chatThreadService.js';
import { remoteTaskChatMessages } from '../common/runner/remoteTaskChatMessages.js';
import { IRemoteTaskService } from './remoteTaskService.interface.js';

export { IRemoteTaskService } from './remoteTaskService.interface.js';

/**
 * Fail-closed timeout (R3): if a task stays in CREATED/QUEUED with no progress
 * events for this many ms after a connect attempt, mark it FAILED so the UI
 * stops showing an eternal "Running" spinner. Generous enough to absorb a
 * slow TLS handshake + auth roundtrip on a remote runner.
 */
const CONNECT_WATCHDOG_MS = 45_000;

/**
 * Heartbeat ack timeout: if no `heartbeat.ack` arrives within this window
 * after the last ack, the socket is closed (code 4000) so onclose can
 * schedule a reconnect. The editor drives liveness — the runner never pings.
 */
const HEARTBEAT_ACK_TIMEOUT_MS = 45_000;

/**
 * Maximum automatic reconnect attempts before marking the task LOST and
 * allowing new submits. The runner may still be processing; user can Reconnect.
 */
const MAX_RECONNECT_ATTEMPTS = 30;

/** Soft warn when persisted remote-task summaries approach the retention cap. */
const MAX_PERSISTED_TASKS = 100;

type Session = {
	taskId: string;
	runnerId: string;
	ws?: WebSocket;
	connected: boolean;
	authenticated: boolean;
	reconnecting: boolean;
	reconnectAttempts: number;
	reconnectTimer?: ReturnType<typeof setTimeout>;
	heartbeatTimer?: number;
	closeTimer?: ReturnType<typeof setTimeout>;
	/** Fail-closed watchdog: if the task stays in CREATED/QUEUED with no
	 * progress events for this long after a connect attempt, mark it FAILED. */
	connectWatchdogTimer?: ReturnType<typeof setTimeout>;
	lastHeartbeatAckAt?: number;
	outbox: RunnerEnvelope[];
	events: RunnerTaskEventPayload[];
	pendingPermission?: RemoteTaskPermissionRequest;
	lastAckSeq: number;
	summary: RemoteTaskSummary;
	wantOpen: boolean;
	pendingCreate: boolean;
	pendingCancelReason?: string;
	pendingApprovalResponse?: RunnerApprovalResponsePayload;
	/** True while waiting for event.replay / resubscribe after a seq gap. */
	awaitingReplay?: boolean;
};

class RemoteTaskService extends Disposable implements IRemoteTaskService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeTasks = this._register(new Emitter<void>());
	readonly onDidChangeTasks = this._onDidChangeTasks.event;

	private readonly _onDidReceiveEvent = this._register(new Emitter<{ taskId: string; event: RunnerTaskEventPayload }>());
	readonly onDidReceiveEvent = this._onDidReceiveEvent.event;

	private readonly _onPermissionRequest = this._register(new Emitter<RemoteTaskPermissionRequest>());
	readonly onPermissionRequest = this._onPermissionRequest.event;

	private readonly _sessions = new Map<string, Session>();
	private _loaded = false;
	private readonly _loadPromise: Promise<void>;
	private _persistWarnedOverCap = false;

	constructor(
		@IRunnerService private readonly _runnerService: IRunnerService,
		@IStorageService private readonly _storageService: IStorageService,
		@IEncryptionService private readonly _encryptionService: IEncryptionService,
		@ILogService private readonly _logService: ILogService,
		@IProductService private readonly _productService: IProductService,
		@IChatThreadService private readonly _chatThreadService: IChatThreadService,
	) {
		super();
		this._loadPromise = this._loadSummaries().then(() => {
			this._onDidChangeTasks.fire();
			this._syncBusyStatus();
			void this.reconnectAllActive();
		});
		this._register({ dispose: () => {
			for (const session of this._sessions.values()) {
				session.wantOpen = false;
				if (session.reconnectTimer) { clearTimeout(session.reconnectTimer); }
				if (session.heartbeatTimer) { mainWindow.clearInterval(session.heartbeatTimer); }
				if (session.closeTimer) { clearTimeout(session.closeTimer); }
				if (session.connectWatchdogTimer) { clearTimeout(session.connectWatchdogTimer); }
				try { session.ws?.close(); } catch { /* ignore */ }
			}
			if (this._persistTimer) { clearTimeout(this._persistTimer); }
		} });
	}

	listTasks(): RemoteTaskSummary[] {
		return [...this._sessions.values()].map(s => s.summary).sort((a, b) => b.updatedAt - a.updatedAt);
	}

	getLiveState(taskId: string): RemoteTaskLiveState | undefined {
		const s = this._sessions.get(taskId);
		if (!s) { return undefined; }
		return {
			summary: s.summary,
			events: s.events.slice(),
			pendingPermission: s.pendingPermission,
			reconnecting: s.reconnecting,
			connected: s.connected,
		};
	}

	async createTask(request: CreateRemoteTaskRequest): Promise<{ ok: true; task: RemoteTaskSummary } | { ok: false; error: string; code?: string }> {
		await this._loadPromise;

		const capsCheck = assertNoUnsupportedCapabilities(request.requestedCapabilities ?? defaultRemoteTaskCapabilities());
		if (!capsCheck.ok) {
			return { ok: false, error: formatRunnerError(capsCheck.error), code: capsCheck.error.code };
		}

		const runner = this._runnerService.getRunner(request.runnerId);
		if (!runner) {
			return { ok: false, error: 'Self-hosted runner not found. Pair a runner in Settings.', code: 'task_not_found' };
		}

		const hostUrl = this._runnerService.getHostUrl(request.runnerId);
		const auth = await this._runnerService.getCredential(request.runnerId);
		if (!hostUrl || !auth) {
			return { ok: false, error: 'Missing runner credentials. Re-pair the runner.', code: 'unauthorized' };
		}

		const now = Date.now();
		const clientTaskId = crypto.randomUUID();
			const summary: RemoteTaskSummary = {
				taskId: clientTaskId,
				runnerId: request.runnerId,
				state: 'CREATED',
				prompt: request.prompt,
				git: request.git,
				model: request.model,
				chatMode: request.chatMode,
				autoApprove: request.autoApprove,
				editorThreadId: request.editorThreadId,
				editorMessageIndex: request.editorMessageIndex,
				editorHistoryAnchor: request.editorHistoryAnchor,
				parentTaskId: request.parentTaskId,
				createdAt: now,
				updatedAt: now,
				lastSeq: -1,
			};

			const session: Session = {
				taskId: clientTaskId,
				runnerId: request.runnerId,
				connected: false,
				authenticated: false,
				reconnecting: false,
				reconnectAttempts: 0,
				outbox: [],
				events: [],
				lastAckSeq: -1,
				summary,
				wantOpen: true,
				pendingCreate: true,
			};
			this._sessions.set(clientTaskId, session);
			if (!(await this._persistSummaries())) {
				this._sessions.delete(clientTaskId);
				return {
					ok: false,
					error: 'Could not save the remote task locally. Try again.',
					code: 'storage_failed',
				};
			}
			this._syncBusyStatus();
			this._onDidChangeTasks.fire();
			void this._ensureSubscribed(session);
			return { ok: true, task: summary };
	}

	async cancelTask(taskId: string, reason?: string): Promise<void> {
		await this._loadPromise;
		const session = this._sessions.get(taskId);
		if (!session) { return; }
		session.pendingCancelReason = reason ?? 'Cancelled from Orbit Editor';
		// If we never authenticated, the runner never accepted the task — fail
		// closed locally so the UI stops showing Running immediately instead
		// of waiting for a task.cancel ack that will never come.
		if (!session.authenticated && !isTerminalTaskState(session.summary.state)) {
			this._failClosed(session, session.pendingCancelReason, 'cancelled');
			return;
		}
		await this._persistSummaries();
		this._sendDurableCommand(session, createRunnerEnvelope('task.cancel', { taskId, reason: session.pendingCancelReason }));
	}

	async approvePermission(decision: RunnerApprovalResponsePayload): Promise<void> {
		await this._loadPromise;
		const session = this._sessions.get(decision.taskId);
		if (!session) { return; }
		session.pendingApprovalResponse = decision;
		await this._persistSummaries();
		this._sendDurableCommand(session, createRunnerEnvelope('approval.response', decision));
	}

	async reconnect(taskId?: string): Promise<void> {
		await this._loadPromise;
		if (taskId) {
			const s = this._sessions.get(taskId);
			if (s) {
				s.wantOpen = true;
				s.reconnectAttempts = 0;
				await this._ensureSubscribed(s, true);
			}
			return;
		}
		await this.reconnectAllActive();
	}

	async reconnectAllActive(): Promise<void> {
		await this._loadPromise;
		const active = [...this._sessions.values()].filter(s => !isTerminalTaskState(s.summary.state));
		await Promise.allSettled(active.map(s => {
			s.wantOpen = true;
			s.reconnectAttempts = 0;
			return this._ensureSubscribed(s, true);
		}));
	}

	async cancelTasksForThread(editorThreadId: string): Promise<void> {
		await this._loadPromise;
		const tasks = this.listTasks().filter(task => task.editorThreadId === editorThreadId);
		await Promise.allSettled(tasks
			.filter(task => !isTerminalTaskState(task.state))
			.map(task => this.cancelTask(task.taskId, 'Thread deleted')));
	}

	async removeTasksForThread(editorThreadId: string): Promise<void> {
		await this._loadPromise;
		await this.cancelTasksForThread(editorThreadId);
		let removed = false;
		for (const [taskId, session] of [...this._sessions.entries()]) {
			if (session.summary.editorThreadId !== editorThreadId) {
				continue;
			}
			session.wantOpen = false;
			if (session.reconnectTimer) { clearTimeout(session.reconnectTimer); }
			if (session.heartbeatTimer) { mainWindow.clearInterval(session.heartbeatTimer); }
			if (session.closeTimer) { clearTimeout(session.closeTimer); }
			if (session.connectWatchdogTimer) { clearTimeout(session.connectWatchdogTimer); }
			try { session.ws?.close(); } catch { /* ignore */ }
			this._sessions.delete(taskId);
			removed = true;
		}
		if (removed) {
			await this._persistSummaries();
			this._syncBusyStatus();
			this._onDidChangeTasks.fire();
		}
	}

	async reattachTaskToThread(taskId: string, editorMessageIndex: number, editorHistoryAnchor: string): Promise<void> {
		await this._loadPromise;
		const session = this._sessions.get(taskId);
		if (!session) { return; }
		session.summary = {
			...session.summary,
			editorMessageIndex,
			editorHistoryAnchor,
			updatedAt: Date.now(),
		};
		await this._persistSummaries();
		this._onDidChangeTasks.fire();
	}

	private _maybeMaterializeRemoteTurn(session: Session): void {
		const { summary } = session;
		if (!summary.editorThreadId || !isTerminalTaskState(summary.state)) {
			return;
		}
		const messages = remoteTaskChatMessages(summary, session.events, { skipUserMessage: true });
		this._chatThreadService.materializeRemoteTurn(summary.editorThreadId, summary.taskId, messages, {
			state: summary.state,
			lastError: summary.lastError,
		});
	}

	private async _ensureSubscribed(session: Session, force = false): Promise<void> {
		if (!session.wantOpen) { return; }
		if (session.ws && (session.ws.readyState === WebSocket.OPEN || session.ws.readyState === WebSocket.CONNECTING) && !force) {
			return;
		}
		if (session.ws) {
			try { session.ws.close(); } catch { /* ignore */ }
			session.ws = undefined;
		}
		if (session.heartbeatTimer) {
			mainWindow.clearInterval(session.heartbeatTimer);
			session.heartbeatTimer = undefined;
		}
		if (session.closeTimer) {
			clearTimeout(session.closeTimer);
			session.closeTimer = undefined;
		}
		if (session.reconnectTimer) {
			clearTimeout(session.reconnectTimer);
			session.reconnectTimer = undefined;
		}

		const hostUrl = this._runnerService.getHostUrl(session.runnerId);
		const auth = await this._runnerService.getCredential(session.runnerId);
		if (!hostUrl || !auth) {
			session.connected = false;
			session.reconnecting = false;
			this._failClosed(session, 'Missing runner credentials. Re-pair the runner in Settings.', 'unauthorized');
			return;
		}

		session.reconnecting = true;
		this._onDidChangeTasks.fire();

		// Arm the connect watchdog (R3): fail closed if no progress within the SLA.
		this._armConnectWatchdog(session);

		let ws: WebSocket;
		try {
			ws = new WebSocket(hostUrl);
		} catch (e) {
			session.reconnecting = false;
			this._failClosed(session, e instanceof Error ? e.message : String(e), 'connect_failed');
			return;
		}

		session.ws = ws;
		session.authenticated = false;

		ws.onopen = () => {
			if (session.ws !== ws) { return; }
			ws.send(JSON.stringify(createRunnerEnvelope('hello', {
				clientName: 'orbit-editor',
				clientVersion: String(this._productService.version || '0.0.0'),
				deviceId: auth.deviceId,
			})));
		};

		ws.onmessage = (ev) => {
			if (session.ws !== ws) { return; }
			const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
			const parsed = parseRunnerWireJson(text);
			if (!parsed.ok) {
				this._logService.warn('[orbit-runner] bad event', safeForLog(parsed.error));
				return;
			}
			if (parsed.message.type === 'welcome') {
				const welcome = parsed.message.payload as RunnerWelcomePayload;
				const welcomeCheck = validateRunnerWelcome(welcome);
				if (!welcomeCheck.ok) {
					this._failClosed(session, formatRunnerError(welcomeCheck.error), welcomeCheck.error.code, ws);
					return;
				}
				ws.send(JSON.stringify(createRunnerEnvelope('auth', {
					deviceId: auth.deviceId,
					credential: auth.credential,
				})));
				return;
			}
		if (parsed.message.type === 'auth.result') {
			const result = parsed.message.payload as { ok?: boolean; error?: string; capabilities?: import('../common/runner/runnerProtocol.js').RunnerCapabilities };
			if (!result.ok) {
				this._failClosed(session, result.error || 'Runner authentication failed', 'unauthorized', ws);
				return;
			}
			// Negotiate capabilities after auth; cache on runner service for submit gating.
			ws.send(JSON.stringify(createRunnerEnvelope('capabilities.negotiate', {
				requested: RUNNER_V1_CAPABILITIES,
			})));
			session.authenticated = true;
			session.connected = true;
			session.reconnecting = false;
			session.reconnectAttempts = 0;
			session.lastHeartbeatAckAt = Date.now();
			// Auth succeeded — clear the connect watchdog. The heartbeat
			// timeout (45s without ack) takes over from here.
			this._clearConnectWatchdog(session);
				if (session.pendingCreate && session.summary.git && session.summary.model && session.summary.chatMode) {
					ws.send(JSON.stringify(createRunnerEnvelope('task.create', {
						taskId: session.taskId,
						parentTaskId: session.summary.parentTaskId,
						prompt: session.summary.prompt,
						model: session.summary.model,
						git: session.summary.git,
						requestedCapabilities: defaultRemoteTaskCapabilities(),
						metadata: {
							chatMode: session.summary.chatMode,
							editorThreadId: session.summary.editorThreadId,
							autoApprove: session.summary.autoApprove ?? {},
						},
					})));
				} else {
					ws.send(JSON.stringify(createRunnerEnvelope('task.subscribe', {
						taskId: session.taskId,
						fromSeq: session.lastAckSeq + 1,
					})));
				}
				ws.send(JSON.stringify(createRunnerEnvelope('heartbeat', {
					lastAckSeq: Math.max(0, session.lastAckSeq),
				})));
				session.heartbeatTimer = mainWindow.setInterval(() => {
					if (session.ws !== ws || ws.readyState !== WebSocket.OPEN || !session.authenticated) { return; }
					if (session.lastHeartbeatAckAt && Date.now() - session.lastHeartbeatAckAt > HEARTBEAT_ACK_TIMEOUT_MS) {
						ws.close(4000, 'heartbeat timeout');
						return;
					}
					ws.send(JSON.stringify(createRunnerEnvelope('heartbeat', {
						lastAckSeq: Math.max(0, session.lastAckSeq),
					})));
				}, RUNNER_HEARTBEAT_INTERVAL_MS);
				for (const queued of session.outbox.splice(0)) {
					ws.send(JSON.stringify(queued));
				}
				if (session.pendingCancelReason) {
					ws.send(JSON.stringify(createRunnerEnvelope('task.cancel', {
						taskId: session.taskId,
						reason: session.pendingCancelReason,
					})));
				}
				if (session.pendingApprovalResponse) {
					ws.send(JSON.stringify(createRunnerEnvelope('approval.response', session.pendingApprovalResponse)));
				}
				this._onDidChangeTasks.fire();
				return;
			}
			this._handleServerMessage(session, parsed.message);
		};

		ws.onerror = () => {
			if (session.ws !== ws) { return; }
			session.connected = false;
			session.authenticated = false;
			session.reconnecting = true;
			this._onDidChangeTasks.fire();
		};

		ws.onclose = (ev) => {
			if (session.ws !== ws) { return; }
			this._logService.info(`[orbit-runner] task ${session.taskId} socket closed (code=${ev.code}${ev.reason ? ` reason=${ev.reason}` : ''})`);
			if (session.heartbeatTimer) {
				mainWindow.clearInterval(session.heartbeatTimer);
				session.heartbeatTimer = undefined;
			}
			this._clearConnectWatchdog(session);
			session.connected = false;
			session.authenticated = false;
			session.ws = undefined;
			this._onDidChangeTasks.fire();
			if (session.wantOpen && !isTerminalTaskState(session.summary.state)) {
				session.reconnecting = true;
				session.reconnectAttempts += 1;
				if (session.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
					// Exhausted reconnects — mark LOST so the UI clears busy state
					// and new submits are allowed. User can still click Reconnect.
					session.reconnecting = false;
					session.wantOpen = false;
					const applied = applyTaskStateTransition(session.summary.state, 'LOST');
					session.summary = {
						...session.summary,
						state: applied.state === 'LOST' ? 'LOST' : applied.state,
						lastError: 'Lost connection to the Self-hosted Runner after repeated reconnect attempts. Click Reconnect to resume, or start a new task.',
						updatedAt: Date.now(),
					};
					if (applied.error) {
						// Force LOST even if the state machine rejected (should not happen after E1 transitions).
						session.summary = { ...session.summary, state: 'LOST' };
					}
					this._persistSummariesDebounced();
					this._syncBusyStatus();
					this._onDidChangeTasks.fire();
					return;
				}
				const base = Math.min(30_000, 1_000 * (2 ** Math.min(session.reconnectAttempts, 5)));
				const delay = base + Math.floor(Math.random() * Math.max(250, base * 0.2));
				session.reconnectTimer = setTimeout(() => {
					session.reconnectTimer = undefined;
					void this._ensureSubscribed(session);
				}, delay);
			} else {
				session.reconnecting = false;
			}
		};
	}

	private _handleServerMessage(session: Session, msg: RunnerEnvelope): void {
		switch (msg.type) {
		case 'task.created': {
			const payload = msg.payload as { taskId: string; state: RunnerTaskState };
			if (payload.taskId !== session.taskId) { return; }
			session.pendingCreate = false;
			this._clearConnectWatchdog(session);
			session.summary = { ...session.summary, state: payload.state, lastError: undefined, updatedAt: Date.now() };
				this._sendOnSession(session, createRunnerEnvelope('task.subscribe', { taskId: session.taskId, fromSeq: session.lastAckSeq + 1 }));
				this._persistSummariesDebounced();
				this._onDidChangeTasks.fire();
				break;
			}
		case 'task.snapshot': {
			const payload = msg.payload as {
				taskId: string;
				state: RunnerTaskState;
				error?: string;
				pendingApproval?: { taskId: string; approvalId: string; toolCallId?: string; toolName: string; toolArgs?: unknown; reason?: string };
			};
			if (payload.taskId !== session.taskId) { return; }
			this._clearConnectWatchdog(session);
			session.summary = { ...session.summary, state: payload.state, lastError: payload.error, updatedAt: Date.now() };
				if (isTerminalTaskState(payload.state)) session.pendingCancelReason = undefined;
				session.pendingPermission = payload.pendingApproval ? {
					taskId: payload.pendingApproval.taskId,
					approvalId: payload.pendingApproval.approvalId,
					toolCallId: payload.pendingApproval.toolCallId,
					toolName: payload.pendingApproval.toolName,
					toolArgs: payload.pendingApproval.toolArgs,
					summary: payload.pendingApproval.reason || `Approve ${payload.pendingApproval.toolName}?`,
					receivedAt: Date.now(),
				} : undefined;
				if (isTerminalTaskState(payload.state)) {
					session.wantOpen = false;
					this._scheduleTerminalClose(session);
					this._maybeMaterializeRemoteTurn(session);
				}
				this._persistSummariesDebounced();
				this._onDidChangeTasks.fire();
				break;
			}
		case 'task.event': {
			const event = msg.payload as RunnerTaskEventPayload;
			if (event.taskId !== session.taskId) { return; }
			session.pendingCreate = false;
			this._clearConnectWatchdog(session);
			if (event.seq <= session.lastAckSeq) { return; }
			// Gap detection: never silently accept holes in the append-only stream.
			if (event.seq > session.lastAckSeq + 1) {
				this._logService.warn(
					`[orbit-runner] event seq gap for ${session.taskId}: got ${event.seq}, expected ${session.lastAckSeq + 1} — resubscribing`,
				);
				session.awaitingReplay = true;
				this._sendOnSession(session, createRunnerEnvelope('task.subscribe', {
					taskId: session.taskId,
					fromSeq: session.lastAckSeq + 1,
				}));
				return;
			}
			session.awaitingReplay = false;
				const previous = session.events[session.events.length - 1];
				if (event.kind === 'agent.message.delta' && previous?.kind === event.kind) {
					const previousData = previous.data as { content?: unknown; iteration?: unknown } | undefined;
					const eventData = event.data as { content?: unknown; iteration?: unknown } | undefined;
					if (typeof previousData?.content === 'string' && typeof eventData?.content === 'string'
						&& previousData.iteration === eventData.iteration) {
						session.events[session.events.length - 1] = {
							...event,
							data: { ...eventData, content: previousData.content + eventData.content },
						};
					} else {
						session.events.push(event);
					}
				} else {
					session.events.push(event);
				}
				if (session.events.length > 2_000) session.events.splice(0, session.events.length - 2_000);
				session.lastAckSeq = Math.max(session.lastAckSeq, event.seq);
				session.summary = { ...session.summary, lastSeq: session.lastAckSeq, updatedAt: Date.now() };
				if (event.kind === 'artifact.branch') {
					const branch = parseArtifactBranch(event.data);
					if (branch?.headCommit && /^[0-9a-f]{40}$/i.test(branch.headCommit)) {
						session.summary = {
							...session.summary,
							headCommit: branch.headCommit,
							git: session.summary.git
								? { ...session.summary.git, commit: branch.headCommit, branch: branch.name || session.summary.git.branch }
								: session.summary.git,
						};
					}
				}
				if (event.kind === 'approval.resolved') {
					const data = event.data as { approvalId?: string } | undefined;
					if (data?.approvalId && session.pendingPermission?.approvalId === data.approvalId) {
						session.pendingPermission = undefined;
					}
					if (data?.approvalId && session.pendingApprovalResponse?.approvalId === data.approvalId) {
						session.pendingApprovalResponse = undefined;
					}
				}
				this._sendOnSession(session, createRunnerEnvelope('event.ack', {
					taskId: session.taskId,
					lastAckSeq: session.lastAckSeq,
				}));
				this._onDidReceiveEvent.fire({ taskId: session.taskId, event });
				this._persistSummariesDebounced();
				this._onDidChangeTasks.fire();
				break;
			}
		case 'task.state': {
			const payload = msg.payload as { taskId: string; from: RunnerTaskState; to: RunnerTaskState; reason?: string };
			if (payload.taskId !== session.taskId) { return; }
			session.pendingCreate = false;
			this._clearConnectWatchdog(session);
			this._updateState(session, payload.to, payload.reason);
				if (isTerminalTaskState(payload.to)) {
					session.pendingCancelReason = undefined;
					session.wantOpen = false;
					this._scheduleTerminalClose(session);
					this._maybeMaterializeRemoteTurn(session);
				}
				break;
			}
			case 'approval.request': {
				const payload = msg.payload as {
					taskId: string; approvalId: string; toolName: string; toolArgs: unknown; reason?: string;
				};
				if (payload.taskId !== session.taskId) { return; }
				const req: RemoteTaskPermissionRequest = {
					taskId: payload.taskId,
					approvalId: payload.approvalId,
					toolCallId: (payload as { toolCallId?: string }).toolCallId,
					toolName: payload.toolName,
					summary: payload.reason || `Approve ${payload.toolName}?`,
					toolArgs: payload.toolArgs,
					receivedAt: Date.now(),
				};
				session.pendingPermission = req;
				this._updateState(session, 'WAITING_FOR_APPROVAL');
				this._onPermissionRequest.fire(req);
				this._onDidChangeTasks.fire();
				break;
			}
		case 'error': {
			const err = msg.payload as { code?: string; message: string; retriable?: boolean };
			if (session.pendingCreate && !err.retriable) {
				this._failClosed(session, formatRunnerError(err), err.code);
				return;
			}
			session.summary = {
				...session.summary,
				lastError: formatRunnerError(err),
				updatedAt: Date.now(),
			};
			this._onDidChangeTasks.fire();
			break;
		}
			case 'welcome':
			case 'auth.result':
			case 'heartbeat.ack':
				session.lastHeartbeatAckAt = Date.now();
				break;
			case 'capabilities.result': {
				const caps = msg.payload as { agreed?: import('../common/runner/runnerProtocol.js').RunnerCapabilities };
				if (caps.agreed) {
					this._runnerService.cacheNegotiatedCapabilities(session.runnerId, caps.agreed);
				}
				break;
			}
			default:
				break;
		}
	}

	private _armConnectWatchdog(session: Session): void {
		if (session.connectWatchdogTimer) {
			clearTimeout(session.connectWatchdogTimer);
		}
		session.connectWatchdogTimer = setTimeout(() => {
			session.connectWatchdogTimer = undefined;
			// Only fail closed if we're still stuck pre-progress.
			if (session.wantOpen && !isTerminalTaskState(session.summary.state)
				&& (session.summary.state === 'CREATED' || session.summary.state === 'QUEUED')
				&& session.events.length === 0) {
				this._logService.warn(`[orbit-runner] connect watchdog fired for ${session.taskId} (state=${session.summary.state})`);
				this._failClosed(session, 'Timed out connecting to the Self-hosted Runner. Reconnect or check the runner status.', 'connect_timeout');
			}
		}, CONNECT_WATCHDOG_MS);
	}

	private _clearConnectWatchdog(session: Session): void {
		if (session.connectWatchdogTimer) {
			clearTimeout(session.connectWatchdogTimer);
			session.connectWatchdogTimer = undefined;
		}
	}

	/**
	 * Fail closed (R2): mark the task terminal FAILED, set lastError, stop
	 * reconnecting, clear the running map, and materialize the remote turn so
	 * the chat shows a visible error bubble instead of an eternal spinner.
	 */
	private _failClosed(session: Session, message: string, code: string | undefined, ws?: WebSocket): void {
		const wasPendingCreate = session.pendingCreate;
		session.pendingCreate = false;
		session.wantOpen = false;
		session.reconnecting = false;
		session.connected = false;
		session.authenticated = false;
		if (session.connectWatchdogTimer) {
			clearTimeout(session.connectWatchdogTimer);
			session.connectWatchdogTimer = undefined;
		}
		if (session.heartbeatTimer) {
			mainWindow.clearInterval(session.heartbeatTimer);
			session.heartbeatTimer = undefined;
		}
		// Only flip to FAILED if not already terminal — preserves COMPLETED etc.
		if (!isTerminalTaskState(session.summary.state)) {
			session.summary = {
				...session.summary,
				state: 'FAILED',
				lastError: message,
				updatedAt: Date.now(),
			};
		} else if (message) {
			session.summary = { ...session.summary, lastError: message, updatedAt: Date.now() };
		}
		void this._persistSummaries();
		// Materialize so an in-flight remote turn surfaces an error bubble
		// instead of disappearing. Skip when there was never a pending create
		// (e.g. reconnect of an already-materialized task) to avoid dupes.
		if (wasPendingCreate) {
			this._maybeMaterializeRemoteTurn(session);
		}
		this._syncBusyStatus();
		this._onDidChangeTasks.fire();
		if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
			try { ws.close(4001, code ?? 'failed'); } catch { /* ignore */ }
		} else if (session.ws && session.ws.readyState === WebSocket.OPEN) {
			try { session.ws.close(4001, code ?? 'failed'); } catch { /* ignore */ }
		}
		if (session.ws === ws) {
			session.ws = undefined;
		}
	}

	private _scheduleTerminalClose(session: Session): void {
		if (session.closeTimer) { clearTimeout(session.closeTimer); }
		session.closeTimer = setTimeout(() => {
			session.closeTimer = undefined;
			const ws = session.ws;
			if (!ws || ws.readyState !== WebSocket.OPEN) { return; }
			ws.send(JSON.stringify(createRunnerEnvelope('task.unsubscribe', { taskId: session.taskId })));
			setTimeout(() => { if (session.ws === ws) ws.close(1000, 'task complete'); }, 50);
		}, 1_000);
	}

	private _updateState(session: Session, to: RunnerTaskState, message?: string): void {
		const applied = applyTaskStateTransition(session.summary.state, to);
		session.summary = {
			...session.summary,
			state: applied.state,
			lastError: applied.error ?? (to === 'FAILED' || to === 'LOST' ? message : session.summary.lastError),
			updatedAt: Date.now(),
		};
		if (applied.error) {
			this._logService.warn(`[orbit-runner] ${applied.error}`);
		}
		this._persistSummariesDebounced();
		this._syncBusyStatus();
		this._onDidChangeTasks.fire();
	}

	private _syncBusyStatus(): void {
		const counts = new Map<string, number>();
		for (const session of this._sessions.values()) {
			if (!isTerminalTaskState(session.summary.state)) {
				counts.set(session.runnerId, (counts.get(session.runnerId) ?? 0) + 1);
			}
		}
		this._runnerService.setActiveTaskCounts(counts);
	}

	private _sendOnSession(session: Session, msg: RunnerEnvelope): void {
		if (session.ws && session.ws.readyState === WebSocket.OPEN && session.authenticated) {
			session.ws.send(JSON.stringify(msg));
			return;
		}
		session.outbox.push(msg);
		session.wantOpen = true;
		void this._ensureSubscribed(session);
	}

	private _sendDurableCommand(session: Session, msg: RunnerEnvelope): void {
		// Not queued on disconnect: the two callers (task.cancel,
		// approval.response) stash their intent on the session
		// (pendingCancelReason / pendingApprovalResponse), which is re-sent
		// on reconnect in _ensureSubscribed. Queueing here would duplicate.
		if (session.ws && session.ws.readyState === WebSocket.OPEN && session.authenticated) {
			session.ws.send(JSON.stringify(msg));
		} else {
			session.wantOpen = true;
			void this._ensureSubscribed(session);
		}
	}

	private _persistTimer: ReturnType<typeof setTimeout> | undefined;

	private _persistSummariesDebounced(): void {
		if (this._persistTimer) { clearTimeout(this._persistTimer); }
		this._persistTimer = setTimeout(() => { void this._persistSummaries(); }, 400);
	}

	private async _loadSummaries(): Promise<void> {
		if (this._loaded) { return; }
		try {
			const stored = this._storageService.get(REMOTE_TASKS_STORAGE_KEY, StorageScope.APPLICATION);
			if (stored) {
				let raw = stored;
				// Encrypted blob (v3+) — decrypt; on failure keep empty and do not wipe storage.
				if (!stored.trimStart().startsWith('{')) {
					try {
						raw = await this._encryptionService.decrypt(stored);
					} catch (e) {
						this._logService.error('[orbit-runner] Failed to decrypt remote tasks; keeping ciphertext (last-known-good)', safeForLog(e));
						this._loaded = true;
						return;
					}
				}
				const parsed = JSON.parse(raw) as {
					version: 1 | 2 | 3;
					tasks?: RemoteTaskSummary[];
					sessions?: Array<{ summary: RemoteTaskSummary; events?: RunnerTaskEventPayload[]; pendingCancelReason?: string; pendingApprovalResponse?: RunnerApprovalResponsePayload }>;
				};
				const storedSessions: Array<{
					summary: RemoteTaskSummary;
					events?: RunnerTaskEventPayload[];
					pendingCancelReason?: string;
					pendingApprovalResponse?: RunnerApprovalResponsePayload;
					pendingPermission?: RemoteTaskPermissionRequest;
				}> = (parsed?.version === 2 || parsed?.version === 3) && Array.isArray(parsed.sessions)
					? parsed.sessions
					: (Array.isArray(parsed.tasks) ? parsed.tasks.map(summary => ({ summary, events: [] })) : []);
				for (const storedSession of storedSessions) {
					const summary = storedSession.summary;
						if (!summary?.taskId) { continue; }
						const events = Array.isArray(storedSession.events) ? storedSession.events.slice(-2_000) : [];
						const lastAckSeq = events.reduce((max, event) => Math.max(max, event.seq), summary.lastSeq ?? -1);
						this._sessions.set(summary.taskId, {
							taskId: summary.taskId,
							runnerId: summary.runnerId,
							connected: false,
							authenticated: false,
							reconnecting: false,
							reconnectAttempts: 0,
							outbox: [],
							events,
							lastAckSeq,
							summary: { ...summary, lastSeq: lastAckSeq },
							wantOpen: !isTerminalTaskState(summary.state),
							pendingCreate: summary.state === 'CREATED',
							pendingCancelReason: storedSession.pendingCancelReason,
							pendingApprovalResponse: storedSession.pendingApprovalResponse,
							pendingPermission: storedSession.pendingPermission,
						});
				}
				// Migrate plaintext → encrypted on next persist.
				if (stored.trimStart().startsWith('{')) {
					void this._persistSummaries();
				}
			}
		} catch (e) {
			this._logService.error('[orbit-runner] Failed to load remote tasks', safeForLog(e));
		} finally {
			this._loaded = true;
		}
	}

	/** @returns false when storage fails (callers that report success must check this). */
	private async _persistSummaries(): Promise<boolean> {
		// Drop terminal sessions from the in-memory map after a grace window of
		// keeping the latest N summaries for history/continuation (E8/E9).
		const all = [...this._sessions.values()]
			.sort((a, b) => b.summary.updatedAt - a.summary.updatedAt);

		if (all.length > MAX_PERSISTED_TASKS && !this._persistWarnedOverCap) {
			this._persistWarnedOverCap = true;
			this._logService.warn(
				`[orbit-runner] ${all.length} remote tasks in memory; persisting only the newest ${MAX_PERSISTED_TASKS}. Delete old threads or revoke runners to reclaim space.`,
			);
		}

		const keep = all.slice(0, MAX_PERSISTED_TASKS);
		const keepIds = new Set(keep.map(s => s.taskId));
		for (const session of all) {
			if (keepIds.has(session.taskId)) {
				continue;
			}
			// Only prune terminal sessions that fell off the retention window.
			if (isTerminalTaskState(session.summary.state)) {
				session.wantOpen = false;
				try { session.ws?.close(); } catch { /* ignore */ }
				this._sessions.delete(session.taskId);
			}
		}

		const sessions = keep.map(s => ({
			summary: s.summary,
			events: s.events.slice(-2_000),
			pendingCancelReason: s.pendingCancelReason,
			pendingApprovalResponse: s.pendingApprovalResponse,
			pendingPermission: s.pendingPermission,
		}));
		try {
			const encrypted = await this._encryptionService.encrypt(JSON.stringify({ version: 3, sessions }));
			this._storageService.store(
				REMOTE_TASKS_STORAGE_KEY,
				encrypted,
				StorageScope.APPLICATION,
				StorageTarget.MACHINE,
			);
			return true;
		} catch (e) {
			this._logService.error('[orbit-runner] Failed to persist remote tasks', safeForLog(e));
			return false;
		}
	}
}

registerSingleton(IRemoteTaskService, RemoteTaskService, InstantiationType.Delayed);
