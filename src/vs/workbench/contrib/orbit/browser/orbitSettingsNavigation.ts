/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export type OrbitSettingsTab = 'account' | 'models' | 'localProviders' | 'providers' | 'featureOptions' | 'mcp' | 'general' | 'skills' | 'agents' | 'all'

let pendingSettingsTab: OrbitSettingsTab | null = null

export const setPendingOrbitSettingsTab = (tab: OrbitSettingsTab) => {
	pendingSettingsTab = tab
}

export const consumePendingOrbitSettingsTab = (): OrbitSettingsTab | null => {
	const tab = pendingSettingsTab
	pendingSettingsTab = null
	if (tab === 'localProviders') {
		return 'providers'
	}
	return tab
}
