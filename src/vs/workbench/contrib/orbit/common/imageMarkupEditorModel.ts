/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export type MarkupPoint = { x: number; y: number }

export type MarkupStroke = {
	color: string
	width: number
	points: MarkupPoint[]
}

export type MarkupHistory = {
	strokes: MarkupStroke[]
	redo: MarkupStroke[]
}

export const createMarkupHistory = (): MarkupHistory => ({ strokes: [], redo: [] })

export const commitMarkupStroke = (history: MarkupHistory, stroke: MarkupStroke): MarkupHistory => {
	if (stroke.points.length === 0) return history
	return { strokes: [...history.strokes, stroke], redo: [] }
}

export const undoMarkupStroke = (history: MarkupHistory): MarkupHistory => {
	const stroke = history.strokes[history.strokes.length - 1]
	if (!stroke) return history
	return {
		strokes: history.strokes.slice(0, -1),
		redo: [...history.redo, stroke],
	}
}

export const redoMarkupStroke = (history: MarkupHistory): MarkupHistory => {
	const stroke = history.redo[history.redo.length - 1]
	if (!stroke) return history
	return {
		strokes: [...history.strokes, stroke],
		redo: history.redo.slice(0, -1),
	}
}

export const imageMarkupOutputType = (dataUrl: string): 'image/jpeg' | 'image/webp' | 'image/png' => {
	const sourceType = /^data:(image\/(?:jpeg|webp));/i.exec(dataUrl)?.[1].toLowerCase()
	if (sourceType === 'image/jpeg' || sourceType === 'image/webp') return sourceType
	return 'image/png'
}

/** Canvas uses `data:,` when it cannot encode its bitmap. Never replace an attachment with it. */
export const isValidImageMarkupOutput = (dataUrl: string): boolean => (
	/^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/]+=*$/i.test(dataUrl)
)
