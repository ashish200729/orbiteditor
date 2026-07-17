/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useEffect, useState } from 'react'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { URI } from '../../../../../../../base/common/uri.js'
import { VoidButtonBgDarken } from '../util/inputs.js'
import { useAccessor, useOrbitProviderAuthState } from '../util/services.js'
import { useOrbitProviderUsage } from '../util/useOrbitProviderUsage.js'
import {
	VOID_ORBIT_PROVIDER_CANCEL_SIGN_IN_ACTION_ID,
	VOID_ORBIT_PROVIDER_SIGN_IN_ACTION_ID,
	VOID_ORBIT_PROVIDER_SIGN_OUT_ACTION_ID,
	VOID_REFRESH_ORBIT_PROVIDER_ACTION_ID,
} from '../../../actionIDs.js'
import { formatOrbitPlanName, formatOrbitWalletBalance, isOrbitLowBalance } from '../../../../common/orbitProviderUsage.js'

const ORBIT_BILLING_URL = 'https://www.orbiteditorai.com/billing'

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
	const openerService = accessor.get('IOpenerService')
	const { usage, usageError, isLoadingUsage, lastUpdatedAt, loadUsage } = useOrbitProviderUsage()

	// Re-render every RELATIVE_TIME_TICK_MS so "Updated Xm ago" stays accurate
	// without coupling the hook itself to a clock tick.
	const [, forceRelativeTimeTick] = useState(0)
	useEffect(() => {
		if (lastUpdatedAt === undefined) return
		const interval = setInterval(() => forceRelativeTimeTick((n) => n + 1), RELATIVE_TIME_TICK_MS)
		return () => clearInterval(interval)
	}, [lastUpdatedAt])

	const displayName = orbitAuth.login
		? `@${orbitAuth.login}`
		: orbitAuth.email ?? 'Signed in'

	const planLabel = formatOrbitPlanName(usage?.plan ?? orbitAuth.plan ?? 'free')
	const remainingLabel = usage
		? formatOrbitWalletBalance(usage.walletBalance)
		: isLoadingUsage
			? 'Loading…'
			: usageError ?? '—'

	const walletAmount = Number(usage?.walletBalance ?? 0)
	const monthlyGrant = Number(usage?.monthlyCredits ?? 0)
	const lowBalance = usage ? isOrbitLowBalance(walletAmount, monthlyGrant) : false

	const openBilling = () => {
		void openerService.open(URI.parse(ORBIT_BILLING_URL), { openExternal: true })
	}

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
							<div className='@@settings-card-sublabel'>
								{planLabel} plan
								<span className='@@settings-profile-dot' aria-hidden='true'>·</span>
								<span className='@@settings-profile-credits'>{remainingLabel} remaining</span>
							</div>
							{lowBalance ? (
								<div className='@@settings-profile-warning'>
									Low balance — add credits before your next request.
								</div>
							) : null}
						</div>
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
					{usage && lastUpdatedAt !== undefined ? (
						<div className='@@settings-card-sublabel @@settings-updated-at' aria-live='polite'>
							{isLoadingUsage ? 'Updating…' : `Updated ${formatRelativeTime(lastUpdatedAt, Date.now())}`}
						</div>
					) : null}
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
				orbitAuth.isPending ? (
					<VoidButtonBgDarken
						className='w-full px-3 py-1.5 text-xs'
						onClick={() => commandService.executeCommand(VOID_ORBIT_PROVIDER_CANCEL_SIGN_IN_ACTION_ID)}
					>
						Cancel sign-in
					</VoidButtonBgDarken>
				) : (
					<VoidButtonBgDarken
						className='w-full px-3 py-1.5 text-xs'
						onClick={() => commandService.executeCommand(VOID_ORBIT_PROVIDER_SIGN_IN_ACTION_ID)}
					>
						Sign in with GitHub
					</VoidButtonBgDarken>
				)
			)}
		</div>
	)
}
