/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { URI } from '../../../../../../../base/common/uri.js'
import { VoidButtonBgDarken } from '../util/inputs.js'
import { useAccessor, useOrbitProviderAuthState } from '../util/services.js'
import {
	VOID_ORBIT_PROVIDER_SIGN_IN_ACTION_ID,
	VOID_ORBIT_PROVIDER_SIGN_OUT_ACTION_ID,
	VOID_REFRESH_ORBIT_PROVIDER_ACTION_ID,
} from '../../../actionIDs.js'
import type { OrbitProviderUsage } from '../../../../common/orbitProviderUsage.js'
import { formatOrbitPlanName, formatOrbitWalletBalance, isOrbitLowBalance } from '../../../../common/orbitProviderUsage.js'

const getOrbitBillingUrl = (isBuilt: boolean) => (
	isBuilt ? 'https://orbiteditor.com/billing' : 'http://localhost:3000/billing'
)

const USAGE_POLL_MS = 60_000
const RELATIVE_TIME_TICK_MS = 15_000

function formatRelativeTime(fromMs: number, nowMs: number): string {
	const deltaSeconds = Math.max(0, Math.round((nowMs - fromMs) / 1000))
	if (deltaSeconds < 10) return 'just now'
	if (deltaSeconds < 60) return `${deltaSeconds}s ago`
	const minutes = Math.round(deltaSeconds / 60)
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.round(minutes / 60)
	return `${hours}h ago`
}

