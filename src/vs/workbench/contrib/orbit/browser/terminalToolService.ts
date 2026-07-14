/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { removeAnsiEscapeCodes } from '../../../../base/common/strings.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { ITerminalCapabilityImplMap, TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { URI } from '../../../../base/common/uri.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { ITerminalService, ITerminalInstance, ICreateTerminalOptions } from '../../terminal/browser/terminal.js';
import { MAX_TERMINAL_CHARS } from '../common/prompt/prompts.js';
import { timeout } from '../../../../base/common/async.js';

export type ShellRunResult = {
	kind: 'done' | 'timeout' | 'backgrounded';
	result?: string;
	exitCode?: number;
	shellId: string;
	durationMs?: number;
	elapsedMs?: number;
	pid?: number;
};

export type AwaitShellResult = {
	kind: 'done' | 'timeout' | 'backgrounded' | 'notfound';
	result?: string;
	exitCode?: number;
	runningForMs: number;
	matchedPattern?: boolean;
	error?: string;
};

type NotifyWatcher = {
	pattern: RegExp;
	debounceMs: number;
	reason: string;
	onMatch: (matchedText: string) => void;
	lastFiredAt: number;
	timer: ReturnType<typeof setTimeout> | null;
	lastMatchedText: string;
};

export type ShellInstance = {
	id: string;
	terminal: ITerminalInstance;
	workingDirectory: string | null;
	threadId: string | null;
	createdAt: number;
	lastCommand: string | null;
	lastExitCode: number | null;
	pid: number | null;
	commandInFlight: boolean;
	notifyWatchers: NotifyWatcher[];
	commandFinishedDisposable: IDisposable | null;
	outputBuffer: string;
	onDataDisposable: IDisposable | null;
	onExitDisposable: IDisposable | null;
	/** Resolves an in-flight runShell/awaitShell wait without interrupting the shell. */
	waitRelease?: () => void;
	/**
	 * Aborts an in-flight runShell/awaitShell wait as 'done'. Invoked by
	 * `_disposeShellListeners` when the terminal exits or is killed mid-wait so
	 * the caller does not hang until the block_until_ms timeout (M3 fix).
	 */
	abortWait?: (() => void) | null;
};

export interface ITerminalToolService {
	readonly _serviceBrand: undefined;

	createShell(opts: { shellId: string; workingDirectory: string | null; threadId?: string | null }): Promise<{ shellId: string; pid: number | null }>;
	getOrCreateShellForThread(opts: { threadId: string; proposedShellId: string; workingDirectory: string | null }): Promise<{ shellId: string; pid: number | null; created: boolean }>;
	killShell(shellId: string): Promise<void>;
	killShellsForThread(threadId: string): Promise<void>;
	interruptShell(shellId: string): void;
	listShellIds(): string[];
	shellExists(shellId: string): boolean;
	getShell(shellId: string): ShellInstance | undefined;

	runShell(
		shellId: string,
		command: string,
		/**
		 * `onDispatched` fires once the command has been written to the terminal,
		 * i.e. after the actual mutation but before the (potentially long) block
		 * wait. Callers use it to release a serialization lock so the block window
		 * does not block unrelated tools.
		 */
		opts: { blockUntilMs: number; workingDirectory?: string | null; onDispatched?: () => void }
	): Promise<ShellRunResult>;

	awaitShell(
		shellId: string | null,
		opts: { blockUntilMs: number; pattern: string | null }
	): Promise<AwaitShellResult>;

	readShell(shellId: string): Promise<string>;
	focusShell(shellId: string): Promise<void>;
	/** Release a blocking runShell/awaitShell wait early (command keeps running). */
	releaseShellWait(shellId: string | null | undefined): void;

	addNotifyWatcher(shellId: string, w: { pattern: string; debounceMs: number; reason: string; onMatch: (m: string) => void }): IDisposable;
}

export const ITerminalToolService = createDecorator<ITerminalToolService>('TerminalToolService');

const shellDisplayName = (id: string) => `Orbit Shell (${id.slice(0, 8)})`;

export class TerminalToolService extends Disposable implements ITerminalToolService {
	readonly _serviceBrand: undefined;

