/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { Fragment, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Services and hooks
import { useAccessor, useChatThreadsState, useThreadRunningState, useSettingsState, useCommandBarState, useMCPServiceState, useQueuedUserMessages, useIsQueuePaused } from '../util/services.js';

// Common imports
import { URI } from '../../../../../../../base/common/uri.js';
import { ChatMessage, StagingSelectionItem } from '../../../../common/chatThreadServiceTypes.js';
import { isFeatureNameDisabled } from '../../../../common/orbitSettingsTypes.js';
import { isABuiltinToolName } from '../../../../common/prompt/prompts.js';

import { TextAreaFns, VoidInputBox2 } from '../util/inputs.js';
import { focusInConnectedWindow, downscaleImageDataUrl } from '../util/helpers.js';
import { getConnectedWindow } from '../util/connectedWindow.js';
import { VOID_CTRL_L_ACTION_ID } from '../../../actionIDs.js';
import { VOID_OPEN_SETTINGS_ACTION_ID } from '../../../orbitSettingsPane.js';

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
import {
	VOID_MESSAGE_QUEUE,
	VOID_MESSAGE_QUEUE_ACTION,
	VOID_MESSAGE_QUEUE_COUNT,
	VOID_MESSAGE_QUEUE_HEADER,
	VOID_MESSAGE_QUEUE_ITEM,
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

export const SidebarChat = () => {
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

	const currentThread = chatThreadsService.getCurrentThread()
	const previousMessages = currentThread?.messages ?? []

	const selections = currentThread.state.stagingSelections
	const setSelections = (s: StagingSelectionItem[]) => { chatThreadsService.setCurrentThreadState({ stagingSelections: s }) }

	const threadId = currentThread.id
	const isRunning = useThreadRunningState(threadId)
	const queuedMessages = useQueuedUserMessages(threadId)
	const isQueuePaused = useIsQueuePaused(threadId)

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
	// State for drag and drop visual feedback
	const [isDragOver, setIsDragOver] = useState(false)

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

		const threadId = chatThreadsService.state.currentThreadId

		// send message to LLM
		const userMessage = _forceSubmit || textAreaRef.current?.value || ''
		const imagesToSend = _images ?? images.map(im => im.url)

		// Snapshot the staged selections NOW. Staging is cleared right after submit (below), and while
		// the agent is running this message may be QUEUED — the queued entry must carry its own context
		// snapshot rather than falling back to whatever is staged when it later drains.
		const selectionsSnapshot = chatThreadsService.state.allThreads[threadId]?.state.stagingSelections ?? []

		try {
			await chatThreadsService.addUserMessageAndStreamResponse({ userMessage, _chatSelections: selectionsSnapshot, _images: imagesToSend.length > 0 ? imagesToSend : undefined, threadId })
		} catch (e) {
			console.error('Error while sending message in chat:', e)
		}

		setSelections([]) // clear staging
		setImages([]) // clear images
		textAreaFnsRef.current?.setValue('')
		focusInConnectedWindow(textAreaRef.current) // focus input after submit (keeps Agents pop-out frontmost)

	}, [chatThreadsService, isDisabled, textAreaRef, textAreaFnsRef, setSelections, settingsState, images])

	const onAbort = useCallback(async () => {
		const threadId = currentThread.id
		await chatThreadsService.abortRunning(threadId)
	}, [currentThread.id, chatThreadsService])

	const keybindingString = accessor.get('IKeybindingService').lookupKeybinding(VOID_CTRL_L_ACTION_ID)?.getLabel()

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
		isRunning: !!isRunning,
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
		key={'messages' + chatThreadsState.currentThreadId}
		threadId={threadId}
		previousMessages={previousMessages}
		currCheckpointIdx={currCheckpointIdx}
		isRunning={isRunning}
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
		className="flex flex-col justify-start px-4 pb-3 w-full flex-1 min-h-0 overflow-x-hidden overflow-y-auto"
	/>


	const onChangeText = useCallback((newStr: string) => {
		setInstructionsAreEmpty(!newStr)
	}, [setInstructionsAreEmpty])
	const onKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
			onSubmit()
		} else if (e.key === 'Escape' && isRunning) {
			onAbort()
		}
	}, [onSubmit, onAbort, isRunning])

	// Handle image file selection
	const handleImageSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		processImageFiles(e.target.files)
		// Reset input
		e.target.value = ''
	}, [processImageFiles])

	// Handle paste event for images
	const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
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
	}, [processImageFiles])

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
		// Simple Browser editor in the main IDE. Detect the agents window by the
		// composer's connected window differing from the main renderer window.
		const node = chatAreaRef.current
		const inAgentWindow = !!node && getConnectedWindow(node) !== window && agentWindowService.isOpen()
		if (inAgentWindow) {
			agentWindowService.requestWorkspacePanel('browser', url)
			return
		}
		commandService.executeCommand('simpleBrowser.show', url)
	}, [commandService, agentWindowService])

	const inputChatArea = <VoidChatArea
		featureName='Chat'
		onSubmit={() => onSubmit()}
		onAbort={onAbort}
		isStreaming={!!isRunning}
		isDisabled={isDisabled}
		hasMessageToSubmit={!instructionsAreEmpty}
		showSelections={true}
		// showProspectiveSelections={previousMessagesHTML.length === 0}
		selections={selections}
		setSelections={setSelections}
		onClickAnywhere={() => { focusInConnectedWindow(textAreaRef.current) }}
		divRef={chatAreaRef}
		imageButton={
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
		}
		onDragEnter={dragHandlers.handleDragEnter}
		onDragOver={dragHandlers.handleDragOver}
		onDragLeave={dragHandlers.handleDragLeave}
		onDrop={dragHandlers.handleDrop}
		isDragOver={isDragOver}
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
				placeholder={`@ to mention, / for commands, ${keybindingString ? `${keybindingString} to add a selection. ` : ''}Enter instructions...`}
				onChangeText={onChangeText}
				onKeyDown={onKeyDown}
				onFocus={() => { chatThreadsService.setCurrentlyFocusedMessageIdx(undefined) }}
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
						<div key={im.id} className='relative'>
							<img
								src={im.url}
								alt={`Upload ${index + 1}`}
								className='w-12 h-12 object-cover rounded border border-void-border-3 shadow-sm'
							/>
							<button
								type='button'
								onClick={() => removeImage(im.id)}
								className='absolute -top-1 -right-1 bg-void-bg-3 rounded-full p-0.5 hover:brightness-125 cursor-pointer shadow-sm'
							>
								<IconX size={12} className='stroke-[2]' />
							</button>
						</div>
					))}
				</div>
			)}
		</div>

	</VoidChatArea>


	const isLandingPage = previousMessages.length === 0


	const initiallySuggestedPromptsHTML = <div className='flex flex-col gap-2 w-full text-nowrap text-void-fg-0 select-none'>
		{[
			'Summarize my codebase',
			'How do types work in Rust?',
			'Create a .orbitrules file for me'
		].map((text, index) => (
			<div
				key={index}
				className='py-1 px-2 rounded text-sm bg-zinc-700/5 hover:bg-zinc-700/10 dark:bg-zinc-300/5 dark:hover:bg-zinc-300/10 cursor-pointer opacity-80 hover:opacity-100'
				onClick={() => onSubmit(text)}
			>
				{text}
			</div>
		))}
	</div>



	const queuedMessagesHTML = queuedMessages.length === 0 ? null : <section className={VOID_MESSAGE_QUEUE} aria-label='Queued messages'>
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
		<div role='list' className='flex flex-col gap-1'>
			{queuedMessages.map((q, i) => {
				const attachmentCount = (q._chatSelections?.length ?? 0) + (q._images?.length ?? 0)
				return (
					<div key={i} role='listitem' className={VOID_MESSAGE_QUEUE_ITEM}>
						<span className={`${VOID_MESSAGE_QUEUE_POSITION} select-none`} aria-hidden='true'>{i + 1}</span>
						<span className='truncate flex-1 min-w-0'>{q.userMessage}</span>
						{attachmentCount > 0 && <span className='shrink-0 text-void-fg-4 text-[11px] select-none' title={`${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}`}>{attachmentCount} file{attachmentCount === 1 ? '' : 's'}</span>}
						<button
							type='button'
							className={`${VOID_MESSAGE_QUEUE_ACTION} shrink-0`}
							onClick={() => chatThreadsService.removeQueuedUserMessage(threadId, i)}
							aria-label='Remove queued message'
						>
							<IconX size={12} className='stroke-[2]' />
						</button>
					</div>
				)
			})}
		</div>
	</section>

	const threadPageInput = <div key={'input' + chatThreadsState.currentThreadId} className='shrink-0'>
		<div className='px-4'>
			<CommandBarInChat />
		</div>
		{queuedMessagesHTML}
		<div className='px-2 pb-2'>
			{inputChatArea}
		</div>
	</div>

	const landingPageInput = <div>
		<div className='pt-8'>
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
		<TodoProvider
			threadId={threadId}
			initialTodos={chatThreadsState.allThreads[threadId]?.todoList}
			isAgentRunning={!!isRunning}
		>
			<Fragment key={threadId} // force rerender when change thread
			>
				{isLandingPage ?
					landingPageContent
					: threadPageContent}
			</Fragment>
		</TodoProvider>
	)
}
