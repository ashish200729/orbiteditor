/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import {
	RUNNER_DEFAULT_HTTP_PORT,
	RUNNER_DEFAULT_WS_PATH,
	RUNNER_DEFAULT_WS_PORT,
} from './runnerProtocol.js';

function isLoopbackHostname(hostname: string): boolean {
	return hostname === 'localhost'
		|| hostname === '127.0.0.1'
		|| hostname === '[::1]'
		|| hostname === '::1';
}

/**
 * Normalize a user-entered runner URL to a WebSocket endpoint.
 * - Coerces http(s) → ws(s)
 * - Defaults missing path to `/ws`
 * - Defaults missing port on loopback to the WS port (7421)
 * - Remaps loopback dashboard port (7420) → WS port (7421)
 */
export function normalizeRunnerHostUrl(raw: string): string | undefined {
	const trimmed = (raw ?? '').trim();
	if (!trimmed) { return undefined; }
	let url = trimmed;
	if (!/^wss?:\/\//i.test(url) && !/^https?:\/\//i.test(url)) {
		url = `ws://${url}`;
	}
	if (/^https:\/\//i.test(url)) {
		url = 'wss://' + url.slice('https://'.length);
	} else if (/^http:\/\//i.test(url)) {
		url = 'ws://' + url.slice('http://'.length);
	}
	try {
		const u = new URL(url);
		if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
			return undefined;
		}
		if (u.username || u.password || u.search || u.hash) {
			return undefined;
		}
		const loopback = isLoopbackHostname(u.hostname);
		if (!u.port && loopback) {
			u.port = String(RUNNER_DEFAULT_WS_PORT);
		} else if (loopback && u.port === String(RUNNER_DEFAULT_HTTP_PORT)) {
			// Dashboard port is commonly pasted as the WS URL; remap to the protocol port.
			u.port = String(RUNNER_DEFAULT_WS_PORT);
		}
		if (!u.pathname || u.pathname === '/') {
			u.pathname = RUNNER_DEFAULT_WS_PATH;
		}
		return u.toString();
	} catch {
		return undefined;
	}
}

export function isSecureRunnerUrl(value: string): boolean {
	try {
		const url = new URL(value);
		if (url.protocol === 'wss:') { return true; }
		if (url.protocol !== 'ws:') { return false; }
		return isLoopbackHostname(url.hostname);
	} catch {
		return false;
	}
}
