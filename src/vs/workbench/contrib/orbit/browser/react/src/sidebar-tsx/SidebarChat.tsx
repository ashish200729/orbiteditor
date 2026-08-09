/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { Fragment, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Services and hooks
import { useAccessor, useChatThreadsState, useThreadRunningState, useSettingsState, useCommandBarState, useMCPServiceState, useQueuedUserMessages, useIsQueuePaused, useRemoteTasks } from '../util/services.js';
import { parseExecutionTargetId, runnerIdFromExecutionTarget, makeRunnerExecutionTarget } from '../../../../common/runner/runnerTypes.js';
import { useWorkspaceGitForRunner } from './components/chat/RunnerBranchDropdown.js';
import { buildRunnerGitSpec } from '../../../../common/runner/gitRemoteHelpers.js';
import { explainModelAvailability, JIT_SYNC_RECOVERABLE_CODES } from '../../../../common/runner/runnerProviderIntegration.js';
import type { ProviderName } from '../../../../common/orbitSettingsTypes.js';
import { remoteTaskChatMessages, remoteTaskHistoryAnchor, shouldSkipRemoteUserMessage } from '../../../../common/runner/remoteTaskChatMessages.js';
import { remoteChatStatusLineLabel, remoteTaskUiPhase, remoteTaskUiPhaseLabel, type RemoteSubmitStage } from '../../../../common/runner/remoteTaskUiStatus.js';
import { RemoteSubmitAlert } from './components/runner/RemoteSubmitAlert.js';
import { RemoteSubmitProgress } from './components/runner/RemoteSubmitProgress.js';

// Common imports
import { URI } from '../../../../../../../base/common/uri.js';
import { ChatMessage, StagingSelectionItem } from '../../../../common/chatThreadServiceTypes.js';
import { ThreadType } from '../../../chatThreadService.js';
import { isFeatureNameDisabled } from '../../../../common/orbitSettingsTypes.js';
import { isABuiltinToolName } from '../../../../common/prompt/prompts.js';

import { TextAreaFns, VoidInputBox2 } from '../util/inputs.js';
import { focusInConnectedWindow, downscaleImageDataUrl } from '../util/helpers.js';

// External components (not extracted)
import ErrorBoundary from './ErrorBoundary.js';



// Extracted components - Icons
import { IconX } from './components/icons/IconX.js';
import { IconLoading } from './components/icons/IconLoading.js';

// Extracted components - Buttons
import { ButtonAddImage } from './components/buttons/ButtonAddImage.js';
import { ButtonOpenBrowser } from './components/buttons/ButtonOpenBrowser.js';

// Extracted components - Wrappers


// Extracted components - Chat
import { VoidChatArea } from './components/chat/orbitChatArea.js';

// Extracted components - Chat Components
import { CommandBarInChat } from './components/chatComponents/CommandBarInChat.js';

// Context providers
import { TodoProvider } from './contexts/TodoContext.js';
import { ChatMessagesScrollArea } from './components/chat/ChatMessagesScrollArea.js';
import { AgentWorkspaceHeader } from '../agent-window-tsx/AgentWorkspaceHeader.js';
import { AgentChatRunHeader } from '../agent-window-tsx/AgentChatRunHeader.js';
import { ImageMarkupEditor } from './ImageMarkupEditor.js';
import {
	VOID_MESSAGE_QUEUE,
	VOID_MESSAGE_QUEUE_ACTION,
	VOID_MESSAGE_QUEUE_CARD,
	VOID_MESSAGE_QUEUE_COUNT,
	VOID_MESSAGE_QUEUE_HEADER,
	VOID_MESSAGE_QUEUE_ITEM,
	VOID_MESSAGE_QUEUE_LIST,
	VOID_MESSAGE_QUEUE_POSITION,
} from './messageQueueCssClasses.js';

// Extracted hooks
import { useChatScrollPolicy } from './hooks/useChatScrollPolicy.js';
import { useStickyUserMessages } from './hooks/useStickyUserMessages.js';

// ============================================================================
// RE-EXPORTS FOR BACKWARDS COMPATIBILITY
// These allow other files to continue importing from SidebarChat.tsx
// ============================================================================

// Re-export Icons
export { IconX } from './components/icons/IconX.js';
export { IconArrowUp } from './components/icons/IconArrowUp.js';
export { IconSquare } from './components/icons/IconSquare.js';
export { IconWarning } from './components/icons/IconWarning.js';
export { IconLoading } from './components/icons/IconLoading.js';
export { CircleSpinner } from './components/icons/CircleSpinner.js';

// Re-export Buttons
export { ButtonSubmit } from './components/buttons/ButtonSubmit.js';
export { ButtonStop } from './components/buttons/ButtonStop.js';
export { ButtonAddImage } from './components/buttons/ButtonAddImage.js';
export { ButtonOpenBrowser } from './components/buttons/ButtonOpenBrowser.js';

// Re-export Wrappers
export { ProseWrapper } from './components/wrappers/ProseWrapper.js';
export { SmallProseWrapper } from './components/wrappers/SmallProseWrapper.js';

// Re-export Chat Components
export { ChatScrollContainer } from './components/chat/ChatScrollContainer.js';
export { VoidChatArea } from './components/chat/orbitChatArea.js';

// Re-export File Components
export { SelectedFiles } from './components/files/SelectedFiles.js';

// Re-export Tool Headers
export { ToolHeaderWrapper } from './components/toolHeaders/ToolHeaderWrapper.js';

// Re-export EditTool Components
export { EditToolCardWrapper } from './components/editTool/EditToolCardWrapper.js';

// Re-export Tool Wrappers
export { ToolChildrenWrapper } from './components/toolWrappers/ToolChildrenWrapper.js';
export { CodeChildren } from './components/toolWrappers/CodeChildren.js';
export { ListableToolItem } from './components/toolWrappers/ListableToolItem.js';

// Re-export Utilities
export { getRelative, getFolderName, getBasename, voidOpenFileFn } from './utils/fileUtils.js';

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/** A pasted/dropped image staged for the next message. `id` is a stable React key. */
type StagedImage = { id: string; url: string }
let _stagedImageSeq = 0
const nextStagedImageId = (): string => {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
	return c?.randomUUID?.() ?? `img-${Date.now()}-${(_stagedImageSeq++).toString(36)}`
}

const REMOTE_TERMINAL_STATES: ReadonlySet<string> = new Set([
	'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LOST',
])

export const SidebarChat = ({ isAgentWindow = false }: { isAgentWindow?: boolean }) => {
	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')
	const chatThreadsState = useChatThreadsState()
	const selectedThreadId = (isAgentWindow ? chatThreadsState.agentWindowThreadId : chatThreadsState.currentThreadId)
		?? chatThreadsService.getSelectedThreadId(isAgentWindow)
	const currentThread = selectedThreadId ? chatThreadsService.getThread(selectedThreadId) : undefined
	if (!currentThread) {
		return (
			<div className='w-full h-full flex items-center justify-center text-void-fg-3 text-sm'>
				Loading chat…
			</div>
		)
	}
	return <SidebarChatLoaded isAgentWindow={isAgentWindow} currentThread={currentThread} />
}

const SidebarChatLoaded = ({ isAgentWindow = false, currentThread }: { isAgentWindow?: boolean; currentThread: ThreadType }) => {
	const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
	const textAreaFnsRef = useRef<TextAreaFns | null>(null)

	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const agentWindowService = accessor.get('IAgentWindowService')
	const chatThreadsService = accessor.get('IChatThreadService')

	const settingsState = useSettingsState()
	const mcpServiceState = useMCPServiceState()
	// ----- HIGHER STATE -----

	// threads state
	const chatThreadsState = useChatThreadsState()

	const localMessages = currentThread.messages ?? []

	const selections = currentThread.state.stagingSelections
	const setSelections = (s: StagingSelectionItem[]) => { chatThreadsService.setThreadState(currentThread.id, { stagingSelections: s }) }

	const threadId = currentThread.id
	const localIsRunning = useThreadRunningState(threadId)
	const queuedMessages = useQueuedUserMessages(threadId)
	const isQueuePaused = useIsQueuePaused(threadId)

	// The portal supplies this synchronously so the agent-only workspace header is
	// present on first paint. Main-window mounts omit it and retain their old UI.
	const inAgentWindow = isAgentWindow

	const mcpToolNameSet = useMemo(() => {
		const names = new Set<string>()
		for (const server of Object.values(mcpServiceState.mcpServerOfName)) {
			if (!server?.tools) continue
			for (const tool of server.tools) {
				if (tool?.name) names.add(tool.name)
			}
		}
		return names
	}, [mcpServiceState])

	// ----- SIDEBAR CHAT state (local) -----

	// state of current message
	const initVal = ''
	const [instructionsAreEmpty, setInstructionsAreEmpty] = useState(!initVal)

	const isDisabled = instructionsAreEmpty || !!isFeatureNameDisabled('Chat', settingsState)

	const sidebarRef = useRef<HTMLDivElement>(null)
	const scrollContainerRef = useRef<HTMLDivElement | null>(null)
	// State for images. Each carries a stable id so React keys survive delete+add (index keys
	// reuse the wrong DOM node, and identical data-URLs would collide if keyed by content).
	const [images, setImages] = useState<StagedImage[]>([])
	const [editingImageTarget, setEditingImageTarget] = useState<{ threadId: string; imageId: string } | null>(null)
	// State for drag and drop visual feedback
	const [isDragOver, setIsDragOver] = useState(false)
	const editingImageId = editingImageTarget?.threadId === threadId ? editingImageTarget.imageId : null
	useEffect(() => {
		setEditingImageTarget(current => current?.threadId === threadId ? current : null)
	}, [threadId])
	const globalExecutionTarget = parseExecutionTargetId(settingsState.globalSettings.executionTarget)
	const threadRunnerId = chatThreadsState.allThreads[threadId]?.runnerProfile?.lastRunnerId
	const workspaceGit = useWorkspaceGitForRunner(isAgentWindow)
	const remoteTasks = useRemoteTasks()
	const remoteTaskService = accessor.get('IRemoteTaskService')
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const [remoteSubmitError, setRemoteSubmitError] = useState<string | null>(null)
	const [remoteSubmitPending, setRemoteSubmitPending] = useState(false)
	const [remoteSubmitStage, setRemoteSubmitStage] = useState<RemoteSubmitStage>('checking-model')
	const remoteSubmitPendingRef = useRef(false)
	/** TaskId of a remote task the user just asked to stop. Cleared once the
	 * task reaches a terminal state. Drives the "Stopping…" status sub-phase so
	 * the user sees immediate feedback while the runner acks the cancel. */
	const [remoteStoppingTaskId, setRemoteStoppingTaskId] = useState<string | null>(null)

	const tasksForThread = useMemo(() => remoteTasks
		.filter(task => {
			if (task.editorThreadId !== threadId) return false
			const index = task.editorMessageIndex ?? localMessages.length
			if (index > localMessages.length) return false
			return !task.editorHistoryAnchor
				|| task.editorHistoryAnchor === remoteTaskHistoryAnchor(localMessages, index)
		})
		.sort((a, b) => a.createdAt - b.createdAt), [remoteTasks, threadId, localMessages])

	// When returning to a Self-hosted Runner thread, restore the runner it last used
	// so live overlays, continuation, stop, and the global picker target the
	// correct daemon — including idle/completed threads, not only in-flight work.
	//
	// When switching onto a local-only thread (has history, no runner profile,
	// no in-flight remote work), clear a stale global Runner target. The Run-on
	// picker is landing-page-only in the IDE sidebar, so without this reset a
	// prior empty-thread Runner choice would silently hijack submits on other
	// threads. Idle/completed runner threads keep their lastRunnerId and may
	// keep the Runner target for follow-ups; Local still wins if the user
	// explicitly switched (R5 — we only force Local when there is no runner profile).
	const hasInFlightRemoteWork = useMemo(
		() => tasksForThread.some(task => !REMOTE_TERMINAL_STATES.has(task.state)),
		[tasksForThread],
	)

	// Effective target for this thread — never inherit a stale global Runner onto local history.
	const threadAllowsRemote = localMessages.length === 0 || !!threadRunnerId || hasInFlightRemoteWork
	const executionTarget = threadRunnerId
		? makeRunnerExecutionTarget(threadRunnerId)
		: (globalExecutionTarget !== 'local' && threadAllowsRemote)
			? globalExecutionTarget
			: 'local'
	const isRemoteTarget = executionTarget !== 'local'
	const remoteRunnerId = runnerIdFromExecutionTarget(executionTarget)
	const activeRunnerName = remoteRunnerId
		? accessor.get('IRunnerService').getRunner(remoteRunnerId)?.name
		: undefined

	useEffect(() => {
		if (!isRemoteTarget) {
			setRemoteSubmitError(null)
		}
	}, [isRemoteTarget])

	useEffect(() => {
		if (threadRunnerId) {
			const desired = makeRunnerExecutionTarget(threadRunnerId)
			if (settingsState.globalSettings.executionTarget !== desired) {
				void voidSettingsService.setGlobalSetting('executionTarget', desired)
			}
			return
		}
		const isLocalOnlyThread = localMessages.length > 0 && !threadRunnerId && !hasInFlightRemoteWork
		if (isLocalOnlyThread && settingsState.globalSettings.executionTarget !== 'local') {
			void voidSettingsService.setGlobalSetting('executionTarget', 'local')
		}
	}, [threadId, threadRunnerId, hasInFlightRemoteWork, localMessages.length, settingsState.globalSettings.executionTarget, voidSettingsService])

	// Reconnect in-flight remote tasks only when navigating to this thread.
	// Do not depend on remoteTasks: every streamed task.event refreshes that list
	// and would force-close healthy websockets via reconnectAllActive().
	useEffect(() => {
		const active = remoteTaskService.listTasks().filter(task =>
			task.editorThreadId === threadId
			&& !REMOTE_TERMINAL_STATES.has(task.state)
		)
		for (const task of active) {
			void remoteTaskService.reconnect(task.taskId)
		}
	}, [threadId, remoteTaskService])

	const tasksForCurrentRunner = useMemo(
		() => (remoteRunnerId ? tasksForThread.filter(task => task.runnerId === remoteRunnerId) : []),
		[tasksForThread, remoteRunnerId],
	)

	const tasksForLiveOverlay = useMemo(() => {
		// Prefer the thread's runner so switching agents doesn't hide cloud turns when the
		// global execution target was left on Local or a different runner.
		if (threadRunnerId) {
			return tasksForThread.filter(task => task.runnerId === threadRunnerId)
		}
		if (isRemoteTarget && remoteRunnerId) {
			return tasksForCurrentRunner
		}
		return tasksForThread
	}, [tasksForThread, threadRunnerId, isRemoteTarget, remoteRunnerId, tasksForCurrentRunner])

	const orphanedRemoteTasks = useMemo(() => remoteTasks
		.filter(task => {
			if (task.editorThreadId !== threadId) return false
			const index = task.editorMessageIndex ?? localMessages.length
			if (index > localMessages.length) return true
			if (!task.editorHistoryAnchor) return false
			return task.editorHistoryAnchor !== remoteTaskHistoryAnchor(localMessages, index)
		})
		.sort((a, b) => a.createdAt - b.createdAt), [remoteTasks, threadId, localMessages])

	const [dismissedOrphanTaskIds, setDismissedOrphanTaskIds] = useState<ReadonlySet<string>>(() => new Set())

	const { previousMessages, readOnlyMessageIndices, threadMessageIndices, remoteTaskFooters } = useMemo(() => {
		const materialized = chatThreadsService.getThread(threadId)?.materializedRemoteTaskIds ?? []
		const remoteAtLocalIndex = new Map<number, Array<{ taskId: string; messages: ChatMessage[] }>>()
		for (const task of tasksForLiveOverlay) {
			if (materialized.includes(task.taskId)) {
				continue
			}
			const index = Math.max(0, Math.min(localMessages.length, task.editorMessageIndex ?? localMessages.length))
			const live = remoteTaskService.getLiveState(task.taskId)
			const bucket = remoteAtLocalIndex.get(index) ?? []
			bucket.push({
				taskId: task.taskId,
				messages: remoteTaskChatMessages(task, live?.events ?? [], {
					skipUserMessage: shouldSkipRemoteUserMessage(task, localMessages, task.editorMessageIndex),
				}),
			})
			remoteAtLocalIndex.set(index, bucket)
		}
		const merged: ChatMessage[] = []
		const readOnly = new Set<number>()
		const threadIndices = new Map<number, number>()
		const footers = new Map<number, string>()
		for (let localIndex = 0; localIndex <= localMessages.length; localIndex++) {
			for (const { taskId, messages } of remoteAtLocalIndex.get(localIndex) ?? []) {
				for (const message of messages) {
					readOnly.add(merged.length)
					merged.push(message)
				}
				if (messages.length > 0) {
					footers.set(merged.length - 1, taskId)
				}
			}
			if (localIndex < localMessages.length) {
				threadIndices.set(merged.length, localIndex)
				merged.push(localMessages[localIndex])
			}
		}
		for (const task of tasksForLiveOverlay) {
			if (materialized.includes(task.taskId)) {
				continue
			}
			const live = remoteTaskService.getLiveState(task.taskId)
			if (!live?.pendingPermission) {
				continue
			}
			if ([...footers.values()].includes(task.taskId)) {
				continue
			}
			if (merged.length > 0) {
				footers.set(merged.length - 1, task.taskId)
			}
		}
		return { previousMessages: merged, readOnlyMessageIndices: readOnly, threadMessageIndices: threadIndices, remoteTaskFooters: footers }
	}, [tasksForLiveOverlay, remoteTaskService, localMessages, chatThreadsService, threadId])
	const terminalRemoteStates = REMOTE_TERMINAL_STATES
	// Prefer the selected runner’s active task, but keep tracking any in-flight remote work on
	// this thread so switching Local mid-run doesn’t hide stop/status or allow a second agent.
	const activeRemoteTaskForRunner = remoteRunnerId
		? [...tasksForCurrentRunner].reverse().find(task => !terminalRemoteStates.has(task.state))
		: undefined
	const activeRemoteTaskOnThread = [...tasksForThread].reverse().find(task => !terminalRemoteStates.has(task.state))
	const activeRemoteTask = activeRemoteTaskForRunner ?? activeRemoteTaskOnThread
	const isRemoteRunning = !!activeRemoteTaskOnThread
	const remotePendingApproval = !!activeRemoteTask
		&& !!remoteTaskService.getLiveState(activeRemoteTask.taskId)?.pendingPermission
	const activeRemotePhase = activeRemoteTask
		? remoteTaskUiPhase(activeRemoteTask, remoteTaskService.getLiveState(activeRemoteTask.taskId))
		: 'idle' as const
	const remotePhaseLabel = (isRemoteRunning && activeRemotePhase !== 'idle')
		? remoteTaskUiPhaseLabel(activeRemotePhase)
		: undefined
	const activeRemoteLive = activeRemoteTask ? remoteTaskService.getLiveState(activeRemoteTask.taskId) : undefined
	// Surface a failed remote task (terminal FAILED/CANCELLED/TIMED_OUT/LOST) as
	// "Failed" in the command bar instead of "Done" so the user sees the turn
	// ended badly even if the inline card is scrolled out of view.
	// Only when nothing is in-flight: activeRemoteTaskOnThread === isRemoteRunning,
	// so requiring both was mutually exclusive and always false.
	const latestTerminalRemote = [...tasksForThread].reverse().find(task =>
		REMOTE_TERMINAL_STATES.has(task.state)
	)
	const remoteFailed = !isRemoteRunning
		&& !!latestTerminalRemote
		&& latestTerminalRemote.state !== 'COMPLETED'
		&& !!latestTerminalRemote.lastError
	const displayedRunningState = localIsRunning
		?? (remotePendingApproval ? 'awaiting_user' : (isRemoteRunning ? 'LLM' : undefined))
	const isComposerRunning = !!localIsRunning || isRemoteRunning

	// In-stream status for Self-hosted Runner: preparing (pre-events) or
	// "Planning next moves" only while waiting — same gate as local StreamingMessagePane.
	const isRemoteStopping = !!remoteStoppingTaskId
		&& activeRemoteTask?.taskId === remoteStoppingTaskId
	const remoteStatusLineLabel = isRemoteRunning
		? remoteChatStatusLineLabel({
			isStopping: isRemoteStopping,
			phase: activeRemotePhase,
			pendingApproval: remotePendingApproval,
			hasRemoteEvents: (activeRemoteLive?.events.length ?? 0) > 0,
			tipMessages: previousMessages,
		})
		: null

	// Pre-flight notice for remote mode: surface unsupported attachments BEFORE
	// the user hits Send, so they aren't surprised by a submit-time error. Images
	// are already hidden in the remote toolbar, but pasted/dropped images and
	// staged code selections can still be present — warn dismissibly.
	const remoteAttachmentNotice = isRemoteTarget && (images.length > 0 || selections.length > 0)
		? (images.length > 0 && selections.length > 0
			? 'Self-hosted Runner does not support images or context attachments. Remove both to send, or switch to Local.'
			: images.length > 0
				? 'Self-hosted Runner does not support image attachments. Remove the image to send, or switch to Local.'
				: 'Self-hosted Runner does not support context attachments. Remove the selected files/ranges to send, or switch to Local.')
		: null

	// Helper function to process image files (used for file input, paste, and drop)
	const processImageFiles = useCallback((files: FileList | File[] | null | undefined) => {
		if (!files || files.length === 0) return

		const imagePromises: Promise<string>[] = []
		for (let i = 0; i < files.length; i++) {
			const file = files[i]
			if (!file.type.startsWith('image/')) continue

			const promise = new Promise<string>((resolve, reject) => {
				const reader = new FileReader()
				reader.onload = (event) => {
					const dataUrl = event.target?.result as string
					// Downscale before it enters thread state/storage and every request.
					downscaleImageDataUrl(dataUrl).then(resolve)
				}
				reader.onerror = reject
				reader.readAsDataURL(file)
			})
			imagePromises.push(promise)
		}

		if (imagePromises.length > 0) {
			Promise.allSettled(imagePromises).then((results) => {
				const ok = results
					.filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
					.map(r => r.value)
				if (ok.length > 0) setImages(prev => [...prev, ...ok.map(url => ({ id: nextStagedImageId(), url }))])
				const failed = results.filter(r => r.status === 'rejected')
				if (failed.length > 0) console.error('Error reading image files:', failed.map(r => (r as PromiseRejectedResult).reason))
			})
		}
	}, [])

	const onSubmit = useCallback(async (_forceSubmit?: string, _images?: string[]) => {

		if (isDisabled && !_forceSubmit) return
		// note: submitting while the agent is running is allowed — the service queues the
		// message (Cursor-style) and drains it when the current run ends

		const threadId = currentThread.id

		// send message to LLM
		const userMessage = _forceSubmit || textAreaRef.current?.value || ''
		const imagesToSend = _images ?? images.map(im => im.url)

		// Self-hosted runner: same composer — auto-detect workspace git remote + branch.
		// `executionTarget` is already thread-aware (stale global Runner cannot hijack local threads).
		const target = executionTarget
		if (target !== 'local') {
			if (remoteSubmitPendingRef.current) return
			setRemoteSubmitError(null)
			const runnerId = runnerIdFromExecutionTarget(target)
			if (!runnerId) {
				setRemoteSubmitError('Select a Self-hosted Runner in the execution target dropdown.')
				return
			}
			if (!userMessage.trim()) {
				return
			}
			if (isRemoteRunning) {
				setRemoteSubmitError('Wait for the current remote task to finish or stop it before starting the next turn.')
				return
			}
			const runnerInfo = accessor.get('IRunnerService').getRunner(runnerId)
			if (runnerInfo && (runnerInfo.status === 'offline' || runnerInfo.status === 'error')) {
				setRemoteSubmitError(
					runnerInfo.lastError
						? `Runner is ${runnerInfo.status}: ${runnerInfo.lastError}. Test connection in Settings → Self-hosted Runners.`
						: `Runner is ${runnerInfo.status}. Test connection in Settings → Self-hosted Runners, or switch to Local.`,
				)
				return
			}
			if (imagesToSend.length > 0) {
				setRemoteSubmitError('Self-hosted Runner does not support image attachments yet. Remove images or switch to Local.')
				return
			}
			if (selections.length > 0) {
				setRemoteSubmitError('Self-hosted Runner context attachments are not supported yet. Remove the selected files/ranges or switch to Local.')
				return
			}
			// E23/E25: Semantic search, browser automation, and MCP tools are
			// local-only editor features. They control the *local* agent's tool
			// loop and are never sent to a runner (a remote task negotiates its
			// own capabilities — see defaultRemoteTaskCapabilities, which sets
			// these to false). So they must NOT block a remote submit; forcing the
			// user to globally disable a local feature just to run one cloud task
			// is wrong. The runner simply doesn't expose these tools remotely.
			const remoteTaskService = accessor.get('IRemoteTaskService')
			const runnerService = accessor.get('IRunnerService')
			const modelSelection = settingsState.modelSelectionOfFeature['Chat']
			const chatMode = settingsState.globalSettings.chatMode

			if (!modelSelection) {
				setRemoteSubmitError('Select a model in the Orbit Chat model picker first.')
				return
			}
			if (!workspaceGit.remoteUrl || !workspaceGit.branch || !workspaceGit.commit) {
				setRemoteSubmitError(workspaceGit.error ?? 'Open a git repository with a GitHub/GitLab origin remote.')
				return
			}

			const repo = buildRunnerGitSpec({ url: workspaceGit.remoteUrl, branch: workspaceGit.branch, commit: workspaceGit.commit })
			if (!repo.ok) {
				setRemoteSubmitError(repo.error.message)
				return
			}

			remoteSubmitPendingRef.current = true
			setRemoteSubmitPending(true)
			setRemoteSubmitStage('checking-model')
			let messageIndex: number | null = null
			try {
				let cat = await runnerService.fetchProviderCatalog(runnerId)
				if (!cat.ok) {
					setRemoteSubmitError(cat.error)
					return
				}
				let avail = explainModelAvailability(cat.providers, modelSelection.providerName, modelSelection.modelName)
				if (!avail.ok && JIT_SYNC_RECOVERABLE_CODES.has(avail.code)) {
					setRemoteSubmitStage('syncing-provider')
					await runnerService.syncProvidersToRunner(runnerId, {
						mode: 'selected',
						providers: [modelSelection.providerName as ProviderName],
					})
					cat = await runnerService.fetchProviderCatalog(runnerId)
					if (!cat.ok) {
						setRemoteSubmitError(cat.error)
						return
					}
					avail = explainModelAvailability(cat.providers, modelSelection.providerName, modelSelection.modelName)
				}
				if (!avail.ok) {
					setRemoteSubmitError(avail.message)
					return
				}
				setRemoteSubmitStage('resolving-model')
				const resolved = await runnerService.resolveModelOnRunner(
					runnerId,
					modelSelection.providerName,
					modelSelection.modelName,
				)
				if (!resolved.ok) {
					setRemoteSubmitError(resolved.error)
					return
				}
				const continuationTasks = threadRunnerId
					? tasksForThread.filter(task => task.runnerId === threadRunnerId)
					: tasksForCurrentRunner
				const parentTask = [...continuationTasks].reverse().find(task =>
					task.state === 'COMPLETED'
					&& !!task.git?.repoUrl
					&& task.git.repoUrl === repo.git.repoUrl
					&& (!task.git.branch || !repo.git.branch || task.git.branch === repo.git.branch)
				)
				// Continuation reuses the parent's remote workspace — pin git identity to the
				// parent's headCommit (post-completion) or original commit (E18).
				const continuationCommit = parentTask?.headCommit || parentTask?.git?.commit
				const gitForTask = continuationCommit
					? {
						...repo.git,
						branch: parentTask?.git?.branch || repo.git.branch,
						commit: continuationCommit,
					}
					: repo.git
				if (inAgentWindow) {
					chatThreadsService.adoptThreadToAgentWorkspace(
						threadId,
						accessor.get('IAgentProjectWorkspaceService').getState().activeWorkspaceId,
					)
				}
				messageIndex = chatThreadsService.addRemoteUserTurn({
					threadId,
					userMessage: userMessage.trim(),
					runnerId,
					runnerName: runnerService.getRunner(runnerId)?.name,
				})
				if (messageIndex === null) {
					setRemoteSubmitError('Could not add message to thread.')
					return
				}
				setRemoteSubmitStage('starting-task')
				const threadMessages = chatThreadsService.getThread(threadId)?.messages ?? []
				const injectIndex = messageIndex + 1
				const result = await remoteTaskService.createTask({
					runnerId,
					prompt: userMessage.trim(),
					git: gitForTask,
					model: {
						provider: modelSelection.providerName,
						modelId: modelSelection.modelName,
					},
					chatMode,
					autoApprove: {
						edits: !!settingsState.globalSettings.autoApprove?.edits,
						terminal: !!settingsState.globalSettings.autoApprove?.terminal,
					},
					editorThreadId: threadId,
					editorMessageIndex: injectIndex,
					editorHistoryAnchor: remoteTaskHistoryAnchor(threadMessages, injectIndex),
					parentTaskId: parentTask?.taskId,
				})
				if (!result.ok) {
					chatThreadsService.revertRemoteUserTurn(threadId, messageIndex)
					setRemoteSubmitError(result.error)
					return
				}
				setSelections([])
				setImages([])
				setEditingImageTarget(null)
				textAreaFnsRef.current?.setValue('')
				focusInConnectedWindow(textAreaRef.current)
			} catch (e) {
				if (messageIndex !== null) {
					chatThreadsService.revertRemoteUserTurn(threadId, messageIndex)
				}
				setRemoteSubmitError(e instanceof Error ? e.message : String(e))
			} finally {
				remoteSubmitPendingRef.current = false
				setRemoteSubmitPending(false)
			}
			return
		}

		// Snapshot the staged selections NOW. Staging is cleared right after submit (below), and while
		// the agent is running this message may be QUEUED — the queued entry must carry its own context
		// snapshot rather than falling back to whatever is staged when it later drains.
		const selectionsSnapshot = chatThreadsService.state.allThreads[threadId]?.state.stagingSelections ?? []

		if (isRemoteRunning) {
			setRemoteSubmitError('Wait for the current remote task to finish or stop it before starting a local agent on this thread.')
			return
		}

		try {
			await chatThreadsService.addUserMessageAndStreamResponse({ userMessage, _chatSelections: selectionsSnapshot, _images: imagesToSend.length > 0 ? imagesToSend : undefined, threadId })
		} catch (e) {
			console.error('Error while sending message in chat:', e)
		}

		setSelections([]) // clear staging
		setImages([]) // clear images
		setEditingImageTarget(null)
		textAreaFnsRef.current?.setValue('')
		focusInConnectedWindow(textAreaRef.current) // focus input after submit (keeps Agents pop-out frontmost)

	}, [chatThreadsService, currentThread.id, isDisabled, textAreaRef, textAreaFnsRef, setSelections, settingsState, images, accessor, workspaceGit, isRemoteRunning, selections.length, localMessages.length, tasksForCurrentRunner, tasksForThread, threadRunnerId, executionTarget, inAgentWindow, mcpToolNameSet])

	const onAbort = useCallback(async () => {
		if (activeRemoteTask && isRemoteRunning) {
			setRemoteStoppingTaskId(activeRemoteTask.taskId)
			await remoteTaskService.cancelTask(activeRemoteTask.taskId)
			return
		}
		await chatThreadsService.abortRunning(currentThread.id)
	}, [activeRemoteTask, isRemoteRunning, remoteTaskService, chatThreadsService, currentThread.id])

	// Clear the stopping marker once the task is no longer active (terminal).
	useEffect(() => {
		if (remoteStoppingTaskId && (!activeRemoteTask || !isRemoteRunning)) {
			setRemoteStoppingTaskId(null)
		}
	}, [remoteStoppingTaskId, activeRemoteTask, isRemoteRunning])

	const currCheckpointIdx = chatThreadsState.allThreads[threadId]?.state?.currCheckpointIdx ?? undefined  // if not exist, treat like checkpoint is last message (infinity)



	// Compute user message indices for sticky tracking
	// Use a stable key to prevent infinite loops (memo returning new array ref -> effect fires -> set state -> re-render)
	const messageRolesString = previousMessages.map(m => m.role).join(',');
	const userMessageIndices = useMemo(() => {
		return previousMessages
			.map((msg, idx) => msg.role === 'user' ? idx : -1)
			.filter(idx => idx !== -1);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [messageRolesString]);

	const { stickyOffset, stickyMessageIndex } = useStickyUserMessages(scrollContainerRef, userMessageIndices)

	const { policy, scrollActions } = useChatScrollPolicy({
		scrollContainerRef,
		userMessageIndices,
		isRunning: !!displayedRunningState,
		threadId,
		previousMessagesLength: previousMessages.length,
	})

	// resolve mount info
	const isResolved = chatThreadsState.allThreads[threadId]?.state.mountedInfo?.mountedIsResolvedRef.current
	useEffect(() => {
		if (isResolved) return
		chatThreadsState.allThreads[threadId]?.state.mountedInfo?._whenMountedResolver?.({
			textAreaRef: textAreaRef,
			scrollToBottom: scrollActions.scrollToBottom,
		})

	}, [chatThreadsState, threadId, textAreaRef, scrollActions.scrollToBottom, isResolved])

	const streamingChatIdx = previousMessages.length
	const lastMessage = previousMessages[previousMessages.length - 1]
	const shouldAddGapForStreaming = lastMessage?.role === 'user'

	const messagesHTML = <ChatMessagesScrollArea
		key={'messages' + threadId}
		threadId={threadId}
		previousMessages={previousMessages}
		currCheckpointIdx={currCheckpointIdx}
		isRunning={displayedRunningState}
		scroll={{
			containerRef: scrollContainerRef,
			policy,
			actions: scrollActions,
		}}
		stickyOffset={stickyOffset}
		stickyMessageIndex={stickyMessageIndex}
		userMessageIndices={userMessageIndices}
		streamingChatIdx={streamingChatIdx}
		shouldAddGapForStreaming={shouldAddGapForStreaming}
		mcpToolNameSet={mcpToolNameSet}
		readOnlyMessageIndices={readOnlyMessageIndices}
		threadMessageIndices={threadMessageIndices}
		remoteTaskFooters={remoteTaskFooters}
		workspaceRoot={workspaceGit.root}
		remoteStatusLineLabel={remoteStatusLineLabel}
		className="flex flex-col justify-start px-4 pb-3 w-full flex-1 min-h-0 overflow-x-hidden overflow-y-auto"
	/>


	const onChangeText = useCallback((newStr: string) => {
		setInstructionsAreEmpty(!newStr)
	}, [setInstructionsAreEmpty])
	const onKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
			onSubmit()
		} else if (e.key === 'Escape' && isComposerRunning) {
			onAbort()
		}
	}, [onSubmit, onAbort, isComposerRunning])

	// Handle image file selection
	const handleImageSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		processImageFiles(e.target.files)
		// Reset input
		e.target.value = ''
	}, [processImageFiles])

	// Handle paste event for images
	const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
		if (isRemoteTarget) {
			return
		}
		const clipboardData = e.clipboardData
		if (!clipboardData) return

		// Check if clipboard contains files (images)
		const files = clipboardData.files
		if (files && files.length > 0) {
			// Check if any files are images
			const hasImages = Array.from(files).some(file => file.type.startsWith('image/'))
			if (hasImages) {
				e.preventDefault() // Prevent default paste behavior
				processImageFiles(files)
			}
		}
		// Allow normal text paste if no images
	}, [isRemoteTarget, processImageFiles])

	// Unified drag and drop handlers for images (reusable across all elements)
	// Check if the drag contains image files
	const hasImageFiles = useCallback((e: React.DragEvent): boolean => {
		if (!e.dataTransfer.types.includes('Files')) return false
		const items = Array.from(e.dataTransfer.items)
		return items.some(item => item.type.startsWith('image/'))
	}, [])

	// Create reusable drag handlers that can be attached to any element
	const createDragHandlers = useCallback(() => {
		const handleDragEnter = (e: React.DragEvent) => {
			if (hasImageFiles(e)) {
				e.preventDefault()
				setIsDragOver(true)
				e.dataTransfer.dropEffect = 'copy'
			}
		}

		const handleDragOver = (e: React.DragEvent) => {
			if (hasImageFiles(e)) {
				e.preventDefault() // Must preventDefault on each element to allow drop
				setIsDragOver(true)
				e.dataTransfer.dropEffect = 'copy'
			}
		}

		const handleDragLeave = (e: React.DragEvent) => {
			// Check if we're actually leaving the drop zone (not just entering a child)
			const relatedTarget = e.relatedTarget as Node | null
			const currentTarget = e.currentTarget as Node | null

			if (currentTarget && (!relatedTarget || !currentTarget.contains(relatedTarget))) {
				setIsDragOver(false)
			}
		}

		const handleDrop = (e: React.DragEvent) => {
			e.preventDefault()
			setIsDragOver(false)

			const files = e.dataTransfer.files
			if (files && files.length > 0) {
				processImageFiles(files)
			}
		}

		return { handleDragEnter, handleDragOver, handleDragLeave, handleDrop }
	}, [hasImageFiles, processImageFiles])

	// Get the handlers (created once and reused)
	const dragHandlers = useMemo(() => createDragHandlers(), [createDragHandlers])

	// Safety net: the drag highlight is toggled by four nested elements' enter/leave handlers, and
	// the composer textarea stops event propagation, so a boundary crossing can drop the final
	// `dragleave` and leave `isDragOver` stuck on. A document-level drop/dragend/exit always fires
	// when the operation truly ends — force-clear there so the overlay can never latch.
	useEffect(() => {
		const doc = sidebarRef.current?.ownerDocument ?? document
		const clear = () => setIsDragOver(false)
		// dragleave with no relatedTarget = the pointer left the window entirely.
		const onWindowLeave = (e: DragEvent) => { if (!e.relatedTarget) clear() }
		doc.addEventListener('drop', clear)
		doc.addEventListener('dragend', clear)
		doc.addEventListener('dragleave', onWindowLeave)
		return () => {
			doc.removeEventListener('drop', clear)
			doc.removeEventListener('dragend', clear)
			doc.removeEventListener('dragleave', onWindowLeave)
		}
	}, [])

	// Remove image
	const removeImage = useCallback((id: string) => {
		setImages(prev => prev.filter(im => im.id !== id))
	}, [])

	const saveAnnotatedImage = useCallback((imageUrl: string) => {
		if (!editingImageId) return
		setImages(prev => prev.map(image => image.id === editingImageId ? { ...image, url: imageUrl } : image))
		setEditingImageTarget(null)
	}, [editingImageId])

	const editingImageIndex = editingImageId ? images.findIndex(image => image.id === editingImageId) : -1
	const editingImage = editingImageIndex >= 0 ? images[editingImageIndex] : undefined

	// File input ref for image button
	const fileInputRef = useRef<HTMLInputElement | null>(null)

	const handleImageButtonClick = useCallback(() => {
		fileInputRef.current?.click()
	}, [])


	const chatAreaRef = useRef<HTMLDivElement | null>(null)

	const handleBrowserButtonClick = useCallback(() => {
		const url = 'https://www.google.com'
		// When this composer is rendered inside the agents pop-out window, open the
		// browser in that window's own right-side workspace column instead of a
		// Simple Browser editor in the main IDE. The portal supplies this context
		// synchronously, so the first click cannot race delayed DOM detection.
		if (inAgentWindow) {
			agentWindowService.requestWorkspacePanel('browser', url)
			return
		}
		commandService.executeCommand('simpleBrowser.show', url)
	}, [commandService, agentWindowService, inAgentWindow])

	const inputChatArea = <><VoidChatArea
		featureName='Chat'
		onSubmit={() => onSubmit()}
		onAbort={onAbort}
		isStreaming={isComposerRunning}
		isDisabled={isDisabled || isRemoteRunning || remoteSubmitPending}
		hasMessageToSubmit={!instructionsAreEmpty}
		showSelections={true}
		// showProspectiveSelections={previousMessagesHTML.length === 0}
		selections={selections}
		setSelections={setSelections}
		onClickAnywhere={() => { focusInConnectedWindow(textAreaRef.current) }}
		divRef={chatAreaRef}
		imageButton={
			isRemoteTarget ? (
				// Self-hosted runner has no image/browser tool surface — keep the toolbar clean.
				undefined
			) : (
			<>
				<input
					ref={fileInputRef}
					type='file'
					accept='image/*'
					multiple
					onChange={handleImageSelect}
					className='hidden'
				/>
				<ButtonAddImage onClick={handleImageButtonClick} />
				<ButtonOpenBrowser onClick={handleBrowserButtonClick} />
			</>
			)
		}
		onDragEnter={isRemoteTarget ? undefined : dragHandlers.handleDragEnter}
		onDragOver={isRemoteTarget ? undefined : dragHandlers.handleDragOver}
		onDragLeave={isRemoteTarget ? undefined : dragHandlers.handleDragLeave}
		onDrop={isRemoteTarget ? undefined : dragHandlers.handleDrop}
		isDragOver={isRemoteTarget ? false : isDragOver}
	>
		<div
			className='w-full min-h-[40px]'
			onDragEnter={dragHandlers.handleDragEnter}
			onDragOver={dragHandlers.handleDragOver}
			onDragLeave={dragHandlers.handleDragLeave}
			onDrop={dragHandlers.handleDrop}
		>
			<VoidInputBox2
				isThreadComposer
				enableAtToMention
				enableSlashCommands
