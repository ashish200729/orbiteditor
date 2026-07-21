/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { mapClinePassApiModel, setClinePassModelMetadata } from '../../common/clinePassModelMetadata.js'
import type { ClinePassModelResponse } from '../../common/sendLLMMessageTypes.js'
import { CLINE_PASS_OAUTH_CONFIG } from '../cline-pass/oauthConfig.js'
import { getClinePassOAuthManager } from '../cline-pass/oauthManager.js'
import type { ListParams_Internal } from './sendLLMMessage.impl.js'

type ClineModelsApiJson = {
	data?: unknown[]
	models?: unknown[]
	clinePass?: unknown[]
}

const asRecordArray = (value: unknown): Array<Record<string, unknown>> => {
	if (!Array.isArray(value)) {
		return []
	}
	return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
}

const mapModels = (items: Array<Record<string, unknown>>): ClinePassModelResponse[] => {
	const models: ClinePassModelResponse[] = []
	for (const item of items) {
		const mapped = mapClinePassApiModel(item as Parameters<typeof mapClinePassApiModel>[0])
		if (mapped) {
			models.push(mapped)
		}
	}
	return models
}

const fetchJson = async (url: string, token: string): Promise<ClineModelsApiJson> => {
	const res = await fetch(url, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/json',
			'HTTP-Referer': CLINE_PASS_OAUTH_CONFIG.httpReferer,
			'X-Title': CLINE_PASS_OAUTH_CONFIG.xTitle,
		},
		signal: AbortSignal.timeout(30_000),
	})
	if (res.status === 401) {
		// Background/unattended poll — do not clear credentials here.
		throw new Error('Please sign in to ClinePass.')
	}
	if (!res.ok) {
		throw new Error(`ClinePass models request failed: ${res.status}`)
	}
	return await res.json() as ClineModelsApiJson
}

export const clinePassProviderList = async ({ onSuccess: onSuccess_, onError: onError_ }: ListParams_Internal<ClinePassModelResponse>) => {
	const onSuccess = ({ models }: { models: ClinePassModelResponse[] }) => {
		onSuccess_({ models })
	}
	const onError = ({ error }: { error: string }) => {
		onError_({ error })
	}

	try {
		const manager = getClinePassOAuthManager()
		const token = await manager.getAccessToken()
		const base = CLINE_PASS_OAUTH_CONFIG.apiBaseUrl

		let models: ClinePassModelResponse[] = []
		try {
			const json = await fetchJson(`${base}${CLINE_PASS_OAUTH_CONFIG.modelsPath}`, token)
			models = mapModels(asRecordArray(json.data ?? json.models))
		} catch (primaryError) {
			// Fallback to recommended-models → clinePass array
			try {
				const recommended = await fetchJson(`${base}${CLINE_PASS_OAUTH_CONFIG.recommendedModelsPath}`, token)
				models = mapModels(asRecordArray(recommended.clinePass ?? recommended.data ?? recommended.models))
			} catch {
				throw primaryError
			}
		}

		if (models.length > 0) {
			setClinePassModelMetadata(models)
		}
		onSuccess({ models })
	} catch (e) {
		onError({ error: e instanceof Error ? e.message : String(e) })
	}
}
