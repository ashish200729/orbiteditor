/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/** One changed path in a git working tree, as surfaced to the Changes panel. */
export interface GitFileChange {
	/** Repo-relative path, forward slashes. */
	path: string;
	/** For renames/copies: the original path. */
	origPath?: string;
	/** Index (staged) status char: M A D R C U ? or ' '. */
	index: string;
	/** Worktree (unstaged) status char: M A D U ? or ' '. */
	worktree: string;
	/** True when the file has staged content in the index. */
	staged: boolean;
	/** True when the file has unstaged working-tree changes. */
	unstaged: boolean;
	/** True when the file is untracked. */
	untracked: boolean;
	/** True for merge-conflicted (unmerged) entries. */
	conflicted: boolean;
}

/** Snapshot of a git repository's state for the Changes panel. */
export interface GitRepoStatus {
	/** Absolute repo root path. */
	root: string;
	/** Current branch name, or null when detached. */
	branch: string | null;
	/** Short detached-HEAD commit when branch is null. */
	detachedHead: string | null;
	/** Configured upstream ref (e.g. origin/main), or null. */
	upstream: string | null;
	/** Commits ahead of upstream. */
	ahead: number;
	/** Commits behind upstream. */
	behind: number;
	/** True when at least one remote is configured. */
	hasRemote: boolean;
	/** All changed files (staged, unstaged, untracked, conflicted). */
	files: GitFileChange[];
}

export interface GitDiffOptions {
	/** Repo-relative path (forward slashes). */
	file: string;
	/** Diff the staged (index) version instead of the working tree. */
	staged?: boolean;
	/** True when the file is untracked (diffed against /dev/null). */
	untracked?: boolean;
	/** Context lines. Pass a large value for full-file diffs. */
	contextLines?: number;
	/** Pass -w to ignore whitespace-only changes. */
	ignoreWhitespace?: boolean;
}

export interface GitCommitOptions {
	amend?: boolean;
}

export interface GitPushOptions {
	/** Push and set upstream (-u) for the current branch. */
	setUpstream?: boolean;
	remote?: string;
	branch?: string;
	force?: boolean;
}

export interface GitCommandResult {
	ok: boolean;
	/** Combined stdout; present on success and failure. */
	stdout: string;
	/** Error text when ok is false. */
	error?: string;
}

export interface IVoidSCMService {
	readonly _serviceBrand: undefined;

	/* ---- read-only summaries (used by commit-message generation) ---- */
	/** Get git diff --stat. */
	gitStat(path: string): Promise<string>
	/** Get sampled diffs for the top-changed files. */
	gitSampledDiffs(path: string): Promise<string>
	/** Get the current git branch. */
	gitBranch(path: string): Promise<string>
	/** Get the last 5 commits excluding merges. */
	gitLog(path: string): Promise<string>

	/* ---- Changes panel: state ---- */
	/** Resolve the repo root that contains `path`, or null when not a repo. */
	getRepoRoot(path: string): Promise<string | null>
	/** Full working-tree status snapshot. */
	getStatus(root: string): Promise<GitRepoStatus>
	/** Unified diff text for one file. */
	getDiff(root: string, options: GitDiffOptions): Promise<string>
	/**
	 * Full content of the "new" side of a file, used to expand collapsed
	 * unmodified regions in the inline diff. `staged` reads the index version;
	 * otherwise the working-tree file.
	 */
	getFileContent(root: string, file: string, staged?: boolean): Promise<string>
	/** Total +added / -removed across all uncommitted tracked changes (vs HEAD). */
	getTotals(root: string): Promise<{ added: number; removed: number }>
	/** Local branch names (current first). */
	getBranches(root: string): Promise<string[]>

	/* ---- Changes panel: mutations ---- */
	stage(root: string, files: string[]): Promise<GitCommandResult>
	unstage(root: string, files: string[]): Promise<GitCommandResult>
	stageAll(root: string): Promise<GitCommandResult>
	unstageAll(root: string): Promise<GitCommandResult>
	/** Discard working-tree changes for tracked files and delete untracked ones. */
	discard(root: string, files: string[], untrackedFiles: string[]): Promise<GitCommandResult>
	/** Apply a unified-diff patch. `cached` stages it; `reverse` unstages/discards. */
	applyPatch(root: string, patch: string, opts: { cached?: boolean; reverse?: boolean }): Promise<GitCommandResult>
	commit(root: string, message: string, options?: GitCommitOptions): Promise<GitCommandResult>
	createBranch(root: string, name: string, checkout?: boolean): Promise<GitCommandResult>
	checkoutBranch(root: string, name: string): Promise<GitCommandResult>
	push(root: string, options?: GitPushOptions): Promise<GitCommandResult>
	/** Open a GitHub compare/PR URL for the pushed branch, or run `gh pr create`. */
	getPullRequestUrl(root: string): Promise<string | null>
}

export const IVoidSCMService = createDecorator<IVoidSCMService>('voidSCMService')
