/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/** True only for hostnames that are unambiguously local after URL parsing. */
export function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
	if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1') {
		return true;
	}
	if (normalized.startsWith('::ffff:')) {
		return isLoopbackHostname(normalized.slice('::ffff:'.length));
	}
	const octets = normalized.split('.');
	return octets.length === 4
		&& octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
		&& Number(octets[0]) === 127;
}

/**
 * Shared policy for endpoints that carry prompts, source, tokens, or API keys:
 * HTTPS is required except for an explicit loopback development service.
 * Returns a user-facing error instead of throwing so callers can surface it in
 * their own settings/config validation flow.
 */
export function remoteHttpEndpointPolicyError(rawEndpoint: string, label: string): string | undefined {
	let endpoint: URL;
	try {
		endpoint = new URL(rawEndpoint);
	} catch {
		return `${label} must be a valid absolute URL.`;
	}
	if (endpoint.username || endpoint.password) {
		return `${label} must not contain credentials in the URL.`;
	}
	if (endpoint.protocol === 'https:') {
		return undefined;
	}
	if (endpoint.protocol === 'http:' && isLoopbackHostname(endpoint.hostname)) {
		return undefined;
	}
	return `${label} must use HTTPS. Plain HTTP is permitted only for loopback development endpoints.`;
}

/** Fetch with every redirect hop revalidated. Native `redirect: follow` checks
 * only the initial URL in application code, so a trusted endpoint could bounce
 * a credential-bearing request onto cleartext or a non-web scheme. */
export async function fetchWithEndpointPolicy(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	label: string,
	redirectCount = 0,
): Promise<Response> {
	const request = new Request(input, init);
	const url = new URL(request.url);
	const policyError = remoteHttpEndpointPolicyError(url.toString(), label);
	if (policyError) throw new Error(policyError);
	const replayableRequest = request.method === 'GET' || request.method === 'HEAD' ? undefined : request.clone();
	const response = await fetch(request, { redirect: 'manual' });
	if (![301, 302, 303, 307, 308].includes(response.status)) return response;
	if (redirectCount >= 5) throw new Error(`${label} exceeded the maximum redirect count.`);
	const location = response.headers.get('location');
	if (!location) throw new Error(`${label} returned a redirect without a Location header.`);
	const target = new URL(location, url);
	const targetError = remoteHttpEndpointPolicyError(target.toString(), `${label} redirect`);
	if (targetError) throw new Error(targetError);
	if (response.body) await response.body.cancel().catch(() => { /* best-effort redirect body disposal */ });

	let method = request.method.toUpperCase();
	if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
		method = 'GET';
	}
	const headers = new Headers(request.headers);
	if (target.origin !== url.origin) {
		// A 307/308 would replay prompts/source to a different service. Refuse it
		// even if the URL is HTTPS; API POST endpoints have no legitimate reason
		// to transfer a body across origins implicitly.
		if (method !== 'GET' && method !== 'HEAD') {
			throw new Error(`${label} refused a cross-origin redirect that would forward a request body.`);
		}
		for (const name of [...headers.keys()]) {
			if (/authorization|cookie|api[-_]?key|token|secret/i.test(name)) headers.delete(name);
		}
	}
	headers.delete('host');
	let body: BodyInit | undefined;
	if (method === 'GET' || method === 'HEAD') {
		headers.delete('content-length');
		headers.delete('content-type');
	} else if (replayableRequest) {
		body = await replayableRequest.arrayBuffer();
	}
	const nextRequest = new Request(target, {
		method,
		headers,
		body,
		signal: request.signal,
		cache: request.cache,
		credentials: request.credentials,
		integrity: request.integrity,
		keepalive: request.keepalive,
		mode: request.mode,
		referrer: request.referrer,
		referrerPolicy: request.referrerPolicy,
	});
	return fetchWithEndpointPolicy(nextRequest, undefined, label, redirectCount + 1);
}
