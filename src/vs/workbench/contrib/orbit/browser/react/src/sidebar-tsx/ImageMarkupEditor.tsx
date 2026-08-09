/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { PointerEvent as ReactPointerEvent, useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Redo2, Undo2, X } from 'lucide-react'
import { focusInConnectedWindow } from '../util/helpers.js'
import { useConnectedDocument } from './contexts/ConnectedWindowContext.js'
import {
	commitMarkupStroke,
	createMarkupHistory,
	imageMarkupOutputType,
	isValidImageMarkupOutput,
	redoMarkupStroke,
	type MarkupHistory as History,
	type MarkupPoint as Point,
	type MarkupStroke as Stroke,
	undoMarkupStroke,
} from '../../../../common/imageMarkupEditorModel.js'

export type ImageMarkupEditorProps = {
	imageUrl: string
	imageIndex: number
	onCancel: () => void
	onSave: (imageUrl: string) => void
}

const ANNOTATION_COLORS = [
	{ value: '#ef4444', label: 'Red', checkColor: '#ffffff' },
	{ value: '#f59e0b', label: 'Amber', checkColor: '#111827' },
	{ value: '#3b82f6', label: 'Blue', checkColor: '#ffffff' },
	{ value: '#111827', label: 'Black', checkColor: '#ffffff' },
	{ value: '#f8fafc', label: 'White', checkColor: '#111827' },
] as const

const BRUSH_SIZES = [3, 6, 10] as const

const getFocusableElements = (root: HTMLElement): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
)).filter(element => !element.hasAttribute('hidden') && element.getClientRects().length > 0)

const drawStroke = (ctx: CanvasRenderingContext2D, stroke: Stroke) => {
	const first = stroke.points[0]
	if (!first) return

	ctx.save()
	ctx.strokeStyle = stroke.color
	ctx.fillStyle = stroke.color
	ctx.lineWidth = stroke.width
	ctx.lineCap = 'round'
	ctx.lineJoin = 'round'

	if (stroke.points.length === 1) {
		ctx.beginPath()
		ctx.arc(first.x, first.y, stroke.width / 2, 0, Math.PI * 2)
		ctx.fill()
		ctx.restore()
		return
	}

	ctx.beginPath()
	ctx.moveTo(first.x, first.y)
	for (let i = 1; i < stroke.points.length; i++) {
		ctx.lineTo(stroke.points[i].x, stroke.points[i].y)
	}
	ctx.stroke()
	ctx.restore()
}

