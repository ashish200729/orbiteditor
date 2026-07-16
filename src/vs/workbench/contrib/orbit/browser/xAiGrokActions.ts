/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js'
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js'
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js'
import { INotificationActions, INotificationService, Severity } from '../../../../platform/notification/common/notification.js'
import { IOpenerService } from '../../../../platform/opener/common/opener.js'
import { IXAiGrokAuthService } from '../common/xAiGrokAuthService.js'
import { VOID_XAI_GROK_DEVICE_SIGN_IN_ACTION_ID, VOID_XAI_GROK_SIGN_IN_ACTION_ID, VOID_XAI_GROK_SIGN_OUT_ACTION_ID } from './actionIDs.js'

const isCancellation = (message: string) => {
	const value = message.toLowerCase()
	return value.includes('cancel') || value.includes('access_denied') || value.includes('denied')
}

const showAuthError = (notificationService: INotificationService, error: unknown) => {
	const message = error instanceof Error ? error.message : String(error)
	if (isCancellation(message)) return
	if (message.toLowerCase().includes('timeout')) {
		notificationService.error('SuperGrok sign-in timed out. Please try again.')
		return
	}
	notificationService.error(message)
}

registerAction2(class extends Action2 {
	constructor() { super({ id: VOID_XAI_GROK_SIGN_IN_ACTION_ID, title: 'Sign in with SuperGrok', f1: false }) }

	async run(accessor: ServicesAccessor) {
		const authService = accessor.get(IXAiGrokAuthService)
		const openerService = accessor.get(IOpenerService)
		const clipboardService = accessor.get(IClipboardService)
		const notificationService = accessor.get(INotificationService)
		try {
			const { authUrl } = await authService.startAuthorizationFlow()
			const actions: INotificationActions = { primary: [
				{ id: 'void.xAiGrok.copySignInUrl', label: 'Copy URL', tooltip: '', class: undefined, enabled: true, run: () => clipboardService.writeText(authUrl) },
				{ id: 'void.xAiGrok.openSignInUrl', label: 'Open URL', tooltip: '', class: undefined, enabled: true, run: () => openerService.open(authUrl, { openExternal: true }) },
			] }
			notificationService.notify({ severity: Severity.Info, message: 'Complete SuperGrok sign-in in your browser.', sticky: true, actions })
			await openerService.open(authUrl, { openExternal: true })
			const state = await authService.waitForCallback()
			if (state.isAuthenticated) notificationService.info(`SuperGrok connected${state.email ? ` as ${state.email}` : ''}.`)
		} catch (error) {
			showAuthError(notificationService, error)
		}
	}
})

registerAction2(class extends Action2 {
	constructor() { super({ id: VOID_XAI_GROK_DEVICE_SIGN_IN_ACTION_ID, title: 'Sign in with SuperGrok using a device code', f1: false }) }

	async run(accessor: ServicesAccessor) {
		const authService = accessor.get(IXAiGrokAuthService)
		const openerService = accessor.get(IOpenerService)
		const clipboardService = accessor.get(IClipboardService)
		const notificationService = accessor.get(INotificationService)
		try {
			const device = await authService.startDeviceAuthorizationFlow()
			const openUrl = device.verificationUriComplete || device.verificationUri
			const actions: INotificationActions = { primary: [
				{ id: 'void.xAiGrok.copyDeviceCode', label: 'Copy code', tooltip: '', class: undefined, enabled: true, run: () => clipboardService.writeText(device.userCode) },
				{ id: 'void.xAiGrok.openDeviceUrl', label: 'Open xAI', tooltip: '', class: undefined, enabled: true, run: () => openerService.open(openUrl, { openExternal: true }) },
			] }
			notificationService.notify({ severity: Severity.Info, message: `Enter code ${device.userCode} at ${device.verificationUri}`, sticky: true, actions })
			await clipboardService.writeText(device.userCode)
			await openerService.open(openUrl, { openExternal: true })
			const state = await authService.waitForDeviceAuthorization()
			if (state.isAuthenticated) notificationService.info(`SuperGrok connected${state.email ? ` as ${state.email}` : ''}.`)
		} catch (error) {
			showAuthError(notificationService, error)
		}
	}
})

registerAction2(class extends Action2 {
	constructor() { super({ id: VOID_XAI_GROK_SIGN_OUT_ACTION_ID, title: 'Sign out of SuperGrok', f1: false }) }

	async run(accessor: ServicesAccessor) {
		const authService = accessor.get(IXAiGrokAuthService)
		const notificationService = accessor.get(INotificationService)
		try {
			await authService.signOut()
			notificationService.info('Signed out of SuperGrok.')
		} catch (error) {
			notificationService.error(error instanceof Error ? error.message : String(error))
		}
	}
})
