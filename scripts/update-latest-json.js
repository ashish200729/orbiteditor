#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Updates update/latest.json for the Orbit auto-updater.
 *
 *  Usage:
 *    node scripts/update-latest-json.js --version 0.2.0 --tag v0.2.0 \
 *      --asset darwin-arm64=./Orbit-0.2.0-darwin-arm64.dmg \
 *      --merge
 *
 *  --merge             Preserve existing platform entries not passed via --asset
 *  --sign-existing     Re-sign update/latest.json in place (no --asset required;
 *                      use to add a signature to an already-published manifest)
 *  --commit            Optional git commit SHA to record in the manifest
 *  --allow-unsigned    Skip Ed25519 signing (local/dev testing only — the app
 *                      refuses to auto-install an unsigned manifest)
 *
 *  Signing requires ORBIT_UPDATE_SIGNING_KEY: a PEM-encoded PKCS8 Ed25519
 *  private key (the full "-----BEGIN PRIVATE KEY-----...-----END PRIVATE
 *  KEY-----" block, e.g. as a GitHub Actions secret). The matching public
 *  key is embedded in src/vs/workbench/contrib/orbit/electron-main/
 *  orbitUpdateSignature.ts — regenerate both together if the key ever
 *  needs to be rotated.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = 'ashish200729/orbiteditor';
const VALID_KEYS = new Set([
	'darwin-arm64',
	'darwin-x64',
	'win32-x64',
	'win32-arm64',
	'linux-x64-deb',
	'linux-x64-rpm',
	'linux-x64-appimage',
	'linux-arm64-deb',
	'linux-arm64-rpm',
	'linux-arm64-appimage',
]);

const ARTIFACT_NAMES = {
	'darwin-arm64': (version) => `Orbit-${version}-darwin-arm64.dmg`,
	'darwin-x64': (version) => `Orbit-${version}-darwin-x64.dmg`,
	'win32-x64': (version) => `Orbit-${version}-win32-x64-setup.exe`,
	'win32-arm64': (version) => `Orbit-${version}-win32-arm64-setup.exe`,
	'linux-x64-deb': (version) => `Orbit-${version}-linux-x64.deb`,
	'linux-x64-rpm': (version) => `Orbit-${version}-linux-x64.rpm`,
	'linux-x64-appimage': (version) => `Orbit-${version}-linux-x64.AppImage`,
	'linux-arm64-deb': (version) => `Orbit-${version}-linux-arm64.deb`,
	'linux-arm64-rpm': (version) => `Orbit-${version}-linux-arm64.rpm`,
	'linux-arm64-appimage': (version) => `Orbit-${version}-linux-arm64.AppImage`,
};

function sha256(filePath) {
	const data = fs.readFileSync(filePath);
	return crypto.createHash('sha256').update(data).digest('hex');
}

// Keep this byte-for-byte identical to canonicalOrbitJsonStringify in
// src/vs/workbench/contrib/orbit/common/orbitUpdateManifest.ts — this
// script signs with this copy, the app verifies with that one.
function canonicalOrbitJsonStringify(value) {
	if (Array.isArray(value)) {
		return `[${value.map((v) => canonicalOrbitJsonStringify(v === undefined ? null : v)).join(',')}]`;
	}
	if (value !== null && typeof value === 'object') {
		const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
		const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalOrbitJsonStringify(value[k])}`);
		return `{${entries.join(',')}}`;
	}
	return JSON.stringify(value);
}

function signingPayload(manifest) {
	const { version, commit, releasedAt, assets } = manifest;
	return canonicalOrbitJsonStringify({ version, commit, releasedAt, assets });
}

function signManifest(manifest, allowUnsigned) {
	const keyPem = process.env.ORBIT_UPDATE_SIGNING_KEY;
	if (!keyPem) {
		if (allowUnsigned) {
			console.warn('WARNING: ORBIT_UPDATE_SIGNING_KEY not set — writing an UNSIGNED manifest (--allow-unsigned). The app will refuse to auto-install from this manifest.');
			return manifest;
		}
		throw new Error(
			'ORBIT_UPDATE_SIGNING_KEY is not set. Refusing to publish an unsigned update manifest ' +
			'(the app will not auto-install from it, silently degrading every user to manual updates). ' +
			'Set the signing key, or pass --allow-unsigned for local/dev testing only.'
		);
	}
	const privateKey = crypto.createPrivateKey(keyPem);
	const payload = Buffer.from(signingPayload(manifest), 'utf8');
	const signature = crypto.sign(null, payload, privateKey).toString('base64');
	return { ...manifest, signature };
}

function releaseUrl(tag, version, platformKey) {
	const fileName = ARTIFACT_NAMES[platformKey](version);
	return `https://github.com/${REPO}/releases/download/${tag}/${fileName}`;
}

function parseArgs(argv) {
	const opts = {
		version: '',
		tag: '',
		commit: undefined,
		merge: false,
		signExisting: false,
		allowUnsigned: false,
		assets: {},
	};

	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--merge') {
			opts.merge = true;
		} else if (arg === '--sign-existing') {
			opts.signExisting = true;
		} else if (arg === '--allow-unsigned') {
			opts.allowUnsigned = true;
		} else if (arg === '--version') {
			opts.version = argv[++i];
		} else if (arg === '--tag') {
			opts.tag = argv[++i];
		} else if (arg === '--commit') {
			opts.commit = argv[++i];
		} else if (arg === '--asset') {
			const pair = argv[++i];
			const eq = pair.indexOf('=');
			if (eq === -1) {
				throw new Error(`Invalid --asset value "${pair}" (expected key=path)`);
			}
			opts.assets[pair.slice(0, eq)] = pair.slice(eq + 1);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!opts.version) {
		const product = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'product.json'), 'utf8'));
		opts.version = product.orbitVersion;
	}
	if (!opts.tag) {
		opts.tag = `v${opts.version.replace(/^v/i, '')}`;
	}

	return opts;
}