export const OrbitAuthPanel = () => {
	const orbitAuth = useOrbitProviderAuthState()
	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const environmentService = accessor.get('IEnvironmentService')
	const openerService = accessor.get('IOpenerService')
	const authService = accessor.get('IOrbitProviderAuthService')

	const [usage, setUsage] = useState<OrbitProviderUsage>()
	const [usageError, setUsageError] = useState<string>()
	const [isLoadingUsage, setIsLoadingUsage] = useState(false)
	const [lastUpdatedAt, setLastUpdatedAt] = useState<number>()
	const [, forceRelativeTimeTick] = useState(0)
	const usageRequest = useRef(0)

	const displayName = orbitAuth.login
		? `@${orbitAuth.login}`
		: orbitAuth.email ?? 'Signed in'

	const planLabel = formatOrbitPlanName(usage?.plan ?? orbitAuth.plan ?? 'free')

	const openBilling = () => {
		void openerService.open(URI.parse(getOrbitBillingUrl(environmentService.isBuilt)), { openExternal: true })
	}

	const loadUsage = useCallback(async () => {
		const request = ++usageRequest.current
		setIsLoadingUsage(true)
		setUsageError(undefined)
		try {
			const nextUsage = await authService.getUsage()
			if (request === usageRequest.current) {
				setUsage(nextUsage)
				setLastUpdatedAt(Date.now())
			}
		} catch (error) {
			if (request === usageRequest.current) {
				setUsage(undefined)
				setUsageError(error instanceof Error ? error.message : 'Usage is unavailable.')
			}
		} finally {
			if (request === usageRequest.current) {
				setIsLoadingUsage(false)
			}
		}
	}, [authService])

	useEffect(() => {
		if (!orbitAuth.isAuthenticated) {
			usageRequest.current++
			setUsage(undefined)
			setUsageError(undefined)
			setIsLoadingUsage(false)
			setLastUpdatedAt(undefined)
			return
		}
		void loadUsage()

		// The wallet balance moves every time a chat request completes
		// elsewhere in the editor — without a periodic refresh this panel
		// only ever updates on manual refresh or a full re-mount, so the
		// displayed number can be arbitrarily stale.
		const interval = setInterval(() => void loadUsage(), USAGE_POLL_MS)
		return () => clearInterval(interval)
	}, [orbitAuth.isAuthenticated, loadUsage])

	useEffect(() => {
		if (!orbitAuth.isAuthenticated || lastUpdatedAt === undefined) return
		const interval = setInterval(() => forceRelativeTimeTick((n) => n + 1), RELATIVE_TIME_TICK_MS)
		return () => clearInterval(interval)
	}, [orbitAuth.isAuthenticated, lastUpdatedAt])

	const walletBalance = formatOrbitWalletBalance(usage?.walletBalance)
	const walletAmount = Number(usage?.walletBalance ?? 0)
	const monthlyGrant = Number(usage?.monthlyCredits ?? 0)
	const lowBalance = isOrbitLowBalance(walletAmount, monthlyGrant)
	const showSubscriptionBucket =
		usage?.subscriptionCredits != null &&
		Number(usage.subscriptionCredits) > 0
	const showTopUpBucket =
		usage?.topUpCredits != null && Number(usage.topUpCredits) > 0

	return (
		<div className='@@provider-auth-panel'>
			<p className='@@provider-auth-desc'>
				Sign in with GitHub to use Orbit Provider. No API key required.
			</p>
			{orbitAuth.isPending ? (
				<p className='@@settings-card-sublabel'>Waiting for sign-in in your browser…</p>
			) : null}
			{orbitAuth.isAuthenticated ? (
				<div className='flex flex-col gap-3'>
					<div className='@@settings-profile'>
						{orbitAuth.avatarUrl ? (
							<img
								src={orbitAuth.avatarUrl}
								alt=''
								className='@@settings-avatar'
							/>
						) : null}
						<div className='min-w-0'>
							<div className='@@settings-profile-name'>{displayName}</div>
							<div className='@@settings-card-sublabel'>{planLabel} plan</div>
						</div>
					</div>
					<div className='@@provider-usage' aria-live='polite'>
						<div className='@@provider-usage-heading'>
							<span>Wallet balance</span>
							<div className='flex items-center gap-1.5'>
								{usage && lastUpdatedAt !== undefined ? (
									<span className='@@settings-card-sublabel' title={new Date(lastUpdatedAt).toLocaleTimeString()}>
										{isLoadingUsage ? 'Updating…' : `Updated ${formatRelativeTime(lastUpdatedAt, Date.now())}`}
									</span>
								) : null}
								<button
									type='button'
									className='@@provider-usage-refresh'
									disabled={isLoadingUsage}
									onClick={() => void loadUsage()}
									aria-label='Refresh Orbit wallet balance'
									title='Refresh balance'
								>
									<RefreshCw size={13} className={isLoadingUsage ? 'animate-spin' : undefined} />
								</button>
							</div>
						</div>
						{usage ? (
							<>
								<div className='@@provider-usage-row'>
									<span>Available</span>
									<strong>{walletBalance}</strong>
								</div>
								{showSubscriptionBucket ? (
									<div className='@@provider-usage-row @@provider-usage-row--weekly'>
										<span>Monthly credits</span>
										<strong>{formatOrbitWalletBalance(usage?.subscriptionCredits)}</strong>
									</div>
								) : null}
								{showTopUpBucket ? (
									<div className='@@provider-usage-row @@provider-usage-row--weekly'>
										<span>Top-up credits</span>
										<strong>{formatOrbitWalletBalance(usage?.topUpCredits)}</strong>
									</div>
								) : null}
								{lowBalance ? (
									<div className='@@provider-usage-status'>
										Low balance — add credits before your next request.
									</div>
								) : null}
								{usage.periodCreditsDeducted != null && usage.monthlyCredits ? (
									<div className='@@provider-usage-row @@provider-usage-row--weekly'>
										<span>This billing period</span>
										<strong>
											{formatOrbitWalletBalance(usage.periodCreditsDeducted)} used
										</strong>
									</div>
								) : usage.last30DaysCreditsDeducted != null ? (
									<div className='@@provider-usage-row @@provider-usage-row--weekly'>
										<span>Last 30 days</span>
										<strong>
											{formatOrbitWalletBalance(usage.last30DaysCreditsDeducted)} used
										</strong>
									</div>
								) : null}
							</>
						) : (
							<div className='@@provider-usage-status'>
								{isLoadingUsage ? 'Loading balance…' : usageError ?? 'Balance unavailable.'}
							</div>
						)}
					</div>
					<div className='flex flex-wrap gap-2'>
						<VoidButtonBgDarken
							className='px-3 py-1 text-xs'
							onClick={() => commandService.executeCommand(VOID_REFRESH_ORBIT_PROVIDER_ACTION_ID)}
						>
							<RefreshCw className='inline w-3 h-3 mr-1 -mt-px' />
							Refresh models
						</VoidButtonBgDarken>
						<VoidButtonBgDarken
							className='px-3 py-1 text-xs'
							onClick={openBilling}
						>
							<ExternalLink className='inline w-3 h-3 mr-1 -mt-px' />
							Billing & usage
						</VoidButtonBgDarken>
						<VoidButtonBgDarken
							className='px-3 py-1 text-xs'
							onClick={() => commandService.executeCommand(VOID_ORBIT_PROVIDER_SIGN_OUT_ACTION_ID)}
						>
							Sign out
						</VoidButtonBgDarken>
					</div>
				</div>
			) : (
				<VoidButtonBgDarken
					className='w-full px-3 py-1.5 text-xs'
					disabled={orbitAuth.isPending}
					onClick={() => commandService.executeCommand(VOID_ORBIT_PROVIDER_SIGN_IN_ACTION_ID)}
				>
					{orbitAuth.isPending ? 'Waiting for sign-in…' : 'Sign in with GitHub'}
				</VoidButtonBgDarken>
			)}
		</div>
	)
}