className={`min-h-[40px] px-0.5 py-0.5 resize-none placeholder:text-void-fg-4`}
				placeholder='Plan, Build, / for skills, @ for context'
				onChangeText={onChangeText}
				onKeyDown={onKeyDown}
				onFocus={() => { chatThreadsService.setThreadFocusedMessageIdx(threadId, undefined) }}
				onPaste={handlePaste}
				onDragEnter={dragHandlers.handleDragEnter}
				onDragOver={dragHandlers.handleDragOver}
				onDragLeave={dragHandlers.handleDragLeave}
				onDrop={dragHandlers.handleDrop}
				ref={textAreaRef}
				fnsRef={textAreaFnsRef}
				multiline={true}
			/>

			{/* Image preview */}
			{images.length > 0 && (
				<div
					className='flex flex-wrap gap-1.5 mt-1'
					onDragEnter={dragHandlers.handleDragEnter}
					onDragOver={dragHandlers.handleDragOver}
					onDragLeave={dragHandlers.handleDragLeave}
					onDrop={dragHandlers.handleDrop}
				>
					{images.map((im, index) => (
						<div key={im.id} className='@@orbit-image-attachment'>
							<button
								type='button'
								onClick={(event) => {
									event.stopPropagation()
									setEditingImageTarget({ threadId, imageId: im.id })
								}}
								aria-label={`Annotate attached image ${index + 1}`}
								title={`Annotate image ${index + 1}`}
								className='@@orbit-image-attachment-button'
							>
								<img
									src={im.url}
									alt=''
									className='@@orbit-image-attachment-preview'
								/>
							</button>
							<button
								type='button'
								onClick={(event) => {
									event.stopPropagation()
									removeImage(im.id)
								}}
								aria-label={`Remove image ${index + 1}`}
								className='@@orbit-image-attachment-remove'
							>
								<IconX size={12} className='stroke-[2]' aria-hidden />
							</button>
						</div>
					))}
				</div>
			)}
		</div>

	</VoidChatArea>

	{editingImage && (
		<ImageMarkupEditor
			imageUrl={editingImage.url}
			imageIndex={editingImageIndex}
			onCancel={() => setEditingImageTarget(null)}
				onSave={saveAnnotatedImage}
		/>
	)}
	</>


	const isLandingPage = previousMessages.length === 0

	const executionTargetHeader = inAgentWindow ? (
		<ErrorBoundary>
			<AgentWorkspaceHeader />
		</ErrorBoundary>
	) : (
		<ErrorBoundary>
			<AgentChatRunHeader isAgentWindow={false} />
		</ErrorBoundary>
	)


	const initiallySuggestedPromptsHTML = <div className='flex flex-col gap-2 w-full text-nowrap text-void-fg-0 select-none'>
		{[
			'Summarize my codebase',
			'How do types work in Rust?',
			'Create a .orbitrules file for me'
		].map((text, index) => (
			<button
				key={index}
				type='button'
				className='py-1 px-2 rounded text-sm bg-zinc-700/5 hover:bg-zinc-700/10 dark:bg-zinc-300/5 dark:hover:bg-zinc-300/10 cursor-pointer opacity-80 hover:opacity-100 text-left'
				onClick={() => onSubmit(text)}
				aria-label={`Send suggested prompt: ${text}`}
			>
				{text}
			</button>
		))}
	</div>



	const queuedMessagesHTML = queuedMessages.length === 0 ? null : <section className={VOID_MESSAGE_QUEUE} aria-label='Queued messages'>
		<div className={VOID_MESSAGE_QUEUE_CARD}>
			<div className={VOID_MESSAGE_QUEUE_HEADER}>
				{isQueuePaused
					? <span className='text-void-warning shrink-0 select-none' role='status' aria-live='polite'>Queue paused — last run failed</span>
					: <span className='shrink-0 select-none font-medium text-void-fg-2'>Up next</span>}
				<span className={VOID_MESSAGE_QUEUE_COUNT} aria-label={`${queuedMessages.length} queued message${queuedMessages.length === 1 ? '' : 's'}`}>{queuedMessages.length}</span>
				<div className='flex-1 min-w-2' />
				{isQueuePaused && <button
					type='button'
					className={`${VOID_MESSAGE_QUEUE_ACTION} shrink-0`}
					onClick={() => chatThreadsService.resumeQueuedUserMessages(threadId)}
				>Resume</button>}
				<button
					type='button'
					className={`${VOID_MESSAGE_QUEUE_ACTION} shrink-0`}
					onClick={() => chatThreadsService.clearQueuedUserMessages(threadId)}
				>Clear all</button>
			</div>
			<div role='list' className={VOID_MESSAGE_QUEUE_LIST}>
				{queuedMessages.map((q, i) => {
					const attachmentCount = (q._chatSelections?.length ?? 0) + (q._images?.length ?? 0)
					return (
						<div key={i} role='listitem' className={VOID_MESSAGE_QUEUE_ITEM}>
							<span className={`${VOID_MESSAGE_QUEUE_POSITION} select-none`} aria-hidden='true'>{i + 1}</span>
							<span
								className='truncate flex-1 min-w-0'
								data-tooltip-id='void-tooltip'
								data-tooltip-content={q.userMessage}
								data-tooltip-place='top'
							>{q.userMessage}</span>
							{attachmentCount > 0 && <span className='shrink-0 text-void-fg-4 text-[11px] select-none' title={`${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}`}>{attachmentCount} file{attachmentCount === 1 ? '' : 's'}</span>}
							<button
								type='button'
								className={`${VOID_MESSAGE_QUEUE_ACTION} shrink-0 opacity-60 hover:opacity-100 transition-opacity`}
								onClick={() => chatThreadsService.removeQueuedUserMessage(threadId, i)}
								aria-label='Remove queued message'
							>
								<IconX size={12} className='stroke-[2]' />
							</button>
						</div>
					)
				})}
			</div>
		</div>
	</section>

	const visibleOrphanedTasks = orphanedRemoteTasks.filter(task => !dismissedOrphanTaskIds.has(task.taskId))
	const anchorMismatchNotice = visibleOrphanedTasks.length > 0 ? (
		<div className='px-4 pb-2 flex flex-col gap-1.5'>
			{visibleOrphanedTasks.map(task => (
				<RemoteSubmitAlert
					key={task.taskId}
					severity='warning'
					message='Remote turn hidden due to edited history.'
					armToken={task.taskId}
					ctaLabel='Reattach'
					onCtaClick={() => {
						const prompt = task.prompt.trim()
						const userIdx = localMessages.findIndex(message =>
							message.role === 'user'
							&& (message.displayContent || message.content || '').trim() === prompt
						)
						const injectIndex = userIdx >= 0 ? userIdx + 1 : (task.editorMessageIndex ?? localMessages.length)
						void remoteTaskService.reattachTaskToThread(
							task.taskId,
							injectIndex,
							remoteTaskHistoryAnchor(localMessages, injectIndex),
						)
					}}
					onDismiss={() => setDismissedOrphanTaskIds(prev => new Set([...prev, task.taskId]))}
				/>
			))}
		</div>
	) : null

	const threadPageInput = <div key={'input' + threadId} className='shrink-0'>
		<div className='px-4'>
		<CommandBarInChat
		threadId={threadId}
		agentRunningState={displayedRunningState}
		remotePhaseLabel={remotePhaseLabel}
		remoteFailed={remoteFailed}
		remotePatchPending={isRemoteRunning}
	/>
		</div>
		{anchorMismatchNotice}
		{!isRemoteTarget && queuedMessagesHTML}
		{remoteAttachmentNotice && (
			<RemoteSubmitAlert
				className='mx-2 mb-1'
				severity='warning'
				message={remoteAttachmentNotice}
				armToken={remoteAttachmentNotice}
				onDismiss={() => { /* re-evaluated each render from attachments; dismiss is per-mount */ }}
			/>
		)}
		{remoteSubmitPending && (
			<RemoteSubmitProgress
				className='mx-2 mb-1'
				stage={remoteSubmitStage}
				runnerName={activeRunnerName}
			/>
		)}
		{!remoteSubmitPending && (remoteSubmitError || (isRemoteTarget && !workspaceGit.loading && workspaceGit.error)) && (
			<RemoteSubmitAlert
				className='mx-2 mb-1'
				message={remoteSubmitError ?? workspaceGit.error}
				armToken={remoteSubmitError ?? workspaceGit.error}
				onDismiss={() => setRemoteSubmitError(null)}
			/>
		)}
		<div className='px-2 pb-2'>
			{inputChatArea}
		</div>
	</div>

	const landingPageInput = <div>
		<div className='pt-4 flex flex-col gap-2'>
			{executionTargetHeader}
			{remoteAttachmentNotice && (
				<RemoteSubmitAlert
					className='mx-1'
					severity='warning'
					message={remoteAttachmentNotice}
					armToken={remoteAttachmentNotice}
					onDismiss={() => { /* re-evaluated each render from attachments */ }}
				/>
			)}
			{remoteSubmitPending && (
				<RemoteSubmitProgress
					className='mx-1'
					stage={remoteSubmitStage}
					runnerName={activeRunnerName}
				/>
			)}
			{!remoteSubmitPending && (remoteSubmitError || (isRemoteTarget && !workspaceGit.loading && workspaceGit.error)) && (
				<RemoteSubmitAlert
					className='mx-1'
					message={remoteSubmitError ?? workspaceGit.error}
					armToken={remoteSubmitError ?? workspaceGit.error}
					onDismiss={() => setRemoteSubmitError(null)}
				/>
			)}
			{inputChatArea}
		</div>
	</div>

	const landingPageContent = <div
		ref={sidebarRef}
		className='w-full h-full max-h-full flex flex-col overflow-auto px-4'
	>
		<ErrorBoundary>
			{landingPageInput}
		</ErrorBoundary>

		<ErrorBoundary>
			<div className='pt-8 mb-2 text-void-fg-0 text-root select-none pointer-events-none'>Suggestions</div>
			{initiallySuggestedPromptsHTML}
		</ErrorBoundary>
	</div>


	// const threadPageContent = <div>
	// 	{/* Thread content */}
	// 	<div className='flex flex-col overflow-hidden'>
	// 		<div className={`overflow-hidden ${previousMessages.length === 0 ? 'h-0 max-h-0 pb-2' : ''}`}>
	// 			<ErrorBoundary>
	// 				{messagesHTML}
	// 			</ErrorBoundary>
	// 		</div>
	// 		<ErrorBoundary>
	// 			{inputForm}
	// 		</ErrorBoundary>
	// 	</div>
	// </div>
	const threadPageContent = <div
		ref={sidebarRef}
		className='w-full h-full flex flex-col overflow-hidden'
	>
		<ErrorBoundary>
			{messagesHTML}
		</ErrorBoundary>
		<ErrorBoundary>
			{threadPageInput}
		</ErrorBoundary>
	</div>


	return (
		<div className='w-full h-full flex flex-col overflow-hidden'>
			<TodoProvider
				threadId={threadId}
				initialTodos={chatThreadsState.allThreads[threadId]?.todoList}
				isAgentRunning={!!displayedRunningState}
			>
				<Fragment key={threadId} // force rerender when change thread
				>
					{isLandingPage ?
						landingPageContent
						: threadPageContent}
				</Fragment>
			</TodoProvider>
		</div>
	)
}
