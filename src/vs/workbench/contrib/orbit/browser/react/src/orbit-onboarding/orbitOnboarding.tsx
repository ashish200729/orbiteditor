/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccessor, useIsDark, useSettingsState } from '../util/services.js';
import { Check, ChevronRight } from 'lucide-react';
import { ColorScheme } from '../../../../../../../platform/theme/common/theme.js';
import { ConfigurationTarget } from '../../../../../../../platform/configuration/common/configuration.js';
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js';
import { isLinux } from '../../../../../../../base/common/platform.js';

const OVERRIDE_VALUE = false

export const VoidOnboarding = () => {
	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const voidSettingsState = useSettingsState()
	const [settingsReady, setSettingsReady] = useState(false)
	const isOnboardingComplete = voidSettingsState.globalSettings.isOnboardingComplete || OVERRIDE_VALUE
	const isDark = useIsDark()

	useEffect(() => {
		let disposed = false
		void voidSettingsService.waitForInitState.then(() => {
			if (!disposed) {
				setSettingsReady(true)
			}
		})
		return () => { disposed = true }
	}, [voidSettingsService])

	if (!settingsReady) {
		return null
	}

	return (
		<div className={`@@void-scope ${isDark ? 'dark' : ''}`}>
			<div
				className={`
					bg-void-bg-3 fixed top-0 right-0 bottom-0 left-0 width-full z-[99999]
					transition-all duration-1000 ${isOnboardingComplete ? 'opacity-0 pointer-events-none' : 'opacity-100 pointer-events-auto'}
				`}
				style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
			>
				<ErrorBoundary>
					<VoidOnboardingContent />
				</ErrorBoundary>
			</div>
		</div>
	)
}

const VoidIcon = () => {
	const accessor = useAccessor()
	const themeService = accessor.get('IThemeService')
	const divRef = useRef<HTMLDivElement | null>(null)

	useEffect(() => {
		const updateTheme = () => {
			const theme = themeService.getColorTheme().type
			const isDarkTheme = theme === ColorScheme.DARK || theme === ColorScheme.HIGH_CONTRAST_DARK
			if (divRef.current) {
				divRef.current.style.maxWidth = '220px'
				divRef.current.style.opacity = '50%'
				divRef.current.style.filter = isDarkTheme ? '' : 'invert(1)'
			}
		}
		updateTheme()
		const d = themeService.onDidColorThemeChange(updateTheme)
		return () => d.dispose()
	}, [themeService])

	return <div ref={divRef} className='@@orbit-orbit-icon' />
}

const FADE_DURATION_MS = 1200

const FadeIn = ({ children, className, delayMs = 0, durationMs, ...props }: {
	children: React.ReactNode
	delayMs?: number
	durationMs?: number
	className?: string
} & React.HTMLAttributes<HTMLDivElement>) => {
	const [opacity, setOpacity] = useState(0)
	const effectiveDurationMs = durationMs ?? FADE_DURATION_MS

	useEffect(() => {
		const timeout = setTimeout(() => setOpacity(1), delayMs)
		return () => clearTimeout(timeout)
	}, [delayMs])

	return (
		<div className={className} style={{ opacity, transition: `opacity ${effectiveDurationMs}ms ease-in-out` }} {...props}>
			{children}
		</div>
	)
}

// ─── Theme selection ───────────────────────────────────────────────────────────

type ThemeOption = {
	settingsId: string
	label: string
	description: string
	colors: { editor: string; sidebar: string; accent: string }
}

const ORBIT_DARK_THEME_ID = 'Orbit Dark'
const ORBIT_LIGHT_THEME_ID = 'Orbit Light'

const themeOptions: ThemeOption[] = [
	{
		settingsId: ORBIT_DARK_THEME_ID,
		label: 'Orbit Dark',
		description: 'Default — easy on the eyes',
		colors: { editor: '#181818', sidebar: '#141414', accent: '#0078D4' },
	},
	{
		settingsId: ORBIT_LIGHT_THEME_ID,
		label: 'Orbit Light',
		description: 'Clean and bright',
		colors: { editor: '#FAFAFA', sidebar: '#F5F5F5', accent: '#0078D4' },
	},
]

