#!/usr/bin/env node
/* Verify a downloaded Orbit update manifest before shell installers trust it. */
'use strict';

const crypto = require('crypto');
const fs = require('fs');

const PUBLIC_KEY_BASE64 = 'yB0jmEMM2ixRTT6kErwnirlg/BI//HY+YBkyS9OfneE=';
const REPO = 'ashish200729/orbiteditor';

function canonical(value) {
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonical(item === undefined ? null : item)).join(',')}]`;
	}
	if (value !== null && typeof value === 'object') {
		return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

function fail(message) {
	console.error(`verify-update-manifest: ${message}`);
	process.exit(1);
}

const manifestPath = process.argv[2];
const platformKey = process.argv[3];
if (!manifestPath || !platformKey) {
	fail('usage: verify-update-manifest.js manifest.json platform-key');
}

let manifest;
try {
	manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (error) {
	fail(`could not read manifest: ${error.message}`);
}

if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || !manifest.assets || typeof manifest.signature !== 'string') {
	fail('manifest structure is invalid');
}
const asset = manifest.assets[platformKey];
if (!asset || !/^[0-9a-f]{64}$/i.test(asset.sha256)) {
	fail(`asset metadata is invalid for ${platformKey}`);
}

let url;
try {
	url = new URL(asset.url);
} catch {
	fail('asset URL is invalid');
}
const expectedPrefix = `/${REPO}/releases/download/v${manifest.version}/`;
if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(expectedPrefix) || url.pathname.length <= expectedPrefix.length) {
	fail('asset URL is not an expected Orbit GitHub release URL');
}

const { version, commit, releasedAt, assets } = manifest;
const payload = Buffer.from(canonical({ version, commit, releasedAt, assets }), 'utf8');
const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
try {
	const publicKey = crypto.createPublicKey({ key: Buffer.concat([spkiPrefix, Buffer.from(PUBLIC_KEY_BASE64, 'base64')]), format: 'der', type: 'spki' });
	if (!crypto.verify(null, payload, publicKey, Buffer.from(manifest.signature, 'base64'))) {
		fail('manifest signature is invalid');
	}
} catch (error) {
	fail(`manifest signature could not be verified: ${error.message}`);
}

console.log(`Verified signed Orbit ${manifest.version} manifest for ${platformKey}`);
