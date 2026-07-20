/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useState } from 'react'
import type { IOrbitProviderAuthService } from '../../../../common/orbitProviderAuthService.js'
import type { OrbitProviderUsage } from '../../../../common/orbitProviderUsage.js'

const USAGE_POLL_MS = 60_000

export type OrbitProviderUsageSnapshot = {
	usage?: OrbitProviderUsage
	usageError?: string
	isLoadingUsage: boolean
	lastUpdatedAt?: number
}

const emptySnapshot = (): OrbitProviderUsageSnapshot => ({ isLoadingUsage: false })

let snapshot: OrbitProviderUsageSnapshot = emptySnapshot()
const listeners = new Set<(s: OrbitProviderUsageSnapshot) => void>()

let usageRequest = 0
let pollTimer: ReturnType<typeof setInterval> | undefined
let authService: IOrbitProviderAuthService | null = null
let isAuthenticated = false
let subscriberCount = 0

const emit = () => listeners.forEach(l => l(snapshot))

const update = (partial: Partial<OrbitProviderUsageSnapshot>) => {
	snapshot = { ...snapshot, ...partial }
	emit()
}

const stopPolling = () => {
	if (pollTimer !== undefined) {
		clearInterval(pollTimer)
		pollTimer = undefined
	}
}

const clearUsage = () => {
	usageRequest++
	stopPolling()
	snapshot = emptySnapshot()
	emit()
}

export const loadOrbitProviderUsage = async (opts?: { silent?: boolean }) => {
	if (!authService || !isAuthenticated) {
		return
	}
	const request = ++usageRequest
	if (!opts?.silent) {
		update({ isLoadingUsage: true })
	}
	update({ usageError: undefined })
	try {
		const nextUsage = await authService.getUsage()
		if (request === usageRequest) {
			update({ usage: nextUsage, lastUpdatedAt: Date.now(), isLoadingUsage: false })
		}
	} catch (error) {
		if (request === usageRequest) {
			update({
				usage: undefined,
				usageError: error instanceof Error ? error.message : 'Usage is unavailable.',
				isLoadingUsage: false,
			})
		}
	}
}

const ensurePolling = () => {
	stopPolling()
	if (!authService || !isAuthenticated || subscriberCount === 0) {
		return
	}
	void loadOrbitProviderUsage()
	pollTimer = setInterval(() => void loadOrbitProviderUsage({ silent: true }), USAGE_POLL_MS)
}

/** Called once from _registerServices with the auth service instance. */
export const initOrbitProviderUsage = (service: IOrbitProviderAuthService) => {
	authService = service
}

/** Called when Orbit Provider auth state changes. */
export const syncOrbitProviderUsageAuth = (authenticated: boolean) => {
	isAuthenticated = authenticated
	if (!authenticated) {
		clearUsage()
		return
	}
	if (subscriberCount > 0) {
		ensurePolling()
	}
}

export function useOrbitProviderUsage(options?: { enabled?: boolean }) {
	const enabled = options?.enabled ?? true
	const [state, setState] = useState(snapshot)

	useEffect(() => {
		const listener = (next: OrbitProviderUsageSnapshot) => setState(next)
		listeners.add(listener)
		setState(snapshot)
		subscriberCount++
		if (enabled && isAuthenticated) {
			ensurePolling()
		}
		return () => {
			listeners.delete(listener)
			subscriberCount--
			if (subscriberCount === 0) {
				stopPolling()
			}
		}
	}, [enabled])

	const loadUsage = useCallback(async (opts?: { silent?: boolean }) => {
		await loadOrbitProviderUsage(opts)
	}, [])

	if (!enabled || !isAuthenticated) {
		return {
			usage: undefined,
			usageError: undefined,
			isLoadingUsage: false,
			lastUpdatedAt: undefined,
			loadUsage,
		}
	}

	return { ...state, loadUsage }
}
