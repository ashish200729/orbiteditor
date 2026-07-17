/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import { IOrbitUpdateManifest, orbitManifestSigningPayload } from '../common/orbitUpdateManifest.js';

// Public key only — safe to ship in source. The matching private key is
// held outside this repo (release CI secret) and is never committed; see
// scripts/update-latest-json.js for the signing side. Without an
// independent signature, the manifest's sha256 alone only proves the
// binary matches what the manifest says — it doesn't prove the manifest
// itself came from us, so anyone who can write to the GitHub repo (or a
// MITM on the raw.githubusercontent.com fetch, absent that host's own TLS)
// could otherwise publish a self-consistent malicious manifest+binary pair
// that auto-installs.
const ORBIT_UPDATE_PUBLIC_KEY_BASE64 = 'jfSv0VvIzLBrxXtfMaDdM8Di6JHv1P6xWbPnA11pxes=';

function toSpkiDer(rawPublicKey: Buffer): Buffer {
	// Ed25519 SubjectPublicKeyInfo prefix for a raw 32-byte public key (RFC 8410).
	const prefix = Buffer.from('302a300506032b6570032100', 'hex');
	return Buffer.concat([prefix, rawPublicKey]);
}

let cachedPublicKey: crypto.KeyObject | undefined;
function getPublicKey(): crypto.KeyObject {
	if (!cachedPublicKey) {
		const der = toSpkiDer(Buffer.from(ORBIT_UPDATE_PUBLIC_KEY_BASE64, 'base64'));
		cachedPublicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
	}
	return cachedPublicKey;
}

/**
 * Returns true only if `manifest.signature` is a valid Ed25519 signature
 * over {@link orbitManifestSigningPayload} from our release key. A missing
 * or invalid signature returns false — callers must treat that the same
 * as a missing sha256 (refuse to auto-install, direct the user to the
 * manual releases page).
 */
export function verifyOrbitManifestSignature(manifest: IOrbitUpdateManifest): boolean {
	if (!manifest.signature) {
		return false;
	}
	try {
		const signatureBytes = Buffer.from(manifest.signature, 'base64');
		const payload = Buffer.from(orbitManifestSigningPayload(manifest), 'utf8');
		return crypto.verify(null, payload, getPublicKey(), signatureBytes);
	} catch {
		return false;
	}
}
