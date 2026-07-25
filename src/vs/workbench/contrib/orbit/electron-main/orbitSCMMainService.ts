/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { promisify } from 'util'
import { execFile as _execFile } from 'child_process'
import { readFile } from 'fs/promises'
import { resolve, relative, isAbsolute, sep } from 'path'

/**
 * Resolve `file` (arriving raw over IPC) against `root` and verify it stays inside `root`.
 * Prevents path traversal (`../../etc/passwd`) turning the diff panel into an arbitrary file-read
 * primitive. Returns the absolute path; throws if it escapes the repository root.
 */
function resolveInsideRoot(root: string, file: string): string {
	const abs = resolve(root, file)
	const rel = relative(root, abs)
	if (rel === '' || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) {
		throw new Error(`Refusing to access path outside repository: ${file}`)
	}
	return abs
}
import {
	GitCommandResult,
	GitCommitOptions,
	GitCompareUrlOptions,
	GitCheckoutRemoteOptions,
	GitDiffOptions,
	GitFetchOptions,
	GitFileChange,
	GitPushOptions,
	GitRepoStatus,
	IVoidSCMService,
} from '../common/orbitSCMTypes.js'

interface NumStat {
	file: string
	added: number
	removed: number
}

const execFile = promisify(_execFile)

//8000 and 10 were chosen after some experimentation on small-to-moderately sized changes
const MAX_DIFF_LENGTH = 8000
const MAX_DIFF_FILES = 10
const MAX_BUFFER = 64 * 1024 * 1024 // 64MB — full-context diffs of large files
// Bounds every git invocation so a hung credential/GPG/hook prompt or a stalled
// network push can't wedge the renderer's commit/push button forever.
const GIT_TIMEOUT_MS = 120_000

interface RunResult { code: number; stdout: string; stderr: string }

/**
 * Run `git` with argument arrays (never string-interpolated) so paths with
 * spaces/quotes/globs are always safe. `core.quotePath=false` keeps unicode
 * paths readable and parseable. Non-zero exit is returned, not thrown, so
 * callers can distinguish "diff found changes" (exit 1) from a real failure.
 */
const runGit = async (root: string, args: string[], input?: string): Promise<RunResult> => {
	const fullArgs = ['-c', 'core.quotePath=false', ...args]
	// GIT_TERMINAL_PROMPT=0 makes a missing-credential push/fetch fail fast
	// instead of hanging on an interactive prompt nothing can answer; the
	// timeout is a backstop for stalled networks, GPG, or pre-commit hooks.
	const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
	try {
		if (input !== undefined) {
			// promisified execFile doesn't stream stdin; use the callback form.
			return await new Promise<RunResult>((resolve) => {
				const child = _execFile('git', fullArgs, { cwd: root, env, maxBuffer: MAX_BUFFER, timeout: GIT_TIMEOUT_MS }, (err, stdout, stderr) => {
					resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' })
				})
				child.stdin?.end(input)
			})
		}
		const { stdout, stderr } = await execFile('git', fullArgs, { cwd: root, env, maxBuffer: MAX_BUFFER, timeout: GIT_TIMEOUT_MS })
		return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' }
	} catch (err: any) {
		const timedOut = err?.killed && err?.signal
		return {
			code: typeof err?.code === 'number' ? err.code : 1,
			stdout: err?.stdout ?? '',
			stderr: timedOut ? `git command timed out after ${GIT_TIMEOUT_MS / 1000}s` : (err?.stderr ?? String(err?.message ?? err)),
		}
	}
}

/** Wrap a mutation run into the panel's uniform result shape. */
const toResult = (r: RunResult): GitCommandResult =>
	r.code === 0
		? { ok: true, stdout: r.stdout }
		: { ok: false, stdout: r.stdout, error: (r.stderr || r.stdout || 'git command failed').trim() }

const hasStagedChanges = async (root: string): Promise<boolean> => {
	const r = await runGit(root, ['diff', '--staged', '--name-only'])
	return r.stdout.trim().length > 0
}

const getNumStat = async (root: string, useStagedChanges: boolean): Promise<NumStat[]> => {
	const args = ['diff', '--numstat']
	if (useStagedChanges) { args.push('--staged') }
	const r = await runGit(root, args)
	return r.stdout
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			const [added, removed, file] = line.split('\t')
			return {
				file,
				added: parseInt(added, 10) || 0,
				removed: parseInt(removed, 10) || 0,
			}
		})
		.filter((s) => !!s.file)
}

