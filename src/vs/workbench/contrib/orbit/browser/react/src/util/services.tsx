/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { MCPUserState, RefreshableProviderName, SettingsOfProvider } from '../../../../common/orbitSettingsTypes.js'
import { DisposableStore, IDisposable } from '../../../../../../../base/common/lifecycle.js'
import { VoidSettingsState } from '../../../../common/orbitSettingsService.js'
import { ColorScheme } from '../../../../../../../platform/theme/common/theme.js'
import { RefreshModelStateOfProvider } from '../../../../common/refreshModelService.js'

import { ServicesAccessor } from '../../../../../../../editor/browser/editorExtensions.js';
import { IExplorerService } from '../../../../../files/browser/files.js'
import { IModelService } from '../../../../../../../editor/common/services/model.js';
import { IClipboardService } from '../../../../../../../platform/clipboard/common/clipboardService.js';
import { IContextViewService, IContextMenuService } from '../../../../../../../platform/contextview/browser/contextView.js';
import { IMenuService } from '../../../../../../../platform/actions/common/actions.js';
import { IFileService } from '../../../../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../../../../platform/hover/browser/hover.js';
import { IThemeService } from '../../../../../../../platform/theme/common/themeService.js';
import { IWorkbenchThemeService } from '../../../../../../services/themes/common/workbenchThemeService.js';
import { ILLMMessageService } from '../../../../common/sendLLMMessageService.js';
import { IRefreshModelService } from '../../../../common/refreshModelService.js';
import { IVoidSettingsService } from '../../../../common/orbitSettingsService.js';
import { IExtensionTransferService } from '../../../extensionTransferService.js'

