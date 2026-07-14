/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IEncryptionService } from '../../../../platform/encryption/common/encryptionService.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IMetricsService } from './metricsService.js';
import { defaultProviderSettings, getModelCapabilities, ModelOverrides } from './modelCapabilities.js';
import { VOID_SETTINGS_STORAGE_KEY } from './storageKeys.js';
import { defaultSettingsOfProvider, FeatureName, ProviderName, ModelSelectionOfFeature, SettingsOfProvider, SettingName, providerNames, ModelSelection, modelSelectionsEqual, featureNames, VoidStatefulModelInfo, GlobalSettings, GlobalSettingName, defaultGlobalSettings, ModelSelectionOptions, OptionsOfModelSelection, ChatMode, OverridesOfModel, defaultOverridesOfModel, MCPUserStateOfName as MCPUserStateOfName, MCPUserState, authGatedProviderNames } from './orbitSettingsTypes.js';
import { IOrbitProviderAuthService, OrbitProviderAuthState } from './orbitProviderAuthService.js';
import { BUILTIN_SUBAGENTS } from './subAgentRegistry.js';


// name is the name in the dropdown
export type ModelOption = { name: string, selection: ModelSelection }



type SetSettingOfProviderFn = <S extends SettingName>(
	providerName: ProviderName,
	settingName: S,
	newVal: SettingsOfProvider[ProviderName][S extends keyof SettingsOfProvider[ProviderName] ? S : never],
) => Promise<void>;

type SetModelSelectionOfFeatureFn = <K extends FeatureName>(
	featureName: K,
	newVal: ModelSelectionOfFeature[K],
) => Promise<void>;

type SetGlobalSettingFn = <T extends GlobalSettingName>(settingName: T, newVal: GlobalSettings[T]) => Promise<void>;

type SetOptionsOfModelSelection = (featureName: FeatureName, providerName: ProviderName, modelName: string, newVal: Partial<ModelSelectionOptions>) => void


export type VoidSettingsState = {
	readonly settingsOfProvider: SettingsOfProvider; // optionsOfProvider
	readonly modelSelectionOfFeature: ModelSelectionOfFeature; // stateOfFeature
	readonly optionsOfModelSelection: OptionsOfModelSelection;
	readonly overridesOfModel: OverridesOfModel;
	readonly globalSettings: GlobalSettings;
	readonly mcpUserStateOfName: MCPUserStateOfName; // user-controlled state of MCP servers

	readonly _modelOptions: ModelOption[] // computed based on the two above items
}

// type RealVoidSettings = Exclude<keyof VoidSettingsState, '_modelOptions'>
// type EventProp<T extends RealVoidSettings = RealVoidSettings> = T extends 'globalSettings' ? [T, keyof VoidSettingsState[T]] : T | 'all'


export interface IVoidSettingsService {
	readonly _serviceBrand: undefined;
	readonly state: VoidSettingsState; // in order to play nicely with react, you should immutably change state
	readonly waitForInitState: Promise<void>;

	onDidChangeState: Event<void>;

	setSettingOfProvider: SetSettingOfProviderFn;
	setModelSelectionOfFeature: SetModelSelectionOfFeatureFn;
	setOptionsOfModelSelection: SetOptionsOfModelSelection;
	setGlobalSetting: SetGlobalSettingFn;
	// setMCPServerStates: (newStates: MCPServerStates) => Promise<void>;

	/** No-op if agentType belongs to a built-in agent — built-ins can never be disabled. */
	disableAgent(agentType: string): Promise<void>;
	enableAgent(agentType: string): Promise<void>;
	getDisabledAgents(): string[];

	// setting to undefined CLEARS it, unlike others:
	setOverridesOfModel(providerName: ProviderName, modelName: string, overrides: Partial<ModelOverrides> | undefined): Promise<void>;

	dangerousSetState(newState: VoidSettingsState): Promise<void>;
	resetState(): Promise<void>;

	setAutodetectedModels(providerName: ProviderName, modelNames: string[], logging: object): void;
	setOrbitProviderModels(modelNames: string[], logging: object): void;
	toggleModelHidden(providerName: ProviderName, modelName: string): void;
	addModel(providerName: ProviderName, modelName: string): void;
	deleteModel(providerName: ProviderName, modelName: string): boolean;