function loadExistingManifest(manifestPath) {
	if (!fs.existsSync(manifestPath)) {
		return { version: '', releasedAt: '', assets: {} };
	}
	return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function writeManifest(manifestPath, signedManifest) {
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, JSON.stringify(signedManifest, null, '\t') + '\n');
	console.log(`Updated ${manifestPath}`);
	console.log(JSON.stringify(signedManifest, null, 2));
}

function main() {
	const opts = parseArgs(process.argv);
	const root = process.cwd();
	const manifestPath = path.join(root, 'update', 'latest.json');
	const versionPattern = /^\d+\.\d+\.\d+$/;
	if (!versionPattern.test(opts.version)) {
		throw new Error(`Invalid release version "${opts.version}" (expected x.y.z)`);
	}
	if (opts.tag !== `v${opts.version}`) {
		throw new Error(`Release tag must be exactly v${opts.version}`);
	}
	if (opts.commit && !/^[0-9a-f]{7,40}$/i.test(opts.commit)) {
		throw new Error('Release commit must be a 7-40 character hexadecimal Git commit ID');
	}

	if (opts.signExisting) {
		const existing = loadExistingManifest(manifestPath);
		if (!existing.version || !existing.assets || Object.keys(existing.assets).length === 0) {
			throw new Error(`No manifest to sign at ${manifestPath}`);
		}

		const { signature: _ignored, ...unsigned } = existing;
		const manifest = {
			version: opts.version || unsigned.version,
			releasedAt: unsigned.releasedAt ?? new Date().toISOString().slice(0, 10),
			assets: unsigned.assets,
		};
		if (opts.commit ?? unsigned.commit) {
			manifest.commit = opts.commit ?? unsigned.commit;
		}

		const signedManifest = signManifest(manifest, opts.allowUnsigned);
		writeManifest(manifestPath, signedManifest);
		return;
	}

	const existing = opts.merge ? loadExistingManifest(manifestPath) : { assets: {} };
	// Never carry packages from an older release into a new version. Doing so
	// labels stale binaries as the new release and can downgrade installations.
	const assets = opts.merge && existing.version === opts.version ? { ...existing.assets } : {};

	for (const [platformKey, filePath] of Object.entries(opts.assets)) {
		if (!VALID_KEYS.has(platformKey)) {
			throw new Error(`Unknown platform key "${platformKey}". Valid: ${[...VALID_KEYS].join(', ')}`);
		}

		const resolved = path.resolve(root, filePath);
		if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
			throw new Error(`Asset file not found for ${platformKey}: ${resolved}`);
		}
		const expectedName = ARTIFACT_NAMES[platformKey](opts.version);
		if (path.basename(resolved) !== expectedName) {
			throw new Error(`Asset for ${platformKey} must be named ${expectedName}`);
		}

		assets[platformKey] = {
			url: releaseUrl(opts.tag, opts.version, platformKey),
			sha256: sha256(resolved),
		};
	}

	if (Object.keys(assets).length === 0) {
		throw new Error('No assets specified. Pass at least one --asset key=path');
	}

	const manifest = {
		version: opts.version,
		releasedAt: new Date().toISOString().slice(0, 10),
		assets,
	};

	if (opts.commit) {
		manifest.commit = opts.commit;
	}

	const signedManifest = signManifest(manifest, opts.allowUnsigned);
	writeManifest(manifestPath, signedManifest);
}

main();
