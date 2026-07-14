/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export type OrbitCustomizeTab = 'mcp' | 'skills' | 'agents' | 'rules'
export type OrbitCustomizeScope = 'user' | 'workspace'
export type OrbitCustomizeView = 'manage' | 'marketplace'

export type PendingOrbitCustomizeState = {
	tab?: OrbitCustomizeTab
	scope?: OrbitCustomizeScope
	view?: OrbitCustomizeView
}

let pendingCustomizeState: PendingOrbitCustomizeState | null = null

export const setPendingOrbitCustomize = (state: PendingOrbitCustomizeState) => {
	// merge so callers can set individual fields without clobbering others
	pendingCustomizeState = { ...(pendingCustomizeState ?? {}), ...state }
}

export const consumePendingOrbitCustomize = (): PendingOrbitCustomizeState | null => {
	const state = pendingCustomizeState
	pendingCustomizeState = null
	return state
}