	addMCPUserStateOfNames(userStateOfName: MCPUserStateOfName): Promise<void>;
	removeMCPUserStateOfNames(serverNames: string[]): Promise<void>;
	setMCPServerState(serverName: string, state: MCPUserState): Promise<void>;
}




const _modelsWithSwappedInNewModels = (options: { existingModels: VoidStatefulModelInfo[], models: string[], type: 'autodetected' | 'default' | 'orbit' }) => {
	const { existingModels, models, type } = options

	const existingModelsMap: Record<string, VoidStatefulModelInfo> = {}
	for (const existingModel of existingModels) {
		existingModelsMap[existingModel.modelName] = existingModel
	}

	const newDefaultModels = models.map((modelName, i) => ({ modelName, type, isHidden: !!existingModelsMap[modelName]?.isHidden, }))

	return [
		...newDefaultModels, // swap out all the models of this type for the new models of this type
		...existingModels.filter(m => {
			const keep = m.type !== type
			return keep
		})
	]
}


export const modelFilterOfFeatureName: {
	[featureName in FeatureName]: {
		filter: (
			o: ModelSelection,
			opts: { chatMode: ChatMode, overridesOfModel: OverridesOfModel }
		) => boolean;
		emptyMessage: null | { message: string, priority: 'always' | 'fallback' }
	} } = {
	'Autocomplete': { filter: (o, opts) => getModelCapabilities(o.providerName, o.modelName, opts.overridesOfModel).supportsFIM, emptyMessage: { message: 'No models support FIM', priority: 'always' } },
	'Chat': { filter: o => true, emptyMessage: null, },
	'Ctrl+K': { filter: o => true, emptyMessage: null, },
	'Apply': { filter: o => true, emptyMessage: null, },
	'SCM': { filter: o => true, emptyMessage: null, },
}


const _stateWithMergedDefaultModels = (state: VoidSettingsState): VoidSettingsState => {
	let newSettingsOfProvider = state.settingsOfProvider

	// recompute default models
	for (const providerName of providerNames) {
		const defaultModels = defaultSettingsOfProvider[providerName]?.models ?? []
		const currentModels = newSettingsOfProvider[providerName]?.models ?? []
		const defaultModelNames = defaultModels.map(m => m.modelName)
		const newModels = _modelsWithSwappedInNewModels({ existingModels: currentModels, models: defaultModelNames, type: 'default' })
		newSettingsOfProvider = {
			...newSettingsOfProvider,
			[providerName]: {
				...newSettingsOfProvider[providerName],
				models: newModels,
			},
		}
	}
	return {
		...state,
		settingsOfProvider: newSettingsOfProvider,
	}
}

const _validatedModelState = (state: Omit<VoidSettingsState, '_modelOptions'>): VoidSettingsState => {

	let newSettingsOfProvider = state.settingsOfProvider

	// recompute _didFillInProviderSettings
	for (const providerName of providerNames) {
		if ((authGatedProviderNames as string[]).includes(providerName)) {
			continue
		}
		const settingsAtProvider = newSettingsOfProvider[providerName]
		if (!settingsAtProvider) continue

		const didFillInProviderSettings = Object.keys(defaultProviderSettings[providerName]).every(key => {
			const val = settingsAtProvider[key as keyof typeof settingsAtProvider]
			// Treat whitespace-only strings as empty: a pasted key that is only spaces/newlines
			// must not count as "configured" (it would fail silently at request time otherwise).
			return typeof val === 'string' ? val.trim().length > 0 : !!val
		})

		if (didFillInProviderSettings === settingsAtProvider._didFillInProviderSettings) continue

		newSettingsOfProvider = {
			...newSettingsOfProvider,
			[providerName]: {
				...settingsAtProvider,
				_didFillInProviderSettings: didFillInProviderSettings,
			},
		}
	}

	// update model options
	let newModelOptions: ModelOption[] = []
	for (const providerName of providerNames) {
		const providerTitle = providerName // displayInfoOfProviderName(providerName).title.toLowerCase() // looks better lowercase, best practice to not use raw providerName
		if (!newSettingsOfProvider[providerName]._didFillInProviderSettings) continue // if disabled, don't display model options
		for (const { modelName, isHidden } of newSettingsOfProvider[providerName].models) {
			if (isHidden) continue
			newModelOptions.push({ name: `${modelName} (${providerTitle})`, selection: { providerName, modelName } })
		}
	}

	// now that model options are updated, make sure the selection is valid
	// if the user-selected model is no longer in the list, update the selection for each feature that needs it to something relevant (the 0th model available, or null)
	let newModelSelectionOfFeature = state.modelSelectionOfFeature
	for (const featureName of featureNames) {

		const { filter } = modelFilterOfFeatureName[featureName]
		const filterOpts = { chatMode: state.globalSettings.chatMode, overridesOfModel: state.overridesOfModel }
		const modelOptionsForThisFeature = newModelOptions.filter((o) => filter(o.selection, filterOpts))

		const modelSelectionAtFeature = newModelSelectionOfFeature[featureName]
		const selnIdx = modelSelectionAtFeature === null ? -1 : modelOptionsForThisFeature.findIndex(m => modelSelectionsEqual(m.selection, modelSelectionAtFeature))

		if (selnIdx !== -1) continue // no longer in list, so update to 1st in list or null

		newModelSelectionOfFeature = {
			...newModelSelectionOfFeature,
			[featureName]: modelOptionsForThisFeature.length === 0 ? null : modelOptionsForThisFeature[0].selection
		}
	}


	const newState = {
		...state,
		settingsOfProvider: newSettingsOfProvider,
		modelSelectionOfFeature: newModelSelectionOfFeature,
		overridesOfModel: state.overridesOfModel,
		_modelOptions: newModelOptions,
	} satisfies VoidSettingsState

	return newState
}





