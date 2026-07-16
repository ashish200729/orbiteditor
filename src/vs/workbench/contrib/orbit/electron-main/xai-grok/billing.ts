/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { XAiGrokUsage } from '../../common/xAiGrokAuthService.js'
import { XAI_GROK_OAUTH_CONFIG } from './oauthConfig.js'

const finiteNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined

const validIsoDate = (value: unknown) => {
	if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined
	return value
}

const configOf = (payload: unknown): Record<string, unknown> => {
	if (!payload || typeof payload !== 'object') throw new Error('xAI returned malformed subscription usage data.')
	const config = (payload as Record<string, unknown>).config
	if (!config || typeof config !== 'object') throw new Error('xAI returned malformed subscription usage data.')
	return config as Record<string, unknown>
}

export const parseXAiGrokMonthlyUsage = (payload: unknown): XAiGrokUsage['monthly'] => {
	const config = configOf(payload)
	const limitContainer = config.monthlyLimit
	const usedContainer = config.used
	const limit = finiteNumber(limitContainer && typeof limitContainer === 'object' ? (limitContainer as Record<string, unknown>).val : undefined)
	const used = finiteNumber(usedContainer && typeof usedContainer === 'object' ? (usedContainer as Record<string, unknown>).val : undefined)
	const resetsAt = validIsoDate(config.billingPeriodEnd)
	if (limit === undefined || limit <= 0 || used === undefined || used < 0 || !resetsAt) {
		throw new Error('xAI returned malformed subscription usage data.')
	}
	return { limit, used, resetsAt }
}

export const parseXAiGrokWeeklyUsage = (payload: unknown): XAiGrokUsage['weekly'] => {
	const config = configOf(payload)
	const currentPeriod = config.currentPeriod
	if (!currentPeriod || typeof currentPeriod !== 'object' || (currentPeriod as Record<string, unknown>).type !== 'USAGE_PERIOD_TYPE_WEEKLY') return undefined
	const resetsAt = validIsoDate(config.billingPeriodEnd)
	if (!resetsAt) return undefined
	const usedPercent = finiteNumber(config.creditUsagePercent) ?? 0
	return { usedPercent: Math.max(0, usedPercent), resetsAt }
}

const billingRequest = async (accessToken: string, query = '') => {
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), 15_000)
	try {
		const response = await fetch(`${XAI_GROK_OAUTH_CONFIG.cliApiBaseUrl}/billing${query}`, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: 'application/json',
				'x-xai-token-auth': 'xai-grok-cli',
			},
			signal: controller.signal,
		})
		if (!response.ok) throw new Error(`xAI subscription usage is unavailable for this account (${response.status}).`)
		return response.json()
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') throw new Error('xAI subscription usage request timed out.')
		throw error
	} finally {
		clearTimeout(timeout)
	}
}

export const fetchXAiGrokUsage = async (accessToken: string): Promise<XAiGrokUsage> => {
	const monthly = parseXAiGrokMonthlyUsage(await billingRequest(accessToken))
	let weekly: XAiGrokUsage['weekly']
	try {
		weekly = parseXAiGrokWeeklyUsage(await billingRequest(accessToken, '?format=credits'))
	} catch {
		// Weekly limits are not present for every plan; monthly usage remains authoritative.
	}
	return { monthly, weekly, fetchedAt: Date.now() }
}
