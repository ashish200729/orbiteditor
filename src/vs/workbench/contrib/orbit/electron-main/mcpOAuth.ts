/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * OAuth 2.0 support for remote (HTTP/SSE) MCP servers.
 *
 * Many hosted MCP servers (Notion, Linear, Figma, Sentry, …) require an OAuth
 * login rather than a static API key. The MCP SDK implements the OAuth client
 * (discovery, dynamic client registration, PKCE, code exchange, refresh) and
 * drives it through an `OAuthClientProvider`. This module supplies that provider
 * plus the desktop pieces the SDK can't do on its own:
 *   - opening the system browser to the authorization URL, and
 *   - a loopback HTTP server that catches the OAuth redirect and hands the code
 *     back to the SDK via `transport.finishAuth()`.
 *
 * Tokens + dynamic client registrations are persisted per server under the app's
 * userData dir, encrypted at rest with Electron `safeStorage` when available.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { app, shell, safeStorage } from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { OAuthClientProvider, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientMetadata, OAuthClientInformation, OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { fetchWithEndpointPolicy } from '../common/networkSecurity.js';

type PersistedOAuth = {
	clientInformation?: OAuthClientInformationFull;
	tokens?: OAuthTokens;
};

const AUTH_TIMEOUT_MS = 5 * 60_000;

function storeDir(): string {
	const dir = path.join(app.getPath('userData'), 'orbit-mcp-oauth');
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stat = fs.lstatSync(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('MCP OAuth storage path is not a safe directory.');
	if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('MCP OAuth storage directory is not owned by the current user.');
	if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
	// Pre-hardening builds used a 32-hex name and could fall back to plaintext.
	// Those files cannot be safely migrated or rebound to an exact resource URL.
	for (const name of fs.readdirSync(dir)) {
		if (/^[0-9a-f]{32}\.json$/i.test(name)) {
			try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* best-effort migration cleanup */ }
		}
	}
	return dir;
}

function canonicalResource(resourceUrl: URL): string {
	const normalized = new URL(resourceUrl.toString());
	normalized.username = '';
	normalized.password = '';
	normalized.hash = '';
	return normalized.toString();
}

function storageIdentity(serverName: string, resourceUrl: URL): string {
	return `${serverName}\n${canonicalResource(resourceUrl)}`;
}

function storeFileFor(serverName: string, resourceUrl: URL): string {
	const safe = crypto.createHash('sha256').update(storageIdentity(serverName, resourceUrl)).digest('hex');
	return path.join(storeDir(), `${safe}.json`);
}

function secureStorageAvailable(): boolean {
	if (!safeStorage.isEncryptionAvailable()) return false;
	return !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text');
}

function readPersisted(serverName: string, resourceUrl: URL): PersistedOAuth {
	try {
		if (!secureStorageAvailable()) return {};
		const file = storeFileFor(serverName, resourceUrl);
		if (!fs.existsSync(file)) return {};
		const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
		const fd = fs.openSync(file, flags);
		try {
			const stat = fs.fstatSync(fd);
			if (!stat.isFile() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return {};
			return JSON.parse(safeStorage.decryptString(fs.readFileSync(fd))) as PersistedOAuth;
		} finally { fs.closeSync(fd); }
	} catch {
		return {};
	}
}

function writePersisted(serverName: string, resourceUrl: URL, data: PersistedOAuth): void {
	let temp: string | undefined;
	try {
		// Never downgrade tokens to plaintext. They remain session-only when the
		// OS keychain/secret service is unavailable or Electron selected basic_text.
		if (!secureStorageAvailable()) return;
		const file = storeFileFor(serverName, resourceUrl);
		temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
		const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
		try {
			fs.writeFileSync(fd, safeStorage.encryptString(JSON.stringify(data)));
			fs.fsyncSync(fd);
		} finally { fs.closeSync(fd); }
		// POSIX rename replaces atomically. Windows rejects replacement, so remove
		// the old user-owned file immediately before installing the complete temp.
		if (process.platform === 'win32' && fs.existsSync(file)) fs.rmSync(file, { force: true });
		fs.renameSync(temp, file);
		if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
	} catch (err) {
		if (temp) try { fs.rmSync(temp, { force: true }); } catch { /* best-effort */ }
		console.error(`[mcpOAuth] Failed to persist tokens for ${serverName}:`, err);
	}
}

/** True if this server has previously completed an OAuth login (tokens on disk). */
export function hasStoredMcpTokens(serverName: string, resourceUrl: URL): boolean {
	return !!readPersisted(serverName, resourceUrl).tokens?.access_token;
}

/** Delete stored OAuth state for a server (used on remove / re-auth). */
export function clearStoredMcpTokens(serverName: string, resourceUrl: URL): void {
	try {
		const file = storeFileFor(serverName, resourceUrl);
		if (fs.existsSync(file)) fs.rmSync(file);
	} catch { /* ignore */ }
}

class OrbitMcpOAuthProvider implements OAuthClientProvider {
	private _codeVerifier: string | undefined;
	private _persisted: PersistedOAuth;
	private readonly _state = crypto.randomBytes(32).toString('base64url');

	constructor(
		private readonly serverName: string,
		private readonly resourceUrl: URL,
		private _redirectUrl: string,
		/** When false, redirectToAuthorization is a no-op — used to probe auth state without opening a browser. */
		private readonly interactive: boolean,
	) {
		this._persisted = readPersisted(serverName, resourceUrl);
	}

	setRedirectUrl(url: string) { this._redirectUrl = url; }

	get redirectUrl(): string { return this._redirectUrl; }

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: 'Orbit Editor',
			redirect_uris: [this._redirectUrl],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
		};
	}

	clientInformation(): OAuthClientInformation | undefined {
		return this._persisted.clientInformation;
	}

	saveClientInformation(clientInformation: OAuthClientInformationFull): void {
		this._persisted = { ...this._persisted, clientInformation };
		writePersisted(this.serverName, this.resourceUrl, this._persisted);
	}

	tokens(): OAuthTokens | undefined {
		return this._persisted.tokens;
	}

	saveTokens(tokens: OAuthTokens): void {
		this._persisted = { ...this._persisted, tokens };
		writePersisted(this.serverName, this.resourceUrl, this._persisted);
	}

	redirectToAuthorization(authorizationUrl: URL): void {
		if (!this.interactive) return; // passive probe — don't pop a browser
		shell.openExternal(authorizationUrl.toString()).catch(err =>
			console.error(`[mcpOAuth] Failed to open browser for ${this.serverName}:`, err));
	}

	saveCodeVerifier(codeVerifier: string): void { this._codeVerifier = codeVerifier; }

	codeVerifier(): string {
		if (!this._codeVerifier) throw new Error('No code verifier saved');
		return this._codeVerifier;
	}

	state(): string { return this._state; }
}

