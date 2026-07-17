/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { OrbitProviderModelResponse } from '../../common/sendLLMMessageTypes.js'
import { getGitHubOAuthManager } from '../github/oauthManager.js'
import { getOrbitApiBaseUrl } from './orbitApiUrl.js'
import { getOrbitLlmMainServices } from './orbitLlmMainServices.js'
import type { ListParams_Internal } from './sendLLMMessage.impl.js'

export const orbitProviderList = async ({ onSuccess: onSuccess_, onError: onError_ }: ListParams_Internal<OrbitProviderModelResponse>) => {
	const onSuccess = ({ models }: { models: OrbitProviderModelResponse[] }) => {
		onSuccess_({ models })
	}
	const onError = ({ error }: { error: string }) => {
		onError_({ error })
	}
	try {
		const { productService, environmentService } = getOrbitLlmMainServices()
		const manager = getGitHubOAuthManager()
		const token = await manager.getAccessToken()
		const baseUrl = getOrbitApiBaseUrl(productService, environmentService)
		const res = await fetch(`${baseUrl}/api/v1/models`, {
			headers: { authorization: `Bearer ${token}` },
		})
		if (res.status === 401) {
			// This runs unattended (startup, auth-state-change refresh) — do not sign the
			// user out or revoke their device key from here. A spurious/transient 401 on a
			// background model-list poll must not silently log a signed-in user out; only
			// an explicit sign-out or a real 401 during an attended chat request should do that.
			throw new Error('Please sign in with GitHub.')
		}
		if (!res.ok) {
			throw new Error(`Orbit /api/v1/models failed: ${res.status}`)
		}
		const json = await res.json() as { data?: Array<{ id: string; orbit?: { contextWindow?: number; supportsTools?: boolean; supportsReasoning?: boolean } }> }
		onSuccess({
			models: (json.data ?? []).map((m) => ({
				modelName: m.id,
				contextWindow: m.orbit?.contextWindow ?? 200_000,
				supportsTools: m.orbit?.supportsTools ?? true,
				supportsReasoning: m.orbit?.supportsReasoning ?? false,
			})),
		})
	} catch (e) {
		onError({ error: e instanceof Error ? e.message : String(e) })
	}
}
