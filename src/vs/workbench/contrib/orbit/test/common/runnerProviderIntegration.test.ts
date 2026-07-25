/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	buildProviderProvisionPayload,
	computeProviderFingerprint,
	explainModelAvailability,
	listCopyableProviders,
	needsProviderSync,
	resolveRunnerProvisionFields,
	RUNNER_PROVISION_CONFIG_VERSION,
	RUNNER_REMOTE_UNSUPPORTED_PROVIDERS,
	selectProvidersForSync,
	syncProvidersToRunner,
} from '../../common/runner/runnerProviderIntegration.js';
import { defaultSettingsOfProvider, type SettingsOfProvider } from '../../common/orbitSettingsTypes.js';

function cloneSettings(): SettingsOfProvider {
	return JSON.parse(JSON.stringify(defaultSettingsOfProvider)) as SettingsOfProvider;
}

suite('runner provider integration', () => {
	test('marks orbit as unsupported', () => {
		assert.ok(RUNNER_REMOTE_UNSUPPORTED_PROVIDERS.has('orbit'));
		assert.ok(RUNNER_REMOTE_UNSUPPORTED_PROVIDERS.has('googleVertex'));
	});

	test('lists copyable openAI when apiKey present', () => {
		const settings = cloneSettings();
		(settings.openAI as { apiKey: string }).apiKey = 'sk-test-key-12345678';
		settings.openAI.models = [{ modelName: 'gpt-4.1', type: 'default', isHidden: false }];
		const list = listCopyableProviders(settings);
		const openAI = list.find(p => p.providerId === 'openAI');
		assert.ok(openAI);
		assert.strictEqual(openAI!.hasApiKey, true);
		assert.ok(!openAI!.reasonUnavailable);
	});

	test('buildProviderProvisionPayload includes models and key', async () => {
		const settings = cloneSettings();
		(settings.openAI as { apiKey: string }).apiKey = 'sk-test-key-12345678';
		settings.openAI.models = [{ modelName: 'gpt-4.1', type: 'default', isHidden: false }];
		const built = buildProviderProvisionPayload(settings, 'openAI');
		assert.strictEqual(built.ok, true);
		if (built.ok) {
			assert.strictEqual(built.payload.userConfirmed, true);
			assert.strictEqual(built.payload.apiKey, 'sk-test-key-12345678');
			assert.strictEqual(built.payload.models[0]?.modelId, 'gpt-4.1');
			assert.strictEqual(built.payload.configVersion, RUNNER_PROVISION_CONFIG_VERSION);
		}
	});

	test('resolveRunnerProvisionFields builds Azure endpoint and headers', () => {
		const settings = cloneSettings();
		(settings.microsoftAzure as { apiKey: string; project: string }).apiKey = 'azure-key';
		(settings.microsoftAzure as { apiKey: string; project: string }).project = 'my-resource';
		(settings.microsoftAzure as { azureApiVersion: string }).azureApiVersion = '2024-05-01-preview';
		const resolved = resolveRunnerProvisionFields(settings, 'microsoftAzure');
		assert.strictEqual(resolved.ok, true);
		if (resolved.ok) {
			assert.strictEqual(resolved.baseUrl, 'https://my-resource.openai.azure.com');
			assert.ok(resolved.headersJSON?.includes('api-key'));
			assert.ok(resolved.headersJSON?.includes('api-version'));
		}
	});

	test('resolveRunnerProvisionFields normalizes awsBedrock proxy URL', () => {
		const settings = cloneSettings();
		(settings.awsBedrock as { apiKey: string }).apiKey = 'bedrock-proxy-key';
		const resolved = resolveRunnerProvisionFields(settings, 'awsBedrock');
		assert.strictEqual(resolved.ok, true);
		if (resolved.ok) {
			assert.strictEqual(resolved.baseUrl, 'http://127.0.0.1:4000/v1');
		}
	});

	test('computeProviderFingerprint matches runner algorithm', async () => {
		const fp = await computeProviderFingerprint({
			providerId: 'openAI',
			baseUrl: 'https://api.openai.com/v1',
			configVersion: '2',
			modelIds: ['gpt-4.1', 'gpt-4.1-mini'],
		});
		assert.strictEqual(typeof fp, 'string');
		assert.strictEqual(fp.length, 16);
	});

	test('selectProvidersForSync all_copyable excludes unsupported', () => {
		const settings = cloneSettings();
		(settings.openAI as { apiKey: string }).apiKey = 'sk-test';
		settings.openAI.models = [{ modelName: 'gpt-4.1', type: 'default', isHidden: false }];
		const ids = selectProvidersForSync(settings, { Chat: { providerName: 'orbit', modelName: 'x' } }, { mode: 'all_copyable' });
		assert.ok(ids.includes('openAI'));
		assert.ok(!ids.includes('orbit'));
	});

	test('syncProvidersToRunner provisions missing provider', async () => {
		const settings = cloneSettings();
		(settings.openAI as { apiKey: string }).apiKey = 'sk-test-key-12345678';
		settings.openAI.models = [{ modelName: 'gpt-4.1', type: 'default', isHidden: false }];
		let copied = 0;
		const result = await syncProvidersToRunner(
			'runner-1',
			{
				settingsOfProvider: settings,
				modelSelectionOfFeature: { Chat: { providerName: 'openAI', modelName: 'gpt-4.1' } },
			},
			{ mode: 'selected', providers: ['openAI'] },
			{
				fetchProviderCatalog: async () => ({ ok: true, providers: [] }),
				copyProviderToRunner: async () => {
					copied++;
					return { ok: true, fingerprint: 'abc123' };
				},
			},
		);
		assert.strictEqual(copied, 1);
		assert.deepStrictEqual(result.synced, ['openAI']);
	});

	test('needsProviderSync detects fingerprint mismatch', async () => {
		const settings = cloneSettings();
		(settings.openAI as { apiKey: string }).apiKey = 'sk-test-key-12345678';
		settings.openAI.models = [{ modelName: 'gpt-4.1', type: 'default', isHidden: false }];
		const built = buildProviderProvisionPayload(settings, 'openAI');
		assert.strictEqual(built.ok, true);
		const editorFp = built.ok
			? await computeProviderFingerprint({
				providerId: 'openAI',
				baseUrl: built.payload.baseUrl ?? 'https://api.openai.com/v1',
				configVersion: built.payload.configVersion,
				modelIds: built.payload.models.map(m => m.modelId),
			})
			: '';
		const check = await needsProviderSync(
			settings,
			'openAI',
			{
				providerId: 'openAI',
				displayName: 'OpenAI',
				source: 'editor_copy',
				baseUrlFingerprint: null,
				configVersion: RUNNER_PROVISION_CONFIG_VERSION,
				fingerprint: 'stale-fingerprint',
				enabled: true,
				hasCredential: true,
				models: built.ok ? built.payload.models : [],
			},
			false,
		);
		assert.strictEqual(check.needed, true);
		assert.notStrictEqual(editorFp, 'stale-fingerprint');
	});

	test('explainModelAvailability requires catalog entry', () => {
		const miss = explainModelAvailability([], 'openAI', 'gpt-4.1');
		assert.strictEqual(miss.ok, false);
		if (!miss.ok) {
			assert.strictEqual(miss.code, 'provider_not_configured');
		}
		const ok = explainModelAvailability(
			[{
				providerId: 'openAI',
				displayName: 'OpenAI',
				source: 'editor_copy',
				baseUrlFingerprint: null,
				configVersion: '1',
				fingerprint: 'abc',
				enabled: true,
				hasCredential: true,
				models: [{ modelId: 'gpt-4.1', capabilities: { streaming: true, toolCalling: true, parallelToolCalls: true, reasoning: false, vision: false } }],
			}],
			'openAI',
			'gpt-4.1',
		);
		assert.strictEqual(ok.ok, true);
	});
});