import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js'
import { ICodeEditorService } from '../../../../../../../editor/browser/services/codeEditorService.js'
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js'
import { IContextKeyService } from '../../../../../../../platform/contextkey/common/contextkey.js'
import { INotificationService } from '../../../../../../../platform/notification/common/notification.js'
import { IAccessibilityService } from '../../../../../../../platform/accessibility/common/accessibility.js'
import { ILanguageConfigurationService } from '../../../../../../../editor/common/languages/languageConfigurationRegistry.js'
import { ILanguageFeaturesService } from '../../../../../../../editor/common/services/languageFeatures.js'
import { ILanguageDetectionService } from '../../../../../../services/languageDetection/common/languageDetectionWorkerService.js'
import { IKeybindingService } from '../../../../../../../platform/keybinding/common/keybinding.js'
import { IEnvironmentService } from '../../../../../../../platform/environment/common/environment.js'
import { IConfigurationService } from '../../../../../../../platform/configuration/common/configuration.js'
import { IPathService } from '../../../../../../services/path/common/pathService.js'
import { IMetricsService } from '../../../../common/metricsService.js'
import { IOpenAiCodexAuthService, OpenAiCodexAuthState } from '../../../../common/openAiCodexAuthService.js'
import { IGitHubAuthService, GitHubAuthState } from '../../../../common/githubAuthService.js'
import { IOrbitProviderAuthService, OrbitProviderAuthState } from '../../../../common/orbitProviderAuthService.js'
import type { OrbitUsageStats } from '../../../../common/orbitUsageTypes.js'
import { URI } from '../../../../../../../base/common/uri.js'
import { IChatThreadService, IsRunningType, ThreadsState, ThreadStreamState } from '../../../chatThreadService.js'
import { ITerminalToolService } from '../../../terminalToolService.js'
import { ISubAgentService } from '../../../subAgentService.js'
import { ISkillImportService } from '../../../skillImportService.js'
import { ILanguageService } from '../../../../../../../editor/common/languages/language.js'
import { IVoidModelService } from '../../../../common/orbitModelService.js'
import { IWorkspaceContextService } from '../../../../../../../platform/workspace/common/workspace.js'
import { IVoidCommandBarService } from '../../../orbitCommandBarService.js'
import { INativeHostService } from '../../../../../../../platform/native/common/native.js';
import { IEditCodeService } from '../../../editCodeServiceInterface.js'
import { IToolsService } from '../../../../common/toolsServiceTypes.js'
import { IConvertToLLMMessageService } from '../../../convertToLLMMessageService.js'
import { ITerminalGroup, ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../../terminal/browser/terminal.js'
import { ISearchService } from '../../../../../../services/search/common/search.js'
import { IExtensionManagementService } from '../../../../../../../platform/extensionManagement/common/extensionManagement.js'
import { IMCPService } from '../../../../common/mcpService.js';
import { IStorageService, StorageScope } from '../../../../../../../platform/storage/common/storage.js'
import { OPT_OUT_KEY } from '../../../../common/storageKeys.js'


// normally to do this you'd use a useEffect that calls .onDidChangeState(), but useEffect mounts too late and misses initial state changes

// even if React hasn't mounted yet, the variables are always updated to the latest state.
// React listens by adding a setState function to these listeners.

let chatThreadsState: ThreadsState
const chatThreadsStateListeners: Set<(s: ThreadsState) => void> = new Set()

let chatThreadsStreamState: ThreadStreamState
const chatThreadsStreamStateListeners: Set<(threadId: string) => void> = new Set()

let chatThreadsStateServiceRef: IChatThreadService | undefined

let runningThreadIds: { [threadId: string]: IsRunningType | undefined } = {}
const runningThreadIdsListeners: Set<() => void> = new Set()

const _recomputeRunningThreadIds = () => {
	const next: { [threadId: string]: IsRunningType | undefined } = {}
	for (const threadId in chatThreadsStreamState) {
		const isRunning = chatThreadsStreamState[threadId]?.isRunning
		if (isRunning) {
			next[threadId] = isRunning
		}
	}
	const prevKeys = Object.keys(runningThreadIds)
	const nextKeys = Object.keys(next)
	let changed = prevKeys.length !== nextKeys.length
	if (!changed) {
		for (const k of nextKeys) {
			if (runningThreadIds[k] !== next[k]) {
				changed = true
				break
			}
		}
	}
	if (changed) {
		runningThreadIds = next
		runningThreadIdsListeners.forEach(l => l())
	}
}

let settingsState: VoidSettingsState
const settingsStateListeners: Set<(s: VoidSettingsState) => void> = new Set()

export type TerminalVibeState = {
	readonly groups: readonly ITerminalGroup[];
	readonly activeGroup: ITerminalGroup | undefined;
	readonly activeInstance: ITerminalInstance | undefined;
};
let terminalVibeState: TerminalVibeState = { groups: [], activeGroup: undefined, activeInstance: undefined };
const terminalVibeStateListeners: Set<(s: TerminalVibeState) => void> = new Set();

let refreshModelState: RefreshModelStateOfProvider
const refreshModelStateListeners: Set<(s: RefreshModelStateOfProvider) => void> = new Set()
const refreshModelProviderListeners: Set<(p: RefreshableProviderName, s: RefreshModelStateOfProvider) => void> = new Set()

let colorThemeState: ColorScheme
const colorThemeStateListeners: Set<(s: ColorScheme) => void> = new Set()

let colorThemeSettingsIdState = ''
const colorThemeSettingsIdListeners: Set<(s: string) => void> = new Set()

let openAiCodexAuthState: OpenAiCodexAuthState = { isAuthenticated: false }
const openAiCodexAuthStateListeners: Set<(s: OpenAiCodexAuthState) => void> = new Set()

let gitHubAuthState: GitHubAuthState = { isAuthenticated: false }
const gitHubAuthStateListeners: Set<(s: GitHubAuthState) => void> = new Set()

let orbitProviderAuthState: OrbitProviderAuthState = { isAuthenticated: false }
const orbitProviderAuthStateListeners: Set<(s: OrbitProviderAuthState) => void> = new Set()

const ctrlKZoneStreamingStateListeners: Set<(diffareaid: number, s: boolean) => void> = new Set()
const commandBarURIStateListeners: Set<(uri: URI) => void> = new Set();
const activeURIListeners: Set<(uri: URI | null) => void> = new Set();

const mcpListeners: Set<() => void> = new Set()


// must call this before you can use any of the hooks below
// this should only be called ONCE! this is the only place you don't need to dispose onDidChange. If you use state.onDidChange anywhere else, make sure to dispose it!
export const _registerServices = (accessor: ServicesAccessor) => {

	const disposables: IDisposable[] = []

	_registerAccessor(accessor)

	const stateServices = {
		chatThreadsStateService: accessor.get(IChatThreadService),
		settingsStateService: accessor.get(IVoidSettingsService),
		refreshModelService: accessor.get(IRefreshModelService),
		themeService: accessor.get(IThemeService),
		workbenchThemeService: accessor.get(IWorkbenchThemeService),
		editCodeService: accessor.get(IEditCodeService),
		voidCommandBarService: accessor.get(IVoidCommandBarService),
		modelService: accessor.get(IModelService),
		mcpService: accessor.get(IMCPService),
		openAiCodexAuthService: accessor.get(IOpenAiCodexAuthService),
		gitHubAuthService: accessor.get(IGitHubAuthService),
		orbitProviderAuthService: accessor.get(IOrbitProviderAuthService),
	}

	const { settingsStateService, chatThreadsStateService, refreshModelService, themeService, workbenchThemeService, editCodeService, voidCommandBarService, modelService, mcpService, openAiCodexAuthService, gitHubAuthService, orbitProviderAuthService } = stateServices
	chatThreadsStateServiceRef = chatThreadsStateService




	chatThreadsState = chatThreadsStateService.state
	disposables.push(
		chatThreadsStateService.onDidChangeCurrentThread(() => {
			chatThreadsState = chatThreadsStateService.state
			chatThreadsStateListeners.forEach(l => l(chatThreadsState))
		})
	)

	// same service, different state
	chatThreadsStreamState = chatThreadsStateService.streamState
	_recomputeRunningThreadIds()
	disposables.push(
		chatThreadsStateService.onDidChangeStreamState(({ threadId }) => {
			chatThreadsStreamState = chatThreadsStateService.streamState
			_recomputeRunningThreadIds()
			chatThreadsStreamStateListeners.forEach(l => l(threadId))
		})
	)

	settingsState = settingsStateService.state
	disposables.push(
		settingsStateService.onDidChangeState(() => {
			settingsState = settingsStateService.state
			settingsStateListeners.forEach(l => l(settingsState))
		})
	)

	refreshModelState = refreshModelService.state
	disposables.push(
		refreshModelService.onDidChangeState((providerName) => {
			refreshModelState = refreshModelService.state
			refreshModelStateListeners.forEach(l => l(refreshModelState))
			refreshModelProviderListeners.forEach(l => l(providerName, refreshModelState)) // no state
		})
	)

	colorThemeState = themeService.getColorTheme().type
	colorThemeSettingsIdState = workbenchThemeService.getColorTheme().settingsId
	disposables.push(
		themeService.onDidColorThemeChange(({ type }) => {
			colorThemeState = type
			colorThemeStateListeners.forEach(l => l(colorThemeState))
		})
	)
	disposables.push(
		workbenchThemeService.onDidColorThemeChange((theme) => {
			colorThemeSettingsIdState = theme.settingsId
			colorThemeSettingsIdListeners.forEach(l => l(colorThemeSettingsIdState))
		})
	)

	// no state
	disposables.push(
		editCodeService.onDidChangeStreamingInCtrlKZone(({ diffareaid }) => {
			const isStreaming = editCodeService.isCtrlKZoneStreaming({ diffareaid })
			ctrlKZoneStreamingStateListeners.forEach(l => l(diffareaid, isStreaming))
		})
	)

	disposables.push(
		voidCommandBarService.onDidChangeState(({ uri }) => {
			commandBarURIStateListeners.forEach(l => l(uri));
		})
	)

	disposables.push(
		voidCommandBarService.onDidChangeActiveURI(({ uri }) => {
			activeURIListeners.forEach(l => l(uri));
		})
	)

	disposables.push(
		mcpService.onDidChangeState(() => {
			mcpListeners.forEach(l => l())
		})
	)

	openAiCodexAuthService.getState().then(state => {
		openAiCodexAuthState = state
		openAiCodexAuthStateListeners.forEach(l => l(openAiCodexAuthState))
	}).catch(() => {
		openAiCodexAuthState = { isAuthenticated: false }
	})
	disposables.push(
		openAiCodexAuthService.onDidChangeState((state) => {
			openAiCodexAuthState = state
			openAiCodexAuthStateListeners.forEach(l => l(openAiCodexAuthState))
		})
	)

	gitHubAuthService.getState().then(state => {
		gitHubAuthState = state
		gitHubAuthStateListeners.forEach(l => l(gitHubAuthState))
	}).catch(() => {
		gitHubAuthState = { isAuthenticated: false }
	})
	disposables.push(
		gitHubAuthService.onDidChangeState((state) => {
			gitHubAuthState = state
			gitHubAuthStateListeners.forEach(l => l(gitHubAuthState))
		})
	)

	orbitProviderAuthService.getState().then(state => {
		orbitProviderAuthState = state
		orbitProviderAuthStateListeners.forEach(l => l(orbitProviderAuthState))
	}).catch(() => {
		orbitProviderAuthState = { isAuthenticated: false }
	})
	disposables.push(
		orbitProviderAuthService.onDidChangeState((state) => {
			orbitProviderAuthState = state
			orbitProviderAuthStateListeners.forEach(l => l(orbitProviderAuthState))
		})
	)

	const terminalGroupService = accessor.get(ITerminalGroupService)
	const terminalService = accessor.get(ITerminalService)
	const refreshTerminalVibeState = () => {
		terminalVibeState = {
			groups: terminalGroupService.groups,
			activeGroup: terminalGroupService.activeGroup,
			activeInstance: terminalGroupService.activeInstance,
		}
		terminalVibeStateListeners.forEach(l => l(terminalVibeState))
	}
	refreshTerminalVibeState()
	disposables.push(
		terminalGroupService.onDidChangeGroups(() => refreshTerminalVibeState()),
		terminalGroupService.onDidChangeActiveGroup(() => refreshTerminalVibeState()),
		terminalGroupService.onDidChangeActiveInstance(() => refreshTerminalVibeState()),
		terminalGroupService.onDidChangeInstances(() => refreshTerminalVibeState()),
		terminalService.onAnyInstanceTitleChange(() => refreshTerminalVibeState()),
	)

	return disposables
}



const getReactAccessor = (accessor: ServicesAccessor) => {
	const reactAccessor = {
		IModelService: accessor.get(IModelService),
		IClipboardService: accessor.get(IClipboardService),
		IContextViewService: accessor.get(IContextViewService),
		IContextMenuService: accessor.get(IContextMenuService),
		IMenuService: accessor.get(IMenuService),
		IFileService: accessor.get(IFileService),
		IHoverService: accessor.get(IHoverService),
		IThemeService: accessor.get(IThemeService),
		IWorkbenchThemeService: accessor.get(IWorkbenchThemeService),
		ILLMMessageService: accessor.get(ILLMMessageService),
		IRefreshModelService: accessor.get(IRefreshModelService),
		IVoidSettingsService: accessor.get(IVoidSettingsService),
		IEditCodeService: accessor.get(IEditCodeService),
		IChatThreadService: accessor.get(IChatThreadService),

		IInstantiationService: accessor.get(IInstantiationService),
		ICodeEditorService: accessor.get(ICodeEditorService),
		ICommandService: accessor.get(ICommandService),
		IContextKeyService: accessor.get(IContextKeyService),
		INotificationService: accessor.get(INotificationService),
		IAccessibilityService: accessor.get(IAccessibilityService),
		ILanguageConfigurationService: accessor.get(ILanguageConfigurationService),
		ILanguageDetectionService: accessor.get(ILanguageDetectionService),
		ILanguageFeaturesService: accessor.get(ILanguageFeaturesService),
		IKeybindingService: accessor.get(IKeybindingService),
		ISearchService: accessor.get(ISearchService),

		IExplorerService: accessor.get(IExplorerService),
		IEnvironmentService: accessor.get(IEnvironmentService),
		IConfigurationService: accessor.get(IConfigurationService),
		IPathService: accessor.get(IPathService),
		IMetricsService: accessor.get(IMetricsService),
		ITerminalToolService: accessor.get(ITerminalToolService),
		ISubAgentService: accessor.get(ISubAgentService),
		ISkillImportService: accessor.get(ISkillImportService),
		ILanguageService: accessor.get(ILanguageService),
		IVoidModelService: accessor.get(IVoidModelService),
		IWorkspaceContextService: accessor.get(IWorkspaceContextService),
		IOpenAiCodexAuthService: accessor.get(IOpenAiCodexAuthService),
		IGitHubAuthService: accessor.get(IGitHubAuthService),
		IOrbitProviderAuthService: accessor.get(IOrbitProviderAuthService),

		IVoidCommandBarService: accessor.get(IVoidCommandBarService),
		INativeHostService: accessor.get(INativeHostService),
		IToolsService: accessor.get(IToolsService),
		IConvertToLLMMessageService: accessor.get(IConvertToLLMMessageService),
		ITerminalService: accessor.get(ITerminalService),
		ITerminalGroupService: accessor.get(ITerminalGroupService),
		IExtensionManagementService: accessor.get(IExtensionManagementService),
		IExtensionTransferService: accessor.get(IExtensionTransferService),
		IMCPService: accessor.get(IMCPService),

		IStorageService: accessor.get(IStorageService),

	} as const
	return reactAccessor
}

type ReactAccessor = ReturnType<typeof getReactAccessor>


let reactAccessor_: ReactAccessor | null = null
const _registerAccessor = (accessor: ServicesAccessor) => {
	const reactAccessor = getReactAccessor(accessor)
	reactAccessor_ = reactAccessor
}

// -- services --
export const useAccessor = () => {
	if (!reactAccessor_) {
		throw new Error(`⚠️ Void useAccessor was called before _registerServices!`)
	}

	return { get: <S extends keyof ReactAccessor,>(service: S): ReactAccessor[S] => reactAccessor_![service] }
}



// -- state of services --

export const useSettingsState = () => {
	const [s, ss] = useState(settingsState)
	useEffect(() => {
		ss(settingsState)
		settingsStateListeners.add(ss)
		return () => { settingsStateListeners.delete(ss) }
	}, [ss])
	return s
}

export const useChatThreadsState = () => {
	const [s, ss] = useState(chatThreadsState)
	useEffect(() => {
		ss(chatThreadsState)
		chatThreadsStateListeners.add(ss)
		return () => { chatThreadsStateListeners.delete(ss) }
	}, [ss])
	return s
	// allow user to set state natively in react
	// const ss: React.Dispatch<React.SetStateAction<ThreadsState>> = (action)=>{
	// 	_ss(action)
	// 	if (typeof action === 'function') {
	// 		const newState = action(chatThreadsState)
	// 		chatThreadsState = newState
	// 	} else {
	// 		chatThreadsState = action
	// 	}
	// }
	// return [s, ss] as const
}




const mergeStreamStateForThread = (threadId: string): ThreadStreamState[string] | undefined => {
	const base = chatThreadsStreamState[threadId]
	const overlay = chatThreadsStateServiceRef?.getToolProgressOverlay(threadId)
	if (!overlay) return base
	const mergedProgress = { ...base?.toolProgressById, ...overlay }
	if (base) {
		return { ...base, toolProgressById: mergedProgress }
	}
	if (Object.keys(mergedProgress).length === 0) {
		return base
	}
	return { toolProgressById: mergedProgress } as ThreadStreamState[string]
}

export const useChatThreadsStreamState = (threadId: string) => {
	const [s, ss] = useState<ThreadStreamState[string] | undefined>(() => mergeStreamStateForThread(threadId))
	useEffect(() => {
		ss(mergeStreamStateForThread(threadId))
		const listener = (threadId_: string) => {
			if (threadId_ !== threadId) return
			ss(mergeStreamStateForThread(threadId))
		}
		chatThreadsStreamStateListeners.add(listener)
		return () => { chatThreadsStreamStateListeners.delete(listener) }
	}, [ss, threadId])
	return s
}

/** Sub-agent labels when stream state has no `isRunning` entry. */
export const useToolProgressOverlay = (threadId: string) => {
	const [overlay, setOverlay] = useState<Readonly<Record<string, string>> | undefined>(
		() => chatThreadsStateServiceRef?.getToolProgressOverlay(threadId)
	)
	useEffect(() => {
		const update = () => setOverlay(chatThreadsStateServiceRef?.getToolProgressOverlay(threadId))
		update()
		const listener = (threadId_: string) => {
			if (threadId_ === threadId) update()
		}
		chatThreadsStreamStateListeners.add(listener)
		return () => { chatThreadsStreamStateListeners.delete(listener) }
	}, [threadId])
	return overlay
}

/** Reactive sub-agent internal conversation (updates on each tool/reasoning append). */
export const useSubAgentConversation = (toolId: string, threadId: string) => {
	const accessor = useAccessor()
	const chatThreadService = accessor.get('IChatThreadService')
	const [, setTick] = useState(0)
	useEffect(() => {
		const listener = (threadId_: string) => {
			if (threadId_ === threadId) setTick(t => t + 1)
		}
		chatThreadsStreamStateListeners.add(listener)
		return () => { chatThreadsStreamStateListeners.delete(listener) }
	}, [threadId])
	return chatThreadService.getSubAgentConversation(toolId)
}

export const useFullChatThreadsStreamState = () => {
	const [s, ss] = useState(chatThreadsStreamState)
	useEffect(() => {
		ss(chatThreadsStreamState)
		const listener = () => { ss(chatThreadsStreamState) }
		chatThreadsStreamStateListeners.add(listener)
		return () => { chatThreadsStreamStateListeners.delete(listener) }
	}, [ss])
	return s
}

/** Only re-renders when isRunning phase changes (LLM/tool/idle), not on every streamed token. */
export const useThreadRunningState = (threadId: string | undefined): IsRunningType => {
	const [isRunning, setIsRunning] = useState<IsRunningType>(() =>
		threadId ? chatThreadsStreamState[threadId]?.isRunning : undefined
	)
	useEffect(() => {
		if (!threadId) {
			setIsRunning(undefined)
			return
		}
		const update = () => {
			const next = chatThreadsStreamState[threadId]?.isRunning
			setIsRunning(prev => (prev === next ? prev : next))
		}
		update()
		const listener = (threadId_: string) => {
			if (threadId_ === threadId) {
				update()
			}
		}
		chatThreadsStreamStateListeners.add(listener)
		return () => { chatThreadsStreamStateListeners.delete(listener) }
	}, [threadId])
	return isRunning
}

/** Boolean convenience wrapper around useThreadRunningState. */
export const useIsThreadRunning = (threadId: string | undefined) => {
	const isRunning = useThreadRunningState(threadId)
	return isRunning !== undefined
}

/** Map of thread ids that are currently running; updates only when run state starts/stops. */
export const useRunningThreadIds = () => {
	const [ids, setIds] = useState(runningThreadIds)
	useEffect(() => {
		setIds(runningThreadIds)
		const listener = () => { setIds({ ...runningThreadIds }) }
		runningThreadIdsListeners.add(listener)
		return () => { runningThreadIdsListeners.delete(listener) }
	}, [])
	return ids
}


export const useIsChatHistoryVisible = (): boolean => {
	const accessor = useAccessor();
	const contextKeyService = accessor.get('IContextKeyService');
	const [isVisible, setIsVisible] = useState<boolean>(() =>
		contextKeyService.getContextKeyValue<boolean>('chatHistoryVisible') ?? false
	);
	useEffect(() => {
		setIsVisible(contextKeyService.getContextKeyValue<boolean>('chatHistoryVisible') ?? false);
		const disposable = contextKeyService.onDidChangeContext((e) => {
			if (e.affectsSome(new Set(['chatHistoryVisible']))) {
				setIsVisible(contextKeyService.getContextKeyValue<boolean>('chatHistoryVisible') ?? false);
			}
		});
		return () => disposable.dispose();
	}, [contextKeyService]);
	return isVisible;
}



export const useRefreshModelState = () => {
	const [s, ss] = useState(refreshModelState)
	useEffect(() => {
		ss(refreshModelState)
		refreshModelStateListeners.add(ss)
		return () => { refreshModelStateListeners.delete(ss) }
	}, [ss])
	return s
}


export const useRefreshModelListener = (listener: (providerName: RefreshableProviderName, s: RefreshModelStateOfProvider) => void) => {
	useEffect(() => {
		refreshModelProviderListeners.add(listener)
		return () => { refreshModelProviderListeners.delete(listener) }
	}, [listener, refreshModelProviderListeners])
}

export const useCtrlKZoneStreamingState = (listener: (diffareaid: number, s: boolean) => void) => {
	useEffect(() => {
		ctrlKZoneStreamingStateListeners.add(listener)
		return () => { ctrlKZoneStreamingStateListeners.delete(listener) }
	}, [listener, ctrlKZoneStreamingStateListeners])
}

export const useIsDark = () => {
	const [s, ss] = useState(colorThemeState)
	useEffect(() => {
		ss(colorThemeState)
		colorThemeStateListeners.add(ss)
		return () => { colorThemeStateListeners.delete(ss) }
	}, [ss])

	// s is the theme, return isDark instead of s
	const isDark = s === ColorScheme.DARK || s === ColorScheme.HIGH_CONTRAST_DARK
	return isDark
}

export const useTerminalVibeState = () => {
	const [s, ss] = useState(terminalVibeState)
	useEffect(() => {
		ss(terminalVibeState)
		terminalVibeStateListeners.add(ss)
		return () => { terminalVibeStateListeners.delete(ss) }
	}, [ss])
	return s
}

export const useThemeSettingsId = () => {
	const [s, ss] = useState(colorThemeSettingsIdState)
	useEffect(() => {
		ss(colorThemeSettingsIdState)
		colorThemeSettingsIdListeners.add(ss)
		return () => { colorThemeSettingsIdListeners.delete(ss) }
	}, [ss])
	return s
}

export const useCommandBarURIListener = (listener: (uri: URI) => void) => {
	useEffect(() => {
		commandBarURIStateListeners.add(listener);
		return () => { commandBarURIStateListeners.delete(listener) };
	}, [listener]);
};
export const useCommandBarState = () => {
	const accessor = useAccessor()
	const commandBarService = accessor.get('IVoidCommandBarService')
	const [s, ss] = useState({ stateOfURI: commandBarService.stateOfURI, sortedURIs: commandBarService.sortedURIs });
	const listener = useCallback(() => {
		ss({ stateOfURI: commandBarService.stateOfURI, sortedURIs: commandBarService.sortedURIs });
	}, [commandBarService])
	useCommandBarURIListener(listener)

	return s;
}



// roughly gets the active URI - this is used to get the history of recent URIs
export const useActiveURI = () => {
	const accessor = useAccessor()
	const commandBarService = accessor.get('IVoidCommandBarService')
	const [s, ss] = useState(commandBarService.activeURI)
	useEffect(() => {
		const listener = () => { ss(commandBarService.activeURI) }
		activeURIListeners.add(listener);
		return () => { activeURIListeners.delete(listener) };
	}, [])
	return { uri: s }
}




export const useMCPServiceState = () => {
	const accessor = useAccessor()
	const mcpService = accessor.get('IMCPService')
	const [s, ss] = useState(mcpService.state)
	useEffect(() => {
		const listener = () => { ss(mcpService.state) }
		mcpListeners.add(listener);
		return () => { mcpListeners.delete(listener) };
	}, []);
	return s
}

export const useOpenAiCodexAuthState = () => {
	const [s, ss] = useState(openAiCodexAuthState)
	useEffect(() => {
		ss(openAiCodexAuthState)
		openAiCodexAuthStateListeners.add(ss)
		return () => { openAiCodexAuthStateListeners.delete(ss) }
	}, [ss])
	return s
}

export const useGitHubAuthState = () => {
	const [s, ss] = useState(gitHubAuthState)
	useEffect(() => {
		ss(gitHubAuthState)
		gitHubAuthStateListeners.add(ss)
		return () => { gitHubAuthStateListeners.delete(ss) }
	}, [ss])
	return s
}

export const useOrbitProviderAuthState = () => {
	const [s, ss] = useState(orbitProviderAuthState)
	useEffect(() => {
		ss(orbitProviderAuthState)
		orbitProviderAuthStateListeners.add(ss)
		return () => { orbitProviderAuthStateListeners.delete(ss) }
	}, [ss])
	return s
}

export const useOrbitUsageStats = (enabled = true) => {
	const accessor = useAccessor()
	const orbitAuth = useOrbitProviderAuthState()
	const authService = accessor.get('IOrbitProviderAuthService')
	const runningThreadIds = useRunningThreadIds()
	const wasRunningRef = useRef(false)
	const [stats, setStats] = useState<OrbitUsageStats | null>(null)
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const refresh = useCallback(async () => {
		if (!enabled || !orbitAuth.isAuthenticated) {
			setStats(null)
			setError(null)
			setLoading(false)
			return
		}
		setLoading(true)
		setError(null)
		try {
			const next = await authService.getUsageStats()
			setStats(next)
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Failed to load usage')
		} finally {
			setLoading(false)
		}
	}, [enabled, orbitAuth.isAuthenticated, authService])

	useEffect(() => {
		void refresh()
	}, [refresh])

	useEffect(() => {
		const isRunning = Object.keys(runningThreadIds).length > 0
		if (wasRunningRef.current && !isRunning && enabled && orbitAuth.isAuthenticated) {
			void refresh()
		}
		wasRunningRef.current = isRunning
	}, [runningThreadIds, enabled, orbitAuth.isAuthenticated, refresh])

	return { stats, loading, error, refresh }
}



export const useIsOptedOut = () => {
	const accessor = useAccessor()
	const storageService = accessor.get('IStorageService')

	const getVal = useCallback(() => {
		return storageService.getBoolean(OPT_OUT_KEY, StorageScope.APPLICATION, false)
	}, [storageService])

	const [s, ss] = useState(getVal())

	useEffect(() => {
		const disposables = new DisposableStore();
		const d = storageService.onDidChangeValue(StorageScope.APPLICATION, OPT_OUT_KEY, disposables)(e => {
			ss(getVal())
		})
		disposables.add(d)
		return () => disposables.clear()
	}, [storageService, getVal])

	return s
}
