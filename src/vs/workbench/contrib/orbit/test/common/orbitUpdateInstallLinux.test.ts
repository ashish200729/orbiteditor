/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { spawn } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import { detectLinuxPackageType, getElevatedLinuxInstallCommand, getLinuxUpdatePackageType, prepareLinuxUpdateInstall } from '../../electron-main/orbitUpdateInstall.linux.js';

(process.platform === 'linux' ? suite : suite.skip)('orbitUpdateInstall.linux', () => {
	test('selects package type from explicit packaging environment', () => {
		assert.strictEqual(detectLinuxPackageType({ ORBIT_LINUX_PACKAGE_TYPE: 'deb' }), 'deb');
		assert.strictEqual(detectLinuxPackageType({ ORBIT_LINUX_PACKAGE_TYPE: 'rpm' }), 'rpm');
		assert.strictEqual(detectLinuxPackageType({ APPIMAGE: '/opt/Orbit.AppImage' }), 'appimage');
	});

	test('classifies signed Linux release package names', () => {
		assert.strictEqual(getLinuxUpdatePackageType('/tmp/Orbit-1.0.0-linux-x64.deb'), 'deb');
		assert.strictEqual(getLinuxUpdatePackageType('/tmp/Orbit-1.0.0-linux-x64.rpm'), 'rpm');
		assert.strictEqual(getLinuxUpdatePackageType('/tmp/Orbit-1.0.0-linux-x64.AppImage'), 'appimage');
		assert.throws(() => getLinuxUpdatePackageType('/tmp/orbit.tar.gz'), /Unsupported Linux update package/);
	});

	test('builds dependency-resolving native package-manager commands', () => {
		const only = (...availableCommands: string[]) => (commandPath: string) => availableCommands.includes(commandPath);
		assert.strictEqual(
			getElevatedLinuxInstallCommand("/tmp/Orbit user's.deb", only('/usr/bin/apt-get')),
			"/usr/bin/apt-get install -y -- '/tmp/Orbit user'\"'\"'s.deb'",
		);
		assert.strictEqual(
			getElevatedLinuxInstallCommand('/tmp/Orbit.rpm', only('/usr/bin/dnf')),
			"/usr/bin/dnf install -y -- '/tmp/Orbit.rpm'",
		);
		assert.strictEqual(
			getElevatedLinuxInstallCommand('/tmp/Orbit.rpm', only('/usr/bin/zypper')),
			"/usr/bin/zypper --non-interactive install -- '/tmp/Orbit.rpm'",
		);
		assert.strictEqual(
			getElevatedLinuxInstallCommand('/tmp/Orbit.rpm', only('/usr/bin/yum')),
			"/usr/bin/yum install -y -- '/tmp/Orbit.rpm'",
		);
		assert.throws(
			() => getElevatedLinuxInstallCommand('/tmp/Orbit.deb', only()),
			/requires apt-get/,
		);
		assert.throws(
			() => getElevatedLinuxInstallCommand('/tmp/Orbit.rpm', only()),
			/requires dnf, zypper, or yum/,
		);
	});

	test('atomically replaces and restarts an AppImage after the current process exits', async () => {
		const directory = await fs.promises.mkdtemp(path.join(tmpdir(), 'orbit-appimage-update-'));
		const target = path.join(directory, 'Orbit.AppImage');
		const update = path.join(directory, 'download.AppImage');
		const marker = path.join(directory, 'restarted');
		const markerCreated = promiseWithResolvers<void>();
		const watcher = fs.watch(directory, (_eventType, filename) => {
			if (filename === 'restarted') {
				markerCreated.resolve();
			}
		});
		try {
			await fs.promises.writeFile(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
			await fs.promises.writeFile(update, `#!/bin/sh\nprintf restarted > "${marker}"\n`, { mode: 0o755 });
			const runningProcess = spawn('/bin/sh', ['-c', 'read _'], { stdio: ['pipe', 'ignore', 'ignore'] });
			assert.ok(runningProcess.pid);
			await prepareLinuxUpdateInstall(update, 'Orbit', runningProcess.pid, { APPIMAGE: target });
			assert.strictEqual(await fs.promises.readFile(target, 'utf8'), '#!/bin/sh\nexit 0\n');
			runningProcess.stdin.end('exit\n');
			await once(runningProcess, 'exit');

			await markerCreated.promise;
			assert.strictEqual(await fs.promises.readFile(marker, 'utf8'), 'restarted');
			assert.strictEqual(await fs.promises.readFile(target, 'utf8'), await fs.promises.readFile(update, 'utf8'));
		} finally {
			watcher.close();
			await fs.promises.rm(directory, { recursive: true, force: true });
		}
	});
});
