/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * OpenAI-compatible gateways normally emit deltas, but some proxies and
 * self-hosted servers emit the complete accumulated value instead. Keep the
 * transport contract delta-based while accepting both forms.
 */
export type OpenAICompatibleStreamAccumulator = {
	value: string;
	sawCumulativeFrame: boolean;
}

export const createOpenAICompatibleStreamAccumulator = (): OpenAICompatibleStreamAccumulator => ({
	value: '',
	sawCumulativeFrame: false,
})

export const textFromOpenAICompatibleContent = (value: unknown): string => {
	if (typeof value === 'string') return value
	if (!Array.isArray(value)) return ''

	return value.map(part => {
		if (typeof part === 'string') return part
		if (!part || typeof part !== 'object') return ''
		const text = (part as { text?: unknown }).text
		return typeof text === 'string' ? text : ''
	}).join('')
}

/** Append one provider frame and return the normalized full value. */
export const appendOpenAICompatibleStreamFrame = (
	state: OpenAICompatibleStreamAccumulator,
	frame: unknown,
): string => {
	const incoming = textFromOpenAICompatibleContent(frame)
	if (!incoming) return state.value

	if (state.sawCumulativeFrame) {
		// Cumulative frames can be repeated or arrive slightly out of order. Do not
		// append a value that is already represented by the accumulated response.
		if (incoming.startsWith(state.value)) {
			state.value = incoming
		} else if (!state.value.startsWith(incoming)) {
			state.value += incoming
		}
		return state.value
	}

	// The first longer prefix match is the reliable signal that this provider is
	// sending cumulative frames. We deliberately do not drop equal standalone
	// deltas here: a model may legitimately emit the same token twice.
	if (state.value && incoming.length > state.value.length && incoming.startsWith(state.value)) {
		state.sawCumulativeFrame = true
		state.value = incoming
	} else {
		state.value += incoming
	}
	return state.value
}

/** Merge tool-name fragments without duplicating names repeated by a gateway. */
export const mergeOpenAICompatibleToolName = (current: string, incoming: string): string => {
	if (!incoming) return current
	if (!current) return incoming
	if (incoming === current || current.startsWith(incoming)) return current
	if (incoming.startsWith(current)) return incoming
	return current + incoming
}