const ThemeSelectionPage = ({ pageIndex, setPageIndex }: { pageIndex: number; setPageIndex: (index: number) => void }) => {
	const accessor = useAccessor()
	const themeService = accessor.get('IWorkbenchThemeService')
	const [selectedTheme, setSelectedTheme] = useState<string>(ORBIT_DARK_THEME_ID)
	const didApplyDefault = useRef(false)

	const applyTheme = useCallback(async (settingsId: string) => {
		const previousSettingsId = themeService.getColorTheme().settingsId
		setSelectedTheme(settingsId)
		try {
			const themes = await themeService.getColorThemes()
			const selected = themes.find(theme => theme.settingsId === settingsId)
				?? themes.find(theme => theme.id === settingsId)
			if (!selected) {
				setSelectedTheme(previousSettingsId)
				return
			}
			const result = await themeService.setColorTheme(selected, ConfigurationTarget.USER)
			if (!result) {
				setSelectedTheme(previousSettingsId)
			}
		} catch {
			setSelectedTheme(previousSettingsId)
		}
	}, [themeService])

	useEffect(() => {
		if (didApplyDefault.current) {
			return
		}
		didApplyDefault.current = true
		const current = themeService.getColorTheme().settingsId
		const isOrbitTheme = themeOptions.some(t => t.settingsId === current)
		void applyTheme(isOrbitTheme ? current : ORBIT_DARK_THEME_ID)
	}, [themeService, applyTheme])

	useEffect(() => {
		const updateSelectedTheme = () => {
			const currentTheme = themeService.getColorTheme()
			if (themeOptions.some(t => t.settingsId === currentTheme.settingsId)) {
				setSelectedTheme(currentTheme.settingsId)
			}
		}
		updateSelectedTheme()
		const disposable = themeService.onDidColorThemeChange(() => updateSelectedTheme())
		return () => disposable.dispose()
	}, [themeService])

	return (
		<div className="h-[80vh] flex flex-col w-full max-w-[640px] mx-auto px-4">
			<div className="text-center mb-10">
				<FadeIn>
					<h1 className="text-3xl font-light text-void-fg-1 mb-2">Choose your theme</h1>
					<p className="text-void-fg-3 text-sm">Orbit Dark is selected by default</p>
				</FadeIn>
			</div>

			<FadeIn delayMs={150}>
				<div className="flex flex-col sm:flex-row gap-5 justify-center items-stretch mb-10">
					{themeOptions.map((theme) => (
						<button
							key={theme.settingsId}
							type="button"
							onClick={() => void applyTheme(theme.settingsId)}
							className={`void-theme-card flex-1 min-w-[180px] max-w-[260px] p-4 text-left ${selectedTheme === theme.settingsId ? 'selected' : ''}`}
							style={{ border: 'none', cursor: 'pointer' }}
						>
							<div
								className="void-theme-preview w-full aspect-[4/3] mb-4 relative rounded-md overflow-hidden"
								style={{ background: theme.colors.editor, display: 'flex' }}
							>
								<div style={{ width: '30%', height: '100%', background: theme.colors.sidebar, borderRight: '1px solid rgba(128,128,128,0.15)' }} />
								<div className="flex-1 p-3">
									<div style={{ width: '60%', height: '4px', background: theme.colors.accent, borderRadius: '2px', marginBottom: '8px' }} />
									<div style={{ width: '80%', height: '3px', background: theme.colors.editor === '#FAFAFA' ? '#E0E0E0' : '#404040', borderRadius: '2px', marginBottom: '6px', opacity: 0.5 }} />
									<div style={{ width: '50%', height: '3px', background: theme.colors.editor === '#FAFAFA' ? '#E0E0E0' : '#404040', borderRadius: '2px', opacity: 0.3 }} />
								</div>
								{selectedTheme === theme.settingsId && (
									<div className="void-theme-selected-indicator">
										<Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />
									</div>
								)}
							</div>
							<div className="text-center">
								<h3 className="text-void-fg-1 font-medium text-sm mb-1">{theme.label}</h3>
								<p className="text-void-fg-3 text-xs">{theme.description}</p>
							</div>
						</button>
					))}
				</div>
			</FadeIn>

			<FadeIn delayMs={300} className="mt-auto">
				<div className="flex items-center justify-center gap-4 pb-4">
					<PreviousButton onClick={() => setPageIndex(pageIndex - 1)} />
					<NextButton onClick={() => setPageIndex(pageIndex + 1)} />
				</div>
			</FadeIn>
		</div>
	)
}

// ─── Shared UI ─────────────────────────────────────────────────────────────────

const OnboardingPageShell = ({ content, hasMaxWidth = true, className = '' }: {
	content?: React.ReactNode
	hasMaxWidth?: boolean
	className?: string
}) => (
	<div className={`h-[80vh] flex flex-col w-full mx-auto ${hasMaxWidth ? 'max-w-[600px]' : ''} ${className}`}>
		{content && <FadeIn className="w-full my-auto">{content}</FadeIn>}
	</div>
)

