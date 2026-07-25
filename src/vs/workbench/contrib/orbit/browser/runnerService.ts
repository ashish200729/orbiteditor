/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IEncryptionService } from '../../../../platform/encryption/common/encryptionService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { PAIRED_RUNNERS_STORAGE_KEY } from '../common/storageKeys.js';
import { safeForLog } from '../common/helpers/sanitizeForLog.js';
import {
	RUNNER_DEFAULT_WS_PATH,
	RUNNER_DEFAULT_WS_PORT,
	RUNNER_PROTOCOL_VERSION,
	RUNNER_V1_CAPABILITIES,
	createRunnerEnvelope,
	formatRunnerError,
	parseRunnerWireJson,
	validateRunnerWelcome,
	type RunnerCapabilities,
	type RunnerEnvelope,
	type RunnerWelcomePayload,
} from '../common/runner/runnerProtocol.js';
import { isSecureRunnerUrl, normalizeRunnerHostUrl } from '../common/runner/runnerHostUrl.js';
import {
	syncProvidersToRunner as syncProvidersToRunnerHelper,
	buildProviderProvisionPayload,
	type EnsureChatProviderResult,
	type RunnerCatalogModel,
	type RunnerProvisionPayload,
	type SyncPolicy,
	type SyncResult,
} from '../common/runner/runnerProviderIntegration.js';
import type { ProviderName } from '../common/orbitSettingsTypes.js';
import { IVoidSettingsService } from '../common/orbitSettingsService.js';
import type {
	PairRunnerRequest,
	PairRunnerResult,
	PairedRunnerCredential,
	PairedRunnerStore,
	RunnerConnectionStatus,
	RunnerInfo,
	TestConnectionResult,
} from '../common/runner/runnerTypes.js';

export interface IRunnerService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeRunners: Event<void>;
	readonly onDidAutoCopyChatProvider: Event<{ runnerId: string; result: EnsureChatProviderResult }>;
	readonly onDidSyncProviders: Event<{ runnerId: string; result: SyncResult }>;
	listRunners(): RunnerInfo[];
	getRunner(runnerId: string): RunnerInfo | undefined;
	pairRunner(request: PairRunnerRequest): Promise<PairRunnerResult>;
	renameRunner(runnerId: string, name: string): Promise<void>;
	/** Mark a runner offline in local UI state (does not revoke credentials). */
	markRunnerOffline(runnerId: string): Promise<void>;
	/** @deprecated Use {@link markRunnerOffline}. */
	disconnectRunner(runnerId: string): Promise<void>;
	revokeRunner(runnerId: string): Promise<void>;
	/** Drop local credentials without contacting the runner (e.g. revoke failed / offline). */
	forgetRunnerLocally(runnerId: string): Promise<void>;
	testConnection(runnerId: string): Promise<TestConnectionResult>;
	refreshHeartbeat(runnerId: string): Promise<void>;
	refreshAllHeartbeats(): Promise<void>;
	/** Cache capabilities from `capabilities.result` (or auth.result). */
	cacheNegotiatedCapabilities(runnerId: string, capabilities: RunnerCapabilities): void;
	/** Update busy status from active remote task counts (E12). */
	setActiveTaskCounts(counts: ReadonlyMap<string, number>): void;
	/** NEVER log the return value. */
	getCredential(runnerId: string): Promise<{ deviceId: string; credential: string } | undefined>;
	getHostUrl(runnerId: string): string | undefined;
	/** Fetch non-secret provider/model catalog from the runner. */
	fetchProviderCatalog(runnerId: string): Promise<{ ok: true; providers: import('../common/runner/runnerProviderIntegration.js').RunnerProviderCatalogEntry[] } | { ok: false; error: string; code?: string }>;
	/**
	 * One-time explicit copy of an Orbit BYOK provider onto the runner.
	 * Requires userConfirmed: true in the provision payload. Never logs secrets.
	 */
	copyProviderToRunner(runnerId: string, provision: {
		providerId: string;
		displayName: string;
		apiKey?: string;
		baseUrl?: string;
		headersJSON?: string;
		models: Array<{ modelId: string; displayName?: string; capabilities?: Record<string, unknown> }>;
		source: 'editor_copy';
		configVersion: string;
		userConfirmed: true;
	}): Promise<{ ok: true; fingerprint: string } | { ok: false; error: string; code?: string }>;
	revokeProviderOnRunner(runnerId: string, providerId: string): Promise<{ ok: boolean; error?: string }>;
	/**
	 * Auto-copy the current Chat provider to the runner if missing.
	 * Pairing / connecting is consent for Chat provider only. Idempotent.
	 */
	ensureChatProviderOnRunner(runnerId: string): Promise<EnsureChatProviderResult>;
	/** Sync copyable providers from editor settings to the runner. */
	syncProvidersToRunner(runnerId: string, policy?: SyncPolicy): Promise<SyncResult>;
	/** Probe local models on the runner host (Ollama / vLLM / LM Studio). */
	probeProviderOnRunner(runnerId: string, providerId: string, baseUrl?: string): Promise<{ ok: true; models: RunnerCatalogModel[] } | { ok: false; error: string }>;
	/** Resolve provider + model on the runner (capability preflight). */
	resolveModelOnRunner(runnerId: string, providerId: string, modelId: string): Promise<{ ok: true; fingerprint?: string } | { ok: false; error: string; code?: string }>;
	getLastSyncResult(runnerId: string): SyncResult | undefined;
	getLastAutoCopyChatProviderResult(runnerId: string): EnsureChatProviderResult | undefined;
}

