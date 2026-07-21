/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { OrbitProviderModelResponse } from './sendLLMMessageTypes.js';

/** Authoritative model metadata from Orbit Provider `/api/v1/models` (ephemeral, not persisted). */
export type OrbitProviderModelMetadata = Required<Pick<OrbitProviderModelResponse,
	'modelName' | 'contextWindow' | 'supportsTools' | 'supportsReasoning' | 'inputCreditMultiplier' | 'outputCreditMultiplier'
>>;

let metadataByModelName: Record<string, OrbitProviderModelMetadata> = {};

const normalizeModel = (model: OrbitProviderModelResponse): OrbitProviderModelMetadata => ({
	modelName: model.modelName,
	contextWindow: model.contextWindow ?? 200_000,
	supportsTools: model.supportsTools ?? true,
	supportsReasoning: model.supportsReasoning ?? false,
	inputCreditMultiplier: model.inputCreditMultiplier ?? 0,
	outputCreditMultiplier: model.outputCreditMultiplier ?? 0,
});

export const setOrbitProviderModelMetadata = (models: OrbitProviderModelResponse[]): void => {
	const next: Record<string, OrbitProviderModelMetadata> = {};
	for (const model of models) {
		next[model.modelName] = normalizeModel(model);
	}
	metadataByModelName = next;
};

export const clearOrbitProviderModelMetadata = (): void => {
	metadataByModelName = {};
};

export const getOrbitProviderModelMetadata = (modelName: string): OrbitProviderModelMetadata | undefined => {
	return metadataByModelName[modelName];
};

/** Convert a stored per-token credit multiplier to vendor-style $/1M tokens. */
export const pricePerMillionFromCreditMultiplier = (multiplier: number): number => {
	return multiplier * 1_000_000;
};
