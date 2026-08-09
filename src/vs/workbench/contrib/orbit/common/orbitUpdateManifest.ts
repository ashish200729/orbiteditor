/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { isLinux, isMacintosh, isWindows } from '../../../../base/common/platform.js';

export const ORBIT_UPDATE_REPO = 'ashish200729/orbiteditor';

export const ORBIT_UPDATE_MANIFEST_URL = `https://raw.githubusercontent.com/${ORBIT_UPDATE_REPO}/main/update/latest.json`;

/** Manifest URL with a cache-busting query param so clients see fresh releases quickly. */
export function getOrbitUpdateManifestUrl(): string {
	return `${ORBIT_UPDATE_MANIFEST_URL}?t=${Date.now()}`;
}

export const ORBIT_RELEASES_URL = `https://github.com/${ORBIT_UPDATE_REPO}/releases/latest`;

export interface IOrbitUpdateAsset {
	readonly url: string;
	readonly sha256?: string;
}

export interface IOrbitUpdateManifest {
	readonly version: string;
	readonly commit?: string;
	readonly releasedAt?: string;
	readonly assets: Record<string, IOrbitUpdateAsset>;
	/** Base64 Ed25519 signature over {@link orbitManifestSigningPayload}. */
	readonly signature?: string;
}
export type OrbitLinuxPackageType = 'deb' | 'rpm' | 'appimage';

/**
 * Deterministic JSON serialization (recursively sorted object keys) so the
 * exact same manifest content always produces the exact same byte string
 * to sign/verify, regardless of the key order it happens to be written or
 * parsed in. Keep this in sync with the identical implementation in
 * scripts/update-latest-json.js — the release script signs with that copy,
 * the app verifies with this one; they must agree byte-for-byte.
 */
export function canonicalOrbitJsonStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(v => canonicalOrbitJsonStringify(v === undefined ? null : v)).join(',')}]`;
	}
	if (value !== null && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).filter(k => record[k] !== undefined).sort();
		const entries = keys.map(k => `${JSON.stringify(k)}:${canonicalOrbitJsonStringify(record[k])}`);
		return `{${entries.join(',')}}`;
	}
	return JSON.stringify(value);
}

/** The exact bytes that are Ed25519-signed/verified — everything in the manifest except the signature itself. */
export function orbitManifestSigningPayload(manifest: Pick<IOrbitUpdateManifest, 'version' | 'commit' | 'releasedAt' | 'assets'>): string {
	const { version, commit, releasedAt, assets } = manifest;
	return canonicalOrbitJsonStringify({ version, commit, releasedAt, assets });
}

export function normalizeOrbitVersion(version: string): string {
	return version.replace(/^v/i, '').trim();
}

export function isValidOrbitVersion(version: string): boolean {
	return /^\d+\.\d+\.\d+$/.test(normalizeOrbitVersion(version));
}

export function isTrustedOrbitUpdateAssetUrl(url: string, version: string): boolean {
	if (!isValidOrbitVersion(version)) {
		return false;
	}
	try {
		const parsed = new URL(url);
		const expectedPrefix = `/${ORBIT_UPDATE_REPO}/releases/download/v${normalizeOrbitVersion(version)}/`;
		return parsed.protocol === 'https:'
			&& parsed.hostname === 'github.com'
			&& !parsed.username
			&& !parsed.password
			&& !parsed.search
			&& !parsed.hash
			&& parsed.pathname.startsWith(expectedPrefix)
			&& parsed.pathname.length > expectedPrefix.length;
	} catch {
		return false;
	}
}

export function getOrbitPlatformAssetKey(linuxPackageType: OrbitLinuxPackageType = 'appimage', architecture: string = process.arch): string {
	const arch = architecture === 'arm64' ? 'arm64' : 'x64';
	if (isWindows) {
		return `win32-${arch}`;
	}
	if (isMacintosh) {
		return `darwin-${arch}`;
	}
	if (isLinux) {
		return `linux-${arch}-${linuxPackageType}`;
	}
	return `linux-${arch}-${linuxPackageType}`;
}

export function compareOrbitVersions(current: string, latest: string): number {
	const parse = (value: string) => normalizeOrbitVersion(value).split('.').map(part => parseInt(part, 10) || 0);
	const a = parse(current);
	const b = parse(latest);
	const length = Math.max(a.length, b.length);

	for (let i = 0; i < length; i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) {
			return diff;
		}
	}

	return 0;
}

export function getCurrentOrbitVersion(version: string | undefined, orbitVersion: string | undefined): string {
	return normalizeOrbitVersion(orbitVersion ?? version ?? '0.0.0');
}