export const ImageMarkupEditor = ({ imageUrl, imageIndex, onCancel, onSave }: ImageMarkupEditorProps) => {
	const connectedDocument = useConnectedDocument()
	const titleId = useId()
	const descriptionId = useId()
	const dialogRef = useRef<HTMLDivElement | null>(null)
	const canvasRef = useRef<HTMLCanvasElement | null>(null)
	const sourceImageRef = useRef<HTMLImageElement | null>(null)
	const activeStrokeRef = useRef<Stroke | null>(null)
	const activePointerIdRef = useRef<number | null>(null)
	const previousFocusRef = useRef<HTMLElement | null>(null)

	const [history, setHistory] = useState<History>(createMarkupHistory)
	const [brushColor, setBrushColor] = useState<string>(ANNOTATION_COLORS[0].value)
	const [brushSize, setBrushSize] = useState<number>(BRUSH_SIZES[1])
	const [isReady, setIsReady] = useState(false)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [saveError, setSaveError] = useState<string | null>(null)

	const renderCanvas = useCallback((strokes: readonly Stroke[]) => {
		const canvas = canvasRef.current
		const image = sourceImageRef.current
		if (!canvas || !image || !canvas.width || !canvas.height) return

		const ctx = canvas.getContext('2d')
		if (!ctx) return
		ctx.clearRect(0, 0, canvas.width, canvas.height)
		ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
		for (const stroke of strokes) drawStroke(ctx, stroke)
	}, [])

	useEffect(() => {
		setHistory(createMarkupHistory())
		setIsReady(false)
		setLoadError(null)
		setSaveError(null)

		const ImageConstructor = connectedDocument.defaultView?.Image ?? globalThis.Image
		const image = new ImageConstructor()
		let disposed = false
		image.onload = () => {
			if (disposed) return
			const canvas = canvasRef.current
			if (!canvas || !image.naturalWidth || !image.naturalHeight) {
				setLoadError('This image could not be opened. Cancel and attach it again.')
				return
			}
			if (!canvas.getContext('2d')) {
				setLoadError('Drawing is unavailable in this window. Cancel and attach the image again.')
				return
			}
			canvas.width = image.naturalWidth
			canvas.height = image.naturalHeight
			sourceImageRef.current = image
			renderCanvas([])
			setIsReady(true)
		}
		image.onerror = () => {
			if (!disposed) setLoadError('This image could not be opened. Cancel and attach it again.')
		}
		image.src = imageUrl

		return () => {
			disposed = true
			image.onload = null
			image.onerror = null
			sourceImageRef.current = null
		}
	}, [connectedDocument, imageUrl, renderCanvas])

	useEffect(() => {
		if (isReady && !activeStrokeRef.current) renderCanvas(history.strokes)
	}, [history.strokes, isReady, renderCanvas])

	const undo = useCallback(() => setHistory(undoMarkupStroke), [])

	const redo = useCallback(() => setHistory(redoMarkupStroke), [])

	const save = useCallback(() => {
		if (!isReady) return
		setSaveError(null)
		const canvas = canvasRef.current
		if (!canvas) {
			setSaveError('The image editor is unavailable. Cancel and attach the image again.')
			return
		}

		const activeStroke = activeStrokeRef.current
		const activePointerId = activePointerIdRef.current
		activeStrokeRef.current = null
		activePointerIdRef.current = null
		if (activePointerId !== null && canvas.hasPointerCapture(activePointerId)) {
			try {
				canvas.releasePointerCapture(activePointerId)
			} catch {
				// The browser may already have released capture while processing the shortcut.
			}
		}

		const strokes = activeStroke?.points.length
			? [...history.strokes, activeStroke]
			: history.strokes
		if (activeStroke?.points.length) {
			// Preserve the in-progress mark if encoding fails and the dialog stays open.
			setHistory(current => commitMarkupStroke(current, activeStroke))
		}

		try {
			if (strokes.length === 0) {
				onSave(imageUrl)
				return
			}
			renderCanvas(strokes)
			const output = canvas.toDataURL(imageMarkupOutputType(imageUrl), 0.92)
			if (!isValidImageMarkupOutput(output)) {
				throw new Error('Canvas returned an invalid image data URL.')
			}
			onSave(output)
		} catch (error) {
			console.error('Error saving annotated image:', error)
			setSaveError('The marked-up image could not be saved. Try again, or cancel and attach it again.')
		}
	}, [history.strokes, imageUrl, isReady, onSave, renderCanvas])

	useEffect(() => {
		const activeElement = connectedDocument.activeElement
		previousFocusRef.current = activeElement && 'focus' in activeElement
			? activeElement as HTMLElement
			: null
		const previousOverflow = connectedDocument.body.style.overflow
		connectedDocument.body.style.overflow = 'hidden'
		const connectedWindow = connectedDocument.defaultView
		const focusFrame = connectedWindow?.requestAnimationFrame(() => focusInConnectedWindow(dialogRef.current))

		return () => {
			if (focusFrame !== undefined) connectedWindow?.cancelAnimationFrame(focusFrame)
			connectedDocument.body.style.overflow = previousOverflow
			focusInConnectedWindow(previousFocusRef.current)
		}
	}, [connectedDocument])

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault()
				event.stopPropagation()
				onCancel()
				return
			}

			const modifier = event.metaKey || event.ctrlKey
			if (modifier && event.key.toLowerCase() === 'z') {
				event.preventDefault()
				event.stopPropagation()
				if (event.shiftKey) redo()
				else undo()
				return
			}
			if (modifier && event.key.toLowerCase() === 'y') {
				event.preventDefault()
				event.stopPropagation()
				redo()
				return
			}
			if (modifier && event.key === 'Enter') {
				event.preventDefault()
				event.stopPropagation()
				save()
				return
			}
			if (event.key !== 'Tab' || !dialogRef.current) return

			const focusable = getFocusableElements(dialogRef.current)
			if (focusable.length === 0) {
				event.preventDefault()
				focusInConnectedWindow(dialogRef.current)
				return
			}
			const first = focusable[0]
			const last = focusable[focusable.length - 1]
			const activeElement = connectedDocument.activeElement
			if (activeElement === dialogRef.current || !dialogRef.current.contains(activeElement)) {
				event.preventDefault()
				if (event.shiftKey) focusInConnectedWindow(last)
				else focusInConnectedWindow(first)
			} else if (event.shiftKey && activeElement === first) {
				event.preventDefault()
				focusInConnectedWindow(last)
			} else if (!event.shiftKey && activeElement === last) {
				event.preventDefault()
				focusInConnectedWindow(first)
			}
		}

		connectedDocument.addEventListener('keydown', handleKeyDown, true)
		return () => connectedDocument.removeEventListener('keydown', handleKeyDown, true)
	}, [connectedDocument, onCancel, redo, save, undo])

	const pointFromPointer = useCallback((event: PointerEvent): Point | null => {
		const canvas = canvasRef.current
		if (!canvas) return null
		const rect = canvas.getBoundingClientRect()
		if (!rect.width || !rect.height) return null
		return {
			x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / rect.width)),
			y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / rect.height)),
		}
	}, [])

	const drawActiveSegment = useCallback((point: Point) => {
		const canvas = canvasRef.current
		const stroke = activeStrokeRef.current
		if (!canvas || !stroke) return
		const ctx = canvas.getContext('2d')
		if (!ctx) return

		const previous = stroke.points[stroke.points.length - 1]
		stroke.points.push(point)
		if (!previous) {
			drawStroke(ctx, stroke)
			return
		}
		ctx.save()
		ctx.strokeStyle = stroke.color
		ctx.lineWidth = stroke.width
		ctx.lineCap = 'round'
		ctx.lineJoin = 'round'
		ctx.beginPath()
		ctx.moveTo(previous.x, previous.y)
		ctx.lineTo(point.x, point.y)
		ctx.stroke()
		ctx.restore()
	}, [])

	const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
		if (!isReady || activeStrokeRef.current || (event.pointerType === 'mouse' && event.button !== 0)) return
		event.preventDefault()
		const canvas = canvasRef.current
		const point = pointFromPointer(event.nativeEvent)
		if (!canvas || !point) return

		const rect = canvas.getBoundingClientRect()
		activeStrokeRef.current = {
			color: brushColor,
			width: brushSize * canvas.width / rect.width,
			points: [],
		}
		activePointerIdRef.current = event.pointerId
		canvas.setPointerCapture(event.pointerId)
		drawActiveSegment(point)
	}, [brushColor, brushSize, drawActiveSegment, isReady, pointFromPointer])

	const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
		if (!activeStrokeRef.current || activePointerIdRef.current !== event.pointerId) return
		event.preventDefault()
		const coalesced = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent]
		for (const pointer of coalesced) {
			const point = pointFromPointer(pointer)
			if (point) drawActiveSegment(point)
		}
	}, [drawActiveSegment, pointFromPointer])

	const finishStroke = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
		const stroke = activeStrokeRef.current
		if (!stroke || activePointerIdRef.current !== event.pointerId) return
		event.preventDefault()
		activeStrokeRef.current = null
		activePointerIdRef.current = null
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId)
		}
		if (stroke.points.length === 0) return
		setHistory(current => commitMarkupStroke(current, stroke))
	}, [])

	const cancelStroke = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
		if (!activeStrokeRef.current || activePointerIdRef.current !== event.pointerId) return
		event.preventDefault()
		activeStrokeRef.current = null
		activePointerIdRef.current = null
		renderCanvas(history.strokes)
	}, [history.strokes, renderCanvas])

	return createPortal(
		<div className='@@void-scope @@orbit-image-editor-root'>
			<div className='@@orbit-image-editor-backdrop' aria-hidden='true' />
			<div
				ref={dialogRef}
				role='dialog'
				aria-modal='true'
				aria-labelledby={titleId}
				aria-describedby={descriptionId}
				aria-busy={!isReady && !loadError}
				className='@@orbit-image-editor-dialog'
				tabIndex={-1}
			>
				<header className='@@orbit-image-editor-header'>
					<div className='@@orbit-image-editor-title-group'>
						<h2 id={titleId}>Mark up image {imageIndex + 1}</h2>
					</div>

					<div className='@@orbit-image-editor-tools' role='toolbar' aria-label='Drawing tools'>
						<div className='@@orbit-image-editor-tool-group'>
							<span className='@@orbit-image-editor-tool-label' aria-hidden='true'>Color</span>
							<div className='@@orbit-image-editor-colors' role='group' aria-label='Stroke color'>
								{ANNOTATION_COLORS.map(color => (
									<button
										key={color.value}
										type='button'
										className='@@orbit-image-editor-color'
										aria-label={`${color.label} stroke`}
										aria-pressed={brushColor === color.value}
										title={color.label}
										onClick={() => setBrushColor(color.value)}
									>
										<span style={{ backgroundColor: color.value }} aria-hidden />
										{brushColor === color.value && <Check size={10} color={color.checkColor} aria-hidden />}
									</button>
								))}
							</div>
						</div>
						<div className='@@orbit-image-editor-divider @@orbit-image-editor-tools-divider' aria-hidden />
						<div className='@@orbit-image-editor-tool-group'>
							<span className='@@orbit-image-editor-tool-label' aria-hidden='true'>Size</span>
							<div className='@@orbit-image-editor-sizes' role='group' aria-label='Stroke width'>
								{BRUSH_SIZES.map(size => (
									<button
										key={size}
										type='button'
										className='@@orbit-image-editor-size'
										aria-label={`${size === 3 ? 'Thin' : size === 6 ? 'Medium' : 'Thick'} stroke`}
										aria-pressed={brushSize === size}
										title={`${size === 3 ? 'Thin' : size === 6 ? 'Medium' : 'Thick'} stroke`}
										onClick={() => setBrushSize(size)}
									>
										<span
											style={{ width: 16, height: Math.max(2, Math.round(size * 0.7)) }}
											aria-hidden
										/>
									</button>
								))}
							</div>
						</div>
					</div>

					<div className='@@orbit-image-editor-actions'>
						<button
							type='button'
							className='@@orbit-image-editor-action @@orbit-image-editor-history-action'
							onClick={undo}
							disabled={history.strokes.length === 0}
							aria-label='Undo last mark'
							aria-keyshortcuts='Control+Z Meta+Z'
							title='Undo (⌘Z / Ctrl+Z)'
						>
							<Undo2 size={14} aria-hidden />
							<span>Undo</span>
						</button>
						<button
							type='button'
							className='@@orbit-image-editor-action @@orbit-image-editor-history-action'
							onClick={redo}
							disabled={history.redo.length === 0}
							aria-label='Redo last mark'
							aria-keyshortcuts='Control+Y Control+Shift+Z Meta+Shift+Z'
							title='Redo (⇧⌘Z / Ctrl+Y)'
						>
							<Redo2 size={14} aria-hidden />
							<span>Redo</span>
						</button>
						<div className='@@orbit-image-editor-divider' aria-hidden />
						<button
							type='button'
							className='@@orbit-image-editor-action @@orbit-image-editor-cancel'
							onClick={onCancel}
							aria-label='Cancel image markup'
						>
							<X size={14} aria-hidden />
							<span>Cancel</span>
						</button>
						<button
							type='button'
							className='@@orbit-image-editor-action @@orbit-image-editor-save'
							onClick={save}
							disabled={!isReady}
							aria-keyshortcuts='Control+Enter Meta+Enter'
							title='Save image (⌘Enter / Ctrl+Enter)'
						>
							Save
						</button>
					</div>
				</header>

				<div className='@@orbit-image-editor-stage'>
					{!isReady && !loadError && <div className='@@orbit-image-editor-status' role='status'>Opening image…</div>}
					{loadError && <div className='@@orbit-image-editor-error' role='alert'>{loadError}</div>}
					<canvas
						ref={canvasRef}
						className={`@@orbit-image-editor-canvas ${isReady ? '' : '@@orbit-image-editor-canvas--hidden'}`}
						aria-label={`Annotate attached image ${imageIndex + 1}`}
						onPointerDown={handlePointerDown}
						onPointerMove={handlePointerMove}
						onPointerUp={finishStroke}
						onPointerCancel={cancelStroke}
						onLostPointerCapture={finishStroke}
					>
						Use a pointer to draw annotations on this image.
					</canvas>
				</div>

				<footer className='@@orbit-image-editor-footer'>
					<p id={descriptionId}>Draw directly on the image. Press Escape to cancel.</p>
					<span aria-live='polite'>{history.strokes.length} mark{history.strokes.length === 1 ? '' : 's'}</span>
					{saveError && <div className='@@orbit-image-editor-save-error' role='alert'>{saveError}</div>}
				</footer>
			</div>
		</div>,
		connectedDocument.body,
	)
}