const defaultState = () => {
	const d: VoidSettingsState = {
		settingsOfProvider: deepClone(defaultSettingsOfProvider),
		modelSelectionOfFeature: { 'Chat': null, 'Ctrl+K': null, 'Autocomplete': null, 'Apply': null, 'SCM': null },
		globalSettings: deepClone(defaultGlobalSettings),
		optionsOfModelSelection: { 'Chat': {}, 'Ctrl+K': {}, 'Autocomplete': {}, 'Apply': {}, 'SCM': {} },
		overridesOfModel: deepClone(defaultOverridesOfModel),
		_modelOptions: [], // computed later
		mcpUserStateOfName: {},
	}
	return d
}

const objectOrEmpty = <T extends object>(value: unknown): Partial<T> => {
	return value && typeof value === 'object' ? value as Partial<T> : {}
}

const stateWithNormalizedGlobalSettings = (state: VoidSettingsState): VoidSettingsState => {
	const incomingGlobalSettings = objectOrEmpty<GlobalSettings>(state.globalSettings)
	const mergedGlobalSettings: GlobalSettings = {
		...deepClone(defaultGlobalSettings),
		...incomingGlobalSettings,
	}

	return {
		...state,
		globalSettings: mergedGlobalSettings,
	}
}

const mergeWithDefaultState = (state: VoidSettingsState): VoidSettingsState => {
	const defaults = defaultState()
	const incomingGlobalSettings = objectOrEmpty<GlobalSettings>(state.globalSettings)
	const incomingProviders = objectOrEmpty<SettingsOfProvider>(state.settingsOfProvider)
	const mergedProviders = { ...defaults.settingsOfProvider }
	for (const providerName of providerNames) {
		mergedProviders[providerName] = {
			...defaults.settingsOfProvider[providerName],
			...objectOrEmpty(incomingProviders[providerName]),
		} as any
	}
	return stateWithNormalizedGlobalSettings({
		...defaults,
		...state,
		settingsOfProvider: mergedProviders,
		globalSettings: {
			...defaults.globalSettings,
			...incomingGlobalSettings,
		},
	})
}


export const IVoidSettingsService = createDecorator<IVoidSettingsService>('VoidSettingsService');
class VoidSettingsService extends Disposable implements IVoidSettingsService {
	_serviceBrand: undefined;

	private readonly _onDidChangeState = new Emitter<void>();
	readonly onDidChangeState: Event<void> = this._onDidChangeState.event; // this is primarily for use in react, so react can listen + update on state changes

	state: VoidSettingsState;

