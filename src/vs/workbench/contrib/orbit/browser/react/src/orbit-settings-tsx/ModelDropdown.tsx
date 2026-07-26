/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FeatureName, featureNames, isFeatureNameDisabled, ModelSelection, modelSelectionsEqual, ProviderName, providerNames, SettingsOfProvider, displayInfoOfProviderName } from '../../../../common/orbitSettingsTypes.js'
import { useSettingsState, useRefreshModelState, useAccessor, useOpenAiCodexAuthState, useOrbitProviderAuthState, useXAiGrokAuthState, useClinePassAuthState } from '../util/services.js'
import { _VoidSelectBox, VoidCustomDropdownBox } from '../util/inputs.js'
import { SelectBox } from '../../../../../../../base/browser/ui/selectBox/selectBox.js'
import { VOID_OPEN_SETTINGS_ACTION_ID, VOID_TOGGLE_SETTINGS_ACTION_ID } from '../../../orbitSettingsPane.js'
import { VOID_CLINE_PASS_SIGN_IN_ACTION_ID } from '../../../actionIDs.js'
import { VOID_OPENAI_CODEX_SIGN_IN_ACTION_ID, VOID_OPEN_ACCOUNT_SETTINGS_ACTION_ID, VOID_XAI_GROK_SIGN_IN_ACTION_ID } from '../../../actionIDs.js'
import { modelFilterOfFeatureName, ModelOption } from '../../../../common/orbitSettingsService.js'
import { WarningBox } from './WarningBox.js'
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js'
import { getModelCapabilities } from '../../../../common/modelCapabilities.js'

const optionsEqual = (m1: ModelOption[], m2: ModelOption[]) => {
	if (m1.length !== m2.length) return false
	for (let i = 0; i < m1.length; i++) {
		if (!modelSelectionsEqual(m1[i].selection, m2[i].selection)) return false
	}
	return true
}

const formatUsdPerMillion = (amount: number) => {
	if (!Number.isFinite(amount) || amount === 0) return '$0'
	if (amount >= 1) return `$${amount.toFixed(2)}`
	if (amount >= 0.01) return `$${amount.toFixed(2)}`
	if (amount >= 0.0001) return `$${amount.toFixed(4)}`
	return `$${amount.toPrecision(3)}`
}

