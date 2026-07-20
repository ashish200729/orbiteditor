/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Error codes for the xAI SuperGrok OAuth flows. The renderer reads these via
// `getXAiGrokOAuthErrorCode` because VS Code's IPC channel serializes rejected
// `Error` instances with only `message`, `name`, and `stack` — custom fields like
// `code` are dropped. The main-process `XAiGrokOAuthError` therefore encodes the
// code in `error.name` as `XAiGrokOAuthError:<code>`.

export const XAI_GROK_LOOPBACK_FAILURE_CODES = new Set([
	'port_unavailable',
	'callback_server_error',
	'port_in_use',
	'timeout',
])

const IPC_ERROR_NAME_RE = /^XAiGrokOAuthError:([\w_]+)$/

export const getXAiGrokOAuthErrorCode = (error: unknown): string | undefined => {
	if (!(error instanceof Error)) {
		return undefined
	}
	const withCode = error as Error & { code?: string }
	if (typeof withCode.code === 'string' && withCode.code.length > 0) {
		return withCode.code
	}
	return IPC_ERROR_NAME_RE.exec(error.name)?.[1]
}
