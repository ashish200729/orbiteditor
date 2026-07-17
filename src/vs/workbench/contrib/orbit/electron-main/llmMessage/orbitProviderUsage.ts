/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { OrbitProviderUsage } from '../../common/orbitProviderUsage.js'
import { parseOrbitProviderUsage } from '../../common/orbitProviderUsage.js'
import { getGitHubOAuthManager } from '../github/oauthManager.js'
import { getOrbitApiBaseUrl } from './orbitApiUrl.js'
import { getOrbitLlmMainServices } from './orbitLlmMainServices.js'

export async function fetchOrbitProviderUsage(): Promise<OrbitProviderUsage> {
	const { productService, environmentService } = getOrbitLlmMainServices()
	const manager = getGitHubOAuthManager()
	const token = await manager.getAccessToken()
	const baseUrl = getOrbitApiBaseUrl(productService, environmentService)
	const res = await fetch(`${baseUrl}/api/usage`, {
		headers: { authorization: `Bearer ${token}` },
	})
	if (res.status === 401) {
		await manager.clearCredentials()
		throw new Error('Please sign in with GitHub.')
	}
	if (!res.ok) {
		throw new Error(`Orbit usage failed: ${res.status}`)
	}
	const json = await res.json() as Parameters<typeof parseOrbitProviderUsage>[0]
	return parseOrbitProviderUsage(json)
}