const ModelSelectBox = ({ options, featureName, className }: { options: ModelOption[], featureName: FeatureName, className: string }) => {
	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')

	const selection = voidSettingsService.state.modelSelectionOfFeature[featureName]
	const selectedOption = selection ? voidSettingsService.state._modelOptions.find(v => modelSelectionsEqual(v.selection, selection)) ?? options[0] : options[0]

	// If the stored model no longer exists (the provider's model list changed), the dropdown falls
	// back to options[0] for display — but the persisted selection stays stale, so the actual model
	// used silently differs from what's shown. Persist the fallback so displayed === stored.
	useEffect(() => {
		if (!selection || options.length === 0) return
		const stillExists = voidSettingsService.state._modelOptions.some(v => modelSelectionsEqual(v.selection, selection))
		if (!stillExists) {
			voidSettingsService.setModelSelectionOfFeature(featureName, options[0].selection)
		}
	}, [selection, options, featureName, voidSettingsService])

	const onChangeOption = useCallback((newOption: ModelOption) => {
		voidSettingsService.setModelSelectionOfFeature(featureName, newOption.selection)
	}, [voidSettingsService, featureName])

	const getOptionDetail = useCallback((option: ModelOption) => {
		const { providerName, modelName } = option.selection
		const overrides = voidSettingsService.state.overridesOfModel
		const capabilities = getModelCapabilities(providerName, modelName, overrides)

		const details: string[] = []
		details.push(`Provider: ${displayInfoOfProviderName(providerName).title}`)
		details.push(`\nContext Window: ${capabilities.contextWindow.toLocaleString()} tokens`)

		if (capabilities.reservedOutputTokenSpace !== null) {
			details.push(`Output Space: ${capabilities.reservedOutputTokenSpace.toLocaleString()} tokens`)
		}

		if (capabilities.reasoningCapabilities) {
			details.push('\nReasoning: Supported')
			if (capabilities.reasoningCapabilities.canTurnOffReasoning) {
				details.push('  • Can toggle reasoning on/off')
			}
			if (capabilities.reasoningCapabilities.canIOReasoning) {
				details.push('  • Outputs reasoning process')
			}
		}

		if (capabilities.specialToolFormat) {
			details.push('\nTools: Supported')
		}

		if (capabilities.cost && (capabilities.cost.input > 0 || capabilities.cost.output > 0)) {
			const costLabel = providerName === 'orbit' ? '\nCost (per 1M tokens, Orbit credits):' : '\nCost (per 1M tokens):'
			details.push(costLabel)
			details.push(`  • Input: ${formatUsdPerMillion(capabilities.cost.input)}`)
			details.push(`  • Output: ${formatUsdPerMillion(capabilities.cost.output)}`)
			if (capabilities.cost.cache_read) {
				details.push(`  • Cache Read: ${formatUsdPerMillion(capabilities.cost.cache_read)}`)
			}
			if (capabilities.cost.cache_write) {
				details.push(`  • Cache Write: ${formatUsdPerMillion(capabilities.cost.cache_write)}`)
			}
		}

		if (capabilities.supportsFIM) {
			details.push('\nFill-in-Middle: Supported')
		}

		if (capabilities.downloadable) {
			const size = capabilities.downloadable.sizeGb === 'not-known' ? 'Unknown' : `${capabilities.downloadable.sizeGb}GB`
			details.push(`\nDownloadable: ${size}`)
		}

		return details.join('\n')
	}, [voidSettingsService])

	return <VoidCustomDropdownBox
		options={options}
		selectedOption={selectedOption}
		onChangeOption={onChangeOption}
		getOptionDisplayName={(option) => option.selection.modelName}
		getOptionDropdownName={(option) => option.selection.modelName}
		getOptionDropdownDetail={getOptionDetail}
		getOptionsEqual={(a, b) => optionsEqual([a], [b])}
		className={className}
		matchInputWidth={false}
		opacity={75}
		searchable
		searchPlaceholder='Search models…'
		searchEmptyLabel='No models found'
		showCheckmarkOnSelected
		highlightSelectedBg={false}
	/>
}


