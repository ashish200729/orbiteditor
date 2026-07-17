/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export type OrbitProviderUsage = {
	walletBalance: string
	subscriptionCredits: string | null
	topUpCredits: string | null
	plan: string
	periodCreditsDeducted: number | null
	last30DaysCreditsDeducted: number | null
	monthlyCredits: string | null
}

type UsageApiResponse = {
	wallet?: {
		availableCredits?: string
		subscriptionCredits?: string
		topUpCredits?: string
	}
	limits?: { plan?: string; monthlyCredits?: string }
	billingPeriod?: { totalCreditsDeducted?: number } | null
	last30Days?: { totalCreditsDeducted?: number }
}

export function parseOrbitProviderUsage(json: UsageApiResponse): OrbitProviderUsage {
	return {
		walletBalance: json.wallet?.availableCredits ?? '0',
		subscriptionCredits: json.wallet?.subscriptionCredits ?? null,
		topUpCredits: json.wallet?.topUpCredits ?? null,
		plan: json.limits?.plan ?? 'free',
		periodCreditsDeducted: json.billingPeriod?.totalCreditsDeducted ?? null,
		last30DaysCreditsDeducted: json.last30Days?.totalCreditsDeducted ?? null,
		monthlyCredits: json.limits?.monthlyCredits ?? null,
	}
}

export function formatOrbitWalletBalance(value: string | number | null | undefined): string {
	const amount = Number(value ?? 0)
	if (!Number.isFinite(amount)) return '$0.00'
	const abs = Math.abs(amount)
	if (abs >= 1) {
		return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)
	}
	if (abs === 0) return '$0.00'
	return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(amount)
}

export function formatOrbitPlanName(plan: string): string {
	const normalized = plan.trim().toLowerCase()
	if (!normalized || normalized === 'free') return 'Free'
	return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

/** Matches orbiteditor-ui low-balance threshold logic. A fully depleted ($0) wallet is the
 *  most important case to warn about, not an exemption from the warning. */
export function isOrbitLowBalance(wallet: number, monthlyCredits: number): boolean {
	const threshold = Math.max(1, Math.min(5, monthlyCredits * 0.1))
	return wallet < threshold
}
