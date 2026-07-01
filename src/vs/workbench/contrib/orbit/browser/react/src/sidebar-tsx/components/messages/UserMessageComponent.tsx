/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Pencil, X, ChevronUp, ChevronDown } from 'lucide-react';
import { ChatMessage, StagingSelectionItem, TodoItem } from '../../../../../../common/chatThreadServiceTypes.js';
import { parseSlashTokenNames } from '../../../../../../common/slashCommands/slashTokens.js';
import { TodoMessageAttachment } from '../toolResults/todo/TodoMessageAttachment.js';
import { useAccessor } from '../../../util/services.js';
import { VoidInputBox2, TextAreaFns } from '../../../util/inputs.js';
import { SlashTokenContent } from '../../../util/slashMenu/SlashTokenContent.js';
import { VoidChatArea } from '../chat/orbitChatArea.js';
import { SelectedFiles } from '../files/SelectedFiles.js';
import { IconX } from '../icons/IconX.js';
import { Checkpoint } from '../chatComponents/Checkpoint.js';
import { ChatScrollActions } from '../../utils/scrollUtils.js';

type ChatBubbleMode = 'display' | 'edit'

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

	// global state
	let isBeingEdited = false
	let stagingSelections: StagingSelectionItem[] = []
	let setIsBeingEdited = (_: boolean) => { }
	let setStagingSelections = (_: StagingSelectionItem[]) => { }

	if (messageIdx !== undefined) {
		const _state = chatThreadsService.getCurrentMessageState(messageIdx)
		isBeingEdited = _state.isBeingEdited
		stagingSelections = _state.stagingSelections
		setIsBeingEdited = (v) => chatThreadsService.setCurrentMessageState(messageIdx, { isBeingEdited: v })
		setStagingSelections = (s) => chatThreadsService.setCurrentMessageState(messageIdx, { stagingSelections: s })
	}


	// local state
	const mode: ChatBubbleMode = isBeingEdited ? 'edit' : 'display'
	const [isFocused, setIsFocused] = useState(false)
	const [isHovered, setIsHovered] = useState(false)
	const [isDisabled, setIsDisabled] = useState(false)
	const [textAreaRefState, setTextAreaRef] = useState<HTMLTextAreaElement | null>(null)
	const textAreaFnsRef = useRef<TextAreaFns | null>(null)
	const [editImages, setEditImages] = useState<string[]>([])
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
			setEditImages(chatMessage.images || [])

			// Re-stage slash tokens that were injected when this message was originally sent.
			const present = new Set(parseSlashTokenNames(chatMessage.displayContent || ''))
			const injected = chatMessage.injectedSlashTokens ?? []
			chatThreadsService.setCurrentThreadState({
				stagedSlashTokens: injected.filter(n => present.has(n)),
			})

			if (textAreaFnsRef.current)
				textAreaFnsRef.current.setValue(chatMessage.displayContent || '')

			textAreaRefState.focus();

			_justEnabledEdit.current = false
			_mustInitialize.current = false
		}

	}, [chatMessage, mode, _justEnabledEdit, textAreaRefState, textAreaFnsRef.current, _justEnabledEdit.current, _mustInitialize.current])

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
		stagedSlashTokensBeforeEditRef.current = [
			...(chatThreadsService.getCurrentThreadState().stagedSlashTokens ?? []),
		]
		setIsBeingEdited(true)
		chatThreadsService.setCurrentlyFocusedMessageIdx(messageIdx)
		_justEnabledEdit.current = true
	}
	const onCloseEdit = () => {
		setIsFocused(false)
		setIsHovered(false)
		setIsBeingEdited(false)
		chatThreadsService.setCurrentlyFocusedMessageIdx(undefined)
		_mustInitialize.current = true
		if (stagedSlashTokensBeforeEditRef.current !== undefined) {
			chatThreadsService.setCurrentThreadState({
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
					resolve(dataUrl)
				}
				reader.onerror = reject
				reader.readAsDataURL(file)
			})
			imagePromises.push(promise)
		}

		Promise.all(imagePromises).then((dataUrls) => {
			setEditImages(prev => [...prev, ...dataUrls])
		}).catch((error) => {
			console.error('Error reading image files:', error)
		})

		e.target.value = ''
	}, [])

	const removeEditImage = useCallback((index: number) => {
		setEditImages(prev => prev.filter((_, i) => i !== index))
	}, [])

	const onEditChangeText = useCallback((text: string) => {
		setIsDisabled(!text)
	}, [])


	let chatbubbleContents: React.ReactNode
	if (mode === 'display') {
		chatbubbleContents = <>
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
					className={`whitespace-pre-wrap leading-relaxed transition-all duration-300 ease-in-out ${!isExpanded && shouldTruncate ? 'line-clamp-3' : ''}`}
					style={{
						display: !isExpanded && shouldTruncate ? '-webkit-box' : 'block',
						WebkitLineClamp: !isExpanded && shouldTruncate ? '3' : 'unset',
						WebkitBoxOrient: !isExpanded && shouldTruncate ? 'vertical' as const : undefined,
						overflow: !isExpanded && shouldTruncate ? 'hidden' : 'visible',
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

			if (isDisabled) return;
			if (!textAreaRefState) return;
			if (messageIdx === undefined) return;

			// cancel any streams on this thread
			const threadId = chatThreadsService.state.currentThreadId

			await chatThreadsService.abortRunning(threadId)

			// update state
			setIsBeingEdited(false)
			chatThreadsService.setCurrentlyFocusedMessageIdx(undefined)
			stagedSlashTokensBeforeEditRef.current = undefined // submit consumes tokens; don't restore composer snapshot

			// stream the edit
			const userMessage = textAreaRefState.value;
			try {
				// Images are preserved from the original message when editing
				// The editUserMessageAndStreamResponse method automatically preserves images
				await chatThreadsService.editUserMessageAndStreamResponse({ userMessage, messageIdx, threadId })
			} catch (e) {
				console.error('Error while editing message:', e)
			}
			await chatThreadsService.focusCurrentChat()
			requestAnimationFrame(() => scrollActions?.scrollToTurnAnchor())
		}

		const onAbort = async () => {
			const threadId = chatThreadsService.state.currentThreadId
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

		if (!chatMessage.content) { // don't show if empty and not loading (if loading, want to show).
			return null
		}

		chatbubbleContents = <VoidChatArea
			featureName='Chat'
			onSubmit={onSubmit}
			onAbort={onAbort}
			isStreaming={false}
			isDisabled={isDisabled}
			showSelections={true}
			showProspectiveSelections={false}
			selections={stagingSelections}
			setSelections={setStagingSelections}
		>
			<VoidInputBox2
				key={`edit-${messageIdx}`}
				enableAtToMention
				enableSlashCommands
				initValue={chatMessage.displayContent || ''}
				ref={setTextAreaRef}
				className='min-h-[81px] max-h-[500px] px-0.5 py-0.5'
				placeholder="Edit your message..."
				onChangeText={onEditChangeText}
				onFocus={() => {
					setIsFocused(true)
					chatThreadsService.setCurrentlyFocusedMessageIdx(messageIdx);
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
						{editImages.map((imageUrl, index) => (
							<div key={index} className='relative'>
								<img
									src={imageUrl}
									alt={`Edit ${index + 1}`}
									className='w-12 h-12 object-cover rounded border border-void-border-3 shadow-sm'
								/>
								<button
									type='button'
									onClick={() => removeEditImage(index)}
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
					: mode === 'display' ? 'p-2 flex flex-col bg-vscode-input-bg text-void-fg-1 overflow-x-auto cursor-pointer border border-void-border-2 shadow-sm' : ''
				}
        `}
			onClick={() => { if (mode === 'display') { onOpenEdit() } }}
		>
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