// `file` may be attacker-controlled (a filename inside a cloned repo the user
// opens) — it MUST reach git as its own argv element, never interpolated into
// a shell string, or a name like `$(touch pwned).txt` executes arbitrary code.
const getSampledDiff = async (file: string, root: string, useStagedChanges: boolean): Promise<string> => {
	const args = ['diff', '--unified=0', '--no-color']
	if (useStagedChanges) { args.push('--staged') }
	args.push('--', file)
	const r = await runGit(root, args)
	return r.stdout.slice(0, MAX_DIFF_LENGTH)
}

/** Reject branch names git would otherwise parse as an option (e.g. `-D`, `--orphan`). */
const isSafeRefName = (name: string): boolean => /^[^\s\-~^:?*\\[\]][^\s~^:?*\\[\]]*$/.test(name)

/** Reject remote names that git would parse as options (e.g. `--upload-pack=…`). */
const isSafeRemoteName = (name: string): boolean => /^[^\s\-~^:?*\\[\]][^\s~^:?*\\[\]]*$/.test(name)

/** Parse `git status --porcelain=v2 --branch`. */
const parseStatus = (root: string, out: string): GitRepoStatus => {
	const status: GitRepoStatus = {
		root,
		branch: null,
		detachedHead: null,
		upstream: null,
		ahead: 0,
		behind: 0,
		hasRemote: false,
		files: [],
	}
	const lines = out.split('\n')
	for (const line of lines) {
		if (!line) { continue }
		if (line.startsWith('# ')) {
			const rest = line.slice(2)
			if (rest.startsWith('branch.head ')) {
				const head = rest.slice('branch.head '.length).trim()
				status.branch = head === '(detached)' ? null : head
			} else if (rest.startsWith('branch.oid ')) {
				const oid = rest.slice('branch.oid '.length).trim()
				status.detachedHead = oid === '(initial)' ? null : oid.slice(0, 7)
			} else if (rest.startsWith('branch.upstream ')) {
				status.upstream = rest.slice('branch.upstream '.length).trim() || null
			} else if (rest.startsWith('branch.ab ')) {
				const ab = rest.slice('branch.ab '.length).trim().split(' ')
				for (const tok of ab) {
					if (tok.startsWith('+')) { status.ahead = parseInt(tok.slice(1), 10) || 0 }
					else if (tok.startsWith('-')) { status.behind = parseInt(tok.slice(1), 10) || 0 }
				}
			}
			continue
		}
		const type = line[0]
		if (type === '1') {
			// 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
			const xy = line.slice(2, 4)
			const parts = line.split(' ')
			const filePath = parts.slice(8).join(' ')
			status.files.push(makeChange(xy, filePath))
		} else if (type === '2') {
			// 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>
			const xy = line.slice(2, 4)
			const parts = line.split(' ')
			const pathField = parts.slice(9).join(' ')
			const [newPath, origPath] = pathField.split('\t')
			const change = makeChange(xy, newPath)
			change.origPath = origPath
			status.files.push(change)
		} else if (type === 'u') {
			// u <XY> ... <path>  (unmerged / conflicted)
			const xy = line.slice(2, 4)
			const parts = line.split(' ')
			const filePath = parts.slice(10).join(' ')
			const change = makeChange(xy, filePath)
			change.conflicted = true
			status.files.push(change)
		} else if (type === '?') {
			status.files.push({
				path: line.slice(2),
				index: '?',
				worktree: '?',
				staged: false,
				unstaged: true,
				untracked: true,
				conflicted: false,
			})
		}
		// '!' ignored — skipped
	}
	return status
}

const makeChange = (xy: string, path: string): GitFileChange => {
	const index = xy[0] ?? ' '
	const worktree = xy[1] ?? ' '
	return {
		path,
		index,
		worktree,
		staged: index !== '.' && index !== ' ' && index !== '?',
		unstaged: worktree !== '.' && worktree !== ' ',
		untracked: false,
		conflicted: false,
	}
}

export class VoidSCMService implements IVoidSCMService {
	readonly _serviceBrand: undefined

