/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js'
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js'
import { IOpenerService } from '../../../../platform/opener/common/opener.js'
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js'
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js'
import { IOrbitProviderAuthService } from '../common/orbitProviderAuthService.js'
import { IRefreshModelService } from '../common/refreshModelService.js'
import { ICommandService } from '../../../../platform/commands/common/commands.js'
import {
	VOID_ORBIT_PROVIDER_CANCEL_SIGN_IN_ACTION_ID,
	VOID_ORBIT_PROVIDER_SIGN_IN_ACTION_ID,
	VOID_ORBIT_PROVIDER_SIGN_OUT_ACTION_ID,
	VOID_REFRESH_ORBIT_PROVIDER_ACTION_ID,
	VOID_OPEN_ACCOUNT_SETTINGS_ACTION_ID,
} from './actionIDs.js'
import { VOID_OPEN_SETTINGS_ACTION_ID } from './orbitSettingsPane.js'
import { setPendingOrbitSettingsTab } from './orbitSettingsNavigation.js'

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VOID_ORBIT_PROVIDER_SIGN_IN_ACTION_ID,
			title: 'Sign in to Orbit',
			f1: false,
		})
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const authService = accessor.get(IOrbitProviderAuthService)
		const refreshService = accessor.get(IRefreshModelService)
		const openerService = accessor.get(IOpenerService)
		const notificationService = accessor.get(INotificationService)
		const clipboardService = accessor.get(IClipboardService)

		try {
			const { authUrl } = await authService.startAuthorizationFlow()
			const opened = await openerService.open(authUrl, { openExternal: true })
			if (!opened) {
				const handle = notificationService.notify({
					severity: Severity.Info,
					message: 'Could not open your browser automatically. Use Copy URL to finish signing in.',
					sticky: true,
					actions: {
						primary: [
							{
								id: 'void.orbitProvider.copySignInUrl',
								label: 'Copy URL',
								tooltip: '',
								class: undefined,
								enabled: true,
								run: () => clipboardService.writeText(authUrl),
							},
							{
								id: 'void.orbitProvider.openSignInUrl',
								label: 'Open URL',
								tooltip: '',
								class: undefined,
								enabled: true,
								run: () => openerService.open(authUrl, { openExternal: true }),
							},
						],
					},
				})
				try {
					const state = await authService.waitForCallback()
					handle.close()
					if (state.isAuthenticated) {
						notificationService.info(`Signed in to Orbit${state.login ? ` as ${state.login}` : ''}.`)
						refreshService.refreshOrbitProviderModels()
					}
				} catch (error) {
					handle.close()
					throw error
				}
			} else {
				const state = await authService.waitForCallback()
				if (state.isAuthenticated) {
					notificationService.info(`Signed in to Orbit${state.login ? ` as ${state.login}` : ''}.`)
					refreshService.refreshOrbitProviderModels()
				}
			}
		}
		catch (error) {
			const message = error instanceof Error ? error.message : `${error}`
			const lower = message.toLowerCase()
			if (lower.includes('cancel') || lower.includes('access_denied') || lower.includes('cancelled')) {
				return
			}
			if (lower.includes('timeout')) {
				notificationService.error('Sign-in timed out. Please try again.')
				return
			}
			notificationService.error(message)
		} finally {
			const state = await authService.getState()
			if (state.isPending) {
				await authService.cancelAuthorizationFlow()
			}
		}
	}
})

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VOID_ORBIT_PROVIDER_CANCEL_SIGN_IN_ACTION_ID,
			title: 'Cancel Orbit sign-in',
			f1: false,
		})
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const authService = accessor.get(IOrbitProviderAuthService)
		await authService.cancelAuthorizationFlow()
	}
})

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VOID_ORBIT_PROVIDER_SIGN_OUT_ACTION_ID,
			title: 'Sign out of Orbit',
			f1: false,
		})
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const authService = accessor.get(IOrbitProviderAuthService)
		await authService.signOut()
	}
})

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VOID_REFRESH_ORBIT_PROVIDER_ACTION_ID,
			title: 'Refresh Orbit Provider models',
			f1: false,
		})
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(IRefreshModelService).refreshOrbitProviderModels()
	}
})

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VOID_OPEN_ACCOUNT_SETTINGS_ACTION_ID,
			title: 'Orbit: Open Account Settings',
			f1: false,
		})
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService)
		setPendingOrbitSettingsTab('account')
		await commandService.executeCommand(VOID_OPEN_SETTINGS_ACTION_ID)
	}
})
