/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { RunnerErrorPayload, RunnerGitProvider, RunnerGitSpec } from './runnerProtocol.js';

export type ParseGitRemoteResult =
	| { ok: true; provider: RunnerGitProvider; repoUrl: string }
	| { ok: false; error: RunnerErrorPayload };

/** v1 remote tasks accept GitHub and GitLab remotes only. */
export function parseGitHubOrGitLabRemote(url: string): ParseGitRemoteResult {
	const trimmed = (url ?? '').trim();
	if (!trimmed) {
		return {
			ok: false,
			error: { code: 'repo_unsupported', message: 'Repository URL is required for remote tasks.', retriable: false },
		};
	}

	// v1: HTTPS only (matches orbit-runner assertAllowedRemote). Never convert SSH→HTTPS.
	if (isSshGitRemote(trimmed)) {
		return {
			ok: false,
			error: {
				code: 'repo_unsupported',
				message: sshRemoteUnsupportedMessage(),
				retriable: false,
			},
		};
	}

	try {
		const u = new URL(trimmed);
		if (u.protocol !== 'https:') {
			return {
				ok: false,
				error: { code: 'repo_unsupported', message: `Unsupported URL scheme "${u.protocol}". Use HTTPS.`, retriable: false },
			};
		}
		const host = u.hostname.toLowerCase();
		const provider = providerFromHost(host);
		if (!provider) {
			return unsupportedHost(host);
		}
		return { ok: true, provider, repoUrl: trimmed };
	} catch {
		return {
			ok: false,
			error: { code: 'repo_unsupported', message: `Could not parse repository URL: ${trimmed}`, retriable: false },
		};
	}
}

export function buildRunnerGitSpec(opts: {
	url: string;
	branch: string;
	commit?: string;
}): { ok: true; git: RunnerGitSpec } | { ok: false; error: RunnerErrorPayload } {
	const parsed = parseGitHubOrGitLabRemote(opts.url);
	if (!parsed.ok) {
		return { ok: false, error: parsed.error };
	}
	const branch = (opts.branch ?? '').trim();
	if (!branch) {
		return {
			ok: false,
			error: { code: 'repo_unsupported', message: 'Branch is required for remote tasks.', retriable: false },
		};
	}
	const commit = (opts.commit ?? '').trim();
	if (!/^[0-9a-f]{40}$/i.test(commit)) {
		return {
			ok: false,
			error: {
				code: 'repo_unsupported',
				message: 'A full 40-character commit SHA is required for remote tasks.',
				retriable: false,
			},
		};
	}
	return {
		ok: true,
		git: {
			provider: parsed.provider,
			repoUrl: parsed.repoUrl,
			branch,
			commit,
			shallow: true,
		},
	};
}

/** @deprecated Use buildRunnerGitSpec — kept for callers expecting RunnerRepoRef shape. */
export function buildRunnerRepoRef(opts: {
	url: string;
	branch: string;
	commit?: string;
}): { ok: true; repo: { provider: RunnerGitProvider; url: string; branch: string; commit?: string } } | { ok: false; error: RunnerErrorPayload } {
	const built = buildRunnerGitSpec(opts);
	if (!built.ok) {
		return { ok: false, error: built.error };
	}
	return {
		ok: true,
		repo: {
			provider: built.git.provider,
			url: built.git.repoUrl,
			branch: built.git.branch!,
			commit: built.git.commit,
		},
	};
}

/** True for git@host:path and ssh:// remotes (v1 runner rejects these). */
export function isSshGitRemote(url: string): boolean {
	const trimmed = (url ?? '').trim();
	return /^git@/i.test(trimmed) || /^ssh:\/\//i.test(trimmed);
}

export function sshRemoteUnsupportedMessage(): string {
	return 'SSH remotes are not supported for Self-hosted Runner in v1. Switch origin to an HTTPS GitHub or GitLab URL (Settings → Remotes), or run locally.';
}

function providerFromHost(host: string): RunnerGitProvider | undefined {
	// Match orbit-runner assertAllowedRemote (allows www. variants).
	if (host === 'github.com' || host === 'www.github.com') {
		return 'github';
	}
	if (host === 'gitlab.com' || host === 'www.gitlab.com') {
		return 'gitlab';
	}
	return undefined;
}

function unsupportedHost(host: string): ParseGitRemoteResult {
	const isEnterprise = host.includes('.') && !host.endsWith('github.com') && !host.endsWith('gitlab.com');
	const hint = isEnterprise
		? ` Enterprise Git hosts (e.g. github.example.com, gitlab.company.com) are not supported in v1 — use github.com or gitlab.com, or run locally.`
		: '';
	return {
		ok: false,
		error: {
			code: 'repo_unsupported',
			message: `Remote host "${host}" is not supported in v1. Use a github.com or gitlab.com HTTPS repository.${hint}`,
			retriable: false,
		},
	};
}