	/* ---------------- existing read-only summaries ---------------- */

	async gitStat(path: string): Promise<string> {
		const useStagedChanges = await hasStagedChanges(path)
		const args = ['diff', '--stat']
		if (useStagedChanges) { args.push('--staged') }
		const r = await runGit(path, args)
		if (r.code !== 0) { throw new Error((r.stderr || 'git diff --stat failed').trim()) }
		return r.stdout.trim()
	}

	async gitSampledDiffs(path: string): Promise<string> {
		const useStagedChanges = await hasStagedChanges(path)
		const numStatList = await getNumStat(path, useStagedChanges)
		const topFiles = numStatList
			.sort((a, b) => (b.added + b.removed) - (a.added + a.removed))
			.slice(0, MAX_DIFF_FILES)
		const diffs = await Promise.all(topFiles.map(async ({ file }) => ({ file, diff: await getSampledDiff(file, path, useStagedChanges) })))
		return diffs.map(({ file, diff }) => `==== ${file} ====\n${diff}`).join('\n\n')
	}

	async gitBranch(path: string): Promise<string> {
		const r = await runGit(path, ['branch', '--show-current'])
		if (r.code !== 0) { throw new Error((r.stderr || 'git branch failed').trim()) }
		return r.stdout.trim()
	}

	async gitLog(path: string): Promise<string> {
		const r = await runGit(path, ['log', '--pretty=format:%h|%s|%ad', '--date=short', '--no-merges', '-n', '5'])
		if (r.code !== 0) { throw new Error((r.stderr || 'git log failed').trim()) }
		return r.stdout.trim()
	}

	/* ---------------- Changes panel: state ---------------- */

	async getRepoRoot(path: string): Promise<string | null> {
		const r = await runGit(path, ['rev-parse', '--show-toplevel'])
		if (r.code !== 0) { return null }
		const root = r.stdout.trim()
		return root || null
	}

	async getStatus(root: string): Promise<GitRepoStatus> {
		const r = await runGit(root, ['status', '--porcelain=v2', '--branch'])
		if (r.code !== 0) {
			throw new Error((r.stderr || 'git status failed').trim())
		}
		const status = parseStatus(root, r.stdout)
		const remotes = await runGit(root, ['remote'])
		status.hasRemote = remotes.code === 0 && remotes.stdout.trim().length > 0
		return status
	}

	async getDiff(root: string, options: GitDiffOptions): Promise<string> {
		const context = options.contextLines ?? 3
		const ws = options.ignoreWhitespace ? ['-w'] : []
		if (options.untracked) {
			// Untracked files have no index/HEAD version — diff against /dev/null.
			// `--no-index` bypasses git's repo-membership check, so validate containment ourselves.
			const abs = resolveInsideRoot(root, options.file)
			const r = await runGit(root, ['diff', '--no-color', `--unified=${context}`, ...ws, '--no-index', '--', '/dev/null', abs])
			// exit 1 = differences found (expected); >1 = error
			return r.stdout
		}
		const args = ['diff', '--no-color', `--unified=${context}`, ...ws]
		if (options.staged) { args.push('--staged') }
		args.push('--', options.file)
		const r = await runGit(root, args)
		return r.stdout
	}

	async getFileContent(root: string, file: string, staged?: boolean): Promise<string> {
		if (staged) {
			const r = await runGit(root, ['show', `:${file}`])
			return r.code === 0 ? r.stdout : ''
		}
		try {
			return await readFile(resolveInsideRoot(root, file), 'utf8')
		} catch {
			return ''
		}
	}

	async getTotals(root: string): Promise<{ added: number; removed: number }> {
		const r = await runGit(root, ['diff', 'HEAD', '--numstat'])
		let added = 0
		let removed = 0
		if (r.code === 0) {
			for (const line of r.stdout.split('\n')) {
				if (!line) { continue }
				const [a, d] = line.split('\t')
				const na = parseInt(a, 10)
				const nd = parseInt(d, 10)
				if (!isNaN(na)) { added += na }
				if (!isNaN(nd)) { removed += nd }
			}
		}
		return { added, removed }
	}

