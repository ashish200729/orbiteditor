/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Pencil, X, ChevronUp, ChevronDown } from 'lucide-react';
import { ChatMessage, StagingSelectionItem, TodoItem } from '../../../../../../common/chatThreadServiceTypes.js';
import { parseSlashTokenNames } from '../../../../../../common/slashCommands/slashTokens.js';
import { TodoMessageAttachment } from '../toolResults/todo/TodoMessageAttachment.js';
import { useAccessor, useRemoteTasks } from '../../../util/services.js';
import { focusInConnectedWindow, downscaleImageDataUrl } from '../../../util/helpers.js';
import { VoidInputBox2, TextAreaFns } from '../../../util/inputs.js';
import { SlashTokenContent } from '../../../util/slashMenu/SlashTokenContent.js';
import { VoidChatArea } from '../chat/orbitChatArea.js';
import { useConnectedDocument } from '../../contexts/ConnectedWindowContext.js';
import { SelectedFiles } from '../files/SelectedFiles.js';
import { IconX } from '../icons/IconX.js';
import { Checkpoint } from '../chatComponents/Checkpoint.js';
import { ChatScrollActions } from '../../utils/scrollUtils.js';
import { RunnerThreadCloudIcon } from '../runner/RunnerThreadCloudIcon.js';
import { TextQuoteCards } from '../chat/TextQuoteCards.js';

type ChatBubbleMode = 'display' | 'edit'

/** An image staged in edit mode. `id` is a stable React key (index keys reuse the wrong
 * DOM node on delete, and identical data-URLs would collide if keyed by content). */
type EditImage = { id: string; url: string }
let _editImageSeq = 0
const nextEditImageId = (): string => {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
	return c?.randomUUID?.() ?? `img-${Date.now()}-${(_editImageSeq++).toString(36)}`
}

