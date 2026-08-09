/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { execFile, spawn } from 'child_process';
import { app } from 'electron';
import * as fs from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const PREFLIGHT_MOUNT_TIMEOUT_MS = 20_000;

const MAC_DMG_INSTALLER_SCRIPT = `#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DMG="$1"
APP_NAME="$2"
TARGET="$3"
PID="$4"
LOG="$5"
MOUNT="$6"
WORK_DIR="$7"
STAGE="$WORK_DIR/$APP_NAME"
BACKUP="$WORK_DIR/previous.app"

log() { echo "$(date -Iseconds) $*" >> "$LOG"; }
cleanup() {
	hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
	rm -rf -- "$WORK_DIR"
	rmdir "$MOUNT" 2>/dev/null || true
	rm -rf -- "$SCRIPT_DIR"
}
rollback() {
	if [[ -d "$BACKUP" ]]; then
		rm -rf -- "$TARGET"
		mv -- "$BACKUP" "$TARGET"
	fi
}
trap cleanup EXIT

log "Waiting for Orbit (pid=$PID) to exit"
for _ in $(seq 1 120); do
	kill -0 "$PID" 2>/dev/null || break
	sleep 0.5
done
if kill -0 "$PID" 2>/dev/null; then
	log "ERROR: Orbit did not exit in time"
	exit 1
fi

log "Mounting update image"
mkdir -p "$MOUNT"
hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT" "$DMG" >/dev/null

SRC="$MOUNT/$APP_NAME"
if [[ ! -d "$SRC" || -L "$SRC" ]]; then
	log "ERROR: expected app is missing from update image"
	exit 1
fi

log "Verifying source signature"
codesign --verify --deep --strict --verbose=2 "$SRC" >> "$LOG" 2>&1

log "Copying verified app to staging"
ditto "$SRC" "$STAGE"
codesign --verify --deep --strict --verbose=2 "$STAGE" >> "$LOG" 2>&1

if [[ -e "$TARGET" ]]; then
	log "Backing up current app"
	mv -- "$TARGET" "$BACKUP"
fi

log "Installing update"
if ! mv -- "$STAGE" "$TARGET"; then
	log "ERROR: install failed; restoring previous app"
	rollback
	exit 1
fi

log "Relaunching updated app"
if ! open -n "$TARGET"; then
	log "ERROR: relaunch failed; restoring previous app"
	rollback
	open -n "$TARGET" || true
	exit 1
fi

rm -rf -- "$BACKUP"
log "Update installed successfully"
`;

function validateMacInstallInputs(dmgPath: string, appName: string, installTarget: string): void {
	if (!path.isAbsolute(dmgPath) || path.extname(dmgPath).toLowerCase() !== '.dmg') {
		throw new Error('The macOS update path must be an absolute .dmg path.');
	}
	if (path.basename(appName) !== appName || !appName.endsWith('.app')) {
		throw new Error('The macOS update contains an invalid app bundle name.');
	}
	if (!path.isAbsolute(installTarget) || path.basename(installTarget) !== appName) {
		throw new Error('The macOS update install target is invalid.');
	}
}

export function resolveMacAppBundlePath(): string {
	// process.execPath → …/Orbit.app/Contents/MacOS/Electron
	return path.resolve(path.dirname(process.execPath), '..', '..');
}

export function resolveMacInstallTarget(appName: string, currentBundlePath: string): string {
	const standard = path.join('/Applications', appName);
	if (currentBundlePath.startsWith('/Applications/')) {
		return standard;
	}

	try {
		fs.accessSync('/Applications', fs.constants.W_OK);
		return standard;
	} catch {
		return path.join(app.getPath('home'), 'Applications', appName);
	}
}

/**
 * Verifies the update can actually be installed before the caller quits the app.
 * Without this, a corrupt DMG or an unwritable install target only fails inside
 * the detached post-quit install script, leaving the user with no running app
 * and no visible error (see install.log). Throws with a user-facing message on
 * any failure; callers should surface the thrown error rather than quitting.
 */
export async function preflightMacInstall(dmgPath: string, appName: string, installTarget: string): Promise<void> {
	validateMacInstallInputs(dmgPath, appName, installTarget);
	const mountPoint = fs.mkdtempSync(path.join(tmpdir(), 'orbit-preflight-'));

	let attached = false;
	try {
		try {
			await Promise.race([
				execFileAsync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath]),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), PREFLIGHT_MOUNT_TIMEOUT_MS)),
			]);
			attached = true;
		} catch (error) {
			throw new Error(`Couldn't mount the update image: ${error instanceof Error ? error.message : error}`);
		}

		const appPath = path.join(mountPoint, appName);
		if (!fs.existsSync(appPath) || !fs.statSync(appPath).isDirectory() || fs.lstatSync(appPath).isSymbolicLink()) {
			throw new Error(`The update image doesn't contain ${appName} — it may be corrupt. Please try again or download it manually.`);
		}

		try {
			await execFileAsync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
		} catch (error) {
			throw new Error(`The update's code signature is invalid: ${error instanceof Error ? error.message : error}`);
		}
	} finally {
		if (attached) {
			await execFileAsync('hdiutil', ['detach', mountPoint, '-quiet']).catch(() => undefined);
		}
		fs.rmSync(mountPoint, { recursive: true, force: true });
	}

	try {
		fs.accessSync(path.dirname(installTarget), fs.constants.W_OK);
	} catch {
		throw new Error(`Can't write to ${path.dirname(installTarget)} — check permissions and try again.`);
	}
}

export function spawnMacDmgInstaller(opts: {
	dmgPath: string;
	appName: string;
	installTarget: string;
	currentPid: number;
	logPath: string;
}): void {
	validateMacInstallInputs(opts.dmgPath, opts.appName, opts.installTarget);
	if (!Number.isSafeInteger(opts.currentPid) || opts.currentPid <= 0) {
		throw new Error('The macOS update process ID is invalid.');
	}
	if (!path.isAbsolute(opts.logPath)) {
		throw new Error('The macOS update log path must be absolute.');
	}

	const scriptDir = fs.mkdtempSync(path.join(tmpdir(), 'orbit-installer-'));
	const scriptPath = path.join(scriptDir, 'install.sh');
	const mountPoint = fs.mkdtempSync(path.join(tmpdir(), 'orbit-mount-'));
	const installParent = path.dirname(opts.installTarget);
	const workDir = fs.mkdtempSync(path.join(installParent, `.${opts.appName}.orbit-update-`));

	fs.mkdirSync(path.dirname(opts.logPath), { recursive: true });
	fs.writeFileSync(scriptPath, MAC_DMG_INSTALLER_SCRIPT, { mode: 0o700, flag: 'wx' });

	const child = spawn('/bin/bash', [
		scriptPath,
		opts.dmgPath,
		opts.appName,
		opts.installTarget,
		String(opts.currentPid),
		opts.logPath,
		mountPoint,
		workDir,
	], {
		detached: true,
		stdio: 'ignore',
	});
	child.once('error', () => {
		fs.rmSync(scriptDir, { recursive: true, force: true });
		fs.rmSync(mountPoint, { recursive: true, force: true });
		fs.rmSync(workDir, { recursive: true, force: true });
	});
	child.unref();
}
