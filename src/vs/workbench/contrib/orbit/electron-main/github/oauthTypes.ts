/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export type GitHubCredentials = {
	accessToken: string
	expiresAt: number
	user: {
		id: string
		email?: string
		login?: string
		avatarUrl?: string
		plan?: string
	}
}

export type PendingState = {
	state: string
	codeVerifier: string
	resolve: (creds: GitHubCredentials) => void
	reject: (err: Error) => void
	timeoutId: NodeJS.Timeout
	startedAt: number
}
