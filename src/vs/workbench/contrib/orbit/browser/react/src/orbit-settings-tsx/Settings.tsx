/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import '../styles.css';
import { ProviderName, providerNames, VoidStatefulModelInfo, RefreshableProviderName, refreshableProviderNames, displayInfoOfProviderName, GlobalSettingName, displayInfoOfFeatureName } from '../../../../common/orbitSettingsTypes.js'
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js'
import { VoidButtonBgDarken, VoidCustomDropdownBox, VoidInputBox2, VoidSimpleInputBox, VoidSwitch } from '../util/inputs.js'
import { useAccessor, useIsDark, useIsOptedOut, useRefreshModelListener, useRefreshModelState, useSettingsState, useOpenAiCodexAuthState, useOrbitProviderAuthState, useOrbitUsageStats } from '../util/services.js'
import { X, RefreshCw, Loader2, Check, Asterisk, Plus, Boxes, Cloud, Sparkles, Settings2, Puzzle, LayoutList, BookOpen, Trash2, Download, type LucideIcon } from 'lucide-react'
import { listSkills, onSkillsChanged, type SkillDefinition } from '../../../../common/skillRegistry.js'
import { URI } from '../../../../../../../base/common/uri.js'
import { ModelDropdown } from './ModelDropdown.js'
import { ChatMarkdownRender } from '../markdown/ChatMarkdownRender.js'
import { WarningBox } from './WarningBox.js'
import { os } from '../../../../common/helpers/systemInfo.js'
import { IconLoading } from '../sidebar-tsx/SidebarChat.js'
import { ToolApprovalType, toolApprovalTypes } from '../../../../common/toolsServiceTypes.js'
import Severity from '../../../../../../../base/common/severity.js'
import { getModelCapabilities, modelOverrideKeys, ModelOverrides } from '../../../../common/modelCapabilities.js';
import { TransferEditorType, TransferFilesInfo } from '../../../extensionTransferTypes.js';
import { MCPServer } from '../../../../common/mcpServiceTypes.js';
import { useMCPServiceState } from '../util/services.js';
import { OPT_OUT_KEY } from '../../../../common/storageKeys.js';
import { StorageScope, StorageTarget } from '../../../../../../../platform/storage/common/storage.js';
import { consumePendingOrbitSettingsTab } from '../../../orbitSettingsNavigation.js';
import { ProvidersSection } from './ProvidersSection.js';

type Tab =
	| 'models'
	| 'providers'
	| 'featureOptions'
	| 'mcp'
	| 'general'
	| 'skills'
	| 'all';

const SETTINGS_NAV_ICON = { size: 15, strokeWidth: 1.75 } as const

const SettingsNavIcon = ({ icon: Icon }: { icon: LucideIcon }) => (
	<Icon {...SETTINGS_NAV_ICON} aria-hidden="true" />
)


const ButtonLeftTextRightOption = ({ text, leftButton }: { text: string, leftButton?: React.ReactNode }) => {

	return <div className='flex items-center text-void-fg-3 px-3 py-0.5 rounded-sm overflow-hidden gap-2'>
		{leftButton ? leftButton : null}
		<span>
			{text}
		</span>
	</div>
}

// models
const RefreshModelButton = ({ providerName }: { providerName: RefreshableProviderName }) => {

	const refreshModelState = useRefreshModelState()

	const accessor = useAccessor()
	const refreshModelService = accessor.get('IRefreshModelService')
	const metricsService = accessor.get('IMetricsService')

	const [justFinished, setJustFinished] = useState<null | 'finished' | 'error'>(null)

	useRefreshModelListener(
		useCallback((providerName2, refreshModelState) => {
			if (providerName2 !== providerName) return
			const { state } = refreshModelState[providerName]
			if (!(state === 'finished' || state === 'error')) return
			// now we know we just entered 'finished' state for this providerName
			setJustFinished(state)
			const tid = setTimeout(() => { setJustFinished(null) }, 2000)
			return () => clearTimeout(tid)
		}, [providerName])
	)

	const { state } = refreshModelState[providerName]

	const { title: providerTitle } = displayInfoOfProviderName(providerName)

	return <ButtonLeftTextRightOption

		leftButton={
			<button
				className='flex items-center'
				disabled={state === 'refreshing' || justFinished !== null}
				onClick={() => {
					refreshModelService.startRefreshingModels(providerName, { enableProviderOnSuccess: false, doNotFire: false })
					metricsService.capture('Click', { providerName, action: 'Refresh Models' })
				}}
			>
				{justFinished === 'finished' ? <Check className='stroke-void-fg-1 size-3' />
					: justFinished === 'error' ? <X className='stroke-void-fg-3 size-3' />
						: state === 'refreshing' ? <Loader2 className='size-3' />
							: <RefreshCw className='size-3' />}
			</button>
		}

		text={justFinished === 'finished' ? `${providerTitle} Models are up-to-date!`
			: justFinished === 'error' ? `${providerTitle} not found!`
				: `Manually refresh ${providerTitle} models.`}
	/>
}

const RefreshableModels = () => {
	const settingsState = useSettingsState()


	const buttons = refreshableProviderNames.map(providerName => {
		if (!settingsState.settingsOfProvider[providerName]._didFillInProviderSettings) return null
		return <RefreshModelButton key={providerName} providerName={providerName} />
	})

	return <>
		{buttons}
	</>

}



export const CheckmarkButton = ({ text, className }: { text?: string, className?: string }) => {
	return <div
		className={`flex items-center gap-1.5 w-fit
			${className ? className : `px-2 py-0.5 text-xs text-void-fg-1 bg-void-bg-2 rounded-sm`}
		`}
	>
		<Check className="size-4" />
		{text}
	</div>
}


