/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { Server } from 'http'

export type XAiGrokCredentials = {
	accessToken: string
	refreshToken?: string
	expiresAt: number
	email?: string
	idToken?: string
}

export type XAiTokenResponse = {
	access_token?: string
	refresh_token?: string
	expires_in?: number
	id_token?: string
	error?: string
	error_description?: string
}

export type XAiDeviceCodeResponse = {
	device_code?: string
	user_code?: string
	verification_uri?: string
	verification_uri_complete?: string
	expires_in?: number
	interval?: number
}

export type PendingBrowserAuth = {
	state: string
	codeVerifier: string
	redirectUri: string
	server: Server
	resolve: (credentials: XAiGrokCredentials) => void
	reject: (error: Error) => void
	promise: Promise<XAiGrokCredentials>
	timeoutId: NodeJS.Timeout
}

export type PendingDeviceAuth = {
	resolve: (credentials: XAiGrokCredentials) => void
	reject: (error: Error) => void
	promise: Promise<XAiGrokCredentials>
	abortController: AbortController
}
