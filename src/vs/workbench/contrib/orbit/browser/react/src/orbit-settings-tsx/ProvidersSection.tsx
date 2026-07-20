/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Eye, EyeOff, RefreshCw } from 'lucide-react'
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js'
import { VoidButtonBgDarken, VoidSimpleInputBox } from '../util/inputs.js'
import { useAccessor, useOpenAiCodexAuthState, useOrbitProviderAuthState, useSettingsState, useXAiGrokAuthState } from '../util/services.js'
import { ChatMarkdownRender } from '../markdown/ChatMarkdownRender.js'
import { WarningBox } from './WarningBox.js'
import { isWindows } from '../../../../../../../base/common/platform.js'
import type { XAiGrokUsage } from '../../../../common/xAiGrokAuthService.js'
import {
	ProviderName,
	SettingName,
	customSettingNamesOfProvider,
	displayInfoOfProviderName,
	displayInfoOfSettingName,
	isProviderNameDisabled,
	localProviderNames,
	nonlocalProviderNames,
	subTextMdOfProviderName,
} from '../../../../common/orbitSettingsTypes.js'
import {
	VOID_OPENAI_CODEX_SIGN_IN_ACTION_ID,
	VOID_OPENAI_CODEX_SIGN_OUT_ACTION_ID,
	VOID_XAI_GROK_DEVICE_SIGN_IN_ACTION_ID,
	VOID_XAI_GROK_SIGN_IN_ACTION_ID,
	VOID_XAI_GROK_SIGN_OUT_ACTION_ID,
} from '../../../actionIDs.js'
import { OrbitAuthPanel } from './OrbitAuthPanel.js'

const cloudProviderNames: ProviderName[] = [...nonlocalProviderNames]

type ProviderSectionGroup = {
	id: string
	title: string
	description?: React.ReactNode
	providerNames: readonly ProviderName[]
	footer?: React.ReactNode
}

const providerStatusLabel = (
	providerName: ProviderName,
	isConfigured: boolean,
	codexAuthenticated: boolean,
	xAiAuthenticated: boolean,
	orbitAuthenticated: boolean,
): string => {
	if (providerName === 'orbit') {
		return orbitAuthenticated ? 'Connected' : 'Not connected'
	}
	if (providerName === 'openAICodex') {
		return codexAuthenticated ? 'Connected' : 'Not connected'
	}
	if (providerName === 'xAISuperGrok') {
		return xAiAuthenticated ? 'Connected' : 'Not connected'
	}
	return isConfigured ? 'Configured' : 'Not configured'
}

const providerSubtitle = (providerName: ProviderName): string => {
	if (providerName === 'orbit') {
		return 'GitHub sign-in · managed by Orbit Provider'
	}
	if (providerName === 'openAICodex') {
		return 'ChatGPT Plus or Pro subscription'
	}
	if (providerName === 'xAISuperGrok') {
		return 'SuperGrok or eligible X Premium subscription'
	}
	if ((localProviderNames as readonly string[]).includes(providerName)) {
		return 'Local endpoint · auto-detected models'
	}
	if (providerName === 'openAICompatible') {
		return 'Any OpenAI-compatible API'
	}
	if (providerName === 'openRouter') {
		return 'Multi-model API gateway'
	}
	if (providerName === 'awsBedrock') {
		return 'AWS models via proxy or gateway'
	}
	if (providerName === 'googleVertex') {
		return 'Google Cloud Vertex AI'
	}
	if (providerName === 'microsoftAzure') {
		return 'Azure OpenAI Service'
	}
	return 'API key authentication'
}

