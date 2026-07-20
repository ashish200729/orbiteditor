/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js'
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js'
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js'
import { INotificationActions, INotificationService, Severity } from '../../../../platform/notification/common/notification.js'
import { IOpenerService } from '../../../../platform/opener/common/opener.js'
import { isWindows } from '../../../../base/common/platform.js'
import { getXAiGrokOAuthErrorCode, XAI_GROK_LOOPBACK_FAILURE_CODES } from '../common/xAiGrokAuthErrors.js'
import { IXAiGrokAuthService } from '../common/xAiGrokAuthService.js'
import { VOID_XAI_GROK_DEVICE_SIGN_IN_ACTION_ID, VOID_XAI_GROK_SIGN_IN_ACTION_ID, VOID_XAI_GROK_SIGN_OUT_ACTION_ID } from './actionIDs.js'

const isCancellation = (message: string) => {
	const value = message.toLowerCase()
	return value.includes('cancel') || value.includes('access_denied') || value.includes('denied')
}

// Error codes that mean the loopback OAuth server could not start or could
// not receive a callback. On Windows these are almost always caused by
// Windows Firewall blocking loopback traffic, a Hyper-V/WSL/Docker port
// reservation, or a stale socket — and the device-code flow sidesteps all
// of those by not binding any port. We auto-fall back to it on Windows so
// the user doesn't have to find and click the "Use a device code" button.
const isLoopbackFailure = (error: unknown) => {
	const code = getXAiGrokOAuthErrorCode(error)
	return !!code && XAI_GROK_LOOPBACK_FAILURE_CODES.has(code)
}

const showAuthError = (notificationService: INotificationService, error: unknown) => {
	const message = error instanceof Error ? error.message : String(error)
	if (isCancellation(message)) return
	if (message.toLowerCase().includes('timeout')) {
		const hint = isWindows
			? 'SuperGrok sign-in timed out. On Windows this is usually caused by Windows Firewall blocking the loopback callback. Try "Use a device code" sign-in instead.'
			: 'SuperGrok sign-in timed out. Please try again.'
		notificationService.error(hint)
		return
	}
	notificationService.error(message)
}

// Runs the device-code flow as a fallback when the browser/loopback flow
// can't start. Used automatically on Windows when the callback server fails
// to bind, and surfaced as a manual "Use a device code" action otherwise.
const runDeviceFlow = async (
	accessor: ServicesAccessor,
	notificationService: INotificationService,
	notePrefix: string,
): Promise<void> => {
	const authService = accessor.get(IXAiGrokAuthService)
	const openerService = accessor.get(IOpenerService)
	const clipboardService = accessor.get(IClipboardService)
	const device = await authService.startDeviceAuthorizationFlow()
	const openUrl = device.verificationUriComplete || device.verificationUri
	const actions: INotificationActions = { primary: [
		{ id: 'void.xAiGrok.copyDeviceCode', label: 'Copy code', tooltip: '', class: undefined, enabled: true, run: () => clipboardService.writeText(device.userCode) },
		{ id: 'void.xAiGrok.openDeviceUrl', label: 'Open xAI', tooltip: '', class: undefined, enabled: true, run: () => openerService.open(openUrl, { openExternal: true }) },
	] }
	notificationService.notify({ severity: Severity.Info, message: `${notePrefix}Enter code ${device.userCode} at ${device.verificationUri}`, sticky: true, actions })
	await clipboardService.writeText(device.userCode)
	await openerService.open(openUrl, { openExternal: true })
	const state = await authService.waitForDeviceAuthorization()
	if (state.isAuthenticated) notificationService.info(`SuperGrok connected${state.email ? ` as ${state.email}` : ''}.`)
}

registerAction2(class extends Action2 {
	constructor() { super({ id: VOID_XAI_GROK_SIGN_IN_ACTION_ID, title: 'Sign in with SuperGrok', f1: false }) }

	async run(accessor: ServicesAccessor) {
		const authService = accessor.get(IXAiGrokAuthService)
		const openerService = accessor.get(IOpenerService)
		const clipboardService = accessor.get(IClipboardService)
		const notificationService = accessor.get(INotificationService)
		let authUrl: string
		try {
			({ authUrl } = await authService.startAuthorizationFlow())
		} catch (error) {
			// If the loopback server couldn't bind and we're on Windows,
			// automatically fall back to the device-code flow, which is
			// reliable on Windows because it doesn't need a local server.
			const code = getXAiGrokOAuthErrorCode(error)
			if (isWindows && code && isLoopbackFailure(error)) {
				notificationService.warn(
					'Browser sign-in is unavailable on this Windows machine (loopback port blocked). ' +
					'Switching to device-code sign-in, which works without a local server.',
				)
				try {
					await runDeviceFlow(accessor, notificationService, 'SuperGrok device-code sign-in. ')
				} catch (deviceError) {
					showAuthError(notificationService, deviceError)
				}
				return
			}
			showAuthError(notificationService, error)
			return
		}
		const actions: INotificationActions = { primary: [
			{ id: 'void.xAiGrok.copySignInUrl', label: 'Copy URL', tooltip: '', class: undefined, enabled: true, run: () => clipboardService.writeText(authUrl) },
			{ id: 'void.xAiGrok.openSignInUrl', label: 'Open URL', tooltip: '', class: undefined, enabled: true, run: () => openerService.open(authUrl, { openExternal: true }) },
		] }
		notificationService.notify({ severity: Severity.Info, message: 'Complete SuperGrok sign-in in your browser.', sticky: true, actions })
		await openerService.open(authUrl, { openExternal: true })
		try {
			const state = await authService.waitForCallback()
			if (state.isAuthenticated) notificationService.info(`SuperGrok connected${state.email ? ` as ${state.email}` : ''}.`)
		} catch (error) {
			// If the callback never arrives (Windows firewall blocked it)
			// and we're on Windows, fall back to device-code so the user
			// isn't stuck re-trying the same broken flow.
			if (isWindows && isLoopbackFailure(error)) {
				notificationService.warn(
					'Browser sign-in did not complete. This is commonly caused by Windows Firewall blocking the local callback. ' +
					'Switching to device-code sign-in.',
				)
				try {
					await runDeviceFlow(accessor, notificationService, 'SuperGrok device-code sign-in. ')
				} catch (deviceError) {
					showAuthError(notificationService, deviceError)
				}
				return
			}
			showAuthError(notificationService, error)
		}
	}
})

registerAction2(class extends Action2 {
	constructor() { super({ id: VOID_XAI_GROK_DEVICE_SIGN_IN_ACTION_ID, title: 'Sign in with SuperGrok using a device code', f1: false }) }

	async run(accessor: ServicesAccessor) {
		const notificationService = accessor.get(INotificationService)
		try {
			await runDeviceFlow(accessor, notificationService, '')
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