	private shellInstanceOfId: Record<string, ShellInstance> = {};
	private defaultShellIdByThread: Record<string, string> = {};
	private _sleepWaitRelease: (() => void) | undefined;

	// Ring counter for full-output overflow files under .orbit/history (bounds clutter to N files).
	private _shellOutputFileSeq = 0;

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
		// Clean up shell output overflow files on dispose: these contain full terminal
		// command output that may include sensitive data (API keys, credentials, etc.).
		this._register(toDisposable(() => {
			this._cleanupShellOutputFiles();
		}));
	}

	listShellIds(): string[] {
		return Object.keys(this.shellInstanceOfId);
	}

	shellExists(shellId: string): boolean {
		return shellId in this.shellInstanceOfId;
	}

	getShell(shellId: string): ShellInstance | undefined {
		return this.shellInstanceOfId[shellId];
	}

	private _listShellsForThread(threadId: string): ShellInstance[] {
		return Object.values(this.shellInstanceOfId).filter(shell => shell.threadId === threadId);
	}

	private _refreshShellPid(shell: ShellInstance): void {
		shell.pid = shell.terminal.processId ?? shell.pid;
	}

	async killShell(shellId: string): Promise<void> {
		const shell = this.shellInstanceOfId[shellId];
		if (!shell) return;
		this._disposeShellListeners(shell);
		shell.terminal.dispose();
		delete this.shellInstanceOfId[shellId];
		for (const [threadId, defaultId] of Object.entries(this.defaultShellIdByThread)) {
			if (defaultId === shellId) {
				delete this.defaultShellIdByThread[threadId];
			}
		}
	}

	async killShellsForThread(threadId: string): Promise<void> {
		const shellIds = this._listShellsForThread(threadId).map(shell => shell.id);
		delete this.defaultShellIdByThread[threadId];
		for (const shellId of shellIds) {
			await this.killShell(shellId);
		}
	}

	interruptShell(shellId: string): void {
		const shell = this.shellInstanceOfId[shellId];
		if (!shell) return;
		// Phase 2.13 (H16) fix: bail if no command is currently running. Sending
		// \x03 to an idle shell either is a no-op (Unix) or breaks the idle prompt
		// (Windows). When `commandInFlight` is false, there is nothing to interrupt.
		if (!shell.commandInFlight) {
			return;
		}
		// ETX (Ctrl+C). On Windows the equivalent is also \x03 (the terminal
		// emulator handles the platform difference).
		void shell.terminal.sendText('\x03', false);
	}

	releaseShellWait(shellId: string | null | undefined): void {
		if (shellId) {
			this.shellInstanceOfId[shellId]?.waitRelease?.();
			return;
		}
		this._sleepWaitRelease?.();
	}

	private _disposeShellListeners(shell: ShellInstance): void {
		// M3 fix: if a runShell/awaitShell wait is currently blocked on this
		// shell, resolve it as 'done' so the caller does not hang until its
		// block_until_ms timeout. This covers both "terminal process exited"
		// and explicit killShell() while a wait is in flight.
		shell.abortWait?.();
		shell.abortWait = null;
		shell.waitRelease = undefined;
		shell.commandFinishedDisposable?.dispose();
		shell.commandFinishedDisposable = null;
		shell.onDataDisposable?.dispose();
		shell.onDataDisposable = null;
		shell.onExitDisposable?.dispose();
		shell.onExitDisposable = null;
		for (const watcher of shell.notifyWatchers) {
			if (watcher.timer) clearTimeout(watcher.timer);
		}
		shell.notifyWatchers = [];
	}

	private async _createTerminal(props: { cwd: string | null, config: ICreateTerminalOptions['config'] }) {
		const { cwd: override_cwd, config } = props;

		const cwd: URI | string | undefined = (override_cwd ?? undefined) ?? this.workspaceContextService.getWorkspace().folders[0]?.uri;

		const options: ICreateTerminalOptions = {
			cwd,
			location: TerminalLocation.Panel,
			config: {
				name: config && 'name' in config ? config.name : undefined,
				forceShellIntegration: true,
				...config,
			},
			skipContributedProfileCheck: true,
		};

		return this.terminalService.createTerminal(options);
	}

	createShell: ITerminalToolService['createShell'] = async ({ shellId, workingDirectory, threadId }) => {
		await this.terminalService.whenConnected;
		const config = { name: shellDisplayName(shellId), title: shellDisplayName(shellId) };
		const terminal = await this._createTerminal({ cwd: workingDirectory, config });

		const shell: ShellInstance = {
			id: shellId,
			terminal,
			workingDirectory,
			threadId: threadId ?? null,
			createdAt: Date.now(),
			lastCommand: null,
			lastExitCode: null,
			pid: terminal.processId ?? null,
			commandInFlight: false,
			notifyWatchers: [],
			commandFinishedDisposable: null,
			outputBuffer: '',
			onDataDisposable: null,
			onExitDisposable: null,
			abortWait: null,
		};

		this.shellInstanceOfId[shellId] = shell;
		this._ensureDataListener(shell);

		shell.onExitDisposable = terminal.onExit(() => {
			if (shellId in this.shellInstanceOfId) {
				this._disposeShellListeners(shell);
				delete this.shellInstanceOfId[shellId];
				for (const [tid, defaultId] of Object.entries(this.defaultShellIdByThread)) {
					if (defaultId === shellId) {
						delete this.defaultShellIdByThread[tid];
					}
				}
			}
		});

		return { shellId, pid: shell.pid };
	};

	getOrCreateShellForThread: ITerminalToolService['getOrCreateShellForThread'] = async ({ threadId, proposedShellId, workingDirectory }) => {
		const idleShell = this._listShellsForThread(threadId).find(shell => !shell.commandInFlight);
		if (idleShell) {
			this._refreshShellPid(idleShell);
			return { shellId: idleShell.id, pid: idleShell.pid, created: false };
		}

		const created = await this.createShell({ shellId: proposedShellId, workingDirectory, threadId });
		if (!this.defaultShellIdByThread[threadId]) {
			this.defaultShellIdByThread[threadId] = proposedShellId;
		}
		return { shellId: created.shellId, pid: created.pid, created: true };
	};

	focusShell: ITerminalToolService['focusShell'] = async (shellId) => {
		const shell = this.shellInstanceOfId[shellId];
		if (!shell) return;
		this.terminalService.setActiveInstance(shell.terminal);
		await this.terminalService.focusActiveInstance();
	};

	readShell: ITerminalToolService['readShell'] = async (shellId) => {
		const shell = this.shellInstanceOfId[shellId];
		if (!shell) {
			throw new Error(`Read Shell: Shell with ID ${shellId} does not exist.`);
		}

		if (!shell.terminal.xterm) {
			return this._capOutput(removeAnsiEscapeCodes(shell.outputBuffer));
		}

		const lines: string[] = [];
		for (const line of shell.terminal.xterm.getBufferReverseIterator()) {
			lines.unshift(line);
		}

		const result = removeAnsiEscapeCodes(lines.join('\n'));
		shell.outputBuffer = result;
		return this._capOutput(result);
	};

	private async _capOutput(result: string): Promise<string> {
		if (result.length <= MAX_TERMINAL_CHARS) return result;

		const fullLen = result.length;
		const half = MAX_TERMINAL_CHARS / 2;
		const head = result.slice(0, half);
		const tail = result.slice(result.length - half);

		// Persist the full output to a workspace file so the agent can read the omitted middle
		// (Cursor's "write long output to a file, let the agent tail/read it" pattern). Awaited
		// so the path we hand back is guaranteed to be readable by the time we return it — a
		// fire-and-forget write let the agent race the write and read a stale/empty file.
		const relPath = await this._writeFullOutputFile(result);
		const note = relPath
			? `\n\n[Output truncated: ${fullLen} chars total, showing first & last ${half}. Full output saved to ${relPath} — read that file for the omitted middle.]\n\n`
			: `\n\n...[truncated ${fullLen - MAX_TERMINAL_CHARS} chars]...\n\n`;
		return head + note + tail;
	}

	/** Writes the full command output to a bounded ring of files under .orbit/history and
	 * resolves once the write has landed, so the returned path is safe to read immediately. */
	private async _writeFullOutputFile(fullOutput: string): Promise<string | undefined> {
		try {
			const folder = this.workspaceContextService.getWorkspace().folders[0];
			if (!folder) return undefined;
			const seq = this._shellOutputFileSeq++ % 20; // ring buffer: cap clutter at 20 files
			const relPath = `.orbit/history/shell-output-${seq}.log`;
			const uri = URI.joinPath(folder.uri, '.orbit', 'history', `shell-output-${seq}.log`);
			await this.fileService.writeFile(uri, VSBuffer.fromString(fullOutput));
			return relPath;
		} catch {
			return undefined;
		}
	}

	/** Best-effort cleanup of all shell output overflow files from .orbit/history. */
	private _cleanupShellOutputFiles(): void {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		if (!folder) return;
		const historyDir = URI.joinPath(folder.uri, '.orbit', 'history');
		void this.fileService.resolve(historyDir).then(stat => {
			if (!stat.children) return;
			for (const child of stat.children) {
				if (child.name && child.name.startsWith('shell-output-') && child.name.endsWith('.log')) {
					void this.fileService.del(child.resource).catch(() => { /* best-effort */ });
				}
			}
		}).catch(() => { /* best-effort: dir may not exist */ });
	}

	private _ensureDataListener(shell: ShellInstance): void {
		if (shell.onDataDisposable) return;

		shell.onDataDisposable = shell.terminal.onData((chunk) => {
			shell.outputBuffer += chunk;
			if (shell.outputBuffer.length > MAX_TERMINAL_CHARS * 2) {
				shell.outputBuffer = shell.outputBuffer.slice(-MAX_TERMINAL_CHARS);
			}
			this._runNotifyWatchers(shell);
		});
	}

	private _getBufferText(shell: ShellInstance): string {
		return removeAnsiEscapeCodes(shell.outputBuffer);
	}

	private _matchPatternInBuffer(text: string, regex: RegExp): RegExpMatchArray | null {
		return text.match(regex);
	}

	/** Returns the last non-empty line of `text` (trailing whitespace trimmed). */
	private _lastNonEmptyLine(text: string): string {
		const lines = text.split('\n');
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i].replace(/\s+$/, '');
			if (line.trim().length > 0) {
				return line;
			}
		}
		return '';
	}

	/**
	 * Best-effort idle-prompt detector used when shell-integration command
	 * detection is unavailable (cmdCap === null). Polls the output buffer and
	 * invokes `onIdle` once when the terminal appears to have returned to an
	 * idle prompt: the buffer has grown past `preSendLen` (so the command was
	 * actually sent), output has been stable for a short quiescence window, and
	 * the last non-empty line is a short prompt ending in `$`, `#`, `%`, or `>`.
	 * Returns a stop function. This is a fallback only — the common path uses
	 * `onCommandFinished` from the command-detection capability.
	 */
	private _pollForIdle(shell: ShellInstance, preSendLen: number, onIdle: () => void): () => void {
		let lastLen = shell.outputBuffer.length;
		let lastChangeAt = Date.now();
		const interval = mainWindow.setInterval(() => {
			const len = shell.outputBuffer.length;
			if (len !== lastLen) {
				lastLen = len;
				lastChangeAt = Date.now();
				return;
			}
			if (Date.now() - lastChangeAt < 400) {
				return;
			}
			const text = this._getBufferText(shell);
			if (text.length <= preSendLen) {
				return;
			}
			const lastLine = this._lastNonEmptyLine(text);
			if (!lastLine || lastLine.length >= 60) {
				return;
			}
			if (!/[\$#%>]\s*$/.test(lastLine)) {
				return;
			}
			mainWindow.clearInterval(interval);
			onIdle();
		}, 200);
		return () => mainWindow.clearInterval(interval);
	}

	/**
	 * Arm a one-shot listener that resets `commandInFlight` to false when the
	 * command that started at/after `commandSentAt` finishes. Used after a
	 * runShell timeout / release-to-background and after a backgrounded send, so
	 * the shell becomes reusable again instead of being permanently stuck "in
	 * flight" — which would force a brand-new terminal to be created for every
	 * subsequent command (C2/C4 fix). Replaces any previously armed reset
	 * listener on the same shell.
	 */
	private _armCommandInFlightReset(
		shell: ShellInstance,
		commandSentAt: number,
		cmdCap: ITerminalCapabilityImplMap[TerminalCapability.CommandDetection] | undefined,
	): void {
		shell.commandFinishedDisposable?.dispose();
		shell.commandFinishedDisposable = null;

		if (cmdCap) {
			// M2 fix: if our command already finished (e.g. during the capability
			// wait in the backgrounded path), reset immediately instead of
			// waiting for an event that will never fire.
			const alreadyFinished = cmdCap.commands.some(c => c.timestamp >= commandSentAt);
			if (alreadyFinished) {
				shell.commandInFlight = false;
				return;
			}
			const l = cmdCap.onCommandFinished(cmd => {
				// Only reset for the command we sent (timestamp >= commandSentAt);
				// ignore stale commands from prior backgrounded runs.
				if (cmd.timestamp < commandSentAt) {
					return;
				}
				shell.commandInFlight = false;
				l.dispose();
				shell.commandFinishedDisposable = null;
			});
			shell.commandFinishedDisposable = l;
		} else {
			// No command detection: fall back to idle-prompt polling. Add a
			// safety cap so the shell is never permanently stuck "in flight" in
			// environments where the prompt is not echoed into the buffer.
			let settled = false;
			const stop = this._pollForIdle(shell, 0, () => {
				settled = true;
				shell.commandInFlight = false;
			});
			const safety = setTimeout(() => {
				if (settled) {
					return;
				}
				stop();
				shell.commandInFlight = false;
			}, 30_000);
			shell.commandFinishedDisposable = {
				dispose: () => {
					stop();
					clearTimeout(safety);
				},
			};
		}
	}

	private _runNotifyWatchers(shell: ShellInstance): void {
		const text = this._getBufferText(shell);
		for (const watcher of shell.notifyWatchers) {
			const match = this._matchPatternInBuffer(text, watcher.pattern);
			if (!match) continue;

			watcher.lastMatchedText = match[0];

			if (watcher.timer) {
				clearTimeout(watcher.timer);
			}

			watcher.timer = setTimeout(() => {
				watcher.timer = null;
				const now = Date.now();
				if (now - watcher.lastFiredAt < watcher.debounceMs) return;
				watcher.lastFiredAt = now;
				watcher.onMatch(watcher.lastMatchedText);
			}, watcher.debounceMs);
		}
	}

	addNotifyWatcher(shellId: string, w: { pattern: string; debounceMs: number; reason: string; onMatch: (m: string) => void }): IDisposable {
		const shell = this.shellInstanceOfId[shellId];
		if (!shell) {
			return Disposable.None;
		}

		const watcher: NotifyWatcher = {
			pattern: new RegExp(w.pattern, 'm'),
			debounceMs: w.debounceMs,
			reason: w.reason,
			onMatch: w.onMatch,
			lastFiredAt: 0,
			timer: null,
			lastMatchedText: '',
		};
		shell.notifyWatchers.push(watcher);
		this._runNotifyWatchers(shell);

		return toDisposable(() => {
			const idx = shell.notifyWatchers.indexOf(watcher);
			if (idx >= 0) {
				if (watcher.timer) clearTimeout(watcher.timer);
				shell.notifyWatchers.splice(idx, 1);
			}
		});
	}

	private async _waitForCommandDetectionCapability(terminal: ITerminalInstance) {
		const cmdCap = terminal.capabilities.get(TerminalCapability.CommandDetection);
		if (cmdCap) return cmdCap;

		const disposables: IDisposable[] = [];

		const waitTimeout = timeout(10_000);
		const waitForCapability = new Promise<ITerminalCapabilityImplMap[TerminalCapability.CommandDetection]>((res) => {
			disposables.push(
				terminal.capabilities.onDidAddCapability((e) => {
					if (e.id === TerminalCapability.CommandDetection) res(e.capability);
				})
			);
		});

		const capability = await Promise.any([waitTimeout, waitForCapability])
			.finally(() => { disposables.forEach((d) => d.dispose()); });

		return capability ?? undefined;
	}

	runShell: ITerminalToolService['runShell'] = async (shellId, command, opts) => {
		await this.terminalService.whenConnected;

		const shell = this.shellInstanceOfId[shellId];
		if (!shell) {
			throw new Error(`Shell with ID ${shellId} does not exist.`);
		}

		this._ensureDataListener(shell);
		shell.lastCommand = command;
		// The command may carry a leading `cd <dir> &&` (prepended by the caller
		// when a working_directory is requested). We optimistically track the new
		// cwd here so a still-running (timeout/background) command — whose `cd`
		// ran first and succeeded — reports the right directory. If the command
		// finishes with a non-zero exit, the `cd` may have failed (the `&&`
		// short-circuited), so we restore this previous value below rather than
		// trust a directory we never confirmed the shell entered.
		const prevWorkingDirectory = shell.workingDirectory;
		if (opts.workingDirectory !== undefined) {
			shell.workingDirectory = opts.workingDirectory;
		}
		shell.commandInFlight = true;
		this._refreshShellPid(shell);
		const startedAt = Date.now();

		// Backgrounded fire-and-forget path (block_until_ms === 0).
		if (opts.blockUntilMs === 0) {
			const commandSentAt = Date.now();
			await shell.terminal.sendText(command, true);
			opts.onDispatched?.();
			// Arm a persistent listener that resets commandInFlight when the
			// backgrounded command eventually completes. Without this, the shell
			// stays permanently marked "in flight" and a brand-new terminal is
			// created for every subsequent command. _armCommandInFlightReset also
			// handles the M2 race where the command already finished during the
			// capability wait (it checks cmdCap.commands for an already-finished
			// entry instead of waiting for an event that will never fire).
			void (async () => {
				try {
					const cap = await this._waitForCommandDetectionCapability(shell.terminal);
					this._armCommandInFlightReset(shell, commandSentAt, cap ?? undefined);
				} catch {
					this._armCommandInFlightReset(shell, commandSentAt, undefined);
				}
			})();
			return {
				kind: 'backgrounded',
				shellId,
				pid: shell.pid ?? undefined,
			};
		}

		const disposables: IDisposable[] = [];
		let resolveReason: 'done' | 'timeout' | 'background' | undefined;
		let exitCode = 0;
		let cmdOutput = '';
		let shellExited = false;
		let commandSentAt = 0;

		const cmdCap = await this._waitForCommandDetectionCapability(shell.terminal);

		// If the terminal exited or was killed during the capability wait, abort
		// early instead of sending text into a dead terminal.
		if (!(shellId in this.shellInstanceOfId)) {
			return {
				kind: 'done',
				result: await this._capOutput(this._getBufferText(shell)),
				exitCode: shell.lastExitCode ?? 0,
				shellId,
				durationMs: Date.now() - startedAt,
			};
		}

		const waitUntilDone = new Promise<void>((resolve) => {
			if (cmdCap) {
				// M1 fix: only resolve for the command we actually sent
				// (timestamp >= commandSentAt). Without this guard, a stale or
				// prior backgrounded command finishing on the same terminal would
				// resolve this promise with the wrong exit code and output.
				const l = cmdCap.onCommandFinished(cmd => {
					if (commandSentAt === 0 || cmd.timestamp < commandSentAt) return;
					if (resolveReason) return;
					resolveReason = 'done';
					exitCode = cmd.exitCode ?? 0;
					cmdOutput = cmd.getOutput() ?? '';
					shell.lastExitCode = exitCode;
					shell.commandInFlight = false;
					l.dispose();
					resolve();
				});
				disposables.push(l);
			} else {
				// C1 fix: no command detection available. Poll the buffer for a
				// returned shell prompt so a fast command does not always wait
				// the full block_until_ms timeout.
				const preSendLen = shell.outputBuffer.length;
				const stop = this._pollForIdle(shell, preSendLen, () => {
					if (resolveReason) return;
					resolveReason = 'done';
					exitCode = shell.lastExitCode ?? 0;
					shell.lastExitCode = exitCode;
					shell.commandInFlight = false;
					resolve();
				});
				disposables.push({ dispose: stop });
			}
		});

		const waitUntilTimeout = new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				if (resolveReason) return;
				resolveReason = 'timeout';
				resolve();
			}, opts.blockUntilMs);
			shell.waitRelease = () => {
				if (resolveReason) return;
				resolveReason = 'background';
				clearTimeout(timer);
				resolve();
			};
		});

		// M3 fix: if the terminal exits or is killed mid-wait, resolve as 'done'
		// instead of hanging until the block_until_ms timeout. `abortWait` is
		// also invoked by `_disposeShellListeners` (covers explicit killShell).
		let resolveExit: () => void = () => {};
		const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve; });
		shell.abortWait = () => {
			if (resolveReason) return;
			resolveReason = 'done';
			exitCode = shell.lastExitCode ?? 0;
			shellExited = true;
			shell.commandInFlight = false;
			resolveExit();
		};

		commandSentAt = Date.now();
		await shell.terminal.sendText(command, true);
		opts.onDispatched?.();
		this.terminalService.setActiveInstance(shell.terminal);

		const readResult = async (): Promise<string> => {
			if (shellExited || !(shellId in this.shellInstanceOfId)) {
				return this._getBufferText(shell);
			}
			try {
				return await this.readShell(shellId);
			} catch {
				return this._getBufferText(shell);
			}
		};

		try {
			await Promise.race([waitUntilDone, waitUntilTimeout, exitPromise]);
		} finally {
			disposables.forEach(d => d.dispose());
			shell.waitRelease = undefined;
			shell.abortWait = null;
		}

		const durationMs = Date.now() - startedAt;

		if (resolveReason === 'done') {
			// A non-zero exit means the command (which may begin with a `cd`) did
			// not fully succeed. Restore the previously tracked cwd so the next
			// same-dir command re-emits the `cd` instead of skipping it on the
			// assumption we already changed directory.
			if (exitCode !== 0 && opts.workingDirectory !== undefined) {
				shell.workingDirectory = prevWorkingDirectory;
			}
			const result = removeAnsiEscapeCodes(cmdOutput ? cmdOutput : await readResult());
			return { kind: 'done', result: await this._capOutput(result), exitCode, shellId, durationMs };
		}

		// C2 fix: the command is still running (timeout or released to
		// background). Arm a persistent listener that resets commandInFlight
		// when the command eventually completes, so the shell becomes reusable
		// again instead of being permanently stuck "in flight".
		this._armCommandInFlightReset(shell, commandSentAt, cmdCap);

		const result = removeAnsiEscapeCodes(await readResult());

		if (resolveReason === 'background') {
			return {
				kind: 'backgrounded',
				result: await this._capOutput(result),
				shellId,
				durationMs,
				pid: shell.pid ?? undefined,
			};
		}

		return {
			kind: 'timeout',
			result: await this._capOutput(result),
			shellId,
			durationMs,
			elapsedMs: opts.blockUntilMs,
		};
	};

	awaitShell: ITerminalToolService['awaitShell'] = async (shellId, opts) => {
		const start = Date.now();

		// Sleep-only mode when no shell_id (matches Cursor Await contract)
		if (!shellId) {
			if (opts.blockUntilMs === 0) {
				return { kind: 'timeout', result: '', runningForMs: 0, matchedPattern: false };
			}
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => resolve(), opts.blockUntilMs);
				this._sleepWaitRelease = () => {
					clearTimeout(timer);
					resolve();
				};
			}).finally(() => {
				this._sleepWaitRelease = undefined;
			});
			return { kind: 'timeout', result: '', runningForMs: Date.now() - start, matchedPattern: false };
		}

		const shell = this.shellInstanceOfId[shellId];
		if (!shell) {
			return {
				kind: 'notfound',
				error: `Shell with id "${shellId}" does not exist.`,
				runningForMs: 0,
			};
		}

		if (opts.blockUntilMs === 0) {
			const result = await this.readShell(shellId);
			return {
				kind: 'timeout',
				result,
				runningForMs: 0,
				matchedPattern: false,
			};
		}

		let patternMatched = false;
		let exitCode: number | undefined;
		let resolveReason: 'done' | 'timeout' | 'background' | 'pattern' | undefined;
		let shellExited = false;
		// The pattern is validated (ReDoS + compile check) in validateAwaitShellParams
		// before reaching here; this try/catch is defense-in-depth so any residual
		// invalid pattern surfaces as a clean tool error rather than a raw throw.
		let regex: RegExp | undefined;
		if (opts.pattern) {
			try {
				regex = new RegExp(opts.pattern, 'm');
			} catch (e) {
				throw new Error(`AwaitShell: invalid pattern regular expression. ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		const checkBufferForPattern = (): boolean => {
			if (!regex) return false;
			const text = this._getBufferText(shell);
			const m = this._matchPatternInBuffer(text, regex);
			if (m) {
				patternMatched = true;
				return true;
			}
			return false;
		};

		if (checkBufferForPattern()) {
			const result = await this.readShell(shellId);
			return { kind: 'timeout', result, runningForMs: Date.now() - start, matchedPattern: true };
		}

		const disposables: IDisposable[] = [];

		const patternPromise = new Promise<void>((resolve) => {
			if (!regex) {
				resolve();
				return;
			}
			const onData = shell.terminal.onData(() => {
				if (checkBufferForPattern()) {
					resolveReason = 'pattern';
					onData.dispose();
					resolve();
				}
			});
			disposables.push(onData);
		});

		const cmdCap = await this._waitForCommandDetectionCapability(shell.terminal);
		const donePromise = new Promise<void>((resolve) => {
			if (cmdCap) {
				const l = cmdCap.onCommandFinished(cmd => {
					if (resolveReason) return;
					resolveReason = 'done';
					exitCode = cmd.exitCode ?? 0;
					shell.lastExitCode = exitCode;
					shell.commandInFlight = false;
					l.dispose();
					resolve();
				});
				disposables.push(l);
			} else if (shell.commandInFlight) {
				// C3 fix: no command detection, but a command is in flight. Poll
				// for a returned prompt so a command that finishes before the
				// timeout does not force a full block_until_ms wait.
				const preSendLen = shell.outputBuffer.length;
				const stop = this._pollForIdle(shell, preSendLen, () => {
					if (resolveReason) return;
					resolveReason = 'done';
					exitCode = shell.lastExitCode ?? 0;
					shell.commandInFlight = false;
					resolve();
				});
				disposables.push({ dispose: stop });
			}
			// else: no command detection and no command in flight — there is
			// nothing to await for completion; let pattern/timeout resolve.
		});

		const timeoutPromise = new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				if (resolveReason) return;
				resolveReason = 'timeout';
				resolve();
			}, opts.blockUntilMs);
			shell.waitRelease = () => {
				if (resolveReason) return;
				// C5 fix: this is an intentional release to background (via
				// releaseShellWait), not a genuine timeout. Distinguish it so the
				// caller/UI can tell the two apart.
				resolveReason = 'background';
				clearTimeout(timer);
				resolve();
			};
		});

		// M3 fix: resolve as 'done' if the terminal exits or is killed mid-wait.
		let resolveExit: () => void = () => {};
		const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve; });
		shell.abortWait = () => {
			if (resolveReason) return;
			resolveReason = 'done';
			exitCode = shell.lastExitCode ?? 0;
			shellExited = true;
			shell.commandInFlight = false;
			resolveExit();
		};

		try {
			await Promise.race([patternPromise, donePromise, timeoutPromise, exitPromise]);
		} finally {
			disposables.forEach(d => d.dispose());
			shell.waitRelease = undefined;
			shell.abortWait = null;
		}

		const readResult = async (): Promise<string> => {
			if (shellExited || !(shellId in this.shellInstanceOfId)) {
				return this._getBufferText(shell);
			}
			try {
				return await this.readShell(shellId);
			} catch {
				return this._getBufferText(shell);
			}
		};

		const runningForMs = Date.now() - start;
		const result = await readResult();

		if (patternMatched) {
			return { kind: 'timeout', result, runningForMs, matchedPattern: true };
		}
		if (resolveReason === 'done') {
			return { kind: 'done', result, exitCode: exitCode ?? 0, runningForMs };
		}
		if (resolveReason === 'background') {
			return { kind: 'backgrounded', result, runningForMs };
		}
		return { kind: 'timeout', result, runningForMs, matchedPattern: false };
	};
}

registerSingleton(ITerminalToolService, TerminalToolService, InstantiationType.Delayed);