const AddButton = ({ disabled, text = 'Add', ...props }: { disabled?: boolean, text?: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) => {
	return <button
		disabled={disabled}
		className={`bg-void-bg-1 border border-void-border-2 px-3 py-1 text-void-fg-1 rounded-sm ${!disabled ? 'hover:bg-void-bg-2 cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}
		{...props}
	>{text}</button>
}

// ConfirmButton prompts for a second click to confirm an action, cancels if clicking outside
const ConfirmButton = ({ children, onConfirm, className }: { children: React.ReactNode, onConfirm: () => void, className?: string }) => {
	const [confirm, setConfirm] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!confirm) return;
		const handleClickOutside = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setConfirm(false);
			}
		};
		document.addEventListener('click', handleClickOutside);
		return () => document.removeEventListener('click', handleClickOutside);
	}, [confirm]);
	return (
		<div ref={ref} className={`inline-block`}>
			<VoidButtonBgDarken className={className} onClick={() => {
				if (!confirm) {
					setConfirm(true);
				} else {
					onConfirm();
					setConfirm(false);
				}
			}}>
				{confirm ? `Confirm Reset` : children}
			</VoidButtonBgDarken>
		</div>
	);
};

// ---------------- Simplified Model Settings Dialog ------------------

// keys of ModelOverrides we allow the user to override



// This new dialog replaces the verbose UI with a single JSON override box.
const SimpleModelSettingsDialog = ({
	isOpen,
	onClose,
	modelInfo,
}: {
	isOpen: boolean;
	onClose: () => void;
	modelInfo: { modelName: string; providerName: ProviderName; type: 'autodetected' | 'custom' | 'default' } | null;
}) => {
	if (!isOpen || !modelInfo) return null;

	const { modelName, providerName, type } = modelInfo;
	const accessor = useAccessor()
	const settingsState = useSettingsState()
	const mouseDownInsideModal = useRef(false); // Ref to track mousedown origin
	const settingsStateService = accessor.get('IVoidSettingsService')

	// current overrides and defaults
	const defaultModelCapabilities = getModelCapabilities(providerName, modelName, undefined);
	const currentOverrides = settingsState.overridesOfModel?.[providerName]?.[modelName] ?? undefined;
	const { recognizedModelName, isUnrecognizedModel } = defaultModelCapabilities

	// Create the placeholder with the default values for allowed keys
	const partialDefaults: Partial<ModelOverrides> = {};
	for (const k of modelOverrideKeys) { if (defaultModelCapabilities[k]) partialDefaults[k] = defaultModelCapabilities[k] as any; }
	const placeholder = JSON.stringify(partialDefaults, null, 2);

	const [overrideEnabled, setOverrideEnabled] = useState<boolean>(() => !!currentOverrides);

	const [errorMsg, setErrorMsg] = useState<string | null>(null);

	const textAreaRef = useRef<HTMLTextAreaElement | null>(null)

	// reset when dialog toggles
	useEffect(() => {
		if (!isOpen) return;
		const cur = settingsState.overridesOfModel?.[providerName]?.[modelName];
		setOverrideEnabled(!!cur);
		setErrorMsg(null);
	}, [isOpen, providerName, modelName, settingsState.overridesOfModel, placeholder]);

	const onSave = async () => {
		// if disabled override, reset overrides
		if (!overrideEnabled) {
			await settingsStateService.setOverridesOfModel(providerName, modelName, undefined);
			onClose();
			return;
		}

		// enabled overrides
		// parse json
		let parsedInput: Record<string, unknown>

		if (textAreaRef.current?.value) {
			try {
				parsedInput = JSON.parse(textAreaRef.current.value);
			} catch (e) {
				setErrorMsg('Invalid JSON');
				return;
			}
		} else {
			setErrorMsg('Invalid JSON');
			return;
		}

		// only keep allowed keys
		const cleaned: Partial<ModelOverrides> = {};
		for (const k of modelOverrideKeys) {
			if (!(k in parsedInput)) continue
			const isEmpty = parsedInput[k] === '' || parsedInput[k] === null || parsedInput[k] === undefined;
			if (!isEmpty) {
				cleaned[k] = parsedInput[k] as any;
			}
		}
		await settingsStateService.setOverridesOfModel(providerName, modelName, cleaned);
		onClose();
	};

	const sourcecodeOverridesLink = `#`

	return (
		<div // Backdrop
			className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999999]"
			onMouseDown={() => {
				mouseDownInsideModal.current = false;
			}}
			onMouseUp={() => {
				if (!mouseDownInsideModal.current) {
					onClose();
				}
				mouseDownInsideModal.current = false;
			}}
		>
			{/* MODAL */}
			<div
				className="bg-void-bg-1 rounded-md p-4 max-w-xl w-full shadow-xl overflow-y-auto max-h-[90vh]"
				onClick={(e) => e.stopPropagation()} // Keep stopping propagation for normal clicks inside
				onMouseDown={(e) => {
					mouseDownInsideModal.current = true;
					e.stopPropagation();
				}}
			>
				<div className="flex justify-between items-center mb-4">
					<h3 className="text-lg font-medium">
						Change Defaults for {modelName} ({displayInfoOfProviderName(providerName).title})
					</h3>
					<button
						onClick={onClose}
						className="text-void-fg-3 hover:text-void-fg-1"
					>
						<X className="size-5" />
					</button>
				</div>

				{/* Display model recognition status */}
				<div className="text-sm text-void-fg-3 mb-4">
					{type === 'default' ? `${modelName} comes packaged with Orbit, so you shouldn't need to change these settings.`
						: isUnrecognizedModel
							? `Model not recognized by Orbit.`
							: `Orbit recognizes ${modelName} ("${recognizedModelName}").`}
				</div>


				{/* override toggle */}
				<div className="flex items-center gap-2 mb-4">
					<VoidSwitch size='xs' value={overrideEnabled} onChange={setOverrideEnabled} />
					<span className="text-void-fg-3 text-sm">Override model defaults</span>
				</div>

				{/* Informational link */}
				{overrideEnabled && <div className="text-sm text-void-fg-3 mb-4">
					<ChatMarkdownRender string={`See the [source code](${sourcecodeOverridesLink}) for a reference on how to set this JSON (advanced).`} chatMessageLocation={undefined} />
				</div>}

				<textarea
					key={overrideEnabled + ''}
					ref={textAreaRef}
					className={`w-full min-h-[200px] p-2 rounded-sm border border-void-border-2 bg-void-bg-2 resize-none font-mono text-sm ${!overrideEnabled ? 'text-void-fg-3' : ''}`}
					defaultValue={overrideEnabled && currentOverrides ? JSON.stringify(currentOverrides, null, 2) : placeholder}
					placeholder={placeholder}
					readOnly={!overrideEnabled}
				/>
				{errorMsg && (
					<div className="text-void-fg-3 mt-2 text-sm">{errorMsg}</div>
				)}


				<div className="flex justify-end gap-2 mt-4">
					<VoidButtonBgDarken onClick={onClose} className="px-3 py-1">
						Cancel
					</VoidButtonBgDarken>
					<VoidButtonBgDarken
						onClick={onSave}
						className="px-3 py-1"
					>
						Save
					</VoidButtonBgDarken>
				</div>
			</div>
		</div>
	);
};




export const ModelDump = ({ filteredProviders }: { filteredProviders?: ProviderName[] }) => {
	const accessor = useAccessor()
	const settingsStateService = accessor.get('IVoidSettingsService')
	const settingsState = useSettingsState()
	const authState = useOpenAiCodexAuthState()
	const orbitAuth = useOrbitProviderAuthState()

	// State to track which model's settings dialog is open
	const [openSettingsModel, setOpenSettingsModel] = useState<{
		modelName: string,
		providerName: ProviderName,
		type: 'autodetected' | 'custom' | 'default'
	} | null>(null);

	// States for add model functionality
	const [isAddModelOpen, setIsAddModelOpen] = useState(false);
	const [showCheckmark, setShowCheckmark] = useState(false);
	const [userChosenProviderName, setUserChosenProviderName] = useState<ProviderName | null>(null);
	const [modelName, setModelName] = useState<string>('');
	const [errorString, setErrorString] = useState('');

	// a dump of all the enabled providers' models
	const modelDump: (VoidStatefulModelInfo & { providerName: ProviderName, providerEnabled: boolean })[] = []

	// Use either filtered providers or all providers
	const providersToShow = (filteredProviders || providerNames).filter((provider) => {
		if (provider === 'openAICodex' && !authState.isAuthenticated) return false
		if (provider === 'orbit' && !orbitAuth.isAuthenticated) return false
		return true
	});

	for (let providerName of providersToShow) {
		const providerSettings = settingsState.settingsOfProvider[providerName]
		// if (!providerSettings.enabled) continue
		modelDump.push(...providerSettings.models.map(model => ({ ...model, providerName, providerEnabled: !!providerSettings._didFillInProviderSettings })))
	}

	// sort by hidden
	modelDump.sort((a, b) => {
		return Number(b.providerEnabled) - Number(a.providerEnabled)
	})

	// Add model handler
	const handleAddModel = () => {
		if (!userChosenProviderName) {
			setErrorString('Please select a provider.');
			return;
		}
		if (!modelName) {
			setErrorString('Please enter a model name.');
			return;
		}

		// Check if model already exists
		if (settingsState.settingsOfProvider[userChosenProviderName].models.find(m => m.modelName === modelName)) {
			setErrorString(`This model already exists.`);
			return;
		}

		settingsStateService.addModel(userChosenProviderName, modelName);
		setShowCheckmark(true);
		setTimeout(() => {
			setShowCheckmark(false);
			setIsAddModelOpen(false);
			setUserChosenProviderName(null);
			setModelName('');
		}, 1500);
		setErrorString('');
	};

	return <div className=''>
		{modelDump.map((m, i) => {
			const { isHidden, type, modelName, providerName, providerEnabled } = m

			const isNewProviderName = (i > 0 ? modelDump[i - 1] : undefined)?.providerName !== providerName

			const providerTitle = displayInfoOfProviderName(providerName).title

			const disabled = !providerEnabled
			const value = disabled ? false : !isHidden

			const tooltipName = (
				disabled ? `Add ${providerTitle} to enable`
					: value === true ? 'Show in Dropdown'
						: 'Hide from Dropdown'
			)


			const detailAboutModel = type === 'autodetected' ?
				<Asterisk size={14} className="inline-block align-text-top text-void-fg-3" data-tooltip-id='void-tooltip' data-tooltip-place='right' data-tooltip-content='Detected locally' />
				: type === 'custom' ?
					<Asterisk size={14} className="inline-block align-text-top text-void-fg-3" data-tooltip-id='void-tooltip' data-tooltip-place='right' data-tooltip-content='Custom model' />
					: undefined

			const hasOverrides = !!settingsState.overridesOfModel?.[providerName]?.[modelName]

			return <div key={`${modelName}${providerName}`}
				className={`flex items-center justify-between gap-4 hover:bg-black/10 dark:hover:bg-gray-300/10 py-1 px-3 rounded-sm overflow-hidden cursor-default truncate group
				`}
			>
				{/* left part is width:full */}
				<div className={`flex flex-grow items-center gap-4 min-w-0`}>
					<span className='w-32 shrink-0 truncate'>{isNewProviderName ? providerTitle : ''}</span>
					<span className='flex-1 truncate'>{modelName}</span>
				</div>

				{/* right part is anything that fits */}
				<div className="flex items-center gap-2 w-fit">

					{/* Advanced Settings button (gear). Hide entirely when provider/model disabled. */}
					{disabled ? null : (
						<div className="w-5 flex items-center justify-center">
							<button
								onClick={() => { setOpenSettingsModel({ modelName, providerName, type }) }}
								data-tooltip-id='void-tooltip'
								data-tooltip-place='right'
								data-tooltip-content='Advanced Settings'
								className={`${hasOverrides ? '' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}
							>
								<Plus size={12} className="text-void-fg-3 opacity-50" />
							</button>
						</div>
					)}

					{/* Blue star */}
					{detailAboutModel}


					{/* Switch */}
					<VoidSwitch
						value={value}
						onChange={() => { settingsStateService.toggleModelHidden(providerName, modelName); }}
						disabled={disabled}
						size='sm'

						data-tooltip-id='void-tooltip'
						data-tooltip-place='right'
						data-tooltip-content={tooltipName}
					/>

					{/* X button */}
					<div className={`w-5 flex items-center justify-center`}>
						{type === 'default' || type === 'autodetected' ? null : <button
							onClick={() => { settingsStateService.deleteModel(providerName, modelName); }}
							data-tooltip-id='void-tooltip'
							data-tooltip-place='right'
							data-tooltip-content='Delete'
							className={`${hasOverrides ? '' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}
						>
							<X size={12} className="text-void-fg-3 opacity-50" />
						</button>}
					</div>
				</div>
			</div>
		})}

		{/* Add Model Section */}
		{showCheckmark ? (
			<div className="mt-4">
				<CheckmarkButton text='Added' className="bg-void-bg-2 text-void-fg-1 px-3 py-1 rounded-sm" />
			</div>
		) : isAddModelOpen ? (
			<div className="mt-4">
				<form className="flex items-center gap-2">

					{/* Provider dropdown */}
					<ErrorBoundary>
						<VoidCustomDropdownBox
							options={providersToShow}
							selectedOption={userChosenProviderName}
							onChangeOption={(pn) => setUserChosenProviderName(pn)}
							getOptionDisplayName={(pn) => pn ? displayInfoOfProviderName(pn).title : 'Provider Name'}
							getOptionDropdownName={(pn) => pn ? displayInfoOfProviderName(pn).title : 'Provider Name'}
							getOptionsEqual={(a, b) => a === b}
							className="max-w-32 mx-2 w-full resize-none bg-void-bg-1 text-void-fg-1 placeholder:text-void-fg-3 border border-void-border-2 focus:border-void-border-1 py-1 px-2 rounded"
							arrowTouchesText={false}
						/>
					</ErrorBoundary>

					{/* Model name input */}
					<ErrorBoundary>
						<VoidSimpleInputBox
							value={modelName}
							compact={true}
							onChangeValue={setModelName}
							placeholder='Model Name'
							className='max-w-32'
						/>
					</ErrorBoundary>

					{/* Add button */}
					<ErrorBoundary>
						<AddButton
							type='button'
							disabled={!modelName || !userChosenProviderName}
							onClick={handleAddModel}
						/>
					</ErrorBoundary>

					{/* X button to cancel */}
					<button
						type="button"
						onClick={() => {
							setIsAddModelOpen(false);
							setErrorString('');
							setModelName('');
							setUserChosenProviderName(null);
						}}
						className='text-void-fg-4'
					>
						<X className='size-4' />
					</button>
				</form>

				{errorString && (
					<div className='text-void-fg-3 truncate whitespace-nowrap mt-1'>
						{errorString}
					</div>
				)}
			</div>
		) : (
			<div
				className="text-void-fg-4 flex flex-nowrap text-nowrap items-center hover:brightness-110 cursor-pointer mt-4"
				onClick={() => setIsAddModelOpen(true)}
			>
				<div className="flex items-center gap-1">
					<Plus size={16} />
					<span>Add a model</span>
				</div>
			</div>
		)}

		{/* Model Settings Dialog */}
		<SimpleModelSettingsDialog
			isOpen={openSettingsModel !== null}
			onClose={() => setOpenSettingsModel(null)}
			modelInfo={openSettingsModel}
		/>
	</div>
}



const formatUsageCount = (value: number) => value.toLocaleString()

const formatUsageTokens = (value: number) => {
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(1)}M`
	}
	if (value >= 1_000) {
		return `${(value / 1_000).toFixed(1)}K`
	}
	return formatUsageCount(value)
}

const formatUsageDate = (iso: string | null) => {
	if (!iso) {
		return '—'
	}
	const date = new Date(iso)
	if (Number.isNaN(date.getTime())) {
		return '—'
	}
	return date.toLocaleString()
}

const usageProgressPercent = (used: number, limit: number) => {
	if (limit <= 0) {
		return 0
	}
	return Math.min(100, Math.round((used / limit) * 100))
}

const UsageProgressBar = ({ label, used, limit, formatValue }: {
	label: string
	used: number
	limit: number
	formatValue: (value: number) => string
}) => {
	const percent = usageProgressPercent(used, limit)
	const isNearLimit = percent >= 90
	return (
		<div className='@@settings-progress'>
			<div className='@@settings-progress-meta'>
				<span className='@@settings-progress-label'>{label}</span>
				<span className={`@@settings-progress-value${isNearLimit ? ' @@settings-progress-value--warning' : ''}`}>
					{formatValue(used)} / {formatValue(limit)}
				</span>
			</div>
			<div className='@@settings-progress-track'>
				<div
					className={`@@settings-progress-fill${isNearLimit ? ' @@settings-progress-fill--warning' : ''}`}
					style={{ width: `${percent}%` }}
				/>
			</div>
		</div>
	)
}

const SettingsPageHeader = ({ title, description }: { title: string; description?: React.ReactNode }) => (
	<div className='@@settings-page-header'>
		<h2 className='@@settings-page-title'>{title}</h2>
		{description ? <div className='@@settings-page-desc'>{description}</div> : null}
	</div>
)

const AccountUsageStats = ({ enabled }: { enabled: boolean }) => {
	const orbitAuth = useOrbitProviderAuthState()
	const { stats, loading, error, refresh } = useOrbitUsageStats(enabled)

	if (!orbitAuth.isAuthenticated) {
		return null
	}

	const totalTokens = (stats?.totalInputTokens ?? 0) + (stats?.totalOutputTokens ?? 0)
	const usedTokens30d = (stats?.last30Days?.totalInputTokens ?? 0) + (stats?.last30Days?.totalOutputTokens ?? 0)
	const tokenLimit30d = stats?.limits?.monthlyTokens

	return (
		<div className='mt-6'>
			<div className='@@settings-usage-header'>
				<h3 className='@@settings-usage-title'>Usage</h3>
				<button
					type='button'
					className='@@settings-refresh-btn'
					disabled={loading}
					onClick={() => void refresh()}
				>
					<RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
					Refresh
				</button>
			</div>

			<div className='@@settings-card'>
				<div className='@@settings-card-body'>
					{error && (
						<p className='@@settings-card-sublabel mb-3'>{error}</p>
					)}
					{loading && !stats ? (
						<div className='@@settings-loading'>
							<Loader2 className='w-4 h-4 animate-spin' />
							Loading usage…
						</div>
					) : (
						<>
							<p className='@@settings-usage-hint'>
								Free plan includes 1M tokens per rolling 30 days. Usage refreshes when you open this tab or finish a chat.
							</p>

							{tokenLimit30d != null && (
								<UsageProgressBar
									label='Tokens (30 days)'
									used={usedTokens30d}
									limit={tokenLimit30d}
									formatValue={formatUsageTokens}
								/>
							)}

							<div className='@@settings-stat-grid @@settings-stat-grid--4'>
								<div className='@@settings-stat'>
									<div className='@@settings-stat-label'>Plan</div>
									<div className='@@settings-stat-value capitalize'>{stats?.limits?.plan ?? orbitAuth.plan ?? 'free'}</div>
								</div>
								<div className='@@settings-stat'>
									<div className='@@settings-stat-label'>Last activity</div>
									<div className='@@settings-stat-value'>{formatUsageDate(stats?.lastRequestAt ?? null)}</div>
								</div>
								{stats?.remaining30Days?.tokens != null && (
									<div className='@@settings-stat'>
										<div className='@@settings-stat-label'>Remaining</div>
										<div className='@@settings-stat-value'>{formatUsageTokens(stats.remaining30Days.tokens)}</div>
									</div>
								)}
								<div className='@@settings-stat'>
									<div className='@@settings-stat-label'>Requests (30d)</div>
									<div className='@@settings-stat-value'>{formatUsageCount(stats?.last30Days?.totalLlmRequests ?? 0)}</div>
								</div>
							</div>

							<div className='@@settings-subsection-title'>All-time</div>
							<div className='@@settings-stat-grid @@settings-stat-grid--4'>
								<div className='@@settings-stat'>
									<div className='@@settings-stat-label'>API requests</div>
									<div className='@@settings-stat-value'>{formatUsageCount(stats?.totalRequests ?? 0)}</div>
								</div>
								<div className='@@settings-stat'>
									<div className='@@settings-stat-label'>LLM requests</div>
									<div className='@@settings-stat-value'>{formatUsageCount(stats?.totalLlmRequests ?? 0)}</div>
								</div>
								<div className='@@settings-stat'>
									<div className='@@settings-stat-label'>Input tokens</div>
									<div className='@@settings-stat-value'>{formatUsageTokens(stats?.totalInputTokens ?? 0)}</div>
								</div>
								<div className='@@settings-stat'>
									<div className='@@settings-stat-label'>Output tokens</div>
									<div className='@@settings-stat-value'>{formatUsageTokens(stats?.totalOutputTokens ?? 0)}</div>
								</div>
							</div>

							<div className='@@settings-total-row'>
								<span className='@@settings-total-label'>Total tokens</span>
								<span className='@@settings-total-value'>{formatUsageTokens(totalTokens)}</span>
							</div>

							{(stats?.byModel?.length ?? 0) > 0 && (
								<>
									<div className='@@settings-subsection-title'>By model</div>
									<div>
										{stats!.byModel.map((row) => (
											<div key={row.model} className='@@settings-model-row'>
												<span className='@@settings-model-name'>{row.model}</span>
												<span className='@@settings-model-meta'>
													{formatUsageCount(row.llmRequests)} calls · {formatUsageTokens(row.inputTokens + row.outputTokens)} tokens
												</span>
											</div>
										))}
									</div>
								</>
							)}
						</>
					)}
				</div>
			</div>
		</div>
	)
}


export const AutoDetectLocalModelsToggle = () => {
	const settingName: GlobalSettingName = 'autoRefreshModels'

	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const metricsService = accessor.get('IMetricsService')

	const voidSettingsState = useSettingsState()

	// right now this is just `enabled_autoRefreshModels`
	const enabled = voidSettingsState.globalSettings[settingName]

	return <ButtonLeftTextRightOption
		leftButton={<VoidSwitch
			size='xxs'
			value={enabled}
			onChange={(newVal) => {
				voidSettingsService.setGlobalSetting(settingName, newVal)
				metricsService.capture('Click', { action: 'Autorefresh Toggle', settingName, enabled: newVal })
			}}
		/>}
		text={`Automatically detect local providers and models (${refreshableProviderNames.map(providerName => displayInfoOfProviderName(providerName).title).join(', ')}).`}
	/>


}

export const AIInstructionsBox = () => {
	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const voidSettingsState = useSettingsState()
	return <VoidInputBox2
		className='min-h-[81px] p-3 rounded-sm'
		initValue={voidSettingsState.globalSettings.aiInstructions}
		placeholder={`Do not change my indentation or delete my comments. When writing TS or JS, do not add ;'s. Write new code using Rust if possible. `}
		multiline
		onChangeText={(newText) => {
			voidSettingsService.setGlobalSetting('aiInstructions', newText)
		}}
	/>
}

const FastApplyMethodDropdown = () => {
	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')

	const options = useMemo(() => [true, false], [])

	const onChangeOption = useCallback((newVal: boolean) => {
		voidSettingsService.setGlobalSetting('enableFastApply', newVal)
	}, [voidSettingsService])

	return <VoidCustomDropdownBox
		className='text-xs text-void-fg-3 bg-void-bg-1 border border-void-border-1 rounded p-0.5 px-1'
		options={options}
		selectedOption={voidSettingsService.state.globalSettings.enableFastApply}
		onChangeOption={onChangeOption}
		getOptionDisplayName={(val) => val ? 'Fast Apply' : 'Slow Apply'}
		getOptionDropdownName={(val) => val ? 'Fast Apply' : 'Slow Apply'}
		getOptionDropdownDetail={(val) => val ? 'Output Search/Replace blocks' : 'Rewrite whole files'}
		getOptionsEqual={(a, b) => a === b}
	/>

}


export const OllamaSetupInstructions = ({ sayWeAutoDetect }: { sayWeAutoDetect?: boolean }) => {
	return <div className='prose-p:my-0 prose-ol:list-decimal prose-p:py-0 prose-ol:my-0 prose-ol:py-0 prose-span:my-0 prose-span:py-0 text-void-fg-3 text-sm list-decimal select-text'>
		<div className=''><ChatMarkdownRender string={`Ollama Setup Instructions`} chatMessageLocation={undefined} /></div>
		<div className=' pl-6'><ChatMarkdownRender string={`1. Download [Ollama](https://ollama.com/download).`} chatMessageLocation={undefined} /></div>
		<div className=' pl-6'><ChatMarkdownRender string={`2. Open your terminal.`} chatMessageLocation={undefined} /></div>
		<div
			className='pl-6 flex items-center w-fit'
			data-tooltip-id='void-tooltip-ollama-settings'
		>
			<ChatMarkdownRender string={`3. Run \`ollama pull your_model\` to install a model.`} chatMessageLocation={undefined} />
		</div>
		{sayWeAutoDetect && <div className=' pl-6'><ChatMarkdownRender string={`Orbit automatically detects locally running models and enables them.`} chatMessageLocation={undefined} /></div>}
	</div>
}


const RedoOnboardingButton = ({ className }: { className?: string }) => {
	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	return <div
		className={`text-void-fg-4 flex flex-nowrap text-nowrap items-center hover:brightness-110 cursor-pointer ${className}`}
		onClick={() => { voidSettingsService.setGlobalSetting('isOnboardingComplete', false) }}
	>
		See onboarding screen?
	</div>

}







export const ToolApprovalTypeSwitch = ({ approvalType, size, desc }: { approvalType: ToolApprovalType, size: "xxs" | "xs" | "sm" | "sm+" | "md", desc: string }) => {
	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const voidSettingsState = useSettingsState()
	const metricsService = accessor.get('IMetricsService')

	const onToggleAutoApprove = useCallback((approvalType: ToolApprovalType, newValue: boolean) => {
		voidSettingsService.setGlobalSetting('autoApprove', {
			...voidSettingsService.state.globalSettings.autoApprove,
			[approvalType]: newValue
		})
		metricsService.capture('Tool Auto-Accept Toggle', { enabled: newValue })
	}, [voidSettingsService, metricsService])

	return <>
		<VoidSwitch
			size={size}
			value={voidSettingsState.globalSettings.autoApprove[approvalType] ?? false}
			onChange={(newVal) => onToggleAutoApprove(approvalType, newVal)}
		/>
		<span className="text-void-fg-3 text-xs">{desc}</span>
	</>
}



export const OneClickSwitchButton = ({ fromEditor = 'VS Code', className = '' }: { fromEditor?: TransferEditorType, className?: string }) => {
	const accessor = useAccessor()
	const extensionTransferService = accessor.get('IExtensionTransferService')

	const [transferState, setTransferState] = useState<{ type: 'done', error?: string } | { type: | 'loading' | 'justfinished' }>({ type: 'done' })



	const onClick = async () => {
		if (transferState.type !== 'done') return

		setTransferState({ type: 'loading' })

		const errAcc = await extensionTransferService.transferExtensions(os, fromEditor)

		// Even if some files were missing, consider it a success if no actual errors occurred
		const hadError = !!errAcc
		if (hadError) {
			setTransferState({ type: 'done', error: errAcc })
		}
		else {
			setTransferState({ type: 'justfinished' })
			setTimeout(() => { setTransferState({ type: 'done' }); }, 3000)
		}
	}

	return <>
		<VoidButtonBgDarken className={`max-w-48 p-4 ${className}`} disabled={transferState.type !== 'done'} onClick={onClick}>
			{transferState.type === 'done' ? `Transfer from ${fromEditor}`
				: transferState.type === 'loading' ? <span className='text-nowrap flex flex-nowrap'>Transferring<IconLoading /></span>
					: transferState.type === 'justfinished' ? <CheckmarkButton text='Settings Transferred' className='bg-void-bg-2 text-void-fg-1' />
						: null
			}
		</VoidButtonBgDarken>
		{transferState.type === 'done' && transferState.error ? <WarningBox text={transferState.error} /> : null}
	</>
}


// full settings

// MCP Server component
const MCPServerComponent = ({ name, server }: { name: string, server: MCPServer }) => {
	const accessor = useAccessor();
	const mcpService = accessor.get('IMCPService');

	const voidSettings = useSettingsState()
	const isOn = voidSettings.mcpUserStateOfName[name]?.isOn

	const removeUniquePrefix = (name: string) => name.split('_').slice(1).join('_')

	return (
		<div className={`@@provider-card my-2${server.status === 'success' ? ' @@configured' : ''}`}>
			<div className="@@provider-card-body">
				<div className="@@settings-card-row">
					<div className="flex items-center gap-2 min-w-0">
						<div className={`@@settings-status-dot${server.status === 'success' ? '' : ''}`} />
						<div className="@@settings-card-label truncate">{name}</div>
					</div>
					<VoidSwitch
						value={isOn ?? false}
						size='xs'
						disabled={server.status === 'error'}
						onChange={() => mcpService.toggleServerIsOn(name, !isOn)}
					/>
				</div>

				{isOn && (
					<div className="mt-3">
						<div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
							{(server.tools ?? []).length > 0 ? (
								(server.tools ?? []).map((tool: { name: string; description?: string }) => (
									<span
										key={tool.name}
										className="px-2 py-0.5 text-void-fg-3 rounded text-xs"
										style={{ background: 'color-mix(in srgb, var(--void-fg-1) 5%, transparent)' }}

										data-tooltip-id='void-tooltip'
										data-tooltip-content={tool.description || ''}
										data-tooltip-class-name='void-max-w-[300px]'
									>
										{removeUniquePrefix(tool.name)}
									</span>
								))
							) : (
								<span className="text-xs text-void-fg-3">No tools available</span>
							)}
						</div>
					</div>
				)}

				{isOn && server.command && (
					<div className="mt-3">
						<div className="@@settings-stat-label mb-1">Command</div>
						<div className="px-2 py-1 text-xs font-mono overflow-x-auto whitespace-nowrap text-void-fg-2 rounded"
							style={{ background: 'color-mix(in srgb, var(--void-fg-1) 5%, transparent)' }}>
							{server.command}
						</div>
					</div>
				)}

				{server.error && (
					<div className="mt-3">
						<WarningBox text={server.error} />
					</div>
				)}
			</div>
		</div>
	);
};

// Main component that renders the list of servers
const MCPServersList = () => {
	const mcpServiceState = useMCPServiceState()

	let content: React.ReactNode
	if (mcpServiceState.error) {
		content = <div className="text-void-fg-3 text-sm mt-2">
			{mcpServiceState.error}
		</div>
	}
	else {
		const entries = Object.entries(mcpServiceState.mcpServerOfName)
		if (entries.length === 0) {
			content = <div className="text-void-fg-3 text-sm mt-2">
				No servers found
			</div>
		}
		else {
			content = entries.map(([name, server]) => (
				<MCPServerComponent key={name} name={name} server={server} />
			))
		}
	}

	return <div className="my-2">{content}</div>
};

// Settings Section Component (Cursor-style)
interface SettingsSectionProps {
	title?: string;
	children: React.ReactNode;
}

const SettingsSection = ({ title, children }: SettingsSectionProps) => {
	return (
		<div className="@@settings-section">
			{title && (
				<div className="@@settings-section-header">
					<h3 className="@@settings-section-title">{title}</h3>
				</div>
			)}
			<div>{children}</div>
		</div>
	);
};

// Settings Cell Component (Individual Row)
interface SettingsCellProps {
	label: string;
	description: string | React.ReactNode;
	badge?: string;
	showDivider?: boolean;
	children: React.ReactNode;
}

const SettingsCell = ({ label, description, badge, showDivider = false, children }: SettingsCellProps) => {
	return (
		<div className="@@settings-cell">
			{showDivider && <div className="@@settings-cell-divider" />}
			<div className="@@settings-cell-leading">
				<p className="@@settings-cell-label">
					{badge && <span className="@@settings-badge">{badge}</span>}
					{label}
				</p>
				<div className="@@settings-cell-description">{description}</div>
			</div>
			<div className="@@settings-cell-trailing">
				{children}
			</div>
		</div>
	);
};

// A single row inside the Skills card (Cursor-style).
const SkillRow = ({ skill, onOpen, onToggle, onDelete }: {
	skill: SkillDefinition;
	onOpen: (skill: SkillDefinition) => void;
	onToggle: (name: string, enabled: boolean) => void;
	onDelete: (skill: SkillDefinition) => void;
}) => {
	const isBuiltIn = skill.source === 'built-in'
	const canOpen = !!skill.filePath
	const deletable = !isBuiltIn && !skill.external
	return (
		<div
			className={`group flex items-start gap-3 px-4 py-3 border-t border-void-border-3 first:border-t-0 transition-colors ${canOpen ? 'cursor-pointer hover:bg-[color-mix(in_srgb,var(--void-fg-1)_4%,transparent)]' : ''} ${skill.enabled ? '' : 'opacity-55'}`}
			onClick={canOpen ? () => onOpen(skill) : undefined}
			role={canOpen ? 'button' : undefined}
			title={canOpen ? 'Open SKILL.md' : undefined}
		>
			<div className='min-w-0 flex-1'>
				<div className='flex items-center gap-2'>
					<span className='text-void-fg-1 text-sm font-medium truncate'>{skill.name}</span>
					{isBuiltIn && (
						<span className='text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded text-void-fg-3' style={{ background: 'color-mix(in srgb, var(--void-fg-1) 8%, transparent)' }}>
							built-in
						</span>
					)}
					{skill.external && (
						<span className='text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded text-void-fg-3' style={{ background: 'color-mix(in srgb, var(--void-fg-1) 8%, transparent)' }}>
							global
						</span>
					)}
					{skill.disableModelInvocation && (
						<span className='text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded text-void-fg-3' style={{ background: 'color-mix(in srgb, var(--void-fg-1) 8%, transparent)' }}>
							manual
						</span>
					)}
				</div>
				<p className='text-void-fg-3 text-xs leading-relaxed mt-0.5 line-clamp-2'>{skill.description}</p>
			</div>
			<div className='flex items-center gap-1.5 flex-shrink-0 pt-0.5' onClick={(e) => e.stopPropagation()}>
				<VoidSwitch
					value={skill.enabled}
					size='xs'
					onChange={(newVal) => onToggle(skill.name, newVal)}
				/>
				{deletable && (
					<button
						className='p-1 rounded text-void-fg-4 opacity-0 group-hover:opacity-100 hover:text-void-fg-1 transition-opacity'
						onClick={() => onDelete(skill)}
						title='Delete skill'
					>
						<Trash2 className='w-3.5 h-3.5' />
					</button>
				)}
			</div>
		</div>
	)
}

const SKILLS_COLLAPSED_COUNT = 6

// Skills list (Skills tab) — single rounded card with hairline-separated rows.
const SkillsListView = ({ skills, onOpen, onToggle, onDelete }: {
	skills: SkillDefinition[];
	onOpen: (skill: SkillDefinition) => void;
	onToggle: (name: string, enabled: boolean) => void;
	onDelete: (skill: SkillDefinition) => void;
}) => {
	const [expanded, setExpanded] = useState(false)

	if (skills.length === 0) {
		return (
			<div className='rounded-lg border border-void-border-3 bg-void-bg-2 px-4 py-8 text-center'>
				<p className='text-void-fg-2 text-sm'>No skills yet.</p>
				<p className='text-void-fg-3 text-xs mt-1'>Import your skills from Cursor, or create a new one.</p>
			</div>
		)
	}

	const hasMore = skills.length > SKILLS_COLLAPSED_COUNT
	const visible = expanded ? skills : skills.slice(0, SKILLS_COLLAPSED_COUNT)

	return (
		<div className='rounded-lg border border-void-border-3 bg-void-bg-2 overflow-hidden'>
			{visible.map(skill => (
				<SkillRow key={skill.filePath || skill.name} skill={skill} onOpen={onOpen} onToggle={onToggle} onDelete={onDelete} />
			))}
			{hasMore && (
				<button
					className='w-full text-left px-4 py-2.5 border-t border-void-border-3 text-void-fg-3 text-xs hover:bg-[color-mix(in_srgb,var(--void-fg-1)_4%,transparent)] transition-colors'
					onClick={() => setExpanded(v => !v)}
				>
					{expanded ? 'Show less' : `Show all (${skills.length - SKILLS_COLLAPSED_COUNT} more)`}
				</button>
			)}
		</div>
	)
}

export const Settings = () => {
	const isDark = useIsDark()
	// ─── sidebar nav ──────────────────────────
	const [selectedSection, setSelectedSection] =
		useState<Tab>(() => consumePendingOrbitSettingsTab() ?? 'models');

	const navItems: { tab: Tab; label: string; icon: React.ReactNode; category?: string }[] = [
		{ tab: 'models', label: 'Models', icon: <SettingsNavIcon icon={Boxes} /> },
		{ tab: 'providers', label: 'Providers', icon: <SettingsNavIcon icon={Cloud} /> },
		{ tab: 'featureOptions', label: 'Feature Options', icon: <SettingsNavIcon icon={Sparkles} /> },
		{ tab: 'general', label: 'General', icon: <SettingsNavIcon icon={Settings2} /> },
		{ tab: 'mcp', label: 'MCP', icon: <SettingsNavIcon icon={Puzzle} /> },
		{ tab: 'skills', label: 'Skills', icon: <SettingsNavIcon icon={BookOpen} /> },
		{ tab: 'all', label: 'All Settings', icon: <SettingsNavIcon icon={LayoutList} /> },
	];
	const shouldShowTab = (tab: Tab) => selectedSection === 'all' || selectedSection === tab;
	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const environmentService = accessor.get('IEnvironmentService')
	const nativeHostService = accessor.get('INativeHostService')
	const settingsState = useSettingsState()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const chatThreadsService = accessor.get('IChatThreadService')
	const notificationService = accessor.get('INotificationService')
	const mcpService = accessor.get('IMCPService')
	const storageService = accessor.get('IStorageService')
	const metricsService = accessor.get('IMetricsService')
	const isOptedOut = useIsOptedOut()

	// --- Skills ---
	const skillImportService = accessor.get('ISkillImportService')
	const [skills, setSkills] = useState<SkillDefinition[]>(() => listSkills())
	useEffect(() => onSkillsChanged(() => setSkills(listSkills())), [])

	const handleImportFromCursor = async () => {
		try {
			const result = await skillImportService.importFromCursor()
			if (result.imported > 0) {
				notificationService.info(`Imported ${result.imported} skill${result.imported !== 1 ? 's' : ''} from Cursor${result.skipped ? `, ${result.skipped} skipped (already installed)` : ''}.`)
			} else if (result.skipped > 0) {
				notificationService.info(`All ${result.skipped} Cursor skill${result.skipped !== 1 ? 's' : ''} are already installed.`)
			} else {
				notificationService.info(result.errors[0] ?? 'No Cursor skills found to import.')
			}
		} catch (err) {
			notificationService.notify({ message: 'Failed to import skills from Cursor', source: err + '', severity: Severity.Error })
		}
	}

	const handleCreateNewSkill = async () => {
		try {
			const name = await skillImportService.createNewSkill()
			if (name) notificationService.info(`Created skill "${name}". Edit its SKILL.md to fill it in.`)
		} catch (err) {
			notificationService.notify({ message: 'Failed to create skill', source: err + '', severity: Severity.Error })
		}
	}

	const handleDeleteSkill = async (skill: SkillDefinition) => {
		try {
			const ok = await skillImportService.deleteSkill(skill.filePath)
			if (!ok) notificationService.info(`Could not delete "${skill.name}".`)
		} catch (err) {
			notificationService.notify({ message: `Failed to delete skill "${skill.name}"`, source: err + '', severity: Severity.Error })
		}
	}

	const handleOpenSkill = (skill: SkillDefinition) => {
		if (!skill.filePath) return
		commandService.executeCommand('vscode.open', URI.file(skill.filePath))
	}

	const handleToggleSkill = (name: string, enabled: boolean) => {
		const current = voidSettingsService.state.globalSettings.disabledSkills ?? []
		const disabled = enabled
			? current.filter((n: string) => n !== name)
			// Dedup so rapid toggles against stale state can't persist duplicate names.
			: Array.from(new Set([...current, name]))
		voidSettingsService.setGlobalSetting('disabledSkills', disabled)
	}

	const onDownload = (t: 'Chats' | 'Settings') => {
		let dataStr: string
		let downloadName: string
		if (t === 'Chats') {
			// Export chat threads
			dataStr = JSON.stringify(chatThreadsService.state, null, 2)
			downloadName = 'void-chats.json'
		}
		else if (t === 'Settings') {
			// Export user settings
			dataStr = JSON.stringify(voidSettingsService.state, null, 2)
			downloadName = 'void-settings.json'
		}
		else {
			dataStr = ''
			downloadName = ''
		}

		const blob = new Blob([dataStr], { type: 'application/json' })
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = downloadName
		a.click()
		URL.revokeObjectURL(url)
	}


	// Add file input refs
	const fileInputSettingsRef = useRef<HTMLInputElement>(null)
	const fileInputChatsRef = useRef<HTMLInputElement>(null)

	const [s, ss] = useState(0)

	const handleUpload = (t: 'Chats' | 'Settings') => (e: React.ChangeEvent<HTMLInputElement>,) => {
		const files = e.target.files
		if (!files) return;
		const file = files[0]
		if (!file) return

		const reader = new FileReader();
		reader.onload = async () => {
			try {
				const json = JSON.parse(reader.result as string);

				if (t === 'Chats') {
					await chatThreadsService.dangerousSetState(json as any)
				}
				else if (t === 'Settings') {
					await voidSettingsService.dangerousSetState(json as any)
				}

				notificationService.info(`${t} imported successfully!`)
			} catch (err) {
				notificationService.notify({ message: `Failed to import ${t}`, source: err + '', severity: Severity.Error, })
			}
		};
		reader.readAsText(file);
		e.target.value = '';

		ss(s => s + 1)
	}


	return (
		<div className={`@@void-scope ${isDark ? 'dark' : ''}`} style={{ height: '100%', width: '100%' }}>
			<div className="@@settings-shell">
				<aside className="@@settings-sidebar">
					<nav className="@@settings-sidebar-inner" aria-label="Settings sections">
						{navItems.map(({ tab, label, icon }) => (
							<button
								key={tab}
								type="button"
								onClick={() => {
									if (tab === 'all') {
										setSelectedSection('all');
									} else {
										setSelectedSection(tab);
									}
								}}
								className={`@@settings-nav-item${selectedSection === tab ? ' @@settings-nav-item--active' : ''}`}
							>
								<span className="@@settings-nav-icon">
									{icon}
								</span>
								<span className="truncate">{label}</span>
							</button>
						))}
					</nav>
				</aside>

			<main className="@@settings-main">
				<div className="@@settings-content">

				<div className='@@settings-section-gap'>
					{/* Models section (formerly FeaturesTab) */}
					<div className={shouldShowTab('models') ? `` : 'hidden'}>
						<ErrorBoundary>
							<SettingsPageHeader title='Models' />
							<ModelDump />
							<hr className='@@settings-divider my-5' />
							<AutoDetectLocalModelsToggle />
							<RefreshableModels />
						</ErrorBoundary>
					</div>

					{/* Providers section */}
					<div className={shouldShowTab('providers') ? `` : 'hidden'}>
						<ErrorBoundary>
							<ProvidersSection />
						</ErrorBoundary>
					</div>

					{/* Feature Options section */}
					<div className={shouldShowTab('featureOptions') ? `` : 'hidden'}>
						<ErrorBoundary>
							<SettingsPageHeader title='Feature Options' />

									<div className='my-4'>
										{/* AI Features Section */}
										<ErrorBoundary>
											<SettingsSection title="AI Features">
												<SettingsCell
													label={displayInfoOfFeatureName('Autocomplete')}
													description={
														<>
															<span>Experimental. </span>
															<span
																className='hover:brightness-110'
																data-tooltip-id='void-tooltip'
																data-tooltip-content='We recommend using the largest qwen2.5-coder model you can with Ollama (try qwen2.5-coder:3b).'
																data-tooltip-class-name='void-max-w-[20px]'
															>
																Only works with FIM models.*
															</span>
														</>
													}
													badge="Experimental"
												>
													<VoidSwitch
														size='xs'
														value={settingsState.globalSettings.enableAutocomplete}
														onChange={(newVal) => voidSettingsService.setGlobalSetting('enableAutocomplete', newVal)}
													/>
												</SettingsCell>

												{settingsState.globalSettings.enableAutocomplete && (
													<div className='@@settings-nested'>
														<div className='@@settings-nested-row'>
															<span className='@@settings-nested-label'>Model</span>
															<ModelDropdown featureName={'Autocomplete'} className='text-xs text-void-fg-3 bg-void-bg-1 border border-void-border-1 rounded p-0.5 px-1' />
														</div>
													</div>
												)}

												<SettingsCell
													label={displayInfoOfFeatureName('Apply')}
													description="Sync Apply feature to use the same model as Chat"
													showDivider
												>
													<VoidSwitch
														size='xs'
														value={settingsState.globalSettings.syncApplyToChat}
														onChange={(newVal) => voidSettingsService.setGlobalSetting('syncApplyToChat', newVal)}
													/>
												</SettingsCell>

												{!settingsState.globalSettings.syncApplyToChat && (
													<div className='@@settings-nested'>
														<div className='@@settings-nested-row'>
															<span className='@@settings-nested-label'>Model</span>
															<ModelDropdown featureName={'Apply'} className='text-xs text-void-fg-3 bg-void-bg-1 border border-void-border-1 rounded p-0.5 px-1' />
														</div>
													</div>
												)}

												<SettingsCell
													label="Fast Apply Method"
													description="Choose how the Fast Apply feature works"
													showDivider
												>
													<FastApplyMethodDropdown />
												</SettingsCell>
											</SettingsSection>
										</ErrorBoundary>

										{/* Tools Section */}
										<ErrorBoundary>
											<SettingsSection title="Tools">
												{[...toolApprovalTypes].map((approvalType, index) => {
													const getApprovalLabel = (type: ToolApprovalType) => {
														switch(type) {
															case 'edits': return 'Auto-approve Code Edits';
															case 'terminal': return 'Auto-approve Terminal Commands';
															case 'MCP tools': return 'Auto-approve MCP Tools';
															default: return `Auto-approve ${type}`;
														}
													};

													const getApprovalDescription = (type: ToolApprovalType) => {
														switch(type) {
															case 'edits': return 'Allow the AI to make code changes without confirmation';
															case 'terminal': return 'Allow the AI to run terminal commands without confirmation';
															case 'MCP tools': return 'Allow the AI to use MCP tools without confirmation';
															default: return `Automatically approve ${type} actions`;
														}
													};

													return (
														<ErrorBoundary key={approvalType}>
															<SettingsCell
																label={getApprovalLabel(approvalType)}
																description={getApprovalDescription(approvalType)}
																showDivider={index > 0}
															>
																<VoidSwitch
																	size='xs'
																	value={settingsState.globalSettings.autoApprove[approvalType] ?? false}
																	onChange={(newVal) => {
																		voidSettingsService.setGlobalSetting('autoApprove', {
																			...settingsState.globalSettings.autoApprove,
																			[approvalType]: newVal
																		});
																	}}
																/>
															</SettingsCell>
														</ErrorBoundary>
													);
												})}

												<SettingsCell
													label="Fix Lint Errors"
													description="Automatically fix lint errors in tool outputs"
													showDivider
												>
													<VoidSwitch
														size='xs'
														value={settingsState.globalSettings.includeToolLintErrors}
														onChange={(newVal) => voidSettingsService.setGlobalSetting('includeToolLintErrors', newVal)}
													/>
												</SettingsCell>

												<SettingsCell
													label="Auto-accept LLM Changes"
													description="Automatically accept changes made by the LLM without confirmation"
													showDivider
												>
													<VoidSwitch
														size='xs'
														value={settingsState.globalSettings.autoAcceptLLMChanges}
														onChange={(newVal) => voidSettingsService.setGlobalSetting('autoAcceptLLMChanges', newVal)}
													/>
												</SettingsCell>

												</SettingsSection>
										</ErrorBoundary>

										{/* Editor Section */}
										<ErrorBoundary>
											<SettingsSection title="Editor">
												<SettingsCell
													label="Show Inline Suggestions"
													description="Display Orbit suggestions in the code editor when text is selected"
												>
													<VoidSwitch
														size='xs'
														value={settingsState.globalSettings.showInlineSuggestions}
														onChange={(newVal) => voidSettingsService.setGlobalSetting('showInlineSuggestions', newVal)}
													/>
												</SettingsCell>
											</SettingsSection>
										</ErrorBoundary>

										{/* Notifications Section */}
										<ErrorBoundary>
											<SettingsSection title="Notifications">
												<SettingsCell
													label="Agent Completion Sound"
													description="Play sound when agent completes task"
												>
													<VoidSwitch
														size='xs'
														value={settingsState.globalSettings.enableAgentCompletionSound}
														onChange={(newVal) => voidSettingsService.setGlobalSetting('enableAgentCompletionSound', newVal)}
													/>
												</SettingsCell>

												<SettingsCell
													label="Agent Completion Notification"
													description="Show notification when agent completes task"
													showDivider
												>
													<VoidSwitch
														size='xs'
														value={settingsState.globalSettings.enableAgentCompletionNotification}
														onChange={(newVal) => voidSettingsService.setGlobalSetting('enableAgentCompletionNotification', newVal)}
													/>
												</SettingsCell>
											</SettingsSection>
										</ErrorBoundary>

										{/* Version Control Section */}
										<ErrorBoundary>
											<SettingsSection title="Version Control">
												<SettingsCell
													label={displayInfoOfFeatureName('SCM')}
													description="Sync commit message generator to use the same model as Chat"
												>
													<VoidSwitch
														size='xs'
														value={settingsState.globalSettings.syncSCMToChat}
														onChange={(newVal) => voidSettingsService.setGlobalSetting('syncSCMToChat', newVal)}
													/>
												</SettingsCell>

												{!settingsState.globalSettings.syncSCMToChat && (
													<div className='@@settings-nested'>
														<div className='@@settings-nested-row'>
															<span className='@@settings-nested-label'>Model</span>
															<ModelDropdown featureName={'SCM'} className='text-xs text-void-fg-3 bg-void-bg-1 border border-void-border-1 rounded p-0.5 px-1' />
														</div>
													</div>
												)}
											</SettingsSection>
										</ErrorBoundary>
									</div>
								</ErrorBoundary>
							</div>

						{/* General section */}
						<div className={shouldShowTab('general') ? '' : 'hidden'}>
							<div className='@@settings-section-gap'>
								<ErrorBoundary>
									<SettingsPageHeader title='General' />
									<RedoOnboardingButton className='mb-2' />
								</ErrorBoundary>

							{/* One-Click Switch section */}
							<div>
								<ErrorBoundary>
									<SettingsPageHeader
										title='One-Click Switch'
										description='Transfer your editor settings into Orbit.'
									/>

									<div className='flex flex-col gap-2'>
										<OneClickSwitchButton className='w-48' fromEditor="VS Code" />
										<OneClickSwitchButton className='w-48' fromEditor="Cursor" />
										<OneClickSwitchButton className='w-48' fromEditor="Windsurf" />
									</div>
								</ErrorBoundary>
							</div>

							{/* Import/Export section */}
							<div>
								<SettingsPageHeader
									title='Import/Export'
									description="Transfer Orbit's settings and chats in and out of Orbit."
								/>
									<div className='flex flex-col gap-8'>
										{/* Settings Subcategory */}
										<div className='flex flex-col gap-2 max-w-48 w-full'>
											<input key={2 * s} ref={fileInputSettingsRef} type='file' accept='.json' className='hidden' onChange={handleUpload('Settings')} />
											<VoidButtonBgDarken className='px-4 py-1 w-full' onClick={() => { fileInputSettingsRef.current?.click() }}>
												Import Settings
											</VoidButtonBgDarken>
											<VoidButtonBgDarken className='px-4 py-1 w-full' onClick={() => onDownload('Settings')}>
												Export Settings
											</VoidButtonBgDarken>
											<ConfirmButton className='px-4 py-1 w-full' onConfirm={() => { voidSettingsService.resetState(); }}>
												Reset Settings
											</ConfirmButton>
										</div>

										{/* Chats Subcategory */}
										<div className='flex flex-col gap-2 max-w-48 w-full'>
											<input key={2 * s + 1} ref={fileInputChatsRef} type='file' accept='.json' className='hidden' onChange={handleUpload('Chats')} />
											<VoidButtonBgDarken className='px-4 py-1 w-full' onClick={() => { fileInputChatsRef.current?.click() }}>
												Import Chats
											</VoidButtonBgDarken>
											<VoidButtonBgDarken className='px-4 py-1 w-full' onClick={() => onDownload('Chats')}>
												Export Chats
											</VoidButtonBgDarken>
											<ConfirmButton className='px-4 py-1 w-full' onConfirm={() => { chatThreadsService.resetState(); }}>
												Reset Chats
											</ConfirmButton>
										</div>
									</div>
								</div>



							{/* Built-in Settings section */}
							<div>
								<SettingsPageHeader
									title='Built-in Settings'
									description='IDE settings, keyboard settings, and theme customization.'
								/>

									<ErrorBoundary>
										<div className='flex flex-col gap-2 justify-center max-w-48 w-full'>
											<VoidButtonBgDarken className='px-4 py-1' onClick={() => { commandService.executeCommand('workbench.action.openSettings') }}>
												General Settings
											</VoidButtonBgDarken>
											<VoidButtonBgDarken className='px-4 py-1' onClick={() => { commandService.executeCommand('workbench.action.openGlobalKeybindings') }}>
												Keyboard Settings
											</VoidButtonBgDarken>
											<VoidButtonBgDarken className='px-4 py-1' onClick={() => { commandService.executeCommand('workbench.action.selectTheme') }}>
												Theme Settings
											</VoidButtonBgDarken>
											<VoidButtonBgDarken className='px-4 py-1' onClick={() => { nativeHostService.showItemInFolder(environmentService.logsHome.fsPath) }}>
												Open Logs
											</VoidButtonBgDarken>
										</div>
									</ErrorBoundary>
								</div>


							{/* Metrics section */}
							<div className='max-w-[600px]'>
								<SettingsPageHeader
									title='Metrics'
									description='Very basic anonymous usage tracking helps us keep Orbit running smoothly. You may opt out below. Regardless of this setting, Orbit never sees your code, messages, or API keys.'
								/>

									<div className='my-2'>
										{/* Disable All Metrics Switch */}
										<ErrorBoundary>
											<div className='flex items-center gap-x-2 my-2'>
												<VoidSwitch
													size='xs'
													value={isOptedOut}
													onChange={(newVal) => {
														storageService.store(OPT_OUT_KEY, newVal, StorageScope.APPLICATION, StorageTarget.MACHINE)
														metricsService.capture(`Set metrics opt-out to ${newVal}`, {}) // this only fires if it's enabled, so it's fine to have here
													}}
												/>
												<span className='text-void-fg-3 text-xs pointer-events-none'>{'Opt-out (requires restart)'}</span>
											</div>
										</ErrorBoundary>
									</div>
								</div>

							{/* AI Instructions section */}
							<div className='max-w-[600px]'>
								<SettingsPageHeader
									title='AI Instructions'
									description={
										<ChatMarkdownRender inPTag={true} string={`
System instructions to include with all AI requests.
Alternatively, place a \`.orbitrules\` file in the root of your workspace.
					`} chatMessageLocation={undefined} />
									}
								/>
									<ErrorBoundary>
										<AIInstructionsBox />
									</ErrorBoundary>
									{/* --- Disable System Message Toggle --- */}
									<div className='my-4'>
										<ErrorBoundary>
											<div className='flex items-center gap-x-2'>
												<VoidSwitch
													size='xs'
													value={!!settingsState.globalSettings.disableSystemMessage}
													onChange={(newValue) => {
														voidSettingsService.setGlobalSetting('disableSystemMessage', newValue);
													}}
												/>
												<span className='text-void-fg-3 text-xs pointer-events-none'>
													{'Disable system message'}
												</span>
											</div>
										</ErrorBoundary>
										<div className='text-void-fg-3 text-xs mt-1'>
											{`When disabled, Orbit will not include anything in the system message except for content you specified above.`}
										</div>
									</div>
								</div>

							</div>
						</div>

					{/* MCP section */}
					<div className={shouldShowTab('mcp') ? `` : 'hidden'}>
						<ErrorBoundary>
							<SettingsPageHeader
								title='MCP'
								description={
									<ChatMarkdownRender inPTag={true} string={`
Use Model Context Protocol to provide Agent mode with more tools.
					`} chatMessageLocation={undefined} />
								}
							/>
									<div className='my-2'>
										<VoidButtonBgDarken className='px-4 py-1 w-full max-w-48' onClick={async () => { await mcpService.revealMCPConfigFile() }}>
											Add MCP Server
										</VoidButtonBgDarken>
									</div>

									<ErrorBoundary>
										<MCPServersList />
									</ErrorBoundary>
								</ErrorBoundary>
							</div>

							{/* ---------------- SKILLS ---------------- */}
							<div className={shouldShowTab('skills') ? '' : 'hidden'}>
								<ErrorBoundary>
									<div className='flex flex-wrap items-start justify-between gap-x-4 gap-y-3 mb-4'>
										<div className='min-w-0 flex-1 basis-64'>
											<h2 className='text-void-fg-1 text-base font-semibold'>Skills</h2>
											<p className='text-void-fg-2 text-xs leading-relaxed mt-1 max-w-xl'>
												Skills give the agent reusable, on-demand knowledge. The agent loads a skill when a task matches its description, or you can trigger it manually. Import your own skills from Cursor, or create a new one.
											</p>
										</div>
										<div className='flex items-center gap-2 flex-shrink-0'>
											<VoidButtonBgDarken className='px-3 py-1 whitespace-nowrap' onClick={handleImportFromCursor}>
												<Download className='w-3.5 h-3.5 mr-1 inline' /> Import from Cursor
											</VoidButtonBgDarken>
											<VoidButtonBgDarken className='px-3 py-1 whitespace-nowrap' onClick={handleCreateNewSkill}>
												<Plus className='w-3.5 h-3.5 mr-1 inline' /> New
											</VoidButtonBgDarken>
										</div>
									</div>
									<ErrorBoundary>
										<SkillsListView skills={skills} onOpen={handleOpenSkill} onToggle={handleToggleSkill} onDelete={handleDeleteSkill} />
									</ErrorBoundary>
								</ErrorBoundary>
							</div>

						</div>

					</div>
				</main>
			</div>
		</div>
	);
}
