/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Helpers for mapping Orbit Editor providers/models onto a self-hosted runner.
 * No orbit-backend involvement — BYOK copy + runner catalog only.
 */

import { displayInfoOfProviderName, type ProviderName, type SettingsOfProvider, type VoidStatefulModelInfo } from '../orbitSettingsTypes.js';
import { getModelCapabilities } from '../modelCapabilities.js';

/** Providers that need Orbit cloud / OAuth and cannot be used for remote v1. */
export const RUNNER_REMOTE_UNSUPPORTED_PROVIDERS = new Set<ProviderName>([
	'orbit',
	'clinePass',
	'openAICodex',
	'xAISuperGrok',
	// Runner v1 speaks OpenAI Chat Completions only; native Anthropic needs a real adapter.
	'anthropic',
	// Vertex uses Google ADC on the editor machine — no portable API key to copy.
	'googleVertex',
]);

/** Bump when provision field resolution changes (triggers fingerprint re-sync). */
export const RUNNER_PROVISION_CONFIG_VERSION = '2';

const LOCAL_PROVIDER_IDS = new Set<ProviderName>(['ollama', 'vLLM', 'lmStudio', 'liteLLM']);

/** Default OpenAI-compatible base URLs aligned with orbit-runner defaultBaseUrlForProvider. */
const DEFAULT_BASE_URLS: Partial<Record<ProviderName, string>> = {
	openAI: 'https://api.openai.com/v1',
	openRouter: 'https://openrouter.ai/api/v1',
	groq: 'https://api.groq.com/openai/v1',
	deepseek: 'https://api.deepseek.com/v1',
	mistral: 'https://api.mistral.ai/v1',
	xAI: 'https://api.x.ai/v1',
	gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
	ollama: 'http://127.0.0.1:11434/v1',
	vLLM: 'http://127.0.0.1:8000/v1',
	lmStudio: 'http://127.0.0.1:1234/v1',
};

export type RunnerModelCapabilities = {
	streaming: boolean;
	toolCalling: boolean;
	parallelToolCalls: boolean;
	reasoning: boolean;
	vision: boolean;
	maxContextTokens?: number;
	maxOutputTokens?: number;
};

export type RunnerCatalogModel = {
	modelId: string;
	displayName?: string;
	capabilities: RunnerModelCapabilities;
};

export type RunnerProviderCatalogEntry = {
	providerId: string;
	displayName: string;
	source: 'editor_copy' | 'dashboard' | 'local';
	baseUrlFingerprint: string | null;
	configVersion: string;
	fingerprint: string;
	enabled: boolean;
	hasCredential: boolean;
	models: RunnerCatalogModel[];
	unavailableReason?: string;
};

export type CopyableProvider = {
	providerId: ProviderName;
	displayName: string;
	/** Non-secret summary for confirmation UI */
	summary: string;
	modelCount: number;
	hasApiKey: boolean;
	baseUrl?: string;
	reasonUnavailable?: string;
};

export type RunnerProvisionPayload = {
	providerId: string;
	displayName: string;
	apiKey?: string;
	baseUrl?: string;
	headersJSON?: string;
	models: RunnerCatalogModel[];
	source: 'editor_copy';
	configVersion: string;
	userConfirmed: true;
};

export type SyncPolicy = {
	mode: 'chat_only' | 'all_copyable' | 'selected';
	force?: boolean;
	providers?: ProviderName[];
};

export type SyncProviderStatus = 'synced' | 'already_present' | 'skipped' | 'failed';

export type SyncProviderEntry = {
	providerId: ProviderName;
	status: SyncProviderStatus;
	message: string;
	fingerprint?: string;
};

export type SyncResult = {
	ok: boolean;
	runnerId: string;
	syncedAt: number;
	entries: SyncProviderEntry[];
	synced: ProviderName[];
	skipped: Array<{ providerId: ProviderName; reason: string }>;
	failed: Array<{ providerId: ProviderName; error: string }>;
};

