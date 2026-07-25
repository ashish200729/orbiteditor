/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IAgentProjectWorkspaceService } from './agentProjectWorkspaceService.js';
import { ISCMService, ISCMRepository } from '../../scm/common/scm.js';
import { IVoidSettingsService } from '../common/orbitSettingsService.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { gitCommitMessage_systemMessage, gitCommitMessage_userMessage } from '../common/prompt/prompts.js';
import { CancellationError } from '../../../../base/common/errors.js';
import {
	GitCommandResult,
	GitCommitOptions,
	GitCompareUrlOptions,
	GitCheckoutRemoteOptions,
	GitDiffOptions,
	GitFetchOptions,
	GitPushOptions,
	GitRepoStatus,
	IVoidSCMService,
} from '../common/orbitSCMTypes.js';

/**
 * Renderer-side git facade for the Agents-window Changes panel.
 *
 * State + mutations are executed in the main process over the `void-channel-scm`
 * IPC channel (a plain `git` CLI backend, so behaviour matches the terminal
 * exactly). Change detection piggy-backs on the workbench `ISCMService` — the
 * built-in git extension already watches the working tree, so we subscribe to
 * its repository/resource change events and re-emit a single debounced
 * `onDidChange` the panel can refresh on. This keeps the pop-out window's git
 * view in lock-step with the main window without a second file watcher.
 */
export interface IAgentGitService {
	readonly _serviceBrand: undefined;

	/** Debounced signal that the repo state may have changed. */
	readonly onDidChange: Event<void>;

	/** Resolve the git root for the current agent workspace, or null when not a repo. */
	resolveRepoRoot(): Promise<string | null>;

	/** Resolve git root that contains an arbitrary filesystem path (IDE sidebar / open folder). */
	resolveRepoRootFromPath(path: string): Promise<string | null>;

	/** Resolve all git roots under active agent folders (multi-root workspaces). */
	resolveRepoRoots(): Promise<string[]>;

	getStatus(root: string): Promise<GitRepoStatus>;
	getDiff(root: string, options: GitDiffOptions): Promise<string>;
	getFileContent(root: string, file: string, staged?: boolean): Promise<string>;
	getTotals(root: string): Promise<{ added: number; removed: number }>;
	getBranches(root: string): Promise<string[]>;
	getRemoteBranches(root: string): Promise<string[]>;
	getRemoteBranchCommit(root: string, branch: string): Promise<string | null>;
	getHeadCommit(root: string): Promise<string | null>;

	stage(root: string, files: string[]): Promise<GitCommandResult>;
	unstage(root: string, files: string[]): Promise<GitCommandResult>;
	stageAll(root: string): Promise<GitCommandResult>;
	unstageAll(root: string): Promise<GitCommandResult>;
	discard(root: string, files: string[], untrackedFiles: string[]): Promise<GitCommandResult>;
	applyPatch(root: string, patch: string, opts: { cached?: boolean; reverse?: boolean }): Promise<GitCommandResult>;
	commit(root: string, message: string, options?: GitCommitOptions): Promise<GitCommandResult>;
	createBranch(root: string, name: string, checkout?: boolean): Promise<GitCommandResult>;
	checkoutBranch(root: string, name: string): Promise<GitCommandResult>;
	push(root: string, options?: GitPushOptions): Promise<GitCommandResult>;
	fetch(root: string, options?: GitFetchOptions): Promise<GitCommandResult>;
	checkoutRemoteBranch(root: string, options: GitCheckoutRemoteOptions): Promise<GitCommandResult>;
	getPullRequestUrl(root: string): Promise<string | null>;
	getCompareUrl(root: string, options: GitCompareUrlOptions): Promise<string | null>;
	getRemoteHttpsUrl(root: string, remote?: string): Promise<string | null>;
	getRemoteUrl(root: string, remote?: string): Promise<string | null>;

	/** Generate a commit message from the current diff using the SCM model. */
	generateCommitMessage(root: string): Promise<string>;

	/** Force a refresh signal (e.g. right after a mutation completes). */
	refresh(): void;
}

export const IAgentGitService = createDecorator<IAgentGitService>('agentGitService');