const MemoizedModelDropdown = ({ featureName, className }: { featureName: FeatureName, className: string }) => {
	const settingsState = useSettingsState()
	const authState = useOpenAiCodexAuthState()
	const xAiAuthState = useXAiGrokAuthState()
	const orbitAuth = useOrbitProviderAuthState()
	const clinePassAuth = useClinePassAuthState()
	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const oldOptionsRef = useRef<ModelOption[]>([])
	const [memoizedOptions, setMemoizedOptions] = useState(oldOptionsRef.current)

	const { filter, emptyMessage } = modelFilterOfFeatureName[featureName]

	useEffect(() => {
		const oldOptions = oldOptionsRef.current
		const newOptions = settingsState._modelOptions
			.filter((o) => filter(o.selection, { chatMode: settingsState.globalSettings.chatMode, overridesOfModel: settingsState.overridesOfModel }))
			.filter((o) => authState.isAuthenticated || o.selection.providerName !== 'openAICodex')
			.filter((o) => xAiAuthState.isAuthenticated || o.selection.providerName !== 'xAISuperGrok')
			.filter((o) => orbitAuth.isAuthenticated || o.selection.providerName !== 'orbit')
			.filter((o) => clinePassAuth.isAuthenticated || o.selection.providerName !== 'clinePass')

		if (!optionsEqual(oldOptions, newOptions)) {
			setMemoizedOptions(newOptions)
		}
		oldOptionsRef.current = newOptions
	}, [settingsState._modelOptions, settingsState.globalSettings.chatMode, settingsState.overridesOfModel, filter, authState.isAuthenticated, xAiAuthState.isAuthenticated, orbitAuth.isAuthenticated, clinePassAuth.isAuthenticated])

	if (memoizedOptions.length === 0) {
		const hasCodexModels = settingsState._modelOptions.some((o) => o.selection.providerName === 'openAICodex')
		const hasXAiModels = settingsState._modelOptions.some((o) => o.selection.providerName === 'xAISuperGrok')
		const hasOrbitModels = settingsState.settingsOfProvider.orbit.models.length > 0
		const hasClinePassModels = settingsState.settingsOfProvider.clinePass.models.length > 0
		if (!authState.isAuthenticated && hasCodexModels) {
			return <WarningBox
				onClick={() => commandService.executeCommand(VOID_OPENAI_CODEX_SIGN_IN_ACTION_ID)}
				text='Sign in to use OpenAI Codex'
			/>
		}
		if (!xAiAuthState.isAuthenticated && hasXAiModels) {
			return <WarningBox
				onClick={() => commandService.executeCommand(VOID_XAI_GROK_SIGN_IN_ACTION_ID)}
				text='Sign in with SuperGrok to use Grok models'
			/>
		}
		if (!orbitAuth.isAuthenticated && hasOrbitModels) {
			return <WarningBox
				onClick={() => commandService.executeCommand(VOID_OPEN_ACCOUNT_SETTINGS_ACTION_ID)}
				text='Sign in with GitHub to use Orbit Provider models'
			/>
		}
		if (!clinePassAuth.isAuthenticated && hasClinePassModels) {
			return <WarningBox
				onClick={() => commandService.executeCommand(VOID_CLINE_PASS_SIGN_IN_ACTION_ID)}
				text='Sign in to use ClinePass models'
			/>
		}
		return <WarningBox text={emptyMessage?.message || 'No models available'} />
	}

	return <ModelSelectBox featureName={featureName} options={memoizedOptions} className={className} />

}

