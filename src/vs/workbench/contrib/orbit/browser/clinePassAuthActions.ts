/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js'
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js'
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js'
import { INotificationActions, INotificationService, Severity } from '../../../../platform/notification/common/notification.js'
import { IOpenerService } from '../../../../platform/opener/common/opener.js'
import { IClinePassAuthService } from '../common/clinePassAuthService.js'
import { VOID_CLINE_PASS_SIGN_IN_ACTION_ID, VOID_CLINE_PASS_SIGN_OUT_ACTION_ID } from './actionIDs.js'

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VOID_CLINE_PASS_SIGN_IN_ACTION_ID,
			title: 'Sign in to ClinePass',
			f1: false,
		})
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const authService = accessor.get(IClinePassAuthService)
		const openerService = accessor.get(IOpenerService)
		const notificationService = accessor.get(INotificationService)
		const clipboardService = accessor.get(IClipboardService)

		try {
			const { authUrl } = await authService.startAuthorizationFlow()
			const actions: INotificationActions = {
				primary: [
					{
						id: 'void.clinePass.copySignInUrl',
						label: 'Copy URL',
						tooltip: '',
						class: undefined,
						enabled: true,
						run: () => clipboardService.writeText(authUrl),
					},
					{
						id: 'void.clinePass.openSignInUrl',
						label: 'Open URL',
						tooltip: '',
						class: undefined,
						enabled: true,
						run: () => openerService.open(authUrl, { openExternal: true }),
					},
				],
			}
			notificationService.notify({
				severity: Severity.Info,
				message: `ClinePass sign-in URL:\n${authUrl}`,
				sticky: true,
				actions,
			})
			await openerService.open(authUrl, { openExternal: true })
			const state = await authService.waitForCallback()
			if (state.isAuthenticated) {
				notificationService.info(`Signed in to ClinePass${state.email ? ` as ${state.email}` : ''}.`)
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
		}
	}
})

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VOID_CLINE_PASS_SIGN_OUT_ACTION_ID,
			title: 'Sign out of ClinePass',
			f1: false,
		})
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const authService = accessor.get(IClinePassAuthService)
		const notificationService = accessor.get(INotificationService)

		try {
			await authService.signOut()
			notificationService.info('Signed out of ClinePass.')
		}
		catch (error) {
			const message = error instanceof Error ? error.message : `${error}`
			notificationService.error(message)
		}
	}
})