const NextButton = ({ onClick, ...props }: { onClick: () => void } & React.ButtonHTMLAttributes<HTMLButtonElement>) => {
	const { disabled, ...buttonProps } = props
	return (
		<button
			onClick={disabled ? undefined : onClick}
			disabled={disabled}
			className="px-5 py-2 rounded text-sm font-medium flex items-center gap-2"
			style={{
				background: disabled ? 'var(--void-fg-3)' : 'var(--void-fg-1)',
				color: 'var(--void-bg-3)',
				opacity: disabled ? 0.3 : 1,
				cursor: disabled ? 'not-allowed' : 'pointer',
				border: 'none',
			}}
			{...buttonProps}
		>
			Continue
			<ChevronRight className="w-4 h-4" />
		</button>
	)
}

const PreviousButton = ({ onClick, ...props }: { onClick: () => void } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
	<button
		onClick={onClick}
		className="px-5 py-2 rounded text-sm"
		style={{ color: 'var(--void-fg-3)', background: 'transparent', border: 'none', cursor: 'pointer' }}
		onMouseEnter={(e) => {
			e.currentTarget.style.color = 'var(--void-fg-2)'
			e.currentTarget.style.background = 'var(--void-bg-2)'
		}}
		onMouseLeave={(e) => {
			e.currentTarget.style.color = 'var(--void-fg-3)'
			e.currentTarget.style.background = 'transparent'
		}}
		{...props}
	>
		Back
	</button>
)

const PrimaryActionButton = ({ children, ringSize, ...props }: {
	children: React.ReactNode
	ringSize?: 'screen'
} & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
	<button
		type="button"
		className={`
			flex items-center justify-center gap-2 px-10 py-3 rounded-lg
			text-white dark:text-black bg-black/90 dark:bg-white/90
			${ringSize === 'screen' ? 'transition-all duration-1000 ease-in-out' : 'transition-all duration-300 ease-in-out'}
			group
		`}
		{...props}
	>
		{children}
		<ChevronRight className="transition-transform duration-300 group-hover:translate-x-1" />
	</button>
)

// ─── Main flow ─────────────────────────────────────────────────────────────────

const VoidOnboardingContent = () => {
	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const voidMetricsService = accessor.get('IMetricsService')
	const voidSettingsState = useSettingsState()
	const [pageIndex, setPageIndex] = useState(0)

	useEffect(() => {
		if (!voidSettingsState.globalSettings.isOnboardingComplete) {
			setPageIndex(0)
		}
	}, [voidSettingsState.globalSettings.isOnboardingComplete])

	const completeOnboarding = () => {
		voidSettingsService.setGlobalSetting('isOnboardingComplete', true)
		voidMetricsService.capture('Completed Onboarding', { pageCount: 3 })
	}

	const contentOfIdx: Record<number, React.ReactNode> = {
		0: (
			<OnboardingPageShell
				content={
					<div className="flex flex-col items-center gap-8 px-4">
						<FadeIn>
							<h1 className="text-4xl font-light text-center text-void-fg-1">Welcome to Orbit</h1>
							<p className="text-void-fg-3 text-center text-sm mt-3 max-w-sm">
								An AI-native editor built for building software with agents.
							</p>
						</FadeIn>
						<div className="max-w-md w-full h-[24vh] mx-auto flex items-center justify-center">
							{!isLinux && <VoidIcon />}
						</div>
						<FadeIn delayMs={600}>
							<PrimaryActionButton onClick={() => setPageIndex(1)}>
								Get started
							</PrimaryActionButton>
						</FadeIn>
					</div>
				}
			/>
		),
		1: (
			<OnboardingPageShell hasMaxWidth={false} content={<ThemeSelectionPage pageIndex={pageIndex} setPageIndex={setPageIndex} />} />
		),
		2: (
			<OnboardingPageShell
				content={
					<div className="flex flex-col items-center gap-8 px-4 text-center">
						<FadeIn>
							<h1 className="text-4xl font-light text-void-fg-1">You&apos;re all set</h1>
							<p className="text-void-fg-3 text-sm mt-3 max-w-sm mx-auto leading-relaxed">
								Open a folder and start chatting with Orbit. Add providers anytime in Settings.
							</p>
						</FadeIn>
						<FadeIn delayMs={200}>
							<PrimaryActionButton
								onClick={completeOnboarding}
								ringSize={voidSettingsState.globalSettings.isOnboardingComplete ? 'screen' : undefined}
							>
								Enter Orbit
							</PrimaryActionButton>
						</FadeIn>
						<PreviousButton onClick={() => setPageIndex(pageIndex - 1)} />
					</div>
				}
			/>
		),
	}

	return (
		<div key={pageIndex} className="w-full h-[80vh] mx-auto flex flex-col items-center justify-center">
			<ErrorBoundary>
				{contentOfIdx[pageIndex]}
			</ErrorBoundary>
		</div>
	)
}
