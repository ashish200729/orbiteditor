/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as sudoPrompt from '@vscode/sudo-prompt';
import { promiseWithResolvers } from '../../../../base/common/async.js';
import type { OrbitLinuxPackageType } from '../common/orbitUpdateManifest.js';


export function detectLinuxPackageType(
	env: NodeJS.ProcessEnv = process.env,
	executablePath: string = process.execPath,
): OrbitLinuxPackageType {
	const override = env['ORBIT_LINUX_PACKAGE_TYPE']?.toLowerCase();
	if (override === 'deb' || override === 'rpm' || override === 'appimage') {
		return override;
	}
	if (env['APPIMAGE']) {
		return 'appimage';
	}
	if (spawnSync('dpkg-query', ['-S', executablePath], { stdio: 'ignore' }).status === 0) {
		return 'deb';
	}
	if (spawnSync('rpm', ['-qf', executablePath], { stdio: 'ignore' }).status === 0) {
		return 'rpm';
	}
	// Portable Linux builds consume AppImage updates. An install attempt still
	// requires APPIMAGE so an unpacked developer build cannot overwrite itself.
	return 'appimage';
}


export function getLinuxUpdatePackageType(packagePath: string): OrbitLinuxPackageType {
	const lower = packagePath.toLowerCase();
	if (lower.endsWith('.deb')) {
		return 'deb';
	}
	if (lower.endsWith('.rpm')) {
		return 'rpm';
	}
	if (lower.endsWith('.appimage')) {
		return 'appimage';
	}
	throw new Error(`Unsupported Linux update package: ${path.basename(packagePath)}`);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function getElevatedLinuxInstallCommand(
	packagePath: string,
	commandExists: (commandPath: string) => boolean = fs.existsSync,
): string {
	const quotedPackagePath = shellQuote(packagePath);
	switch (getLinuxUpdatePackageType(packagePath)) {
		case 'deb':
			if (commandExists('/usr/bin/apt-get')) {
				return `/usr/bin/apt-get install -y -- ${quotedPackagePath}`;
			}
			throw new Error('Orbit requires apt-get to install Debian updates with their dependencies.');
		case 'rpm':
			if (commandExists('/usr/bin/dnf')) {
				return `/usr/bin/dnf install -y -- ${quotedPackagePath}`;
			}
			if (commandExists('/usr/bin/zypper')) {
				return `/usr/bin/zypper --non-interactive install -- ${quotedPackagePath}`;
			}
			if (commandExists('/usr/bin/yum')) {
				return `/usr/bin/yum install -y -- ${quotedPackagePath}`;
			}
			throw new Error('Orbit requires dnf, zypper, or yum to install RPM updates with their dependencies.');
		case 'appimage':
			throw new Error('AppImage updates do not use an elevated package-manager command.');
	}
}

async function runElevated(command: string, productName: string): Promise<void> {
	const { promise, resolve, reject } = promiseWithResolvers<void>();
	sudoPrompt.exec(command, { name: productName.replace(/-/g, '') }, (error?, _stdout?, stderr?) => {
		if (error) {
			reject(new Error(stderr?.toString() || error.message));
		} else {
			resolve();
		}
	});
	await promise;
}

async function prepareAppImageReplacement(packagePath: string, currentPid: number, env: NodeJS.ProcessEnv): Promise<void> {
	const targetPath = env['APPIMAGE'];
	if (!targetPath) {
		throw new Error('Orbit is not running from an AppImage; refusing to replace an unknown portable installation.');
	}
	await fs.promises.access(path.dirname(targetPath), fs.constants.W_OK);
	const stagedPath = `${targetPath}.orbit-update-${currentPid}`;
	await fs.promises.copyFile(packagePath, stagedPath);
	await fs.promises.chmod(stagedPath, 0o755);

	const replaceScript = [
		'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done',
		'mv -f -- "$2" "$3"',
		'exec "$3"',
	].join('\n');
	const child = spawn('/bin/sh', ['-c', replaceScript, 'orbit-appimage-update', String(currentPid), stagedPath, targetPath], {
		detached: true,
		stdio: 'ignore',
	});
	child.unref();
}

export async function prepareLinuxUpdateInstall(
	packagePath: string,
	productName: string,
	currentPid: number = process.pid,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const packageType = getLinuxUpdatePackageType(packagePath);
	if (packageType === 'deb' || packageType === 'rpm') {
		await runElevated(getElevatedLinuxInstallCommand(packagePath), productName);
		return;
	}
	await prepareAppImageReplacement(packagePath, currentPid, env);
}
