/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export type OpenAiCodexRequestHeaderParams = {
	accessToken: string;
	accountId: string | undefined;
	originator: string;
	sessionId: string;
	clientVersion: string;
};

/** Headers required by ChatGPT's Codex Responses endpoint. */
export function buildOpenAiCodexRequestHeaders({
	accessToken,
	accountId,
	originator,
	sessionId,
	clientVersion,
}: OpenAiCodexRequestHeaderParams): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		'Content-Type': 'application/json',
		Accept: 'text/event-stream',
		originator,
		'session-id': sessionId,
		...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
		version: clientVersion,
		'User-Agent': 'orbit-editor',
	};
}