export const ModelDropdown = ({ featureName, className }: { featureName: FeatureName, className: string }) => {
	const settingsState = useSettingsState()
	const authState = useOpenAiCodexAuthState()
	const xAiAuthState = useXAiGrokAuthState()
	const orbitAuth = useOrbitProviderAuthState()
	const clinePassAuth = useClinePassAuthState()

	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const voidSettingsService = accessor.get('IVoidSettingsService')

	const openSettings = () => { commandService.executeCommand(VOID_OPEN_SETTINGS_ACTION_ID); };


	const { emptyMessage } = modelFilterOfFeatureName[featureName]
	const selection = settingsState.modelSelectionOfFeature[featureName]

	useEffect(() => {
		if (!orbitAuth.isAuthenticated && selection?.providerName === 'orbit') {
			const { filter } = modelFilterOfFeatureName[featureName]
		const fallbackOptions = settingsState._modelOptions
			.filter((o) => filter(o.selection, { chatMode: settingsState.globalSettings.chatMode, overridesOfModel: settingsState.overridesOfModel }))
			.filter((o) => o.selection.providerName !== 'orbit')
			.filter((o) => authState.isAuthenticated || o.selection.providerName !== 'openAICodex')
			.filter((o) => xAiAuthState.isAuthenticated || o.selection.providerName !== 'xAISuperGrok')
			.filter((o) => clinePassAuth.isAuthenticated || o.selection.providerName !== 'clinePass')
			voidSettingsService.setModelSelectionOfFeature(featureName, fallbackOptions[0]?.selection ?? null)
		}
	}, [orbitAuth.isAuthenticated, authState.isAuthenticated, xAiAuthState.isAuthenticated, clinePassAuth.isAuthenticated, selection?.providerName, settingsState._modelOptions, settingsState.globalSettings.chatMode, settingsState.overridesOfModel, featureName, voidSettingsService])

	useEffect(() => {
		if (authState.isAuthenticated) return
		if (selection?.providerName !== 'openAICodex') return
		const { filter } = modelFilterOfFeatureName[featureName]
		const fallbackOptions = settingsState._modelOptions
			.filter((o) => filter(o.selection, { chatMode: settingsState.globalSettings.chatMode, overridesOfModel: settingsState.overridesOfModel }))
			.filter((o) => o.selection.providerName !== 'openAICodex')
			.filter((o) => xAiAuthState.isAuthenticated || o.selection.providerName !== 'xAISuperGrok')
			.filter((o) => orbitAuth.isAuthenticated || o.selection.providerName !== 'orbit')
			.filter((o) => clinePassAuth.isAuthenticated || o.selection.providerName !== 'clinePass')
		voidSettingsService.setModelSelectionOfFeature(featureName, fallbackOptions[0]?.selection ?? null)
	}, [authState.isAuthenticated, xAiAuthState.isAuthenticated, orbitAuth.isAuthenticated, clinePassAuth.isAuthenticated, selection?.providerName, settingsState._modelOptions, settingsState.globalSettings.chatMode, settingsState.overridesOfModel, featureName, voidSettingsService])

	useEffect(() => {
		if (xAiAuthState.isAuthenticated) return
		if (selection?.providerName !== 'xAISuperGrok') return
		const { filter } = modelFilterOfFeatureName[featureName]
		const fallbackOptions = settingsState._modelOptions
			.filter((o) => filter(o.selection, { chatMode: settingsState.globalSettings.chatMode, overridesOfModel: settingsState.overridesOfModel }))
			.filter((o) => o.selection.providerName !== 'xAISuperGrok')
			.filter((o) => authState.isAuthenticated || o.selection.providerName !== 'openAICodex')
			.filter((o) => orbitAuth.isAuthenticated || o.selection.providerName !== 'orbit')
			.filter((o) => clinePassAuth.isAuthenticated || o.selection.providerName !== 'clinePass')
		voidSettingsService.setModelSelectionOfFeature(featureName, fallbackOptions[0]?.selection ?? null)
	}, [xAiAuthState.isAuthenticated, authState.isAuthenticated, orbitAuth.isAuthenticated, clinePassAuth.isAuthenticated, selection?.providerName, settingsState._modelOptions, settingsState.globalSettings.chatMode, settingsState.overridesOfModel, featureName, voidSettingsService])

	useEffect(() => {
		if (clinePassAuth.isAuthenticated) return
		if (selection?.providerName !== 'clinePass') return
		const { filter } = modelFilterOfFeatureName[featureName]
		const fallbackOptions = settingsState._modelOptions
			.filter((o) => filter(o.selection, { chatMode: settingsState.globalSettings.chatMode, overridesOfModel: settingsState.overridesOfModel }))
			.filter((o) => o.selection.providerName !== 'clinePass')
			.filter((o) => authState.isAuthenticated || o.selection.providerName !== 'openAICodex')
			.filter((o) => xAiAuthState.isAuthenticated || o.selection.providerName !== 'xAISuperGrok')
			.filter((o) => orbitAuth.isAuthenticated || o.selection.providerName !== 'orbit')
		voidSettingsService.setModelSelectionOfFeature(featureName, fallbackOptions[0]?.selection ?? null)
	}, [clinePassAuth.isAuthenticated, authState.isAuthenticated, xAiAuthState.isAuthenticated, orbitAuth.isAuthenticated, selection?.providerName, settingsState._modelOptions, settingsState.globalSettings.chatMode, settingsState.overridesOfModel, featureName, voidSettingsService])

	const isDisabled = isFeatureNameDisabled(featureName, settingsState)
	if (isDisabled)
		return <WarningBox onClick={openSettings} text={
			emptyMessage && emptyMessage.priority === 'always' ? emptyMessage.message :
				isDisabled === 'needToEnableModel' ? 'Enable a model'
					: isDisabled === 'addModel' ? 'Add a model'
						: (isDisabled === 'addProvider' || isDisabled === 'notFilledIn' || isDisabled === 'providerNotAutoDetected') ? 'Provider required'
							: 'Provider required'
		} />

	return <ErrorBoundary>
		<MemoizedModelDropdown featureName={featureName} className={className} />
	</ErrorBoundary>
}