/** Result of attempting a connection that may require OAuth. */
export type OAuthProbeResult =
	| { kind: 'ok'; provider: OrbitMcpOAuthProvider }
	| { kind: 'needs-auth' }
	| { kind: 'no-auth' }; // server didn't require auth

/**
 * Build an OAuthClientProvider for a server. Attaches to HTTP/SSE transports so
 * the SDK auto-refreshes and (in interactive flows) drives the login.
 */
export function makeOAuthProvider(serverName: string, resourceUrl: URL, interactive: boolean): OrbitMcpOAuthProvider {
	// redirectUrl is finalized once the loopback server binds; use a placeholder
	// for the passive (non-interactive) provider where no redirect happens.
	return new OrbitMcpOAuthProvider(serverName, resourceUrl, 'http://127.0.0.1:0/callback', interactive);
}

const SUCCESS_HTML = (title: string, message: string) => {
	const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,Segoe UI,sans-serif;background:#0b0d12;color:#e6e8ee}
.card{max-width:440px;padding:32px 36px;border-radius:16px;background:#151922;border:1px solid #262b36;text-align:center}
h1{font-size:20px;margin:0 0 8px}p{color:#9aa2b1;font-size:14px;margin:0}</style></head>
<body><div class="card"><h1>${esc(title)}</h1><p>${esc(message)}</p><p style="margin-top:12px">You can return to Orbit and close this tab.</p></div>
<script>setTimeout(()=>window.close(),1500)</script></body></html>`;
};

/**
 * Run the interactive OAuth login for a remote MCP server:
 * open the browser, catch the loopback redirect, exchange the code, persist tokens.
 * Resolves when tokens are stored (the caller then reconnects normally).
 */
export async function runMcpOAuthFlow(serverName: string, serverUrl: URL, isSSE: boolean): Promise<void> {
	// Fresh registration/tokens each explicit login attempt keeps the flow robust
	// against a stale/rejected dynamic client registration.
	const provider = new OrbitMcpOAuthProvider(serverName, serverUrl, 'http://127.0.0.1:0/callback', true);

	let resolveCode!: (code: string) => void;
	let rejectCode!: (err: Error) => void;
	const codePromise = new Promise<string>((res, rej) => { resolveCode = res; rejectCode = rej; });
	codePromise.catch(() => { /* observed below */ });

	let expectedHost = '';
	let callbackConsumed = false;
	const server = http.createServer((req, res) => {
		if (req.method !== 'GET' || req.headers.host !== expectedHost) {
			res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('Invalid callback request'); return;
		}
		const reqUrl = req.url ? new URL(req.url, 'http://127.0.0.1') : null;
		if (!reqUrl || reqUrl.pathname !== '/callback') {
			res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return;
		}
		const returnedState = reqUrl.searchParams.get('state');
		const respond = (title: string, message: string) => {
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
			res.end(SUCCESS_HTML(title, message));
		};
		if (callbackConsumed || returnedState !== provider.state()) {
			res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('Invalid or expired OAuth state'); return;
		}
		callbackConsumed = true;
		const error = reqUrl.searchParams.get('error');
		const code = reqUrl.searchParams.get('code');
		if (error) {
			respond('Sign-in failed', reqUrl.searchParams.get('error_description') ?? error);
			rejectCode(new Error(`OAuth error: ${error}`));
			return;
		}
		if (!code) {
			respond('Sign-in failed', 'Authorization code missing.');
			rejectCode(new Error('Authorization code missing'));
			return;
		}
		respond('Connected', `Orbit is now connected to ${serverName}.`);
		resolveCode(code);
	});

	const port: number = await new Promise((resolve, reject) => {
		server.once('error', reject);
		// Bind an ephemeral loopback port; the redirect_uri is registered dynamically
		// at authorize time, so the port need not be fixed.
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			resolve(typeof addr === 'object' && addr ? addr.port : 0);
		});
	});
	expectedHost = `127.0.0.1:${port}`;
	provider.setRedirectUrl(`http://127.0.0.1:${port}/callback`);

	const guardedFetch = (input: string | URL, init?: RequestInit) => fetchWithEndpointPolicy(input, init, `MCP server "${serverName}"`);
	const makeTransport = () => isSSE
		? new SSEClientTransport(serverUrl, { authProvider: provider, fetch: guardedFetch })
		: new StreamableHTTPClientTransport(serverUrl, { authProvider: provider, fetch: guardedFetch });

	const timeout = setTimeout(() => rejectCode(new Error('Authorization timed out')), AUTH_TIMEOUT_MS);

	const transport = makeTransport();
	const client = new Client({ name: `${serverName}-client`, version: '0.1.0' });
	try {
		try {
			await client.connect(transport);
			// Already authorized (tokens were valid) — nothing more to do.
			await client.close().catch(() => { });
			return;
		} catch (e) {
			if (!(e instanceof UnauthorizedError)) throw e;
			// Expected: browser opened via redirectToAuthorization. Await the code.
		}
		const code = await codePromise;
		await transport.finishAuth(code); // exchanges code + persists tokens via provider
		await transport.close().catch(() => { });
	} finally {
		clearTimeout(timeout);
		if (server.listening) server.close();
	}
}
