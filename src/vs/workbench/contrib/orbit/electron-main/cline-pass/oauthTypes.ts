/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { Server } from 'http'

export type ClinePassCredentials = {
	accessToken: string
	refreshToken: string
	expiresAt: number
	email?: string
	userId?: string
	displayName?: string
}

export type PendingAuthState = {
	state: string
	redirectUri: string
	server: Server
	resolve: (credentials: ClinePassCredentials) => void
	reject: (error: Error) => void
	promise: Promise<ClinePassCredentials>
	timeoutId: NodeJS.Timeout
	startedAt: number
}

export type ClinePassTokenResponseData = {
	accessToken: string
	refreshToken?: string
	tokenType?: string
	expiresAt?: string
	userInfo?: {
		subject?: string | null
		email?: string
		name?: string
		clineUserId?: string | null
		accounts?: string[] | null
	}
}

export type ClinePassTokenApiResponse = {
	success?: boolean
	data?: ClinePassTokenResponseData
	error?: string
	error_description?: string
}