export type ProviderSyncStatus = {
	providerId: ProviderName;
	displayName: string;
	state: 'synced' | 'stale' | 'missing' | 'unsupported' | 'not_configured';
	message?: string;
	editorFingerprint?: string;
	runnerFingerprint?: string;
};

function readSetting(settings: SettingsOfProvider, providerId: ProviderName, key: string): string | undefined {
	const block = settings[providerId] as Record<string, unknown>;
	const v = block?.[key];
	return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function mergeHeadersJSON(existing: string | undefined, extra: Record<string, string>): string | undefined {
	if (!existing && Object.keys(extra).length === 0) {
		return undefined;
	}
	let base: Record<string, string> = {};
	if (existing) {
		try {
			base = JSON.parse(existing) as Record<string, string>;
		} catch {
			base = {};
		}
	}
	return JSON.stringify({ ...base, ...extra });
}

/**
 * Resolve baseUrl / headers for runner provision (mirrors editor main-process URL construction).
 */
export function resolveRunnerProvisionFields(
	settings: SettingsOfProvider,
	providerId: ProviderName,
): { ok: true; baseUrl?: string; headersJSON?: string; apiKey?: string } | { ok: false; error: string; code: string } {
	if (RUNNER_REMOTE_UNSUPPORTED_PROVIDERS.has(providerId)) {
		return {
			ok: false,
			error: `Provider “${displayInfoOfProviderName(providerId).title}” cannot be copied to a self-hosted runner.`,
			code: 'orbit_provider_remote_unavailable',
		};
	}

	const apiKey = readSetting(settings, providerId, 'apiKey');
	const endpoint = readSetting(settings, providerId, 'endpoint')
		?? readSetting(settings, providerId, 'baseURL');
	const headersJSON = readSetting(settings, providerId, 'headersJSON');
	const isLocal = LOCAL_PROVIDER_IDS.has(providerId);

	if (providerId === 'microsoftAzure') {
		const project = readSetting(settings, providerId, 'project');
		if (!apiKey || !project) {
			return { ok: false, error: 'Azure requires API key and resource name in Orbit Settings.', code: 'credential_missing' };
		}
		const azureApiVersion = readSetting(settings, providerId, 'azureApiVersion') ?? '2024-05-01-preview';
		return {
			ok: true,
			apiKey,
			baseUrl: `https://${project}.openai.azure.com`,
			headersJSON: mergeHeadersJSON(headersJSON, { 'api-key': apiKey, 'api-version': azureApiVersion }),
		};
	}

	if (providerId === 'awsBedrock') {
		if (!apiKey) {
			return { ok: false, error: 'AWS Bedrock proxy requires an API key in Orbit Settings.', code: 'credential_missing' };
		}
		let baseUrl = endpoint || 'http://127.0.0.1:4000/v1';
		if (!baseUrl.endsWith('/v1')) {
			baseUrl = baseUrl.replace(/\/+$/, '') + '/v1';
		}
		return { ok: true, apiKey, baseUrl, headersJSON };
	}

	if (!apiKey && !isLocal) {
		return { ok: false, error: 'Provider has no API key configured in Orbit Settings.', code: 'credential_missing' };
	}
	if (isLocal && !endpoint && !apiKey) {
		return { ok: false, error: 'Local provider has no endpoint configured.', code: 'endpoint_missing' };
	}

	return {
		ok: true,
		apiKey: apiKey || undefined,
		baseUrl: endpoint ?? DEFAULT_BASE_URLS[providerId],
		headersJSON,
	};
}

function capabilitiesFor(providerId: ProviderName, modelName: string): RunnerModelCapabilities {
	const caps = getModelCapabilities(providerId, modelName, undefined);
	const toolCalling = caps.specialToolFormat === 'openai-style'
		|| caps.specialToolFormat === 'anthropic-style'
		|| caps.specialToolFormat === 'gemini-style'
		|| caps.specialToolFormat === undefined;
	return {
		streaming: true,
		toolCalling,
		parallelToolCalls: caps.specialToolFormat === 'openai-style' || caps.specialToolFormat === undefined,
		reasoning: !!caps.reasoningCapabilities,
		vision: false,
		maxContextTokens: caps.contextWindow,
		maxOutputTokens: caps.reservedOutputTokenSpace ?? undefined,
	};
}

function visibleModels(settings: SettingsOfProvider, providerId: ProviderName): RunnerCatalogModel[] {
	return settings[providerId].models
		.filter(m => !m.isHidden)
		.map(m => ({
			modelId: m.modelName,
			displayName: m.modelName,
			capabilities: capabilitiesFor(providerId, m.modelName),
		}));
}

/** Mirrors orbit-runner fingerprintProvider (SHA-256, first 16 hex chars). */
export async function computeProviderFingerprint(input: {
	providerId: string;
	baseUrl?: string | null;
	configVersion: string;
	modelIds: string[];
}): Promise<string> {
	const material = [
		input.providerId,
		'|',
		input.baseUrl ?? '',
		'|',
		input.configVersion,
		'|',
		[...input.modelIds].sort().join(','),
	].join('');
	const data = new TextEncoder().encode(material);
	const hash = await crypto.subtle.digest('SHA-256', data);
	const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
	return hex.slice(0, 16);
}

export function listCopyableProviders(settings: SettingsOfProvider): CopyableProvider[] {
	const out: CopyableProvider[] = [];
	for (const providerId of Object.keys(settings) as ProviderName[]) {
		const info = displayInfoOfProviderName(providerId);
		if (RUNNER_REMOTE_UNSUPPORTED_PROVIDERS.has(providerId)) {
			out.push({
				providerId,
				displayName: info.title,
				summary: providerId === 'googleVertex'
					? 'Uses Google Application Default Credentials on this machine — not copyable to a runner'
					: 'Requires Orbit login / OAuth — not available for self-hosted runner v1',
				modelCount: settings[providerId].models.filter(m => !m.isHidden).length,
				hasApiKey: false,
				reasonUnavailable: 'orbit_provider_remote_unavailable',
			});
			continue;
		}

		const resolved = resolveRunnerProvisionFields(settings, providerId);
		if (!resolved.ok) {
			continue;
		}

		const models = settings[providerId].models.filter((m: VoidStatefulModelInfo) => !m.isHidden);
		const isLocal = LOCAL_PROVIDER_IDS.has(providerId);
		const parts: string[] = [];
		if (resolved.apiKey) {
			parts.push('API key (will be encrypted on the runner)');
		}
		if (resolved.baseUrl) {
			parts.push(`endpoint ${resolved.baseUrl}${isLocal ? ' (localhost = runner machine)' : ''}`);
		}
		parts.push(`${models.length} visible model(s)`);

		out.push({
			providerId,
			displayName: info.title,
			summary: parts.join(' · '),
			modelCount: models.length,
			hasApiKey: !!resolved.apiKey,
			baseUrl: resolved.baseUrl,
		});
	}
	return out;
}

export function buildProviderProvisionPayload(
	settings: SettingsOfProvider,
	providerId: ProviderName,
): { ok: true; payload: RunnerProvisionPayload } | { ok: false; error: string; code: string } {
	if (RUNNER_REMOTE_UNSUPPORTED_PROVIDERS.has(providerId)) {
		return {
			ok: false,
			error: `Provider “${displayInfoOfProviderName(providerId).title}” cannot be copied to a self-hosted runner.`,
			code: 'orbit_provider_remote_unavailable',
		};
	}

	const resolved = resolveRunnerProvisionFields(settings, providerId);
	if (!resolved.ok) {
		return resolved;
	}

	const models = visibleModels(settings, providerId);

	return {
		ok: true,
		payload: {
			providerId,
			displayName: displayInfoOfProviderName(providerId).title,
			apiKey: resolved.apiKey,
			baseUrl: resolved.baseUrl,
			headersJSON: resolved.headersJSON,
			models,
			source: 'editor_copy',
			configVersion: RUNNER_PROVISION_CONFIG_VERSION,
			userConfirmed: true,
		},
	};
}

export async function computeEditorProviderFingerprint(
	settings: SettingsOfProvider,
	providerId: ProviderName,
): Promise<string | undefined> {
	const built = buildProviderProvisionPayload(settings, providerId);
	if (!built.ok) {
		return undefined;
	}
	const modelIds = built.payload.models.map(m => m.modelId);
	return computeProviderFingerprint({
		providerId,
		baseUrl: built.payload.baseUrl ?? DEFAULT_BASE_URLS[providerId] ?? null,
		configVersion: built.payload.configVersion,
		modelIds,
	});
}

export function selectProvidersForSync(
	settings: SettingsOfProvider,
	modelSelectionOfFeature: { Chat: { providerName: ProviderName; modelName: string } | null },
	policy: SyncPolicy,
): ProviderName[] {
	if (policy.mode === 'selected') {
		return (policy.providers ?? []).filter(id => !RUNNER_REMOTE_UNSUPPORTED_PROVIDERS.has(id));
	}
	if (policy.mode === 'chat_only') {
		const chat = modelSelectionOfFeature.Chat?.providerName;
		return chat && !RUNNER_REMOTE_UNSUPPORTED_PROVIDERS.has(chat) ? [chat] : [];
	}
	return listCopyableProviders(settings)
		.filter(p => !p.reasonUnavailable)
		.map(p => p.providerId);
}

export async function needsProviderSync(
	settings: SettingsOfProvider,
	providerId: ProviderName,
	catalogEntry: RunnerProviderCatalogEntry | undefined,
	force: boolean,
): Promise<{ needed: boolean; reason: string }> {
	if (force) {
		return { needed: true, reason: 'force' };
	}
	const built = buildProviderProvisionPayload(settings, providerId);
	if (!built.ok) {
		return { needed: false, reason: built.error };
	}
	if (!catalogEntry) {
		return { needed: true, reason: 'missing' };
	}
	const isLocal = LOCAL_PROVIDER_IDS.has(providerId);
	if (!catalogEntry.hasCredential && !isLocal) {
		return { needed: true, reason: 'credential_missing' };
	}
	const editorFingerprint = await computeEditorProviderFingerprint(settings, providerId);
	if (editorFingerprint && editorFingerprint !== catalogEntry.fingerprint) {
		return { needed: true, reason: 'fingerprint_mismatch' };
	}
	return { needed: false, reason: 'already_present' };
}

export async function syncProvidersToRunner(
	runnerId: string,
	settings: {
		settingsOfProvider: SettingsOfProvider;
		modelSelectionOfFeature: { Chat: { providerName: ProviderName; modelName: string } | null };
	},
	policy: SyncPolicy,
	deps: {
		fetchProviderCatalog: (runnerId: string) => Promise<
			{ ok: true; providers: RunnerProviderCatalogEntry[] } | { ok: false; error: string; code?: string }
		>;
		copyProviderToRunner: (
			runnerId: string,
			provision: RunnerProvisionPayload,
		) => Promise<{ ok: true; fingerprint: string } | { ok: false; error: string; code?: string }>;
		probeProvider?: (
			runnerId: string,
			providerId: string,
		) => Promise<{ ok: true; models: RunnerCatalogModel[] } | { ok: false; error: string }>;
	},
): Promise<SyncResult> {
	const syncedAt = Date.now();
	const providerIds = selectProvidersForSync(settings.settingsOfProvider, settings.modelSelectionOfFeature, policy);
	const result: SyncResult = {
		ok: true,
		runnerId,
		syncedAt,
		entries: [],
		synced: [],
		skipped: [],
		failed: [],
	};

	if (providerIds.length === 0) {
		return result;
	}

	const catalog = await deps.fetchProviderCatalog(runnerId);
	if (!catalog.ok) {
		return {
			...result,
			ok: false,
			failed: providerIds.map(id => ({
				providerId: id,
				error: catalog.error,
			})),
		};
	}

	for (const providerId of providerIds) {
		const catalogEntry = catalog.providers.find(p => p.providerId === providerId);
		const syncCheck = await needsProviderSync(
			settings.settingsOfProvider,
			providerId,
			catalogEntry,
			!!policy.force,
		);

		if (!syncCheck.needed) {
			result.skipped.push({ providerId, reason: syncCheck.reason });
			result.entries.push({
				providerId,
				status: 'already_present',
				message: `Already present: ${displayInfoOfProviderName(providerId).title}`,
				fingerprint: catalogEntry?.fingerprint,
			});
			continue;
		}

		const built = buildProviderProvisionPayload(settings.settingsOfProvider, providerId);
		if (!built.ok) {
			result.skipped.push({ providerId, reason: built.error });
			result.entries.push({
				providerId,
				status: 'skipped',
				message: built.error,
			});
			continue;
		}

		let payload = built.payload;
		if (deps.probeProvider && LOCAL_PROVIDER_IDS.has(providerId)) {
			const probed = await deps.probeProvider(runnerId, providerId);
			if (probed.ok && probed.models.length > 0) {
				payload = { ...payload, models: probed.models };
			}
		}

		const copied = await deps.copyProviderToRunner(runnerId, payload);
		if (!copied.ok) {
			result.failed.push({ providerId, error: copied.error });
			result.entries.push({
				providerId,
				status: 'failed',
				message: copied.error,
			});
			result.ok = false;
			continue;
		}

		result.synced.push(providerId);
		result.entries.push({
			providerId,
			status: 'synced',
			message: `Synced ${displayInfoOfProviderName(providerId).title}`,
			fingerprint: copied.fingerprint,
		});
	}

	return result;
}

export async function computeProviderSyncStatuses(
	settings: SettingsOfProvider,
	catalog: RunnerProviderCatalogEntry[] | undefined,
): Promise<ProviderSyncStatus[]> {
	const copyable = listCopyableProviders(settings);
	const statuses: ProviderSyncStatus[] = [];

	for (const entry of copyable) {
		if (entry.reasonUnavailable) {
			statuses.push({
				providerId: entry.providerId,
				displayName: entry.displayName,
				state: 'unsupported',
				message: entry.summary,
			});
			continue;
		}

		const catalogEntry = catalog?.find(p => p.providerId === entry.providerId);
		const editorFingerprint = await computeEditorProviderFingerprint(settings, entry.providerId);

		if (!catalogEntry) {
			statuses.push({
				providerId: entry.providerId,
				displayName: entry.displayName,
				state: 'missing',
				message: 'Not on runner yet',
				editorFingerprint,
			});
			continue;
		}

		const isLocal = LOCAL_PROVIDER_IDS.has(entry.providerId);
		if (!catalogEntry.hasCredential && !isLocal) {
			statuses.push({
				providerId: entry.providerId,
				displayName: entry.displayName,
				state: 'missing',
				message: 'Runner entry has no credential',
				editorFingerprint,
				runnerFingerprint: catalogEntry.fingerprint,
			});
			continue;
		}

		if (editorFingerprint && editorFingerprint !== catalogEntry.fingerprint) {
			statuses.push({
				providerId: entry.providerId,
				displayName: entry.displayName,
				state: 'stale',
				message: 'Editor settings differ from runner — sync recommended',
				editorFingerprint,
				runnerFingerprint: catalogEntry.fingerprint,
			});
			continue;
		}

		statuses.push({
			providerId: entry.providerId,
			displayName: entry.displayName,
			state: 'synced',
			editorFingerprint,
			runnerFingerprint: catalogEntry.fingerprint,
		});
	}

	return statuses;
}

export type EnsureChatProviderStatus = 'copied' | 'already_present' | 'skipped' | 'failed';

export type EnsureChatProviderResult = {
	status: EnsureChatProviderStatus;
	message: string;
	providerId?: string;
};

/**
 * Ensure the current Chat feature provider credentials exist on a paired runner.
 * Delegates to syncProvidersToRunner (chat_only mode).
 */
export async function ensureChatProviderOnRunner(
	runnerId: string,
	settings: {
		settingsOfProvider: SettingsOfProvider;
		modelSelectionOfFeature: { Chat: { providerName: ProviderName; modelName: string } | null };
	},
	deps: {
		fetchProviderCatalog: (runnerId: string) => Promise<
			{ ok: true; providers: RunnerProviderCatalogEntry[] } | { ok: false; error: string; code?: string }
		>;
		copyProviderToRunner: (
			runnerId: string,
			provision: RunnerProvisionPayload,
		) => Promise<{ ok: true; fingerprint: string } | { ok: false; error: string; code?: string }>;
		probeProvider?: (
			runnerId: string,
			providerId: string,
		) => Promise<{ ok: true; models: RunnerCatalogModel[] } | { ok: false; error: string }>;
	},
): Promise<EnsureChatProviderResult> {
	const chatSelection = settings.modelSelectionOfFeature.Chat;
	if (!chatSelection?.providerName) {
		return { status: 'skipped', message: 'Skipped: no Chat model selected.' };
	}
	const providerId = chatSelection.providerName;

	const sync = await syncProvidersToRunner(
		runnerId,
		settings,
		{ mode: 'chat_only' },
		deps,
	);

	const entry = sync.entries.find(e => e.providerId === providerId)
		?? sync.entries[0];

	if (sync.failed.some(f => f.providerId === providerId)) {
		const fail = sync.failed.find(f => f.providerId === providerId)!;
		return { status: 'failed', providerId, message: `Failed: ${fail.error}` };
	}

	if (sync.synced.includes(providerId)) {
		return {
			status: 'copied',
			providerId,
			message: `Copied “${displayInfoOfProviderName(providerId).title}” (Chat provider) to the runner.`,
		};
	}

	if (entry?.status === 'already_present') {
		return {
			status: 'already_present',
			providerId,
			message: entry.message,
		};
	}

	return {
		status: 'skipped',
		providerId,
		message: entry?.message ?? 'Skipped: Chat provider could not be synced.',
	};
}

export function explainModelAvailability(
	catalog: RunnerProviderCatalogEntry[] | undefined,
	providerId: string,
	modelId: string,
): { ok: true } | { ok: false; message: string; code: string } {
	if (RUNNER_REMOTE_UNSUPPORTED_PROVIDERS.has(providerId as ProviderName)) {
		return {
			ok: false,
			code: 'orbit_provider_remote_unavailable',
			message: 'Orbit Provider / OAuth models cannot run on Self-hosted Runner (they need Orbit cloud tokens). Switch the Chat model picker to a BYOK provider already on the runner (DeepSeek, OpenAI, OpenRouter, Groq, OpenAI-Compatible, …), or Local.',
		};
	}
	if (!catalog) {
		return { ok: false, code: 'catalog_unknown', message: 'Could not load runner provider catalog. Test the runner connection.' };
	}
	const entry = catalog.find(p => p.providerId === providerId);
	if (!entry) {
		return {
			ok: false,
			code: 'provider_not_configured',
			message: `Provider “${providerId}” is not on this runner. Pair/connect the runner (providers auto-sync) or open Settings → Self-hosted Runners → Providers on this runner.`,
		};
	}
	if (!entry.hasCredential && !LOCAL_PROVIDER_IDS.has(providerId as ProviderName)) {
		return { ok: false, code: 'credential_missing', message: `Runner has “${providerId}” but no API key. Sync providers again from Settings.` };
	}
	if (entry.models.length > 0 && !entry.models.some(m => m.modelId === modelId)) {
		return {
			ok: false,
			code: 'model_unsupported',
			message: `Model “${modelId}” is not in the runner catalog for “${providerId}”. Sync providers again after enabling the model in Orbit Settings.`,
		};
	}
	return { ok: true };
}

/** Error codes that JIT sync can recover from before remote submit. */
export const JIT_SYNC_RECOVERABLE_CODES = new Set([
	'provider_not_configured',
	'credential_missing',
	'model_unsupported',
]);
