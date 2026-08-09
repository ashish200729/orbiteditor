/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { canonicalOrbitJsonStringify, compareOrbitVersions, getCurrentOrbitVersion, getOrbitPlatformAssetKey, getOrbitUpdateManifestUrl, isTrustedOrbitUpdateAssetUrl, isValidOrbitVersion, normalizeOrbitVersion, orbitManifestSigningPayload } from '../../common/orbitUpdateManifest.js';

suite('orbitUpdateManifest', () => {
	test('normalizeOrbitVersion strips leading v', () => {
		assert.strictEqual(normalizeOrbitVersion('v0.2.0'), '0.2.0');
		assert.strictEqual(normalizeOrbitVersion('V1.0.0'), '1.0.0');
	});

	test('compareOrbitVersions orders numeric segments', () => {
		assert.ok(compareOrbitVersions('0.1.0', '0.2.0') < 0);
		assert.ok(compareOrbitVersions('0.2.0', '0.1.0') > 0);
		assert.strictEqual(compareOrbitVersions('v0.1.0', '0.1.0'), 0);
		assert.ok(compareOrbitVersions('0.1.9', '0.1.10') < 0);
	});

	test('getCurrentOrbitVersion prefers orbitVersion', () => {
		assert.strictEqual(getCurrentOrbitVersion('9.9.9', '0.1.0'), '0.1.0');
		assert.strictEqual(getCurrentOrbitVersion('0.2.0', undefined), '0.2.0');
		assert.strictEqual(getCurrentOrbitVersion(undefined, undefined), '0.0.0');
	});

	test('getOrbitUpdateManifestUrl includes cache buster', () => {
		const url = getOrbitUpdateManifestUrl();
		assert.ok(url.includes('latest.json?t='));
	});

	test('validates release versions and trusted asset URLs', () => {
		assert.strictEqual(isValidOrbitVersion('v0.5.2'), true);
		assert.strictEqual(isValidOrbitVersion('0.5'), false);
		assert.strictEqual(isValidOrbitVersion('0.5.2-beta'), false);
		assert.strictEqual(isTrustedOrbitUpdateAssetUrl('https://github.com/ashish200729/orbiteditor/releases/download/v0.5.2/Orbit-0.5.2-darwin-arm64.dmg', '0.5.2'), true);
		assert.strictEqual(isTrustedOrbitUpdateAssetUrl('https://example.com/Orbit-0.5.2.dmg', '0.5.2'), false);
		assert.strictEqual(isTrustedOrbitUpdateAssetUrl('https://github.com/ashish200729/orbiteditor/releases/download/v0.5.1/Orbit-0.5.1-darwin-arm64.dmg', '0.5.2'), false);
	});

	test('uses package-specific Linux asset keys', () => {
		if (process.platform === 'linux') {
			const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
			assert.strictEqual(getOrbitPlatformAssetKey('deb'), `linux-${arch}-deb`);
			assert.strictEqual(getOrbitPlatformAssetKey('rpm'), `linux-${arch}-rpm`);
			assert.strictEqual(getOrbitPlatformAssetKey('appimage'), `linux-${arch}-appimage`);
			assert.strictEqual(getOrbitPlatformAssetKey('deb', 'x64'), 'linux-x64-deb');
			assert.strictEqual(getOrbitPlatformAssetKey('appimage', 'arm64'), 'linux-arm64-appimage');
		}
	});

	test('canonicalOrbitJsonStringify is independent of key order', () => {
		const a = { version: '1.0.0', assets: { x: { url: 'u', sha256: 's' } }, releasedAt: '2026-01-01' };
		const b = { releasedAt: '2026-01-01', assets: { x: { sha256: 's', url: 'u' } }, version: '1.0.0' };
		assert.strictEqual(canonicalOrbitJsonStringify(a), canonicalOrbitJsonStringify(b));
	});

	test('canonicalOrbitJsonStringify drops undefined-valued keys, matching JSON.stringify semantics', () => {
		const withUndefined = { version: '1.0.0', commit: undefined, assets: {} };
		const withoutKey = { version: '1.0.0', assets: {} };
		assert.strictEqual(canonicalOrbitJsonStringify(withUndefined), canonicalOrbitJsonStringify(withoutKey));
	});

	test('orbitManifestSigningPayload changes when any signed field changes', () => {
		const base = { version: '1.0.0', releasedAt: '2026-01-01', assets: { 'darwin-arm64': { url: 'u', sha256: 's' } } };
		const changedVersion = { ...base, version: '2.0.0' };
		const changedUrl = { ...base, assets: { 'darwin-arm64': { url: 'other', sha256: 's' } } };
		const payload = orbitManifestSigningPayload(base);
		assert.notStrictEqual(orbitManifestSigningPayload(changedVersion), payload);
		assert.notStrictEqual(orbitManifestSigningPayload(changedUrl), payload);
		// signature itself must never affect the payload it's computed over
		const withSignature = { ...base, signature: 'anything' };
		assert.strictEqual(orbitManifestSigningPayload(withSignature), payload);
	});
});