	private readonly _resolver: () => void
	waitForInitState: Promise<void> // await this if you need a valid state initially

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IEncryptionService private readonly _encryptionService: IEncryptionService,
		@IMetricsService private readonly _metricsService: IMetricsService,
		@IOrbitProviderAuthService private readonly _orbitProviderAuth: IOrbitProviderAuthService,
	) {
		super()

		this._register(this._orbitProviderAuth.onDidChangeState((state) => {
			this._revalidateOrbitProvider(state)
		}))

		// at the start, we haven't read the partial config yet, but we need to set state to something
		this.state = defaultState()
		let resolver: () => void = () => { }
		this.waitForInitState = new Promise((res, rej) => resolver = res)
		this._resolver = resolver

		this.readAndInitializeState()
	}




	dangerousSetState = async (newState: VoidSettingsState) => {
		this.state = _validatedModelState(mergeWithDefaultState(newState))
		await this._storeState()
		this._onDidChangeState.fire()
		this._onUpdate_syncApplyToChat()
		this._onUpdate_syncSCMToChat()
	}
	async resetState() {
		await this.dangerousSetState(defaultState())
	}




	async readAndInitializeState() {
		let readS: VoidSettingsState
		// Only a failure to READ/parse the persisted blob should fall back to defaults. Once we
		// have a valid merged state, a later migration/normalization throw must NOT reset it —
		// doing so would silently wipe the user's API keys.
		try {
			readS = await this._readState();
			readS = mergeWithDefaultState(readS)
		}
		catch (e) {
			console.error('[OrbitSettings] Failed to read settings; resetting to defaults.', e)
			readS = defaultState()
		}

		try {
			// 1.0.3 addition, remove when enough users have had this code run
			if (readS.globalSettings.includeToolLintErrors === undefined) readS.globalSettings.includeToolLintErrors = true

			// autoapprove is now an obj not a boolean (1.2.5)
			if (typeof readS.globalSettings.autoApprove === 'boolean') readS.globalSettings.autoApprove = {}

			// 1.3.5 add source control feature
			if (readS.modelSelectionOfFeature && !readS.modelSelectionOfFeature['SCM']) {
				readS.modelSelectionOfFeature['SCM'] = deepClone(readS.modelSelectionOfFeature['Chat'])
				readS.optionsOfModelSelection['SCM'] = deepClone(readS.optionsOfModelSelection['Chat'])
			}
			// add disableSystemMessage feature
			if (readS.globalSettings.disableSystemMessage === undefined) readS.globalSettings.disableSystemMessage = false;

			// add autoAcceptLLMChanges feature
			if (readS.globalSettings.autoAcceptLLMChanges === undefined) readS.globalSettings.autoAcceptLLMChanges = false;
		}
		catch (e) {
			// Preserve the already-read settings (including API keys) rather than wiping them.
			console.error('[OrbitSettings] Settings migration failed; preserving existing settings.', e)
		}

		// the stored data structure might be outdated, so we need to update it here
		try {
			for (const providerName of providerNames) {
				readS.settingsOfProvider[providerName] = {
					...defaultSettingsOfProvider[providerName],
					...readS.settingsOfProvider[providerName],
				} as any

				// conversion from 1.0.3 to 1.2.5 (can remove this when enough people update)
				for (const m of readS.settingsOfProvider[providerName].models) {
					if (!m.type) {
						const old = (m as { isAutodetected?: boolean; isDefault?: boolean })
						if (old.isAutodetected)
							m.type = 'autodetected'
						else if (old.isDefault)
							m.type = 'default'
						else m.type = 'custom'
					}
				}

				// remove when enough people have had it run (default is now {})
				if (providerName === 'openAICompatible' && !readS.settingsOfProvider[providerName].headersJSON) {
					readS.settingsOfProvider[providerName].headersJSON = '{}'
				}
			}
		}

		catch (e) {
			// Preserve the already-read settings (including API keys) rather than wiping them.
			console.error('[OrbitSettings] Provider settings normalization failed; preserving existing settings.', e)
		}

		this.state = readS
		this.state = _stateWithMergedDefaultModels(this.state)
		this.state = _validatedModelState(this.state);


		this._resolver();
		this._onDidChangeState.fire();

		void this._orbitProviderAuth.getState().then((state) => this._revalidateOrbitProvider(state))
	}

	private async _readState(): Promise<VoidSettingsState> {
		const encryptedState = this._storageService.get(VOID_SETTINGS_STORAGE_KEY, StorageScope.APPLICATION)

		if (!encryptedState)
			return defaultState()

		let stateStr: string;
		try {
			stateStr = await this._encryptionService.decrypt(encryptedState)
		} catch (decryptError) {
			// Phase 1.7 (C7) fix: the encrypted blob cannot be decrypted (e.g. user
			// profile moved between machines, OS keychain reset). Wipe the blob so we
			// don't loop on a corrupt state, log to the user, and return defaults.
			console.error('[OrbitSettings] Failed to decrypt settings; resetting to defaults.', decryptError)
			try {
				this._storageService.remove(VOID_SETTINGS_STORAGE_KEY, StorageScope.APPLICATION)
			} catch {
				// best-effort
			}
			return defaultState()
		}

		let state: unknown
		try {
			state = JSON.parse(stateStr)
		} catch (parseError) {
			// Phase 1.7 (C7) fix: decrypt succeeded but the content is not valid JSON.
			// Log the failure, write a backup of the encrypted blob (best-effort) and
			// return defaults rather than silently wiping the user's settings.
			console.error('[OrbitSettings] Failed to parse decrypted settings; resetting to defaults.', parseError)
			try {
				this._storageService.store(
					`${VOID_SETTINGS_STORAGE_KEY}.bak`,
					encryptedState,
					StorageScope.APPLICATION,
					StorageTarget.USER,
				)
			} catch {
				// best-effort
			}
			try {
				this._storageService.remove(VOID_SETTINGS_STORAGE_KEY, StorageScope.APPLICATION)
			} catch {
				// best-effort
			}
			return defaultState()
		}

		// Phase 1.7 (C7) fix: forward-compat hook. Older settings may not have a
		// `version` field; treat anything missing or != 1 as a known shape and pass
		// through (we do not have migrations yet, but logging helps when this fires).
		if (state !== null && typeof state === 'object' && !('version' in (state as Record<string, unknown>))) {
			console.warn('[OrbitSettings] Settings blob has no version field; treating as v1.')
		}

		return state as VoidSettingsState
	}


	private async _storeState() {
		const state = this.state
		const encryptedState = await this._encryptionService.encrypt(JSON.stringify(state))
		this._storageService.store(VOID_SETTINGS_STORAGE_KEY, encryptedState, StorageScope.APPLICATION, StorageTarget.USER);
	}

	setSettingOfProvider: SetSettingOfProviderFn = async (providerName, settingName, newVal) => {

		const newModelSelectionOfFeature = this.state.modelSelectionOfFeature

		const newOptionsOfModelSelection = this.state.optionsOfModelSelection

		const newSettingsOfProvider: SettingsOfProvider = {
			...this.state.settingsOfProvider,
			[providerName]: {
				...this.state.settingsOfProvider[providerName],
				[settingName]: newVal,
			}
		}

		const newGlobalSettings = this.state.globalSettings
		const newOverridesOfModel = this.state.overridesOfModel
		const newMCPUserStateOfName = this.state.mcpUserStateOfName

		const newState = {
			modelSelectionOfFeature: newModelSelectionOfFeature,
			optionsOfModelSelection: newOptionsOfModelSelection,
			settingsOfProvider: newSettingsOfProvider,
			globalSettings: newGlobalSettings,
			overridesOfModel: newOverridesOfModel,
			mcpUserStateOfName: newMCPUserStateOfName,
		}

		this.state = _validatedModelState(newState)

		await this._storeState()
		this._onDidChangeState.fire()

	}


	private _onUpdate_syncApplyToChat() {
		// if sync is turned on, sync (call this whenever Chat model or !!sync changes)
		this.setModelSelectionOfFeature('Apply', deepClone(this.state.modelSelectionOfFeature['Chat']))
	}

	private _onUpdate_syncSCMToChat() {
		this.setModelSelectionOfFeature('SCM', deepClone(this.state.modelSelectionOfFeature['Chat']))
	}

	setGlobalSetting: SetGlobalSettingFn = async (settingName, newVal) => {
		const newState: VoidSettingsState = {
			...this.state,
			globalSettings: {
				...this.state.globalSettings,
				[settingName]: newVal
			}
		}
		this.state = _validatedModelState(stateWithNormalizedGlobalSettings(newState))
		await this._storeState()
		this._onDidChangeState.fire()

		// hooks
		if (this.state.globalSettings.syncApplyToChat) this._onUpdate_syncApplyToChat()
		if (this.state.globalSettings.syncSCMToChat) this._onUpdate_syncSCMToChat()

	}

	getDisabledAgents(): string[] {
		return this.state.globalSettings.disabledAgentTypes ?? []
	}

	async disableAgent(agentType: string): Promise<void> {
		if (BUILTIN_SUBAGENTS.some(a => a.agentType === agentType)) return // built-ins can't be disabled
		const current = this.getDisabledAgents()
		if (current.includes(agentType)) return
		await this.setGlobalSetting('disabledAgentTypes', [...current, agentType])
	}

	async enableAgent(agentType: string): Promise<void> {
		const current = this.getDisabledAgents()
		if (!current.includes(agentType)) return
		await this.setGlobalSetting('disabledAgentTypes', current.filter(t => t !== agentType))
	}


	setModelSelectionOfFeature: SetModelSelectionOfFeatureFn = async (featureName, newVal) => {
		const newState: VoidSettingsState = {
			...this.state,
			modelSelectionOfFeature: {
				...this.state.modelSelectionOfFeature,
				[featureName]: newVal
			}
		}

		this.state = _validatedModelState(newState)

		await this._storeState()
		this._onDidChangeState.fire()

		// hooks
		if (featureName === 'Chat') {
			// When Chat model changes, update synced features
			this._onUpdate_syncApplyToChat()
			this._onUpdate_syncSCMToChat()
		}
	}


	setOptionsOfModelSelection = async (featureName: FeatureName, providerName: ProviderName, modelName: string, newVal: Partial<ModelSelectionOptions>) => {
		const newState: VoidSettingsState = {
			...this.state,
			optionsOfModelSelection: {
				...this.state.optionsOfModelSelection,
				[featureName]: {
					...this.state.optionsOfModelSelection[featureName],
					[providerName]: {
						...this.state.optionsOfModelSelection[featureName][providerName],
						[modelName]: {
							...this.state.optionsOfModelSelection[featureName][providerName]?.[modelName],
							...newVal
						}
					}
				}
			}
		}
		this.state = _validatedModelState(newState)

		await this._storeState()
		this._onDidChangeState.fire()
	}

	setOverridesOfModel = async (providerName: ProviderName, modelName: string, overrides: Partial<ModelOverrides> | undefined) => {
		const newState: VoidSettingsState = {
			...this.state,
			overridesOfModel: {
				...this.state.overridesOfModel,
				[providerName]: {
					...this.state.overridesOfModel[providerName],
					[modelName]: overrides === undefined ? undefined : {
						...this.state.overridesOfModel[providerName][modelName],
						...overrides
					},
				}
			}
		};

		this.state = _validatedModelState(newState);
		await this._storeState();
		this._onDidChangeState.fire();

		this._metricsService.capture('Update Model Overrides', { providerName, modelName, overrides });
	}




	setAutodetectedModels(providerName: ProviderName, autodetectedModelNames: string[], logging: object) {

		const { models } = this.state.settingsOfProvider[providerName]
		const oldModelNames = models.map(m => m.modelName)

		const newModels = _modelsWithSwappedInNewModels({ existingModels: models, models: autodetectedModelNames, type: 'autodetected' })
		this.setSettingOfProvider(providerName, 'models', newModels)

		// if the models changed, log it
		const new_names = newModels.map(m => m.modelName)
		if (!(oldModelNames.length === new_names.length
			&& oldModelNames.every((_, i) => oldModelNames[i] === new_names[i]))
		) {
			this._metricsService.capture('Autodetect Models', { providerName, newModels: newModels, ...logging })
		}
	}

	setOrbitProviderModels(orbitModelNames: string[], logging: object) {
		const providerName = 'orbit' as const
		const { models } = this.state.settingsOfProvider[providerName]
		const oldModelNames = models.map(m => m.modelName)
		const newModels = _modelsWithSwappedInNewModels({ existingModels: models, models: orbitModelNames, type: 'orbit' })
		this.setSettingOfProvider(providerName, 'models', newModels)
		const new_names = newModels.map(m => m.modelName)
		if (!(oldModelNames.length === new_names.length
			&& oldModelNames.every((_, i) => oldModelNames[i] === new_names[i]))
		) {
			this._metricsService.capture('Orbit Provider Models', { providerName, newModels, ...logging })
		}
	}

	private _revalidateOrbitProvider(state: OrbitProviderAuthState) {
		const prev = this.state.settingsOfProvider.orbit._didFillInProviderSettings
		const next = !!state.isAuthenticated
		if (prev === next) {
			return
		}
		this.state = {
			...this.state,
			settingsOfProvider: {
				...this.state.settingsOfProvider,
				orbit: { ...this.state.settingsOfProvider.orbit, _didFillInProviderSettings: next },
			},
		}
		this.state = _validatedModelState(this.state)
		this._onDidChangeState.fire()
		void this._storeState()
		if (!next) {
			this._clearOrbitProviderModels()
		}
	}

	private _clearOrbitProviderModels() {
		const defaultNames = defaultSettingsOfProvider.orbit.models
			.filter(m => m.type === 'default')
			.map(m => m.modelName)
		this.setOrbitProviderModels(defaultNames, { source: 'sign_out' })
	}

	toggleModelHidden(providerName: ProviderName, modelName: string) {


		const { models } = this.state.settingsOfProvider[providerName]
		const modelIdx = models.findIndex(m => m.modelName === modelName)
		if (modelIdx === -1) return
		const newIsHidden = !models[modelIdx].isHidden
		const newModels: VoidStatefulModelInfo[] = [
			...models.slice(0, modelIdx),
			{ ...models[modelIdx], isHidden: newIsHidden },
			...models.slice(modelIdx + 1, Infinity)
		]
		this.setSettingOfProvider(providerName, 'models', newModels)

		this._metricsService.capture('Toggle Model Hidden', { providerName, modelName, newIsHidden })

	}
	addModel(providerName: ProviderName, modelName: string) {
		const { models } = this.state.settingsOfProvider[providerName]
		const existingIdx = models.findIndex(m => m.modelName === modelName)
		if (existingIdx !== -1) return // if exists, do nothing
		const newModels = [
			...models,
			{ modelName, type: 'custom', isHidden: false } as const
		]
		this.setSettingOfProvider(providerName, 'models', newModels)

		this._metricsService.capture('Add Model', { providerName, modelName })

	}
	deleteModel(providerName: ProviderName, modelName: string): boolean {
		const { models } = this.state.settingsOfProvider[providerName]
		const delIdx = models.findIndex(m => m.modelName === modelName)
		if (delIdx === -1) return false
		const newModels = [
			...models.slice(0, delIdx), // delete the idx
			...models.slice(delIdx + 1, Infinity)
		]
		this.setSettingOfProvider(providerName, 'models', newModels)

		this._metricsService.capture('Delete Model', { providerName, modelName })

		return true
	}

	// MCP Server State
	private _setMCPUserStateOfName = async (newStates: MCPUserStateOfName) => {
		const newState: VoidSettingsState = {
			...this.state,
			mcpUserStateOfName: {
				...this.state.mcpUserStateOfName,
				...newStates
			}
		};
		this.state = _validatedModelState(newState);
		await this._storeState();
		this._onDidChangeState.fire();
		this._metricsService.capture('Set MCP Server States', { newStates });
	}

	addMCPUserStateOfNames = async (newMCPStates: MCPUserStateOfName) => {
		const { mcpUserStateOfName: mcpServerStates } = this.state
		const newMCPServerStates = {
			...mcpServerStates,
			...newMCPStates,
		}
		await this._setMCPUserStateOfName(newMCPServerStates)
		this._metricsService.capture('Add MCP Servers', { servers: Object.keys(newMCPStates).join(', ') });
	}

	removeMCPUserStateOfNames = async (serverNames: string[]) => {
		const { mcpUserStateOfName: mcpServerStates } = this.state
		const newMCPServerStates = {
			...mcpServerStates,
		}
		serverNames.forEach(serverName => {
			if (serverName in newMCPServerStates) {
				delete newMCPServerStates[serverName]
			}
		})
		await this._setMCPUserStateOfName(newMCPServerStates)
		this._metricsService.capture('Remove MCP Servers', { servers: serverNames.join(', ') });
	}

	setMCPServerState = async (serverName: string, state: MCPUserState) => {
		const { mcpUserStateOfName } = this.state
		const newMCPServerStates = {
			...mcpUserStateOfName,
			[serverName]: state,
		}
		await this._setMCPUserStateOfName(newMCPServerStates)
		this._metricsService.capture('Update MCP Server State', { serverName, state });
	}

}


registerSingleton(IVoidSettingsService, VoidSettingsService, InstantiationType.Eager);