export const IRunnerService = createDecorator<IRunnerService>('orbitRunnerService');

type RunnerRuntimeState = {
	status: RunnerConnectionStatus;
	lastSeenAt?: number;
	lastError?: string;
	capabilities?: RunnerCapabilities;
	protocolVersion?: string;
};

class RunnerService extends Disposable implements IRunnerService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeRunners = this._register(new Emitter<void>());
	readonly onDidChangeRunners = this._onDidChangeRunners.event;

	private readonly _onDidAutoCopyChatProvider = this._register(new Emitter<{ runnerId: string; result: EnsureChatProviderResult }>());
	readonly onDidAutoCopyChatProvider = this._onDidAutoCopyChatProvider.event;

	private readonly _onDidSyncProviders = this._register(new Emitter<{ runnerId: string; result: SyncResult }>());
	readonly onDidSyncProviders = this._onDidSyncProviders.event;

	private _credentials: PairedRunnerCredential[] = [];
	private readonly _runtime = new Map<string, RunnerRuntimeState>();
	private _loaded = false;
	private readonly _loadPromise: Promise<void>;
	/** In-flight sync promises per runner — prevents parallel double-copies. */
	private readonly _syncInFlight = new Map<string, Promise<SyncResult>>();
	private readonly _lastSyncResult = new Map<string, SyncResult>();
	private readonly _lastAutoCopyResult = new Map<string, EnsureChatProviderResult>();
	private _settingsSyncTimer: ReturnType<typeof setTimeout> | undefined;
	/** Active non-terminal remote task counts per runner (from RemoteTaskService). */
	private readonly _activeTaskCounts = new Map<string, number>();
	/** Backoff for idle heartbeats when a runner is offline/error. */
	private readonly _heartbeatBackoffMs = new Map<string, number>();
	private _heartbeatTimer: number | undefined;

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IEncryptionService private readonly _encryptionService: IEncryptionService,
		@ILogService private readonly _logService: ILogService,
		@IProductService private readonly _productService: IProductService,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
	) {
		super();
		this._loadPromise = this._loadStore().then(() => {
			this._onDidChangeRunners.fire();
			setTimeout(() => { void this.refreshAllHeartbeats(); }, 0);
		});
		// Lightweight idle heartbeat: tick every 60s but skip recently-seen online runners
		// and apply backoff for offline ones (E14) — avoids full testConnection churn.
		this._heartbeatTimer = mainWindow.setInterval(() => { void this._tickHeartbeats(); }, 60_000);
		this._register({ dispose: () => { if (this._heartbeatTimer) { mainWindow.clearInterval(this._heartbeatTimer); } } });
		this._register(this._settingsService.onDidChangeState(() => {
			if (this._settingsSyncTimer) {
				clearTimeout(this._settingsSyncTimer);
			}
			// Debounced auto-sync: chat_only + fingerprint-diff only (E11).
			this._settingsSyncTimer = setTimeout(() => { void this._syncAllOnlineRunners(); }, 2_000);
		}));
	}

	listRunners(): RunnerInfo[] {
		return this._credentials.map(c => this._toInfo(c));
	}

	getRunner(runnerId: string): RunnerInfo | undefined {
		const cred = this._credentials.find(c => c.runnerId === runnerId);
		return cred ? this._toInfo(cred) : undefined;
	}

	async pairRunner(request: PairRunnerRequest): Promise<PairRunnerResult> {
		await this._loadPromise;
		const pairingCode = (request.code ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
		const hostUrl = normalizeRunnerHostUrl(request.hostUrl);
		if (pairingCode.length !== 8) {
			return { ok: false, error: 'Enter the 8-character pairing code from the runner dashboard.', code: 'pairing_invalid' };
		}
		if (!hostUrl) {
			return { ok: false, error: `Enter the runner WebSocket URL (e.g. ws://127.0.0.1:${RUNNER_DEFAULT_WS_PORT}${RUNNER_DEFAULT_WS_PATH}).`, code: 'invalid_message' };
		}
		if (!isSecureRunnerUrl(hostUrl)) {
			return { ok: false, error: 'Use wss:// for a runner on another machine. Unencrypted ws:// is allowed only for localhost.', code: 'invalid_message' };
		}

		const deviceName = (request.deviceName ?? `${this._productService.nameShort || 'Orbit'} on ${guessHostLabel()}`).slice(0, 128);

		try {
			const result = await this._wsRoundTrip(hostUrl, async (send, wait) => {
				// hello → welcome
				send(createRunnerEnvelope('hello', {
					clientName: 'orbit-editor',
					clientVersion: String(this._productService.version || '0.0.0'),
				}));
				const welcome = await wait(['welcome', 'error'], 15_000);
				if (welcome.type === 'error') {
					return welcome;
				}
				send(createRunnerEnvelope('pair.redeem', { pairingCode, deviceName }));
				return wait(['pair.result', 'error'], 30_000);
			});

			if (result.type === 'error') {
				const err = result.payload as { code?: string; message: string };
				return { ok: false, error: formatRunnerError(err), code: err.code };
			}
			if (result.type !== 'pair.result') {
				return { ok: false, error: 'Unexpected response during pairing.', code: 'invalid_message' };
			}

			const payload = result.payload as { runnerId?: string; deviceId: string; credential: string; expiresAt: number | null };
			const now = Date.now();
			const runnerId = payload.runnerId || `runner_${payload.deviceId}`;
			const cred: PairedRunnerCredential = {
				runnerId,
				deviceId: payload.deviceId,
				credential: payload.credential,
				hostUrl,
				name: `Self-hosted Runner`,
				createdAt: now,
				updatedAt: now,
			};
			const previous = this._credentials.find(c => c.runnerId === runnerId);
			if (previous && previous.deviceId !== cred.deviceId) {
				const revoked = await this._authenticatedExchange(previous, (send, wait) => {
					send(createRunnerEnvelope('device.revoke', {}));
					return wait(['device.revoke.result', 'error'], 15_000);
				});
				if (revoked.type === 'error' || !(revoked.payload as { ok?: boolean }).ok) {
					const staleOldCredential = revoked.type === 'error'
						&& (revoked.payload as { code?: string }).code === 'UNAUTHORIZED';
					if (staleOldCredential) {
						this._logService.info(`[orbit-runner] Replaced stale revoked credential ${previous.deviceId}`);
					} else {
					// Do not leave the newly issued replacement credential active if rotation failed.
					await this._authenticatedExchange(cred, (send, wait) => {
						send(createRunnerEnvelope('device.revoke', {}));
						return wait(['device.revoke.result', 'error'], 15_000);
					}).catch(() => undefined);
					return {
						ok: false,
						error: 'Could not revoke the previous runner credential. The existing pairing was kept; revoke it from the runner dashboard before pairing again.',
						code: 'credential_rotation_failed',
					};
					}
				}
			}

			const previousCredentials = this._credentials;
			const previousRuntime = this._runtime.get(cred.runnerId);
			this._credentials = [
				...this._credentials.filter(c => c.deviceId !== cred.deviceId && c.runnerId !== cred.runnerId),
				cred,
			];
			this._runtime.set(cred.runnerId, {
				status: 'online',
				lastSeenAt: now,
				protocolVersion: RUNNER_PROTOCOL_VERSION,
			});
			if (!(await this._saveStore())) {
				this._credentials = previousCredentials;
				if (previousRuntime) {
					this._runtime.set(cred.runnerId, previousRuntime);
				} else {
					this._runtime.delete(cred.runnerId);
				}
				await this._authenticatedExchange(cred, (send, wait) => {
					send(createRunnerEnvelope('device.revoke', {}));
					return wait(['device.revoke.result', 'error'], 15_000);
				}).catch(() => undefined);
				return {
					ok: false,
					error: 'Paired with the runner, but could not save credentials locally. Try pairing again.',
					code: 'storage_failed',
				};
			}
			this._onDidChangeRunners.fire();
			this._logService.info(`[orbit-runner] Paired device ${cred.deviceId} at ${hostUrl}`);
			void this._maybeSyncProviders(cred.runnerId);
			return { ok: true, runner: this._toInfo(cred) };
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this._logService.warn(`[orbit-runner] Pairing failed: ${message}`);
			return { ok: false, error: message, code: 'runner_offline' };
		}
	}

	async renameRunner(runnerId: string, name: string): Promise<void> {
		await this._loadPromise;
		const trimmed = name.trim().slice(0, 80);
		if (!trimmed) { return; }
		this._credentials = this._credentials.map(c =>
			c.runnerId === runnerId ? { ...c, name: trimmed, updatedAt: Date.now() } : c
		);
		await this._saveStore();
		this._onDidChangeRunners.fire();
	}

	async markRunnerOffline(runnerId: string): Promise<void> {
		await this._loadPromise;
		const rt = this._runtime.get(runnerId) ?? { status: 'unknown' as const };
		this._runtime.set(runnerId, { ...rt, status: 'offline' });
		this._onDidChangeRunners.fire();
	}

	/** @deprecated Use {@link markRunnerOffline}. */
	async disconnectRunner(runnerId: string): Promise<void> {
		return this.markRunnerOffline(runnerId);
	}

	async revokeRunner(runnerId: string): Promise<void> {
		await this._loadPromise;
		const credential = this._credentials.find(c => c.runnerId === runnerId);
		if (credential) {
			const result = await this._authenticatedExchange(credential, (send, wait) => {
				send(createRunnerEnvelope('device.revoke', {}));
				return wait(['device.revoke.result', 'error'], 15_000);
			});
			if (result.type === 'error' || !(result.payload as { ok?: boolean }).ok) {
				throw new Error(result.type === 'error'
					? formatRunnerError(result.payload as { code?: string; message: string })
					: 'Runner refused to revoke this device.');
			}
		}
		await this.forgetRunnerLocally(runnerId);
	}

	async forgetRunnerLocally(runnerId: string): Promise<void> {
		await this._loadPromise;
		const before = this._credentials.length;
		this._credentials = this._credentials.filter(c => c.runnerId !== runnerId);
		this._runtime.delete(runnerId);
		this._activeTaskCounts.delete(runnerId);
		this._heartbeatBackoffMs.delete(runnerId);
		if (this._credentials.length !== before) {
			await this._saveStore();
			this._onDidChangeRunners.fire();
			this._logService.info(`[orbit-runner] Forgot local credentials for ${runnerId}`);
		}
	}

	cacheNegotiatedCapabilities(runnerId: string, capabilities: RunnerCapabilities): void {
		const rt = this._runtime.get(runnerId) ?? { status: 'unknown' as const };
		this._runtime.set(runnerId, {
			...rt,
			capabilities,
			protocolVersion: RUNNER_PROTOCOL_VERSION,
		});
		this._onDidChangeRunners.fire();
	}

	setActiveTaskCounts(counts: ReadonlyMap<string, number>): void {
		let changed = false;
		const seen = new Set<string>();
		for (const [runnerId, count] of counts) {
			seen.add(runnerId);
			const prev = this._activeTaskCounts.get(runnerId) ?? 0;
			if (prev !== count) {
				this._activeTaskCounts.set(runnerId, count);
				changed = true;
			}
			const rt = this._runtime.get(runnerId);
			if (!rt) {
				continue;
			}
			if (count > 0 && (rt.status === 'online' || rt.status === 'busy')) {
				if (rt.status !== 'busy') {
					this._runtime.set(runnerId, { ...rt, status: 'busy' });
					changed = true;
				}
			} else if (count === 0 && rt.status === 'busy') {
				this._runtime.set(runnerId, { ...rt, status: 'online' });
				changed = true;
			}
		}
		for (const [runnerId] of this._activeTaskCounts) {
			if (!seen.has(runnerId)) {
				this._activeTaskCounts.delete(runnerId);
				const rt = this._runtime.get(runnerId);
				if (rt?.status === 'busy') {
					this._runtime.set(runnerId, { ...rt, status: 'online' });
					changed = true;
				}
			}
		}
		if (changed) {
			this._onDidChangeRunners.fire();
		}
	}

	async testConnection(runnerId: string): Promise<TestConnectionResult> {
		await this._loadPromise;
		const cred = this._credentials.find(c => c.runnerId === runnerId);
		if (!cred) {
			return { ok: false, error: 'Runner not found.', code: 'task_not_found' };
		}
		const previous = this._runtime.get(runnerId);
		this._runtime.set(runnerId, {
			status: 'connecting',
			lastSeenAt: Date.now(),
			lastError: previous?.lastError,
			capabilities: previous?.capabilities,
			protocolVersion: previous?.protocolVersion,
		});
		this._onDidChangeRunners.fire();
		const started = Date.now();
		try {
			const result = await this._wsRoundTrip(cred.hostUrl, async (send, wait) => {
				send(createRunnerEnvelope('hello', {
					clientName: 'orbit-editor',
					clientVersion: String(this._productService.version || '0.0.0'),
					deviceId: cred.deviceId,
				}));
				const welcome = await wait(['welcome', 'error'], 15_000);
				if (welcome.type === 'error') {
					return welcome;
				}
				const welcomePayload = welcome.payload as RunnerWelcomePayload;
				const welcomeCheck = validateRunnerWelcome(welcomePayload);
				if (!welcomeCheck.ok) {
					return createRunnerEnvelope('error', welcomeCheck.error);
				}
				send(createRunnerEnvelope('auth', {
					deviceId: cred.deviceId,
					credential: cred.credential,
				}));
				const auth = await wait(['auth.result', 'error'], 15_000);
				if (auth.type === 'error') {
					return auth;
				}
				const authPayload = auth.payload as { ok: boolean; error?: string; capabilities?: RunnerCapabilities };
				if (!authPayload.ok) {
					return createRunnerEnvelope('error', {
						code: 'UNAUTHORIZED',
						message: authPayload.error || 'Unauthorized',
						retriable: false,
					});
				}
				send(createRunnerEnvelope('capabilities.negotiate', {
					requested: RUNNER_V1_CAPABILITIES,
				}));
				const caps = await wait(['capabilities.result', 'error'], 15_000);
				if (caps.type === 'error') {
					// Older runners may not support negotiate — fall back to auth capabilities.
					return createRunnerEnvelope('auth.result', {
						ok: true,
						capabilities: authPayload.capabilities ?? welcomePayload.capabilities,
					});
				}
				const capsPayload = caps.payload as { agreed?: RunnerCapabilities };
				return createRunnerEnvelope('auth.result', {
					ok: true,
					capabilities: capsPayload.agreed ?? authPayload.capabilities ?? welcomePayload.capabilities,
				});
			});

			const latencyMs = Date.now() - started;
			if (result.type === 'auth.result') {
				const payload = result.payload as { ok: boolean; error?: string; capabilities?: RunnerCapabilities };
				if (!payload.ok) {
					this._runtime.set(runnerId, { status: 'error', lastSeenAt: Date.now(), lastError: payload.error || 'Unauthorized' });
					this._onDidChangeRunners.fire();
					return { ok: false, error: payload.error || 'Unauthorized', code: 'unauthorized' };
				}
				const wasOnline = previous?.status === 'online' || previous?.status === 'busy';
				const active = this._activeTaskCounts.get(runnerId) ?? 0;
				this._runtime.set(runnerId, {
					status: active > 0 ? 'busy' : 'online',
					lastSeenAt: Date.now(),
					capabilities: payload.capabilities,
					protocolVersion: RUNNER_PROTOCOL_VERSION,
				});
				this._heartbeatBackoffMs.delete(runnerId);
				this._onDidChangeRunners.fire();
				if (!wasOnline) {
					void this._maybeSyncProviders(runnerId);
				}
				return { ok: true, latencyMs, capabilities: payload.capabilities };
			}
			const err = result.payload as { code?: string; message: string };
			this._runtime.set(runnerId, { status: 'error', lastSeenAt: Date.now(), lastError: formatRunnerError(err) });
			this._onDidChangeRunners.fire();
			return { ok: false, error: formatRunnerError(err), code: err.code };
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this._runtime.set(runnerId, { status: 'offline', lastSeenAt: Date.now(), lastError: message });
			this._onDidChangeRunners.fire();
			return { ok: false, error: message, code: 'runner_offline' };
		}
	}

	async refreshHeartbeat(runnerId: string): Promise<void> {
		await this.testConnection(runnerId);
	}

	async refreshAllHeartbeats(): Promise<void> {
		await this._loadPromise;
		await Promise.allSettled(this._credentials.map(c => this.testConnection(c.runnerId)));
	}

	/** Skip recently-healthy runners; backoff offline ones. */
	private async _tickHeartbeats(): Promise<void> {
		await this._loadPromise;
		const now = Date.now();
		await Promise.allSettled(this._credentials.map(async c => {
			const rt = this._runtime.get(c.runnerId);
			const lastSeen = rt?.lastSeenAt ?? 0;
			const status = rt?.status ?? 'unknown';
			if (status === 'connecting') {
				return;
			}
			if ((status === 'online' || status === 'busy') && now - lastSeen < 90_000) {
				return; // still fresh — skip full reconnect
			}
			const backoff = this._heartbeatBackoffMs.get(c.runnerId) ?? 60_000;
			if ((status === 'offline' || status === 'error') && now - lastSeen < backoff) {
				return;
			}
			const result = await this.testConnection(c.runnerId);
			if (!result.ok) {
				this._heartbeatBackoffMs.set(c.runnerId, Math.min(5 * 60_000, backoff * 2));
			} else {
				this._heartbeatBackoffMs.delete(c.runnerId);
			}
		}));
	}

	async getCredential(runnerId: string): Promise<{ deviceId: string; credential: string } | undefined> {
		await this._loadPromise;
		const c = this._credentials.find(x => x.runnerId === runnerId);
		return c ? { deviceId: c.deviceId, credential: c.credential } : undefined;
	}

	getHostUrl(runnerId: string): string | undefined {
		return this._credentials.find(c => c.runnerId === runnerId)?.hostUrl;
	}

	async fetchProviderCatalog(runnerId: string): Promise<{ ok: true; providers: import('../common/runner/runnerProviderIntegration.js').RunnerProviderCatalogEntry[] } | { ok: false; error: string; code?: string }> {
		await this._loadPromise;
		const cred = this._credentials.find(c => c.runnerId === runnerId);
		if (!cred) {
			return { ok: false, error: 'Runner not found.', code: 'task_not_found' };
		}
		try {
			const result = await this._authenticatedExchange(cred, (send, wait) => {
				send(createRunnerEnvelope('provider.catalog.request', {}));
				return wait(['provider.catalog.response', 'error'], 20_000);
			});
			if (result.type === 'error') {
				const err = result.payload as { code?: string; message: string };
				return { ok: false, error: formatRunnerError(err), code: err.code };
			}
			const payload = result.payload as { providers: import('../common/runner/runnerProviderIntegration.js').RunnerProviderCatalogEntry[] };
			return { ok: true, providers: payload.providers ?? [] };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e), code: 'runner_offline' };
		}
	}

	async copyProviderToRunner(runnerId: string, provision: {
		providerId: string;
		displayName: string;
		apiKey?: string;
		baseUrl?: string;
		headersJSON?: string;
		models: Array<{ modelId: string; displayName?: string; capabilities?: Record<string, unknown> }>;
		source: 'editor_copy';
		configVersion: string;
		userConfirmed: true;
	}): Promise<{ ok: true; fingerprint: string } | { ok: false; error: string; code?: string }> {
		await this._loadPromise;
		const cred = this._credentials.find(c => c.runnerId === runnerId);
		if (!cred) {
			return { ok: false, error: 'Runner not found.', code: 'task_not_found' };
		}
		if (!provision.userConfirmed) {
			return { ok: false, error: 'User confirmation is required to copy a provider.', code: 'unauthorized' };
		}
		try {
			const result = await this._authenticatedExchange(cred, (send, wait) => {
				send(createRunnerEnvelope('provider.provision.request', provision));
				return wait(['provider.provision.result', 'error'], 30_000);
			});
			if (result.type === 'error') {
				const err = result.payload as { code?: string; message: string };
				return { ok: false, error: formatRunnerError(err), code: err.code };
			}
			const payload = result.payload as { ok: boolean; fingerprint?: string; error?: string; code?: string };
			if (!payload.ok) {
				return { ok: false, error: payload.error || 'Provision failed', code: payload.code };
			}
			this._logService.info(`[orbit-runner] Provisioned provider ${provision.providerId} on ${runnerId} (fingerprint=${payload.fingerprint ?? 'n/a'})`);
			return { ok: true, fingerprint: payload.fingerprint ?? '' };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e), code: 'runner_offline' };
		}
	}

	async revokeProviderOnRunner(runnerId: string, providerId: string): Promise<{ ok: boolean; error?: string }> {
		await this._loadPromise;
		const cred = this._credentials.find(c => c.runnerId === runnerId);
		if (!cred) {
			return { ok: false, error: 'Runner not found.' };
		}
		try {
			const result = await this._authenticatedExchange(cred, (send, wait) => {
				send(createRunnerEnvelope('provider.revoke.request', { providerId }));
				return wait(['provider.revoke.result', 'error'], 20_000);
			});
			if (result.type === 'error') {
				const err = result.payload as { message: string };
				return { ok: false, error: err.message };
			}
			const payload = result.payload as { ok: boolean };
			return { ok: !!payload.ok };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	getLastAutoCopyChatProviderResult(runnerId: string): EnsureChatProviderResult | undefined {
		return this._lastAutoCopyResult.get(runnerId);
	}

	getLastSyncResult(runnerId: string): SyncResult | undefined {
		return this._lastSyncResult.get(runnerId);
	}

	async syncProvidersToRunner(runnerId: string, policy: SyncPolicy = { mode: 'all_copyable' }): Promise<SyncResult> {
		await this._loadPromise;
		if (!this._canAutoSyncCredentials(runnerId)) {
			return {
				ok: false,
				runnerId,
				syncedAt: Date.now(),
				entries: [],
				synced: [],
				skipped: [],
				failed: [{ providerId: 'openAI' as never, error: 'Use wss:// for remote runners before syncing credentials.' }],
			};
		}
		const existing = this._syncInFlight.get(runnerId);
		if (existing) {
			return existing;
		}
		const promise = (async (): Promise<SyncResult> => {
			try {
				await this._settingsService.waitForInitState;
				const state = this._settingsService.state;
				const effectivePolicy = this._effectiveSyncPolicy(runnerId, policy);
				const result = await syncProvidersToRunnerHelper(
					runnerId,
					{
						settingsOfProvider: state.settingsOfProvider,
						modelSelectionOfFeature: state.modelSelectionOfFeature,
					},
					effectivePolicy,
					this._syncDeps(),
				);
				this._lastSyncResult.set(runnerId, result);
				this._onDidSyncProviders.fire({ runnerId, result });
				if (result.synced.length > 0) {
					this._logService.info(`[orbit-runner] Synced providers to ${runnerId}: ${result.synced.join(', ')}`);
				}
				const chatProvider = state.modelSelectionOfFeature.Chat?.providerName;
				if (chatProvider) {
					const chatEntry = result.entries.find(e => e.providerId === chatProvider);
					if (chatEntry) {
						const chatResult: EnsureChatProviderResult = {
							status: chatEntry.status === 'synced' ? 'copied'
								: chatEntry.status === 'already_present' ? 'already_present'
									: chatEntry.status === 'failed' ? 'failed' : 'skipped',
							message: chatEntry.message,
							providerId: chatProvider,
						};
						this._lastAutoCopyResult.set(runnerId, chatResult);
						this._onDidAutoCopyChatProvider.fire({ runnerId, result: chatResult });
					}
				}
				return result;
			} catch (e) {
				const result: SyncResult = {
					ok: false,
					runnerId,
					syncedAt: Date.now(),
					entries: [],
					synced: [],
					skipped: [],
					failed: [{ providerId: 'openAI' as never, error: e instanceof Error ? e.message : String(e) }],
				};
				this._lastSyncResult.set(runnerId, result);
				this._onDidSyncProviders.fire({ runnerId, result });
				return result;
			} finally {
				this._syncInFlight.delete(runnerId);
			}
		})();
		this._syncInFlight.set(runnerId, promise);
		return promise;
	}

	async probeProviderOnRunner(runnerId: string, providerId: string, baseUrl?: string): Promise<{ ok: true; models: RunnerCatalogModel[] } | { ok: false; error: string }> {
		await this._loadPromise;
		const cred = this._credentials.find(c => c.runnerId === runnerId);
		if (!cred) {
			return { ok: false, error: 'Runner not found.' };
		}
		try {
			const result = await this._authenticatedExchange(cred, (send, wait) => {
				send(createRunnerEnvelope('provider.probe.request', { providerId, baseUrl }));
				return wait(['provider.probe.result', 'error'], 20_000);
			});
			if (result.type === 'error') {
				const err = result.payload as { message: string };
				return { ok: false, error: err.message };
			}
			const payload = result.payload as { ok: boolean; models?: RunnerCatalogModel[]; error?: string };
			if (!payload.ok) {
				return { ok: false, error: payload.error || 'Probe failed' };
			}
			return { ok: true, models: payload.models ?? [] };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	async resolveModelOnRunner(runnerId: string, providerId: string, modelId: string): Promise<{ ok: true; fingerprint?: string } | { ok: false; error: string; code?: string }> {
		await this._loadPromise;
		const cred = this._credentials.find(c => c.runnerId === runnerId);
		if (!cred) {
			return { ok: false, error: 'Runner not found.', code: 'task_not_found' };
		}
		try {
			const result = await this._authenticatedExchange(cred, (send, wait) => {
				send(createRunnerEnvelope('model.resolve.request', { providerId, modelId }));
				return wait(['model.resolve.result', 'error'], 20_000);
			});
			if (result.type === 'error') {
				const err = result.payload as { code?: string; message: string };
				return { ok: false, error: formatRunnerError(err), code: err.code };
			}
			const payload = result.payload as { ok: boolean; fingerprint?: string; error?: string; code?: string };
			if (!payload.ok) {
				return { ok: false, error: payload.error || 'Model resolve failed', code: payload.code };
			}
			return { ok: true, fingerprint: payload.fingerprint };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e), code: 'runner_offline' };
		}
	}

	async ensureChatProviderOnRunner(runnerId: string): Promise<EnsureChatProviderResult> {
		const sync = await this.syncProvidersToRunner(runnerId, { mode: 'chat_only' });
		const state = this._settingsService.state;
		const chatProvider = state.modelSelectionOfFeature.Chat?.providerName;
		const last = this._lastAutoCopyResult.get(runnerId);
		if (last) {
			return last;
		}
		if (!chatProvider) {
			return { status: 'skipped', message: 'Skipped: no Chat model selected.' };
		}
		if (sync.synced.includes(chatProvider)) {
			return { status: 'copied', providerId: chatProvider, message: `Copied Chat provider to the runner.` };
		}
		const entry = sync.entries.find(e => e.providerId === chatProvider);
		if (entry?.status === 'already_present') {
			return { status: 'already_present', providerId: chatProvider, message: entry.message };
		}
		const fail = sync.failed.find(f => f.providerId === chatProvider);
		if (fail) {
			return { status: 'failed', providerId: chatProvider, message: `Failed: ${fail.error}` };
		}
		return { status: 'skipped', providerId: chatProvider, message: entry?.message ?? 'Skipped.' };
	}

	private _syncDeps() {
		return {
			fetchProviderCatalog: (id: string) => this.fetchProviderCatalog(id),
			copyProviderToRunner: (id: string, provision: RunnerProvisionPayload) => this.copyProviderToRunner(id, provision),
			probeProvider: async (id: string, providerId: string) => {
				const built = buildProviderProvisionPayload(this._settingsService.state.settingsOfProvider, providerId as ProviderName);
				const baseUrl = built.ok ? built.payload.baseUrl : undefined;
				return this.probeProviderOnRunner(id, providerId, baseUrl);
			},
		};
	}

	private _effectiveSyncPolicy(runnerId: string, policy: SyncPolicy): SyncPolicy {
		const caps = this._runtime.get(runnerId)?.capabilities;
		if (caps?.provider_sync === false) {
			if (policy.mode === 'all_copyable') {
				return { ...policy, mode: 'chat_only' };
			}
		}
		if (policy.mode === 'all_copyable' && caps?.provider_sync !== true) {
			// Older runners without provider_sync — chat-only on bulk sync
			return { ...policy, mode: 'chat_only' };
		}
		return policy;
	}

	private _canAutoSyncCredentials(runnerId: string): boolean {
		const hostUrl = this.getHostUrl(runnerId);
		return !!hostUrl && isSecureRunnerUrl(hostUrl);
	}

	private async _syncAllOnlineRunners(): Promise<void> {
		await this._loadPromise;
		const online = this._credentials.filter(c => {
			const rt = this._runtime.get(c.runnerId);
			return rt?.status === 'online' || rt?.status === 'busy';
		});
		// Debounced settings change → chat_only fingerprint sync only (E11).
		await Promise.allSettled(online.map(c => this.syncProvidersToRunner(c.runnerId, { mode: 'chat_only' })));
	}

	/** Fire-and-forget provider sync when a runner becomes reachable — chat provider only. */
	private _maybeSyncProviders(runnerId: string): void {
		void this.syncProvidersToRunner(runnerId, { mode: 'chat_only' });
	}

	/** Auth hello → auth, then run exchange. */
	private _authenticatedExchange(
		cred: PairedRunnerCredential,
		exchange: (
			send: (msg: RunnerEnvelope) => void,
			wait: (types: string[], timeoutMs: number) => Promise<RunnerEnvelope>,
		) => Promise<RunnerEnvelope>,
	): Promise<RunnerEnvelope> {
		return this._wsRoundTrip(cred.hostUrl, async (send, wait) => {
			send(createRunnerEnvelope('hello', {
				clientName: 'orbit-editor',
				clientVersion: String(this._productService.version || '0.0.0'),
				deviceId: cred.deviceId,
			}));
			const welcome = await wait(['welcome', 'error'], 15_000);
			if (welcome.type === 'error') {
				return welcome;
			}
			const welcomeCheck = validateRunnerWelcome(welcome.payload as RunnerWelcomePayload);
			if (!welcomeCheck.ok) {
				return createRunnerEnvelope('error', welcomeCheck.error);
			}
			send(createRunnerEnvelope('auth', {
				deviceId: cred.deviceId,
				credential: cred.credential,
			}));
			const auth = await wait(['auth.result', 'error'], 15_000);
			if (auth.type === 'error') {
				return auth;
			}
			const authPayload = auth.payload as { ok: boolean; error?: string; capabilities?: RunnerCapabilities };
			if (!authPayload.ok) {
				return createRunnerEnvelope('error', {
					code: 'UNAUTHORIZED',
					message: authPayload.error || 'Unauthorized',
					retriable: false,
				});
			}
			if (authPayload.capabilities) {
				this.cacheNegotiatedCapabilities(cred.runnerId, authPayload.capabilities);
			}
			return exchange(send, wait);
		});
	}

	private async _loadStore(): Promise<void> {
		if (this._loaded) { return; }
		const previousCredentials = this._credentials;
		try {
			const encrypted = this._storageService.get(PAIRED_RUNNERS_STORAGE_KEY, StorageScope.APPLICATION);
			if (encrypted) {
				let decrypted: string;
				try {
					decrypted = await this._encryptionService.decrypt(encrypted);
				} catch (e) {
					// E34: keep last-known-good in-memory credentials; do not wipe storage.
					this._logService.error('[orbit-runner] Failed to decrypt paired runners; keeping last-known-good credentials', safeForLog(e));
					this._credentials = previousCredentials;
					this._loaded = true;
					return;
				}
				const parsed = JSON.parse(decrypted) as PairedRunnerStore;
				if (parsed?.version === 1 && Array.isArray(parsed.runners)) {
					this._credentials = parsed.runners.filter(isValidCredential);
				}
			}
			for (const c of this._credentials) {
				if (!this._runtime.has(c.runnerId)) {
					this._runtime.set(c.runnerId, { status: 'unknown' });
				}
			}
		} catch (e) {
			this._logService.error('[orbit-runner] Failed to load paired runners', safeForLog(e));
			// Prefer keeping whatever we already had over wiping on parse errors.
			if (previousCredentials.length > 0) {
				this._credentials = previousCredentials;
			}
		} finally {
			this._loaded = true;
		}
	}

	/** @returns false when encryption or storage fails (caller must not report success). */
	private async _saveStore(): Promise<boolean> {
		const store: PairedRunnerStore = { version: 1, runners: this._credentials };
		try {
			const encrypted = await this._encryptionService.encrypt(JSON.stringify(store));
			this._storageService.store(PAIRED_RUNNERS_STORAGE_KEY, encrypted, StorageScope.APPLICATION, StorageTarget.MACHINE);
			return true;
		} catch (e) {
			this._logService.error('[orbit-runner] Failed to save paired runners', safeForLog(e));
			return false;
		}
	}

	private _toInfo(cred: PairedRunnerCredential): RunnerInfo {
		const rt = this._runtime.get(cred.runnerId);
		return {
			id: cred.runnerId,
			name: cred.name,
			hostUrl: cred.hostUrl,
			deviceId: cred.deviceId,
			status: rt?.status ?? 'unknown',
			lastSeenAt: rt?.lastSeenAt,
			lastError: rt?.lastError,
			capabilities: rt?.capabilities,
			protocolVersion: rt?.protocolVersion,
			createdAt: cred.createdAt,
			updatedAt: cred.updatedAt,
		};
	}

	private _wsRoundTrip(
		hostUrl: string,
		exchange: (
			send: (msg: RunnerEnvelope) => void,
			wait: (types: string[], timeoutMs: number) => Promise<RunnerEnvelope>,
		) => Promise<RunnerEnvelope>,
	): Promise<RunnerEnvelope> {
		return new Promise((resolve, reject) => {
			let settled = false;
			let ws: WebSocket;
			try {
				ws = new WebSocket(hostUrl);
			} catch (e) {
				reject(e instanceof Error ? e : new Error(String(e)));
				return;
			}

			const pending: Array<{ types: Set<string>; resolve: (m: RunnerEnvelope) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

			const fail = (err: Error) => {
				if (settled) { return; }
				settled = true;
				for (const p of pending) { clearTimeout(p.timer); p.reject(err); }
				pending.length = 0;
				try { ws.close(); } catch { /* ignore */ }
				reject(err);
			};

			const succeed = (msg: RunnerEnvelope) => {
				if (settled) { return; }
				settled = true;
				for (const p of pending) { clearTimeout(p.timer); }
				pending.length = 0;
				try { ws.close(); } catch { /* ignore */ }
				resolve(msg);
			};

			const send = (msg: RunnerEnvelope) => ws.send(JSON.stringify(msg));
			const wait = (types: string[], timeoutMs: number) => new Promise<RunnerEnvelope>((res, rej) => {
				const timer = setTimeout(() => {
					const idx = pending.findIndex(p => p.resolve === res);
					if (idx >= 0) { pending.splice(idx, 1); }
					rej(new Error('Timed out waiting for runner response.'));
				}, timeoutMs);
				pending.push({ types: new Set(types), resolve: res, reject: rej, timer });
			});

			ws.onopen = () => { exchange(send, wait).then(succeed, fail); };
			ws.onerror = () => { fail(new Error(`Could not connect to runner at ${hostUrl}. Is the runner running?`)); };
			ws.onclose = (ev) => { if (!settled) { fail(new Error(`Connection closed (${ev.code}).`)); } };
			ws.onmessage = (ev) => {
				const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
				const parsed = parseRunnerWireJson(text);
				if (!parsed.ok) {
					this._logService.warn('[orbit-runner] Invalid message', safeForLog(parsed.error));
					return;
				}
				const idx = pending.findIndex(p => p.types.has(parsed.message.type));
				if (idx >= 0) {
					const p = pending.splice(idx, 1)[0];
					clearTimeout(p.timer);
					p.resolve(parsed.message);
				}
			};
		});
	}
}

function isValidCredential(c: unknown): c is PairedRunnerCredential {
	if (!c || typeof c !== 'object') { return false; }
	const o = c as Record<string, unknown>;
	return typeof o.runnerId === 'string'
		&& typeof o.deviceId === 'string'
		&& typeof o.credential === 'string'
		&& typeof o.hostUrl === 'string'
		&& typeof o.name === 'string';
}

function guessHostLabel(): string {
	try {
		return typeof navigator !== 'undefined' ? (navigator.platform || 'desktop') : 'desktop';
	} catch {
		return 'desktop';
	}
}

registerSingleton(IRunnerService, RunnerService, InstantiationType.Delayed);