class AgentGitService extends Disposable implements IAgentGitService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly channel: IVoidSCMService;
	/** Per-repository change listeners, disposed when their repository is removed. */
	private readonly repoListeners = this._register(new DisposableStore());
	private readonly listenersByRepo = new Map<ISCMRepository, DisposableStore>();
	private readonly debouncer: RunOnceScheduler;
	private cachedRoot: { path: string; root: string | null } | null = null;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IAgentProjectWorkspaceService private readonly agentProjectWorkspaceService: IAgentProjectWorkspaceService,
		@ISCMService private readonly scmService: ISCMService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IConvertToLLMMessageService private readonly convertToLLMMessageService: IConvertToLLMMessageService,
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
	) {
		super();
		this.channel = ProxyChannel.toService<IVoidSCMService>(mainProcessService.getChannel('void-channel-scm'));

		this.debouncer = this._register(new RunOnceScheduler(() => this._onDidChange.fire(), 250));

		this._register(this.agentProjectWorkspaceService.onDidChangeState(() => {
			this.cachedRoot = null;
			this.scheduleChange();
		}));

		// Track existing + future SCM repositories for change signals.
		for (const repo of this.scmService.repositories) {
			this.hookRepository(repo);
		}
		this._register(this.scmService.onDidAddRepository(repo => {
			this.hookRepository(repo);
			this.scheduleChange();
		}));
		this._register(this.scmService.onDidRemoveRepository(repo => {
			// Drop this repo's listeners — they accumulated for the lifetime of
			// the service before, firing (and leaking) for closed repositories.
			const store = this.listenersByRepo.get(repo);
			if (store) {
				this.repoListeners.delete(store); // delete() also disposes it
				this.listenersByRepo.delete(repo);
			}
			this.scheduleChange();
		}));
	}

	private hookRepository(repo: ISCMRepository): void {
		if (this.listenersByRepo.has(repo)) {
			return;
		}
		const provider = repo.provider;
		const store = new DisposableStore();
		store.add(provider.onDidChangeResources(() => this.scheduleChange()));
		store.add(provider.onDidChangeResourceGroups(() => this.scheduleChange()));
		this.listenersByRepo.set(repo, store);
		this.repoListeners.add(store);
	}

	private scheduleChange(): void {
		if (!this.debouncer.isScheduled()) {
			this.debouncer.schedule();
		}
	}

	refresh(): void {
		this._onDidChange.fire();
	}

	async resolveRepoRoot(): Promise<string | null> {
		// Agent-window only — never fall back to the IDE workspace (No Repo = no repo).
		const folders = this.agentProjectWorkspaceService.getActiveFolders()
			.filter(u => u.scheme === 'file')
			.map(uri => ({ uri }));
		if (folders.length === 0) {
			this.cachedRoot = null;
			return null;
		}
		for (const folder of folders) {
			const path = folder.uri.fsPath;
			// Only cache a *found* root. A null result ("not a git repo yet") must
			// keep re-checking — otherwise running `git init` in the terminal after
			// the panel first loads leaves it stuck on "Not a git repository" forever.
			if (this.cachedRoot && this.cachedRoot.path === path && this.cachedRoot.root !== null) {
				return this.cachedRoot.root;
			}
			const root = await this.channel.getRepoRoot(path);
			if (root !== null) {
				this.cachedRoot = { path, root };
				return root;
			}
		}
		this.cachedRoot = { path: folders[0].uri.fsPath, root: null };
		return null;
	}

	async resolveRepoRootFromPath(path: string): Promise<string | null> {
		return this.channel.getRepoRoot(path);
	}

	/** All git roots under the active agent folders (multi-root). */
	async resolveRepoRoots(): Promise<string[]> {
		const folders = this.agentProjectWorkspaceService.getActiveFolders().filter(u => u.scheme === 'file');
		// Parallelize the per-folder getRepoRoot IPC calls — a sequential await
		// loop costs N round-trips end-to-end, which is noticeable for multi-root
		// workspaces (each getRepoRoot spawns a git process in the main process).
		// Order is preserved by mapping back to the folder order before dedup. L1.
		const rootsPerFolder = await Promise.all(
			folders.map(uri => this.channel.getRepoRoot(uri.fsPath).catch((): string | null => null))
		);
		const roots: string[] = [];
		const seen = new Set<string>();
		for (const root of rootsPerFolder) {
			if (root !== null && !seen.has(root)) {
				seen.add(root);
				roots.push(root);
			}
		}
		return roots;
	}

	getStatus(root: string): Promise<GitRepoStatus> { return this.channel.getStatus(root); }
	getDiff(root: string, options: GitDiffOptions): Promise<string> { return this.channel.getDiff(root, options); }
	getFileContent(root: string, file: string, staged?: boolean): Promise<string> { return this.channel.getFileContent(root, file, staged); }
	getTotals(root: string): Promise<{ added: number; removed: number }> { return this.channel.getTotals(root); }
	getBranches(root: string): Promise<string[]> { return this.channel.getBranches(root); }
	getRemoteBranches(root: string): Promise<string[]> { return this.channel.getRemoteBranches(root); }
	getRemoteBranchCommit(root: string, branch: string): Promise<string | null> { return this.channel.getRemoteBranchCommit(root, branch); }
	getHeadCommit(root: string): Promise<string | null> { return this.channel.getHeadCommit(root); }

	async stage(root: string, files: string[]): Promise<GitCommandResult> { return this.mutate(this.channel.stage(root, files)); }
	async unstage(root: string, files: string[]): Promise<GitCommandResult> { return this.mutate(this.channel.unstage(root, files)); }
	async stageAll(root: string): Promise<GitCommandResult> { return this.mutate(this.channel.stageAll(root)); }
	async unstageAll(root: string): Promise<GitCommandResult> { return this.mutate(this.channel.unstageAll(root)); }
	async discard(root: string, files: string[], untrackedFiles: string[]): Promise<GitCommandResult> { return this.mutate(this.channel.discard(root, files, untrackedFiles)); }
	async applyPatch(root: string, patch: string, opts: { cached?: boolean; reverse?: boolean }): Promise<GitCommandResult> { return this.mutate(this.channel.applyPatch(root, patch, opts)); }
	async commit(root: string, message: string, options?: GitCommitOptions): Promise<GitCommandResult> { return this.mutate(this.channel.commit(root, message, options)); }
	async createBranch(root: string, name: string, checkout?: boolean): Promise<GitCommandResult> { return this.mutate(this.channel.createBranch(root, name, checkout)); }
	async checkoutBranch(root: string, name: string): Promise<GitCommandResult> { return this.mutate(this.channel.checkoutBranch(root, name)); }
	async push(root: string, options?: GitPushOptions): Promise<GitCommandResult> { return this.mutate(this.channel.push(root, options)); }
	async fetch(root: string, options?: GitFetchOptions): Promise<GitCommandResult> { return this.mutate(this.channel.fetch(root, options)); }
	async checkoutRemoteBranch(root: string, options: GitCheckoutRemoteOptions): Promise<GitCommandResult> { return this.mutate(this.channel.checkoutRemoteBranch(root, options)); }
	getPullRequestUrl(root: string): Promise<string | null> { return this.channel.getPullRequestUrl(root); }
	getCompareUrl(root: string, options: GitCompareUrlOptions): Promise<string | null> { return this.channel.getCompareUrl(root, options); }
	getRemoteHttpsUrl(root: string, remote?: string): Promise<string | null> { return this.channel.getRemoteHttpsUrl(root, remote); }
	getRemoteUrl(root: string, remote?: string): Promise<string | null> { return this.channel.getRemoteUrl(root, remote); }

	async generateCommitMessage(root: string): Promise<string> {
		const [stat, sampledDiffs, branch, log] = await Promise.all([
			this.channel.gitStat(root),
			this.channel.gitSampledDiffs(root),
			this.channel.gitBranch(root),
			this.channel.gitLog(root),
		]);

		const modelSelection = this.voidSettingsService.state.modelSelectionOfFeature['SCM'] ?? null;
		const modelSelectionOptions = modelSelection
			? this.voidSettingsService.state.optionsOfModelSelection['SCM'][modelSelection.providerName]?.[modelSelection.modelName]
			: undefined;
		const overridesOfModel = this.voidSettingsService.state.overridesOfModel;

		const prompt = gitCommitMessage_userMessage(stat, sampledDiffs, branch, log);
		const { messages, separateSystemMessage } = this.convertToLLMMessageService.prepareLLMSimpleMessages({
			simpleMessages: [{ role: 'user', content: prompt }],
			systemMessage: gitCommitMessage_systemMessage,
			modelSelection,
			featureName: 'SCM',
		});

		return new Promise<string>((resolve, reject) => {
			this.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages,
				separateSystemMessage,
				chatMode: null,
				modelSelection,
				modelSelectionOptions,
				overridesOfModel,
				onText: () => { },
				onFinalMessage: ({ fullText }: { fullText: string }) => {
					const match = fullText.match(/<output>([\s\S]*?)<\/output>/i);
					resolve((match ? match[1] : fullText).trim());
				},
				onError: (error: any) => reject(error),
				onAbort: () => reject(new CancellationError()),
				logging: { loggingName: 'AgentGit - Commit Message' },
			});
		});
	}

	/** Run a mutation, then nudge a refresh so the panel repaints even if the
	 *  SCM watcher is slow to fire (or the change is index-only). */
	private async mutate(op: Promise<GitCommandResult>): Promise<GitCommandResult> {
		const result = await op;
		this._onDidChange.fire();
		return result;
	}
}

registerSingleton(IAgentGitService, AgentGitService, InstantiationType.Delayed);