	async getBranches(root: string): Promise<string[]> {
		const r = await runGit(root, [
			'for-each-ref',
			'--format=%(refname:short)',
			'--sort=-committerdate',
			'refs/heads',
			'refs/remotes/origin',
		])
		if (r.code !== 0) { return [] }
		const current = (await runGit(root, ['branch', '--show-current'])).stdout.trim()
		const names = [...new Set(r.stdout.split('\n')
			.map(s => s.trim())
			.filter(name => !!name && name !== 'origin/HEAD')
			.map(name => name.replace(/^origin\//, '')))]
		if (current && names.includes(current)) {
			return [current, ...names.filter(n => n !== current)]
		}
		return names
	}

	async getRemoteBranches(root: string): Promise<string[]> {
		const remote = await this.resolveConfiguredRemote(root)
		if (!remote) { return [] }
		const r = await runGit(root, ['ls-remote', '--heads', '--', remote])
		if (r.code !== 0) { return [] }
		return [...new Set(r.stdout.split('\n')
			.map(line => line.trim().split(/\s+/)[1] ?? '')
			.filter(ref => ref.startsWith('refs/heads/'))
			.map(ref => ref.slice('refs/heads/'.length)))]
	}

	async getRemoteBranchCommit(root: string, branch: string): Promise<string | null> {
		if (!isSafeRefName(branch)) { return null }
		const remote = await this.resolveConfiguredRemote(root)
		if (!remote) { return null }
		const r = await runGit(root, ['ls-remote', '--heads', '--', remote, `refs/heads/${branch}`])
		const commit = r.stdout.trim().split(/\s+/)[0] ?? ''
		return r.code === 0 && /^[0-9a-f]{40}$/i.test(commit) ? commit : null
	}

	async getHeadCommit(root: string): Promise<string | null> {
		const r = await runGit(root, ['rev-parse', '--verify', 'HEAD^{commit}'])
		const commit = r.stdout.trim()
		return r.code === 0 && /^[0-9a-f]{40}$/i.test(commit) ? commit : null
	}

	/* ---------------- Changes panel: mutations ---------------- */

	async stage(root: string, files: string[]): Promise<GitCommandResult> {
		if (files.length === 0) { return { ok: true, stdout: '' } }
		return toResult(await runGit(root, ['add', '--', ...files]))
	}

	async unstage(root: string, files: string[]): Promise<GitCommandResult> {
		if (files.length === 0) { return { ok: true, stdout: '' } }
		return toResult(await runGit(root, ['reset', '-q', 'HEAD', '--', ...files]))
	}

	async stageAll(root: string): Promise<GitCommandResult> {
		return toResult(await runGit(root, ['add', '-A']))
	}

	async unstageAll(root: string): Promise<GitCommandResult> {
		// `git reset HEAD` clears the whole index staging area. Avoid a trailing
		// bare `--` which some git builds treat as an empty pathspec error.
		return toResult(await runGit(root, ['reset', '-q', 'HEAD']))
	}

	async discard(root: string, files: string[], untrackedFiles: string[]): Promise<GitCommandResult> {
		let last: RunResult = { code: 0, stdout: '', stderr: '' }
		if (files.length > 0) {
			// Unstage first (non-destructive/reversible) — needed so the HEAD-membership
			// check below and the mutating batches after it see accurate tracked state.
			await runGit(root, ['reset', '-q', 'HEAD', '--', ...files])
			// Split into tracked-in-HEAD vs newly-added *before* mutating anything, so a
			// staged-new file (no HEAD blob) can't make a single `checkout HEAD --` call
			// fail for every other file. Each category is then reverted as one batch
			// instead of file-by-file, so a mid-batch failure can't leave some files
			// already irreversibly reverted while others silently weren't attempted.
			const trackedFiles: string[] = []
			const newFiles: string[] = []
			for (const file of files) {
				const inHead = (await runGit(root, ['cat-file', '-e', `HEAD:${file}`])).code === 0
				if (inHead) { trackedFiles.push(file) } else { newFiles.push(file) }
			}
			if (trackedFiles.length > 0) {
				last = await runGit(root, ['checkout', 'HEAD', '--', ...trackedFiles])
				if (last.code !== 0) { return toResult(last) }
			}
			if (newFiles.length > 0) {
				last = await runGit(root, ['clean', '-fdq', '--', ...newFiles])
				if (last.code !== 0) { return toResult(last) }
			}
		}
		if (untrackedFiles.length > 0) {
			last = await runGit(root, ['clean', '-fdq', '--', ...untrackedFiles])
		}
		return toResult(last)
	}

	async applyPatch(root: string, patch: string, opts: { cached?: boolean; reverse?: boolean }): Promise<GitCommandResult> {
		// Cap the patch fed to `git apply` on stdin so a runaway/hostile patch can't
		// pin memory in the main process (the whole string is buffered here and again
		// in the child's stdin pipe).
		const MAX_PATCH_BYTES = 50 * 1024 * 1024
		if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) {
			return { ok: false, stdout: '', error: 'Patch exceeds the maximum size (50MB).' }
		}
		const args = ['apply', '--whitespace=nowarn']
		if (opts.cached) { args.push('--cached') }
		if (opts.reverse) { args.push('--reverse') }
		args.push('-')
		const normalized = patch.endsWith('\n') ? patch : patch + '\n'
		return toResult(await runGit(root, args, normalized))
	}

	async commit(root: string, message: string, options?: GitCommitOptions): Promise<GitCommandResult> {
		const args = ['commit', '-m', message]
		if (options?.amend) { args.push('--amend') }
		return toResult(await runGit(root, args))
	}

	async createBranch(root: string, name: string, checkout = true): Promise<GitCommandResult> {
		if (!isSafeRefName(name)) { return { ok: false, stdout: '', error: `Invalid branch name: "${name}"` } }
		// `-b` always takes the very next argv element as the branch name, so it
		// can't be misread as another flag; plain `branch <name>` can, so pin it
		// as a positional arg with `--`.
		return toResult(await runGit(root, checkout ? ['checkout', '-b', name] : ['branch', '--', name]))
	}

	async checkoutBranch(root: string, name: string): Promise<GitCommandResult> {
		if (!isSafeRefName(name)) { return { ok: false, stdout: '', error: `Invalid branch name: "${name}"` } }
		return toResult(await runGit(root, ['checkout', name]))
	}

	async push(root: string, options?: GitPushOptions): Promise<GitCommandResult> {
		const args = ['push']
		if (options?.force) { args.push('--force-with-lease') }
		if (options?.setUpstream) {
			const branch = options.branch || (await runGit(root, ['branch', '--show-current'])).stdout.trim()
			if (!branch) { return { ok: false, stdout: '', error: 'Cannot set upstream from a detached HEAD — check out a branch first.' } }
			const remote = options.remote || 'origin'
			args.push('-u', remote, branch)
		} else {
			if (options?.remote) { args.push(options.remote) }
			if (options?.branch) { args.push(options.branch) }
		}
		return toResult(await runGit(root, args))
	}

	async fetch(root: string, options?: GitFetchOptions): Promise<GitCommandResult> {
		const remote = options?.remote || 'origin'
		if (!isSafeRemoteName(remote)) {
			return { ok: false, stdout: '', error: `Invalid remote name: "${remote}"` }
		}
		const args = ['fetch', remote]
		if (options?.ref) {
			if (!isSafeRefName(options.ref)) {
				return { ok: false, stdout: '', error: `Invalid ref: "${options.ref}"` }
			}
			args.push(options.ref)
		}
		return toResult(await runGit(root, args))
	}

	async checkoutRemoteBranch(root: string, options: GitCheckoutRemoteOptions): Promise<GitCommandResult> {
		const remoteBranch = options.remoteBranch
		const localBranch = options.localBranch || remoteBranch
		if (!isSafeRefName(remoteBranch) || !isSafeRefName(localBranch)) {
			return { ok: false, stdout: '', error: `Invalid branch name: "${remoteBranch}" / "${localBranch}"` }
		}
		const remoteRef = `refs/remotes/origin/${remoteBranch}`
		const fetchSpec = `+refs/heads/${remoteBranch}:${remoteRef}`
		const fetchResult = toResult(await runGit(root, ['fetch', 'origin', fetchSpec]))
		if (!fetchResult.ok) {
			return fetchResult
		}
		const tracking = `origin/${remoteBranch}`
		if (options.createWorktreePath) {
			const path = options.createWorktreePath
			// Reject NUL bytes and paths git would parse as an option (leading dash),
			// or a leading space. A hyphen anywhere else is fine — worktree paths
			// like ".../orbit-editor-orbit-branch" legitimately contain hyphens.
			if (!path || path.includes('\0') || /^[\s-]/.test(path)) {
				return { ok: false, stdout: '', error: 'Invalid worktree path.' }
			}
			return toResult(await runGit(root, ['worktree', 'add', '-B', localBranch, path, tracking]))
		}
		return toResult(await runGit(root, ['checkout', '-B', localBranch, tracking]))
	}

	async getPullRequestUrl(root: string): Promise<string | null> {
		// Prefer the GitHub CLI when available (creates the PR); otherwise build a
		// compare URL the panel can open in the browser.
		const branch = (await runGit(root, ['branch', '--show-current'])).stdout.trim()
		if (!branch) { return null }
		const remoteUrl = (await runGit(root, ['remote', 'get-url', 'origin'])).stdout.trim()
		const httpUrl = normalizeRemoteToHttps(remoteUrl)
		if (!httpUrl) { return null }
		return `${httpUrl}/compare/${encodeURIComponent(branch)}?expand=1`
	}

	async getCompareUrl(root: string, options: GitCompareUrlOptions): Promise<string | null> {
		if (!isSafeRefName(options.base) || !isSafeRefName(options.head)) {
			return null
		}
		const remoteUrl = (await runGit(root, ['remote', 'get-url', 'origin'])).stdout.trim()
		const httpUrl = normalizeRemoteToHttps(remoteUrl)
		if (!httpUrl) { return null }
		const base = encodeURIComponent(options.base)
		const head = encodeURIComponent(options.head)
		// Never strip namespace prefixes (orbit/, cursor/) — required for correct PR head.
		if (/gitlab\.com/i.test(httpUrl)) {
			return `${httpUrl}/-/compare/${base}...${head}`
		}
		return `${httpUrl}/compare/${base}...${head}?expand=1`
	}

	async getRemoteHttpsUrl(root: string, remote = 'origin'): Promise<string | null> {
		const raw = await this.getRemoteUrl(root, remote)
		if (!raw) { return null }
		// Never silently convert SSH → HTTPS for runner clone paths (E3).
		if (/^git@/i.test(raw) || /^ssh:\/\//i.test(raw)) {
			return null
		}
		return normalizeRemoteToHttps(raw)
	}

	async getRemoteUrl(root: string, remote = 'origin'): Promise<string | null> {
		const remoteName = await this.resolveConfiguredRemote(root, remote)
		if (!remoteName) { return null }
		const r = await runGit(root, ['remote', 'get-url', '--', remoteName])
		if (r.code !== 0) { return null }
		const url = r.stdout.trim()
		return url || null
	}

	/**
	 * Prefer `origin` (or an explicit preferred name), else the first configured remote.
	 * Rejects names that git would treat as options.
	 */
	private async resolveConfiguredRemote(root: string, preferred = 'origin'): Promise<string | null> {
		if (!isSafeRemoteName(preferred)) { return null }
		const list = await runGit(root, ['remote'])
		if (list.code !== 0) { return null }
		const remotes = list.stdout.trim().split('\n').map(s => s.trim()).filter(Boolean)
		if (remotes.includes(preferred)) { return preferred }
		const first = remotes.find(name => isSafeRemoteName(name))
		return first ?? null
	}
}

/** Turn a git remote (ssh or https, with/without .git) into an https browse URL. */
const normalizeRemoteToHttps = (remote: string): string | null => {
	if (!remote) { return null }
	let url = remote.trim()
	// git@github.com:owner/repo.git  ->  https://github.com/owner/repo
	const sshMatch = url.match(/^git@([^:]+):(.+)$/)
	if (sshMatch) {
		url = `https://${sshMatch[1]}/${sshMatch[2]}`
	} else if (url.startsWith('ssh://')) {
		url = url.replace(/^ssh:\/\/git@/, 'https://').replace(/^ssh:\/\//, 'https://')
	}
	try {
		const parsed = new URL(url)
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { return null }
		parsed.protocol = 'https:'
		parsed.username = ''
		parsed.password = ''
		parsed.search = ''
		parsed.hash = ''
		parsed.pathname = parsed.pathname.replace(/\.git$/, '')
		return parsed.toString().replace(/\/$/, '')
	} catch {
		return null
	}
}