export const UserMessageComponent = React.memo(({ chatMessage, messageIdx, isCheckpointGhost, currCheckpointIdx, checkpointBeforeIdx, isFirstUserMessage, threadId, scrollActions, threadTodos, isAgentRunning }: {
	chatMessage: ChatMessage & { role: 'user' };
	messageIdx: number;
	currCheckpointIdx: number | undefined;
	checkpointBeforeIdx: number | undefined;
	isFirstUserMessage: boolean;
	threadId: string;
	isCheckpointGhost: boolean;
	scrollActions: ChatScrollActions | null;
	threadTodos?: TodoItem[];
	isAgentRunning?: boolean;
}) => {

	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')
	const connectedDocument = useConnectedDocument()
	const remoteTasks = useRemoteTasks()
	const remoteIsRunning = remoteTasks.some(task => task.editorThreadId === threadId
		&& !['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LOST'].includes(task.state))
	const isRemoteUserTurn = remoteTasks.some(task =>
		task.editorThreadId === threadId
		&& (task.editorMessageIndex ?? 0) === messageIdx + 1
	)

	// global state
	let isBeingEdited = false
	let editingWindowId: number | undefined
	let stagingSelections: StagingSelectionItem[] = []
	let setIsBeingEdited = (_: boolean) => { }
	let setStagingSelections = (_: StagingSelectionItem[]) => { }

	if (messageIdx !== undefined) {
		const _state = chatThreadsService.getThreadMessageState(threadId, messageIdx)
		isBeingEdited = _state.isBeingEdited
		editingWindowId = _state.editingWindowId
		stagingSelections = _state.stagingSelections
		setIsBeingEdited = (v) => chatThreadsService.setThreadMessageState(threadId, messageIdx, {
			isBeingEdited: v,
			editingWindowId: v
				? (connectedDocument.defaultView as (Window & { vscodeWindowId?: number }) | null)?.vscodeWindowId
				: undefined,
		})
		setStagingSelections = (s) => chatThreadsService.setThreadMessageState(threadId, messageIdx, { stagingSelections: s })
	}


	// local state
	const connectedWindowId = (connectedDocument.defaultView as (Window & { vscodeWindowId?: number }) | null)?.vscodeWindowId
	// The same message is rendered in the IDE and Agents window. Only the window
	// that initiated editing should replace its bubble with the inline editor.
	const isBeingEditedHere = isBeingEdited && (editingWindowId === undefined || editingWindowId === connectedWindowId)
	const mode: ChatBubbleMode = isBeingEditedHere ? 'edit' : 'display'
	const [isFocused, setIsFocused] = useState(false)
	const [isHovered, setIsHovered] = useState(false)
	const [isDisabled, setIsDisabled] = useState(false)
	const [textAreaRefState, setTextAreaRef] = useState<HTMLTextAreaElement | null>(null)
	const textAreaFnsRef = useRef<TextAreaFns | null>(null)
	const [editImages, setEditImages] = useState<EditImage[]>([])
	const [editTextQuotes, setEditTextQuotes] = useState(() => chatMessage.textQuotes?.map(quote => ({ ...quote })) ?? [])
	// Text truncation state
	const [isExpanded, setIsExpanded] = useState(false)
	const [shouldTruncate, setShouldTruncate] = useState(false)
	const contentRef = useRef<HTMLDivElement | null>(null)
	// initialize on first render, and when edit was just enabled
	const _mustInitialize = useRef(true)
	const _justEnabledEdit = useRef(false)
	/** Composer `stagedSlashTokens` snapshot taken when edit opens; restored on cancel. */
	const stagedSlashTokensBeforeEditRef = useRef<string[] | undefined>(undefined)
	useEffect(() => {
		const canInitialize = mode === 'edit' && textAreaRefState
		const shouldInitialize = _justEnabledEdit.current || _mustInitialize.current
		if (canInitialize && shouldInitialize) {
			setStagingSelections(
				(chatMessage.selections || []).map(s => { // quick hack so we dont have to do anything more
					if (s.type === 'File') return { ...s, state: { ...s.state, wasAddedAsCurrentFile: false, } }
					else return s
				})
			)

			// Initialize images for edit mode
			setEditImages((chatMessage.images || []).map(url => ({ id: nextEditImageId(), url })))
			setEditTextQuotes(chatMessage.textQuotes?.map(quote => ({ ...quote })) ?? [])

			// Re-stage slash tokens that were injected when this message was originally sent.
			const present = new Set(parseSlashTokenNames(chatMessage.displayContent || ''))
			const injected = chatMessage.injectedSlashTokens ?? []
			chatThreadsService.setThreadState(threadId, {
				stagedSlashTokens: injected.filter(n => present.has(n)),
			})

			if (textAreaFnsRef.current)
				textAreaFnsRef.current.setValue(chatMessage.displayContent || '')

			// focusInConnectedWindow (not a bare .focus()) so entering edit mode inside the
			// Agents pop-out keeps that window frontmost instead of raising the main IDE window.
			// Both the IDE sidebar and Agents window observe the shared edit flag.
			// Only the surface where the user clicked Edit may claim focus; the other
			// mounted copy still initializes so it remains consistent and usable.
			if (_justEnabledEdit.current) {
				focusInConnectedWindow(textAreaRefState);
			}

			_justEnabledEdit.current = false
			_mustInitialize.current = false
		}

		// Ref `.current` values are intentionally excluded: mutating a ref doesn't
		// re-render, so listing them as deps is misleading and does nothing.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [chatMessage, mode, textAreaRefState])

	// Determine if truncation is needed based on content length and line breaks
	useEffect(() => {
		if (mode === 'display') {
			const content = chatMessage.displayContent || ''
			const lines = content.split('\n').length
			const avgCharsPerLine = 50 // approximate characters per line in the sidebar
			const estimatedLines = Math.max(lines, Math.ceil(content.length / avgCharsPerLine))

			// Truncate if content exceeds 3 lines
			setShouldTruncate(estimatedLines > 3 || content.length > 150)
		}
	}, [chatMessage.displayContent, mode])

	const onOpenEdit = () => {
		if (remoteIsRunning) return
		stagedSlashTokensBeforeEditRef.current = [
			...(chatThreadsService.getThread(threadId)?.state.stagedSlashTokens ?? []),
		]
		setIsBeingEdited(true)
		chatThreadsService.setThreadFocusedMessageIdx(threadId, messageIdx)
		_justEnabledEdit.current = true
	}
	const onCloseEdit = () => {
		setIsFocused(false)
		setIsHovered(false)
		setIsBeingEdited(false)
		chatThreadsService.setThreadFocusedMessageIdx(threadId, undefined)
		_mustInitialize.current = true
		if (stagedSlashTokensBeforeEditRef.current !== undefined) {
			chatThreadsService.setThreadState(threadId, {
				stagedSlashTokens: [...stagedSlashTokensBeforeEditRef.current],
			})
			stagedSlashTokensBeforeEditRef.current = undefined
		}
	}

	const EditSymbol = mode === 'display' ? Pencil : X

	// Hooks must not be conditional: define edit image handlers outside mode branches
	const handleEditImageSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		const files = e.target.files
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

		// allSettled, not all: one unreadable file must not discard the images that read fine.
		Promise.allSettled(imagePromises).then((results) => {
			const ok = results
				.filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
				.map(r => r.value)
			if (ok.length > 0) setEditImages(prev => [...prev, ...ok.map(url => ({ id: nextEditImageId(), url }))])
			const failed = results.filter(r => r.status === 'rejected')
			if (failed.length > 0) console.error('Error reading image files:', failed.map(r => (r as PromiseRejectedResult).reason))
		})

		e.target.value = ''
	}, [])

	const removeEditImage = useCallback((id: string) => {
		setEditImages(prev => prev.filter(im => im.id !== id))
	}, [])

	const onEditChangeText = useCallback((text: string) => {
		setIsDisabled(!text)
	}, [])


	let chatbubbleContents: React.ReactNode
	if (mode === 'display') {
		chatbubbleContents = <>
			<TextQuoteCards quotes={chatMessage.textQuotes ?? []} compact />
			<SelectedFiles type='past' messageIdx={messageIdx} selections={chatMessage.selections || []} />
			{/* Display images if present */}
			{chatMessage.images && chatMessage.images.length > 0 && (
				<div className='flex flex-wrap gap-1.5 px-0.5 mb-1'>
					{chatMessage.images.map((imageUrl, index) => (
						<img
							key={index}
							src={imageUrl}
							alt={`Image ${index + 1}`}
							className='w-12 h-12 object-cover rounded border border-void-border-3 shadow-sm'
						/>
					))}
				</div>
			)}
			<div className='px-0.5'>
				<div
					ref={contentRef}
					className={`whitespace-pre-wrap leading-relaxed ${!isExpanded && shouldTruncate ? 'overflow-hidden' : ''}`}
					style={{
						// Prefer max-height over -webkit-box/line-clamp — the latter shatters
						// native ::selection into overlapping line bars.
						maxHeight: !isExpanded && shouldTruncate ? '4.5em' : undefined,
						overflowWrap: 'break-word',
						wordBreak: 'break-word',
					}}
				>
					<SlashTokenContent text={chatMessage.displayContent || ''} />
				</div>
				{shouldTruncate && (
					<button
						onClick={(e) => {
							e.stopPropagation()
							setIsExpanded(!isExpanded)
						}}
						className='text-[11px] text-void-fg-3 hover:text-void-fg-2 transition-colors mt-0.5 flex items-center gap-0.5 cursor-pointer'
					>
						{isExpanded ? (
							<>
								<ChevronUp size={12} />
								<span>Show less</span>
							</>
						) : (
							<>
								<ChevronDown size={12} />
								<span>Show more</span>
							</>
						)}
				</button>
			)}
		</div>
		{isAgentRunning && (
			<div className="mt-2 pt-1.5 border-t border-void-border-2 w-full min-w-0 -mx-0.5 px-0.5">
				<TodoMessageAttachment />
			</div>
		)}
	</>
}
	else if (mode === 'edit') {

		const onSubmit = async () => {

			if (isDisabled && editTextQuotes.length === 0) return;
			if (!textAreaRefState) return;
			if (messageIdx === undefined) return;

			// cancel any streams on this thread
			await chatThreadsService.abortRunning(threadId)

			// update state
			setIsBeingEdited(false)
			chatThreadsService.setThreadFocusedMessageIdx(threadId, undefined)
			stagedSlashTokensBeforeEditRef.current = undefined // submit consumes tokens; don't restore composer snapshot

			// stream the edit
			const userMessage = textAreaRefState.value;
			try {
				// Images are preserved from the original message when editing
				// The editUserMessageAndStreamResponse method automatically preserves images
				await chatThreadsService.editUserMessageAndStreamResponse({ userMessage, messageIdx, threadId, _textQuotes: editTextQuotes })
			} catch (e) {
				console.error('Error while editing message:', e)
			}
			// Focus the composer in the same connected document. A thread can be
			// mounted in the IDE and Agents window simultaneously, so the service's
			// legacy single mounted ref is not sufficient to choose the right surface.
			connectedDocument.defaultView?.requestAnimationFrame(() => {
				const composer = connectedDocument.querySelector<HTMLTextAreaElement>(
					'textarea[data-orbit-thread-composer="true"]',
				)
				focusInConnectedWindow(composer)
				scrollActions?.scrollToTurnAnchor()
			})
		}

		const onAbort = async () => {
			await chatThreadsService.abortRunning(threadId)
		}

		const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === 'Escape') {
				onCloseEdit()
			}
			if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
				onSubmit()
			}
		}

		if (!chatMessage.content && editTextQuotes.length === 0) { // quote-only turns remain editable.
			return null
		}

		chatbubbleContents = <VoidChatArea
			featureName='Chat'
			onSubmit={onSubmit}
			onAbort={onAbort}
			isStreaming={false}
			isDisabled={isDisabled && editTextQuotes.length === 0}
			showSelections={true}
			showProspectiveSelections={false}
			selections={stagingSelections}
			setSelections={setStagingSelections}
		>
			<TextQuoteCards quotes={editTextQuotes} onRemove={id => setEditTextQuotes(current => current.filter(quote => quote.id !== id))} />
			<VoidInputBox2
				key={`edit-${messageIdx}`}
				enableAtToMention
				enableSlashCommands
				threadId={threadId}
				initValue={chatMessage.displayContent || ''}
				ref={setTextAreaRef}
				className='min-h-[81px] max-h-[500px] px-0.5 py-0.5'
				placeholder="Edit your message..."
				onChangeText={onEditChangeText}
				onFocus={() => {
					setIsFocused(true)
					chatThreadsService.setThreadFocusedMessageIdx(threadId, messageIdx);
				}}
				onBlur={() => {
					setIsFocused(false)
				}}
				onKeyDown={onKeyDown}
				fnsRef={textAreaFnsRef}
				multiline={true}
			/>

			{/* Image upload and preview for edit mode */}
			<div className='flex flex-col gap-1 mt-1'>
				{editImages.length > 0 && (
					<div className='flex flex-wrap gap-1.5'>
						{editImages.map((im, index) => (
							<div key={im.id} className='relative'>
								<img
									src={im.url}
									alt={`Edit ${index + 1}`}
									className='w-12 h-12 object-cover rounded border border-void-border-3 shadow-sm'
								/>
								<button
									type='button'
									onClick={() => removeEditImage(im.id)}
									className='absolute -top-1 -right-1 bg-void-bg-3 rounded-full p-0.5 hover:brightness-125 cursor-pointer shadow-sm'
								>
									<IconX size={12} className='stroke-[2]' />
								</button>
							</div>
						))}
					</div>
				)}
				<label className='cursor-pointer text-xs text-void-fg-3 hover:text-void-fg-2 inline-flex items-center gap-1'>
					<input
						type='file'
						accept='image/*'
						multiple
						onChange={handleEditImageSelect}
						className='hidden'
					/>
					<svg width={14} height={14} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={2}>
						<rect x='3' y='3' width='18' height='18' rx='2' ry='2' />
						<circle cx='8.5' cy='8.5' r='1.5' />
						<polyline points='21 15 16 10 5 21' />
					</svg>
					Add image{editImages.length > 0 ? ` (${editImages.length})` : ''}
				</label>
			</div>
		</VoidChatArea>
	}

	const isMsgAfterCheckpoint = currCheckpointIdx !== undefined && currCheckpointIdx === messageIdx - 1

	const isMessageGhosted = isCheckpointGhost && !isMsgAfterCheckpoint;

	return <div
		data-role="user"
		className="relative break-words w-full"
	>
		{checkpointBeforeIdx !== undefined && (
			<Checkpoint
				threadId={threadId}
				userMessageIdx={messageIdx}
				checkpointIdx={checkpointBeforeIdx}
				currCheckpointIdx={currCheckpointIdx}
				isFirstUserMessage={isFirstUserMessage}
			/>
		)}
		<div
			// align chatbubble according to role
			className={`
        relative break-words
        ${mode === 'edit' ? 'w-full max-w-full'
				: mode === 'display' ? 'w-full whitespace-pre-wrap' : ''
			}
        ${isMessageGhosted ? 'opacity-50 pointer-events-none' : ''}
    `}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
		>
		<div
			// style chatbubble according to role
			className={`
            text-left rounded-xl max-w-full
			${mode === 'edit' ? ''
					: mode === 'display' ? `relative p-2 flex flex-col bg-vscode-input-bg text-void-fg-1 overflow-x-auto ${remoteIsRunning ? 'cursor-default' : 'cursor-pointer'} border border-void-border-2 shadow-sm` : ''
				}
        `}
			onClick={() => {
				if (mode !== 'display' || remoteIsRunning) return
				// Don't hijack a text selection — copying your own message text requires
				// finishing a selection inside the bubble without entering edit mode.
				if (connectedDocument.getSelection()?.toString()) return
				onOpenEdit()
			}}
		>
			{mode === 'display' && isRemoteUserTurn && (
				<RunnerThreadCloudIcon
					size={11}
					className="absolute top-1.5 right-1.5 opacity-50 pointer-events-none"
				/>
			)}
			{chatbubbleContents}
		</div>
		<div
			className="absolute -top-1 -right-1 translate-x-0 -translate-y-0 z-1"
		// data-tooltip-id='void-tooltip'
		// data-tooltip-content='Edit message'
		// data-tooltip-place='left'
		>
			<EditSymbol
				size={18}
				className={`
                    cursor-pointer
                    p-[2px]
                    bg-void-bg-1 border border-void-border-1 rounded-md
                    transition-opacity duration-200 ease-in-out
                    ${isHovered || (isFocused && mode === 'edit') ? 'opacity-100' : 'opacity-0'}
                `}
				onClick={() => {
					if (mode === 'display') {
						onOpenEdit()
					} else if (mode === 'edit') {
						onCloseEdit()
					}
				}}
			/>
		</div>
		</div>
	</div>

});