const ProviderSetting = ({ providerName, settingName, subTextMd }: { providerName: ProviderName, settingName: SettingName, subTextMd: React.ReactNode }) => {
	const { title: settingTitle, placeholder, isPasswordField } = displayInfoOfSettingName(providerName, settingName)

	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const settingsState = useSettingsState()
	const [showValue, setShowValue] = useState(false)

	const rawSettingValue = settingsState.settingsOfProvider[providerName][settingName]
	const settingValue = typeof rawSettingValue === 'string' ? rawSettingValue : ''

	// Hooks must run unconditionally — compute the invalid case as a flag and bail AFTER the hooks
	// below (the previous early-return-before-useCallback broke the rules of hooks).
	const isInvalidValue = typeof rawSettingValue !== 'string'

	const handleChangeValue = useCallback((newVal: string) => {
		// Trim leading/trailing whitespace on API keys/endpoints — a pasted key with a trailing
		// newline is the single most common cause of confusing "invalid key" auth failures.
		const cleaned = isPasswordField ? newVal.replace(/^\s+|\s+$/g, '') : newVal
		voidSettingsService.setSettingOfProvider(providerName, settingName, cleaned)
	}, [voidSettingsService, providerName, settingName, isPasswordField])

	if (isInvalidValue) {
		console.log('Error: Provider setting had a non-string value.')
		return null
	}

	// Warn about interior whitespace (another common paste artifact) without mutating the value.
	const hasInteriorWhitespace = isPasswordField && /\S\s+\S/.test(settingValue)

	// Custom Headers must be a JSON object — surface bad JSON at save time instead of failing at
	// request time. Non-blocking hint; the value is still persisted (the runtime guard handles it).
	const hasInvalidHeadersJson = settingName === 'headersJSON' && settingValue.trim().length > 0 && (() => {
		try {
			const parsed = JSON.parse(settingValue)
			return typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
		} catch {
			return true
		}
	})()

	return (
		<ErrorBoundary>
			<div className='@@provider-field'>
				<div className="relative">
					<VoidSimpleInputBox
						value={settingValue}
						onChangeValue={handleChangeValue}
						placeholder={`${settingTitle} (${placeholder})`}
						passwordBlur={isPasswordField && !showValue}
						compact={true}
						className="pr-10"
						style={{
							background: 'var(--void-bg-3)',
							borderColor: 'var(--void-border-2)',
						}}
					/>
					{isPasswordField && settingValue && (
						<button
							onClick={() => setShowValue(!showValue)}
							className="absolute right-3 top-1/2 -translate-y-1/2 text-void-fg-3 hover:text-void-fg-2 transition-colors"
							type="button"
						>
							{showValue ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
						</button>
					)}
				</div>
				{hasInteriorWhitespace ? (
					<div className='@@provider-field-hint' style={{ color: 'var(--vscode-editorWarning-foreground, #cca700)' }}>
						This value contains spaces — double-check it was pasted correctly.
					</div>
				) : null}
				{hasInvalidHeadersJson ? (
					<div className='@@provider-field-hint' style={{ color: 'var(--vscode-editorError-foreground, #f14c4c)' }}>
						Custom Headers must be a JSON object, e.g. {`{ "X-Request-Id": "..." }`}
					</div>
				) : null}
				{subTextMd ? (
					<div className='@@provider-field-hint'>
						{subTextMd}
					</div>
				) : null}
			</div>
		</ErrorBoundary>
	)
}

const OpenAICodexProviderPanel = () => {
	const authState = useOpenAiCodexAuthState()
	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')

	return (
		<div className='@@provider-auth-panel'>
			<p className='@@provider-auth-desc'>
				Use your ChatGPT Plus or Pro subscription. No API key needed.
			</p>
			{authState.isAuthenticated ? (
				<div className='@@provider-auth-row'>
					<span className='@@settings-profile-name'>{authState.email ?? 'Signed in'}</span>
					<VoidButtonBgDarken
						className='px-3 py-1 text-xs shrink-0'
						onClick={() => commandService.executeCommand(VOID_OPENAI_CODEX_SIGN_OUT_ACTION_ID)}
					>
						Sign out
					</VoidButtonBgDarken>
				</div>
			) : (
				<VoidButtonBgDarken
					className='w-full px-3 py-1.5 text-xs'
					onClick={() => commandService.executeCommand(VOID_OPENAI_CODEX_SIGN_IN_ACTION_ID)}
				>
					Sign in
				</VoidButtonBgDarken>
			)}
		</div>
	)
}

const XAiSuperGrokProviderPanel = () => {
	const authState = useXAiGrokAuthState()
	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const authService = accessor.get('IXAiGrokAuthService')
	const [usage, setUsage] = useState<XAiGrokUsage>()
	const [usageError, setUsageError] = useState<string>()
	const [isLoadingUsage, setIsLoadingUsage] = useState(false)
	const usageRequest = useRef(0)

	const loadUsage = useCallback(async (forceRefresh = false) => {
		const request = ++usageRequest.current
		setIsLoadingUsage(true)
		setUsageError(undefined)
		try {
			const nextUsage = await authService.getUsage(forceRefresh)
			if (request === usageRequest.current) setUsage(nextUsage)
		} catch (error) {
			if (request === usageRequest.current) {
				setUsage(undefined)
				setUsageError(error instanceof Error ? error.message : 'Subscription usage is unavailable.')
			}
		} finally {
			if (request === usageRequest.current) setIsLoadingUsage(false)
		}
	}, [authService])

	useEffect(() => {
		if (!authState.isAuthenticated) {
			usageRequest.current++
			setUsage(undefined)
			setUsageError(undefined)
			setIsLoadingUsage(false)
			return
		}
		void loadUsage()
	}, [authState.isAuthenticated, loadUsage])

	const formatReset = (value: string) => {
		const date = new Date(value)
		if (!Number.isFinite(date.getTime())) return undefined
		return date.toLocaleString(undefined, {
			month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
		})
	}
	const monthlyPercent = usage
		? Math.min(100, Math.max(0, Math.round((usage.monthly.used / usage.monthly.limit) * 100)))
		: 0
	const weeklyPercent = usage?.weekly
		? Math.min(100, Math.max(0, Math.round(usage.weekly.usedPercent)))
		: 0
	const monthlyReset = usage ? formatReset(usage.monthly.resetsAt) : undefined
	const weeklyReset = usage?.weekly ? formatReset(usage.weekly.resetsAt) : undefined

	return (
		<div className='@@provider-auth-panel'>
			<p className='@@provider-auth-desc'>
				Use Composer 2.5 and Grok 4.5 through your SuperGrok or X Premium subscription. No xAI API key needed.
			</p>
			{authState.isAuthenticated ? (
				<div className='flex flex-col gap-3'>
					<div className='@@provider-auth-row'>
						<span className='@@settings-profile-name'>{authState.email ?? 'SuperGrok connected'}</span>
						<VoidButtonBgDarken
							className='px-3 py-1 text-xs shrink-0'
							disabled={authState.isAuthorizing}
							onClick={() => commandService.executeCommand(VOID_XAI_GROK_SIGN_OUT_ACTION_ID)}
						>
							Sign out
						</VoidButtonBgDarken>
					</div>
					<div className='@@provider-usage' aria-live='polite'>
						<div className='@@provider-usage-heading'>
							<span>Subscription usage</span>
							<button
								type='button'
								className='@@provider-usage-refresh'
								disabled={isLoadingUsage}
								onClick={() => void loadUsage(true)}
								aria-label='Refresh SuperGrok usage'
								title='Refresh usage'
							>
								<RefreshCw size={13} className={isLoadingUsage ? 'animate-spin' : undefined} />
							</button>
						</div>
						{usage ? (
							<>
								<div className='@@provider-usage-row'>
									<span>Monthly credits</span>
									<strong>{usage.monthly.used.toLocaleString()} / {usage.monthly.limit.toLocaleString()} · {monthlyPercent}%</strong>
								</div>
								<div className='@@provider-usage-track' aria-hidden='true'>
									<span style={{ width: `${monthlyPercent}%` }} />
								</div>
								<div className='@@provider-usage-reset'>{monthlyReset ? `Resets ${monthlyReset}` : 'Reset time unavailable'}</div>
								{usage.weekly && (
									<div className='@@provider-usage-row @@provider-usage-row--weekly'>
										<span>Weekly limit</span>
										<strong>{weeklyPercent}% used · {weeklyReset ? `resets ${weeklyReset}` : 'reset time unavailable'}</strong>
									</div>
								)}
							</>
						) : (
							<div className='@@provider-usage-status'>
								{isLoadingUsage ? 'Loading usage…' : usageError ?? 'Usage data is unavailable for this plan.'}
							</div>
						)}
					</div>
				</div>
	) : (
			<div className='flex flex-col gap-2'>
				{isWindows && (
					<p className='@@provider-auth-desc'>
						On Windows, browser sign-in can be blocked by Windows Firewall or a port reserved by Hyper-V / WSL. If it doesn't complete, use the device-code option below.
					</p>
				)}
				<VoidButtonBgDarken
					className='w-full px-3 py-1.5 text-xs'
					disabled={authState.isAuthorizing}
					onClick={() => commandService.executeCommand(VOID_XAI_GROK_SIGN_IN_ACTION_ID)}
				>
					{authState.isAuthorizing ? 'Waiting for xAI…' : 'Sign in with browser'}
				</VoidButtonBgDarken>
				<VoidButtonBgDarken
					className='w-full px-3 py-1.5 text-xs'
					disabled={authState.isAuthorizing}
					onClick={() => commandService.executeCommand(VOID_XAI_GROK_DEVICE_SIGN_IN_ACTION_ID)}
				>
					Use a device code {isWindows ? '(recommended on Windows)' : ''}
				</VoidButtonBgDarken>
			</div>
		)}
		</div>
	)
}

const ProviderAccordionPanel = ({ providerName }: { providerName: ProviderName }) => {
	const voidSettingsState = useSettingsState()
	const needsModel = isProviderNameDisabled(providerName, voidSettingsState) === 'addModel'
	const settingNames = customSettingNamesOfProvider(providerName)
	const { title: providerTitle } = displayInfoOfProviderName(providerName)

	if (providerName === 'openAICodex') {
		return <OpenAICodexProviderPanel />
	}
	if (providerName === 'orbit') {
		return <OrbitAuthPanel />
	}
	if (providerName === 'xAISuperGrok') {
		return <XAiSuperGrokProviderPanel />
	}

	return (
		<div className='@@provider-panel-fields'>
			{settingNames.map((settingName, i) => (
				<ProviderSetting
					key={settingName}
					providerName={providerName}
					settingName={settingName}
					subTextMd={i !== settingNames.length - 1 ? null
						: <ChatMarkdownRender string={subTextMdOfProviderName(providerName)} chatMessageLocation={undefined} />}
				/>
			))}
			{needsModel && (
				<div className="mt-2">
					{providerName === 'ollama' ? (
						<WarningBox className="pl-0" text={`Please install an Ollama model. We'll auto-detect it.`} />
					) : (
						<WarningBox className="pl-0" text={`Please add a model for ${providerTitle} (Models section).`} />
					)}
				</div>
			)}
		</div>
	)
}

const ProviderAccordionItem = ({
	providerName,
	isOpen,
	onToggle,
}: {
	providerName: ProviderName
	isOpen: boolean
	onToggle: () => void
}) => {
	const voidSettingsState = useSettingsState()
	const authState = useOpenAiCodexAuthState()
	const xAiAuthState = useXAiGrokAuthState()
	const orbitAuthState = useOrbitProviderAuthState()

	const { title: providerTitle } = displayInfoOfProviderName(providerName)
	const isConfigured = voidSettingsState.settingsOfProvider[providerName]._didFillInProviderSettings
	const isConnected = providerName === 'orbit'
		? orbitAuthState.isAuthenticated
		: providerName === 'openAICodex'
		? authState.isAuthenticated
		: providerName === 'xAISuperGrok'
			? xAiAuthState.isAuthenticated
		: !!isConfigured

	const statusLabel = providerStatusLabel(providerName, !!isConfigured, authState.isAuthenticated, xAiAuthState.isAuthenticated, orbitAuthState.isAuthenticated)

	return (
		<div className={`@@provider-accordion${isOpen ? ' @@provider-accordion--open' : ''}${isConnected && providerName !== 'orbit' ? ' @@provider-accordion--connected' : ''}`}>
			<button
				type="button"
				className="@@provider-accordion-trigger"
				onClick={onToggle}
				aria-expanded={isOpen}
			>
				<div className="@@provider-accordion-leading">
					<div className="@@provider-accordion-title">{providerTitle}</div>
					<div className="@@provider-accordion-subtitle">{providerSubtitle(providerName)}</div>
				</div>
				{providerName !== 'orbit' ? (
					<div className={`@@provider-accordion-status${isConnected ? ' @@provider-accordion-status--connected' : ''}`}>
						<span className="@@provider-accordion-status-dot" aria-hidden="true" />
						<span className="@@provider-accordion-status-label">{statusLabel}</span>
					</div>
				) : null}
				<ChevronDown className="@@provider-accordion-chevron" size={14} aria-hidden="true" />
			</button>
			{isOpen && (
				<div className="@@provider-accordion-panel">
					<ProviderAccordionPanel providerName={providerName} />
				</div>
			)}
		</div>
	)
}

const ProviderAccordionList = ({
	providerNames,
	expanded,
	onToggle,
}: {
	providerNames: readonly ProviderName[]
	expanded: Set<ProviderName>
	onToggle: (providerName: ProviderName) => void
}) => (
	<div className="@@provider-accordion-list">
		{providerNames.map((providerName) => (
			<ProviderAccordionItem
				key={providerName}
				providerName={providerName}
				isOpen={expanded.has(providerName)}
				onToggle={() => onToggle(providerName)}
			/>
		))}
	</div>
)

const LocalSetupCollapsible = () => {
	const [open, setOpen] = useState(false)

	return (
		<div className="@@provider-local-setup">
			<button
				type="button"
				className="@@provider-local-setup-trigger"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
			>
				<span>Local setup guide</span>
				<ChevronDown className={`@@provider-local-setup-chevron${open ? ' @@provider-local-setup-chevron--open' : ''}`} size={14} />
			</button>
			{open && (
				<div className="@@provider-local-setup-panel">
					<div className='prose-p:my-0 prose-ol:list-decimal prose-p:py-0 prose-ol:my-0 prose-ol:py-0 prose-span:my-0 prose-span:py-0 text-void-fg-3 text-sm list-decimal select-text'>
						<div><ChatMarkdownRender string={`Ollama Setup Instructions`} chatMessageLocation={undefined} /></div>
						<div className='pl-6'><ChatMarkdownRender string={`1. Download [Ollama](https://ollama.com/download).`} chatMessageLocation={undefined} /></div>
						<div className='pl-6'><ChatMarkdownRender string={`2. Open your terminal.`} chatMessageLocation={undefined} /></div>
						<div className='pl-6'><ChatMarkdownRender string={`3. Run \`ollama pull your_model\` to install a model.`} chatMessageLocation={undefined} /></div>
						<div className='pl-6'><ChatMarkdownRender string={`Orbit automatically detects locally running models and enables them.`} chatMessageLocation={undefined} /></div>
					</div>
				</div>
			)}
		</div>
	)
}

const OrbitProviderFeaturedSection = ({
	expanded,
	onToggle,
}: {
	expanded: Set<ProviderName>
	onToggle: (providerName: ProviderName) => void
}) => {
	const orbitAuthState = useOrbitProviderAuthState()
	const isOpen = expanded.has('orbit')

	return (
		<section className="@@provider-orbit-featured">
			<div className="@@provider-orbit-featured-header">
				<div className="@@provider-orbit-featured-heading">
					<h3 className="@@provider-orbit-featured-title">Orbit Provider</h3>
					<p className="@@provider-orbit-featured-desc">
						Sign in with GitHub to use managed models. No API key required — manage billing and usage from your account page.
					</p>
				</div>
				<div className={`@@provider-orbit-featured-status${orbitAuthState.isAuthenticated ? ' @@provider-orbit-featured-status--connected' : ''}`}>
					<span className="@@provider-orbit-featured-status-dot" aria-hidden="true" />
					<span>{orbitAuthState.isAuthenticated ? 'Connected' : 'Not connected'}</span>
				</div>
			</div>
			<div className={`@@provider-orbit-featured-card${isOpen ? ' @@provider-orbit-featured-card--open' : ''}`}>
				<button
					type="button"
					className="@@provider-orbit-featured-trigger"
					onClick={() => onToggle('orbit')}
					aria-expanded={isOpen}
				>
					<div className="@@provider-orbit-featured-trigger-text">
						<span className="@@provider-orbit-featured-trigger-title">Account &amp; billing</span>
						<span className="@@provider-orbit-featured-trigger-subtitle">
							{orbitAuthState.isAuthenticated
								? 'Manage sign-in, wallet balance, and model refresh'
								: 'Connect GitHub to unlock Orbit Provider models'}
						</span>
					</div>
					<ChevronDown className="@@provider-orbit-featured-chevron" size={14} aria-hidden="true" />
				</button>
				{isOpen ? (
					<div className="@@provider-orbit-featured-panel">
						<OrbitAuthPanel />
					</div>
				) : null}
			</div>
		</section>
	)
}

const ProviderSectionGroup = ({
	title,
	description,
	providerNames,
	footer,
	expanded,
	onToggle,
}: ProviderSectionGroup & {
	expanded: Set<ProviderName>
	onToggle: (providerName: ProviderName) => void
}) => (
	<section className="@@provider-section">
		<div className="@@provider-section-header">
			<h3 className="@@provider-section-title">{title}</h3>
			{description ? <div className="@@provider-section-desc">{description}</div> : null}
		</div>
		{footer}
		<ProviderAccordionList providerNames={providerNames} expanded={expanded} onToggle={onToggle} />
	</section>
)

export const ProvidersSection = () => {
	const sections = useMemo<ProviderSectionGroup[]>(() => [
		{
			id: 'cloud',
			title: 'Bring your own provider',
			description: 'Connect ChatGPT, SuperGrok, and API keys from Anthropic, OpenAI, OpenRouter, and other hosted providers.',
			providerNames: cloudProviderNames,
		},
		{
			id: 'local',
			title: 'Local',
			description: 'Host models on your machine. Orbit auto-detects Ollama, vLLM, and LM Studio when running.',
			providerNames: localProviderNames,
			footer: <LocalSetupCollapsible />,
		},
	], [])

	const [expanded, setExpanded] = useState<Set<ProviderName>>(() => new Set(['orbit']))

	const toggleProvider = useCallback((providerName: ProviderName) => {
		setExpanded((prev) => {
			const next = new Set(prev)
			if (next.has(providerName)) {
				next.delete(providerName)
			} else {
				next.add(providerName)
			}
			return next
		})
	}, [])

	return (
		<>
			<div className='@@settings-page-header'>
				<h2 className='@@settings-page-title'>Providers</h2>
				<div className='@@settings-page-desc'>
					Connect Orbit Provider or bring your own API keys and local runtimes. Configure credentials here, then choose models on the Models tab.
				</div>
			</div>

			<div className="@@providers-sections">
				<OrbitProviderFeaturedSection expanded={expanded} onToggle={toggleProvider} />
				{sections.map((section) => (
					<ProviderSectionGroup
						key={section.id}
						title={section.title}
						description={section.description}
						providerNames={section.providerNames}
						footer={section.footer}
						expanded={expanded}
						onToggle={toggleProvider}
					/>
				))}
			</div>
		</>
	)
}
