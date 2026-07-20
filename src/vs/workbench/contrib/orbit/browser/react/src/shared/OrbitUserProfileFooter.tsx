/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React from 'react'
import { Settings2 } from 'lucide-react'
import { useAccessor, useOrbitProviderAuthState } from '../util/services.js'
import { useOrbitProviderUsage } from '../util/useOrbitProviderUsage.js'
import {
	VOID_OPEN_ACCOUNT_SETTINGS_ACTION_ID,
	VOID_ORBIT_PROVIDER_SIGN_IN_ACTION_ID,
} from '../../../actionIDs.js'
import { formatOrbitPlanName, formatOrbitWalletBalance } from '../../../../common/orbitProviderUsage.js'

function getProfileInitials(login?: string, email?: string): string {
	const source = (login ?? email ?? '?').replace(/^@/, '').trim()
	if (!source) return '?'
	const parts = source.split(/[\s._-]+/).filter(Boolean)
	if (parts.length >= 2) {
		return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase()
	}
	return source.slice(0, 2).toUpperCase()
}

export const OrbitUserProfileFooter = () => {
	const orbitAuth = useOrbitProviderAuthState()
	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const { usage, isLoadingUsage } = useOrbitProviderUsage()

	const displayName = orbitAuth.login
		? orbitAuth.login
		: orbitAuth.email?.split('@')[0] ?? 'Account'

	const planLabel = formatOrbitPlanName(usage?.plan ?? orbitAuth.plan ?? 'free')
	// Wallet balance is the live value from the backend; fall back to the auth
	// state's plan only if usage hasn't loaded yet. Keeping the meta line stable
	// (plan · balance) avoids layout shift once usage arrives.
	const balanceLabel = usage
		? formatOrbitWalletBalance(usage.walletBalance)
		: isLoadingUsage
			? '…'
			: ''

	const openAccount = () => {
		void commandService.executeCommand(VOID_OPEN_ACCOUNT_SETTINGS_ACTION_ID)
	}

	const signIn = () => {
		void commandService.executeCommand(VOID_ORBIT_PROVIDER_SIGN_IN_ACTION_ID)
	}

	if (!orbitAuth.isAuthenticated) {
		return (
			<div className="@@chat-history-profile-footer">
				<button
					type="button"
					className="@@chat-history-profile-signin"
					disabled={orbitAuth.isPending}
					onClick={signIn}
				>
					{orbitAuth.isPending ? 'Signing in…' : 'Sign in with GitHub'}
				</button>
			</div>
		)
	}

	return (
		<div className="@@chat-history-profile-footer">
			<button
				type="button"
				className="@@chat-history-profile-row"
				onClick={openAccount}
				title="Open account settings"
			>
				{orbitAuth.avatarUrl ? (
					<img
						src={orbitAuth.avatarUrl}
						alt=""
						className="@@chat-history-profile-avatar"
					/>
				) : (
					<span className="@@chat-history-profile-avatar @@chat-history-profile-avatar--initials" aria-hidden="true">
						{getProfileInitials(orbitAuth.login, orbitAuth.email)}
					</span>
				)}
				<span className="@@chat-history-profile-text">
					<span className="@@chat-history-profile-name">{displayName}</span>
					<span className="@@chat-history-profile-meta">
						{planLabel} plan
						{balanceLabel ? (
							<>
								<span className="@@chat-history-profile-dot" aria-hidden="true">·</span>
								{balanceLabel}
							</>
						) : null}
					</span>
				</span>
				<span className="@@chat-history-profile-action" aria-hidden="true">
					<Settings2 size={14} />
				</span>
			</button>
		</div>
	)
}
