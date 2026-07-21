/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { ClinePassModelResponse } from './sendLLMMessageTypes.js'

/** Authoritative model metadata from ClinePass model list (ephemeral, not persisted). */
export type ClinePassModelMetadata = Required<Pick<ClinePassModelResponse,
	'modelName' | 'contextWindow' | 'supportsTools' | 'supportsReasoning' | 'inputPrice' | 'outputPrice'
>> & {
	supportsImages?: boolean
	maxTokens?: number
}

let metadataByModelName: Record<string, ClinePassModelMetadata> = {}

const normalizeModel = (model: ClinePassModelResponse): ClinePassModelMetadata => ({
	modelName: model.modelName,
	contextWindow: model.contextWindow ?? 200_000,
	supportsTools: model.supportsTools ?? true,
	supportsReasoning: model.supportsReasoning ?? false,
	inputPrice: model.inputPrice ?? 0,
	outputPrice: model.outputPrice ?? 0,
	supportsImages: model.supportsImages,
	maxTokens: model.maxTokens,
})

export const setClinePassModelMetadata = (models: ClinePassModelResponse[]): void => {
	const next: Record<string, ClinePassModelMetadata> = {}
	for (const model of models) {
		next[model.modelName] = normalizeModel(model)
	}
	metadataByModelName = next
}

export const clearClinePassModelMetadata = (): void => {
	metadataByModelName = {}
}

export const getClinePassModelMetadata = (modelName: string): ClinePassModelMetadata | undefined => {
	return metadataByModelName[modelName]
}

/** Map a raw Cline models API entry into our response shape. */
export const mapClinePassApiModel = (raw: {
	id?: string
	name?: string
	context_length?: number
	contextWindow?: number
	max_tokens?: number
	maxTokens?: number
	architecture?: {
		modality?: string
		tokenizer?: string
		instruct_type?: string
	}
	pricing?: {
		prompt?: string | number
		completion?: string | number
		input?: string | number
		output?: string | number
	}
	supports_tools?: boolean
	supportsTools?: boolean
	supports_reasoning?: boolean
	supportsReasoning?: boolean
	supports_images?: boolean
	supportsImages?: boolean
	top_provider?: {
		context_length?: number
		max_completion_tokens?: number
	}
}): ClinePassModelResponse | null => {
	const modelName = raw.id ?? raw.name
	if (typeof modelName !== 'string' || !modelName.startsWith('cline-pass/')) {
		return null
	}

	const parsePrice = (value: string | number | undefined): number | undefined => {
		if (typeof value === 'number' && Number.isFinite(value)) {
			// Cline/OpenRouter-style pricing is often per-token; convert tiny values to $/1M.
			return value > 0 && value < 1 ? value * 1_000_000 : value
		}
		if (typeof value === 'string' && value.trim().length > 0) {
			const n = Number(value)
			if (!Number.isFinite(n)) return undefined
			return n > 0 && n < 1 ? n * 1_000_000 : n
		}
		return undefined
	}

	const modality = raw.architecture?.modality ?? ''
	const supportsImages = raw.supportsImages ?? raw.supports_images ?? modality.includes('image')
	const contextWindow = raw.contextWindow
		?? raw.context_length
		?? raw.top_provider?.context_length
		?? 200_000
	const maxTokens = raw.maxTokens
		?? raw.max_tokens
		?? raw.top_provider?.max_completion_tokens

	return {
		modelName,
		contextWindow,
		maxTokens,
		supportsTools: raw.supportsTools ?? raw.supports_tools ?? true,
		supportsReasoning: raw.supportsReasoning ?? raw.supports_reasoning ?? true,
		supportsImages,
		inputPrice: parsePrice(raw.pricing?.prompt ?? raw.pricing?.input) ?? 0,
		outputPrice: parsePrice(raw.pricing?.completion ?? raw.pricing?.output) ?? 0,
	}
}
