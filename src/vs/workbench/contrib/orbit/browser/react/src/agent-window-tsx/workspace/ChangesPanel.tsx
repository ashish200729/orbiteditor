/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as React from 'react';
import {
	GitBranch, ChevronDown, ChevronRight, Undo2, RefreshCw, Search, X, Check,
	Loader2, Sparkles, MoreHorizontal, PanelRight, ChevronsDownUp, Monitor, GitCommitVertical,
	SquareCheckBig,
} from 'lucide-react';
import { URI } from '../../../../../../../../base/common/uri.js';
import { useAccessor } from '../../util/services.js';
import { useConnectedDocument } from '../../sidebar-tsx/contexts/ConnectedWindowContext.js';
import { VsCodeFileIcon } from '../../sidebar-tsx/utils/fileIcons.js';
import { voidOpenFileFn } from '../../sidebar-tsx/utils/fileUtils.js';
import type { WorkspacePanelProps } from './workspaceTypes.js';
import type { GitFileChange, GitRepoStatus } from '../../../../../common/orbitSCMTypes.js';
import { GitDiffView, DiffLayout } from './GitDiffView.js';
import { ChangesTree } from './ChangesTree.js';

/* ---------------------------------------------------------------------------- */

const splitPath = (p: string): { name: string; dir: string } => {
	const clean = p.replace(/\/+$/, '');
	const idx = clean.lastIndexOf('/');
	return idx >= 0 ? { name: clean.slice(idx + 1), dir: clean.slice(0, idx) } : { name: clean, dir: '' };
};

interface Badge { letter: string; kind: string; label: string }
const badgeFor = (f: GitFileChange): Badge => {
	if (f.conflicted) { return { letter: '!', kind: 'conflict', label: 'Conflict' }; }
	if (f.untracked) { return { letter: 'U', kind: 'untracked', label: 'Untracked' }; }
	const c = f.staged && !f.unstaged ? f.index : f.worktree !== ' ' && f.worktree !== '.' ? f.worktree : f.index;
	switch (c) {
		case 'A': return { letter: 'A', kind: 'add', label: 'Added' };
		case 'D': return { letter: 'D', kind: 'del', label: 'Deleted' };
		case 'R': return { letter: 'R', kind: 'rename', label: 'Renamed' };
		case 'C': return { letter: 'C', kind: 'rename', label: 'Copied' };
		default: return { letter: 'M', kind: 'mod', label: 'Modified' };
	}
};

/* ---------------------------------------------------------------------------- */

const useGitStatus = () => {
	const accessor = useAccessor();
	const gitService = accessor.get('IAgentGitService');

	const [root, setRoot] = React.useState<string | null | undefined>(undefined);
	const [status, setStatus] = React.useState<GitRepoStatus | null>(null);
	const [totals, setTotals] = React.useState<{ added: number; removed: number }>({ added: 0, removed: 0 });
	const [error, setError] = React.useState<string | null>(null);
	const [refreshKey, setRefreshKey] = React.useState(0);

	React.useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const r = await gitService.resolveRepoRoot();
				if (!cancelled) { setRoot(r); }
			} catch {
				if (!cancelled) { setRoot(null); }
			}
		})();
		return () => { cancelled = true; };
	}, [gitService]);

	// Once we've resolved "not a repo yet", keep re-checking whenever the SCM
	// service signals a change (e.g. the built-in git extension picks up a
	// `git init` run from the agent's terminal) — otherwise this gets stuck on
	// "Not a git repository" forever even after a repo appears.
	React.useEffect(() => {
		if (root !== null) { return; }
		let cancelled = false;
		const sub = gitService.onDidChange(() => {
			void (async () => {
				try {
					const r = await gitService.resolveRepoRoot();
					if (!cancelled) { setRoot(r); }
				} catch { /* still not a repo */ }
			})();
		});
		return () => { cancelled = true; sub.dispose(); };
	}, [root, gitService]);

	// Guards against an in-flight reload's response landing after a newer one's
	// (e.g. a manual refresh fired right as a debounced onDidChange reload was
	// still in flight) and clobbering fresher status with stale data.
	const reloadSeq = React.useRef(0);
	const reload = React.useCallback(async (r: string) => {
		const seq = ++reloadSeq.current;
		try {
			const [s, t] = await Promise.all([gitService.getStatus(r), gitService.getTotals(r)]);
			if (seq !== reloadSeq.current) { return; }
			setStatus(s);
			setTotals(t);
			setError(null);
		} catch (e: any) {
			if (seq !== reloadSeq.current) { return; }
			setError(String(e?.message ?? e));
		}
	}, [gitService]);

	React.useEffect(() => {
		if (!root) { return; }
		void reload(root);
		const sub = gitService.onDidChange(() => {
			void reload(root);
			setRefreshKey(k => k + 1);
		});
		return () => sub.dispose();
	}, [root, gitService, reload]);

	const manualRefresh = React.useCallback(() => {
		if (root) { void reload(root); setRefreshKey(k => k + 1); }
	}, [root, reload]);

	return { gitService, root, status, totals, error, refreshKey, manualRefresh };
};

/* ---------------------------------------------------------------------------- */

type CommitAction = 'branch-commit' | 'branch-commit-push' | 'commit-push' | 'commit' | 'commit-pr';

export const ChangesPanel = ({ openInWorkspace }: WorkspacePanelProps) => {
	const accessor = useAccessor();
	const notificationService = accessor.get('INotificationService');
	const openerService = accessor.get('IOpenerService');
	const dialogService = accessor.get('IDialogService');
	const workspaceContextService = accessor.get('IWorkspaceContextService');
	const doc = useConnectedDocument();
	const { gitService, root, status, totals, error, refreshKey, manualRefresh } = useGitStatus();

	const [busy, setBusy] = React.useState<string | null>(null);
	const [message, setMessage] = React.useState('');
	const [layout, setLayout] = React.useState<DiffLayout>('unified');
	const [wordWrap, setWordWrap] = React.useState(false);
	const [ignoreWhitespace, setIgnoreWhitespace] = React.useState(false);
	const [treeVisible, setTreeVisible] = React.useState(false);
	const [collapsedFiles, setCollapsedFiles] = React.useState<Set<string>>(new Set());
	const [statsByFile, setStatsByFile] = React.useState<Record<string, { added: number; removed: number }>>({});
	const [findOpen, setFindOpen] = React.useState(false);
	const [findText, setFindText] = React.useState('');
	const [activePath, setActivePath] = React.useState<string | null>(null);

	const [overflowOpen, setOverflowOpen] = React.useState(false);
	const [layoutSubOpen, setLayoutSubOpen] = React.useState(false);
	const [commitMenuOpen, setCommitMenuOpen] = React.useState(false);
	const [branchMenuOpen, setBranchMenuOpen] = React.useState(false);
	const [branches, setBranches] = React.useState<string[]>([]);

	const overflowRef = React.useRef<HTMLDivElement | null>(null);
	const commitRef = React.useRef<HTMLDivElement | null>(null);
	const branchRef = React.useRef<HTMLDivElement | null>(null);
	const listRef = React.useRef<HTMLDivElement | null>(null);
	const sectionRefs = React.useRef<Record<string, HTMLDivElement | null>>({});

	const repoName = React.useMemo(() => {
		const folder = workspaceContextService.getWorkspace().folders[0];
		return folder ? folder.name : (root ? splitPath(root).name : 'repo');
	}, [workspaceContextService, root]);

	const files = React.useMemo(() => (status?.files ?? []).slice().sort((a, b) => a.path.localeCompare(b.path)), [status]);
	const visibleFiles = React.useMemo(() => {
		const q = findText.trim().toLowerCase();
		return q ? files.filter(f => f.path.toLowerCase().includes(q)) : files;
	}, [files, findText]);
	const count = files.length;
	const allCollapsed = count > 0 && collapsedFiles.size >= count;
	const allFullyStaged = count > 0 && files.every(f => f.staged && !f.unstaged);
	const anyStaged = files.some(f => f.staged);
	const anyUnstaged = files.some(f => f.unstaged || f.untracked || !f.staged);

	const notifyResult = React.useCallback((label: string, ok: boolean, err?: string) => {
		if (!ok) { notificationService.error(`${label} failed: ${err ?? 'unknown error'}`); }
	}, [notificationService]);

	const run = React.useCallback(async (key: string, fn: () => Promise<void>) => {
		setBusy(key);
		try { await fn(); } finally { setBusy(null); }
	}, []);

	/* ------- close menus on outside click ------- */
	React.useEffect(() => {
		if (!overflowOpen && !commitMenuOpen && !branchMenuOpen) { return; }
		const onDown = (e: MouseEvent) => {
			const t = e.target as Node;
			if (overflowRef.current?.contains(t) || commitRef.current?.contains(t) || branchRef.current?.contains(t)) { return; }
			setOverflowOpen(false); setLayoutSubOpen(false); setCommitMenuOpen(false); setBranchMenuOpen(false);
		};
		const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOverflowOpen(false); setLayoutSubOpen(false); setCommitMenuOpen(false); setBranchMenuOpen(false); } };
		doc.addEventListener('mousedown', onDown, true);
		doc.addEventListener('keydown', onKey, true);
		return () => { doc.removeEventListener('mousedown', onDown, true); doc.removeEventListener('keydown', onKey, true); };
	}, [overflowOpen, commitMenuOpen, branchMenuOpen, doc]);

	/* ------- keyboard: ⌘F find, ⌘R refresh ------- */
	React.useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); setFindOpen(true); }
			if ((e.metaKey || e.ctrlKey) && e.key === 'r') { e.preventDefault(); manualRefresh(); }
		};
		doc.addEventListener('keydown', onKey);
		return () => doc.removeEventListener('keydown', onKey);
	}, [doc, manualRefresh]);

	/* ------- actions ------- */
	const toggleFile = (path: string) => setCollapsedFiles(prev => {
		const next = new Set(prev);
		if (next.has(path)) { next.delete(path); } else { next.add(path); }
		return next;
	});
	const collapseAll = () => setCollapsedFiles(allCollapsed ? new Set() : new Set(files.map(f => f.path)));
	const reportStats = React.useCallback((path: string, added: number, removed: number) => {
		setStatsByFile(prev => (prev[path]?.added === added && prev[path]?.removed === removed ? prev : { ...prev, [path]: { added, removed } }));
	}, []);

	const openInIDE = (f: GitFileChange) => root && voidOpenFileFn(URI.file(`${root}/${f.path}`), accessor);
	const openFileTab = (f: GitFileChange) => root && openInWorkspace('files', URI.file(`${root}/${f.path}`).toString());

	const toggleStage = (f: GitFileChange) => root && run(`stage:${f.path}`, async () => {
		const isStaged = f.staged && !f.unstaged;
		const res = isStaged ? await gitService.unstage(root, [f.path]) : await gitService.stage(root, [f.path]);
		notifyResult(isStaged ? 'Unstage' : 'Stage', res.ok, res.error);
	});
	const discardFile = (f: GitFileChange) => root && run(`discard:${f.path}`, async () => {
		const confirmed = await dialogService.confirm({ type: 'warning', message: `Discard changes to ${splitPath(f.path).name}?`, detail: 'This is irreversible.', primaryButton: 'Discard' });
		if (!confirmed.confirmed) { return; }
		const res = await gitService.discard(root, f.untracked ? [] : [f.path], f.untracked ? [f.path] : []);
		notifyResult('Discard', res.ok, res.error);
	});

	const stageAll = () => root && run('stageAll', async () => {
		if (allFullyStaged) {
			const res = await gitService.unstageAll(root);
			notifyResult('Unstage all', res.ok, res.error);
			if (res.ok) { gitService.refresh(); }
			return;
		}
		const res = await gitService.stageAll(root);
		notifyResult('Stage all', res.ok, res.error);
		if (res.ok) { gitService.refresh(); }
	});
	const discardAll = () => root && run('discardAll', async () => {
		const confirmed = await dialogService.confirm({ type: 'warning', message: 'Discard ALL changes in the working tree?', detail: 'This is irreversible.', primaryButton: 'Discard All' });
		if (!confirmed.confirmed) { return; }
		const tracked = files.filter(f => !f.untracked).map(f => f.path);
		const untracked = files.filter(f => f.untracked).map(f => f.path);
		const res = await gitService.discard(root, tracked, untracked);
		notifyResult('Discard all', res.ok, res.error);
	});

	const generateMessage = () => root && run('generate', async () => {
		setOverflowOpen(false);
		try {
			const msg = await gitService.generateCommitMessage(root);
			if (msg) { setMessage(msg); notificationService.info('Commit message generated.'); }
		} catch (e: any) {
			notificationService.error(`Generate message failed: ${String(e?.message ?? e)}`);
		}
	});

	const promptMessage = async (): Promise<string | null> => {
		const result = await dialogService.input({
			type: 'none', message: 'Commit message', primaryButton: 'Commit',
			inputs: [{ placeholder: 'Describe your changes', value: message }],
		});
		if (!result.confirmed) { return null; }
		const v = (result.values?.[0] ?? '').trim();
		return v || null;
	};
	const promptBranch = async (): Promise<string | null> => {
		const result = await dialogService.input({
			type: 'none', message: 'Create new branch', primaryButton: 'Create',
			inputs: [{ placeholder: 'feature/my-change' }],
		});
		if (!result.confirmed) { return null; }
		const v = (result.values?.[0] ?? '').trim();
		return v || null;
	};

	const doCommit = (action: CommitAction) => {
		setCommitMenuOpen(false);
		if (!root) { return; }
		run(`commit:${action}`, async () => {
			const msg = await promptMessage();
			if (!msg) { return; }
			setMessage('');

			if (action === 'branch-commit' || action === 'branch-commit-push') {
				const name = await promptBranch();
				if (!name) { return; }
				const b = await gitService.createBranch(root, name, true);
				if (!b.ok) { notifyResult('Create branch', false, b.error); return; }
			}
			// Commit staged; if nothing staged, stage everything first (commit-all).
			if (!files.some(f => f.staged)) {
				const s = await gitService.stageAll(root);
				if (!s.ok) { notifyResult('Stage all', false, s.error); return; }
			}
			const c = await gitService.commit(root, msg);
			if (!c.ok) { notifyResult('Commit', false, c.error); return; }

			if (action === 'commit-push' || action === 'branch-commit-push') {
				const needsUpstream = !status?.upstream || action !== 'commit-push';
				const p = await gitService.push(root, { setUpstream: needsUpstream });
				if (!p.ok) { notifyResult('Push', false, p.error); return; }
			}
			if (action === 'commit-pr') {
				const p = await gitService.push(root, { setUpstream: !status?.upstream });
				if (!p.ok) { notifyResult('Push', false, p.error); return; }
				const url = await gitService.getPullRequestUrl(root);
				if (url) { void openerService.open(URI.parse(url)); }
				else { notificationService.info('No GitHub remote found to open a pull request.'); }
				return;
			}
			notificationService.info(
				action === 'branch-commit-push' || action === 'commit-push'
					? 'Committed and pushed.'
					: action === 'branch-commit'
						? 'Branch created and committed.'
						: 'Committed.'
			);
		});
	};

	const openBranchMenu = async () => {
		if (!root) { return; }
		const willOpen = !branchMenuOpen;
		setBranchMenuOpen(willOpen);
		if (willOpen) { try { setBranches(await gitService.getBranches(root)); } catch { /* ignore */ } }
	};
	const checkoutBranch = (name: string) => root && run(`checkout:${name}`, async () => {
		setBranchMenuOpen(false);
		notifyResult('Checkout', (await gitService.checkoutBranch(root, name)).ok);
	});
	const createBranchFromMenu = () => root && run('newbranch', async () => {
		setBranchMenuOpen(false);
		const name = await promptBranch();
		if (!name) { return; }
		notifyResult('Create branch', (await gitService.createBranch(root, name, true)).ok);
	});

	const scrollToFile = (path: string) => {
		setActivePath(path);
		setCollapsedFiles(prev => { const n = new Set(prev); n.delete(path); return n; });
		requestAnimationFrame(() => sectionRefs.current[path]?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
	};

	/* ------- render ------- */
	if (root === undefined) {
		return <div className="agent-git-empty"><Loader2 size={20} className="agent-git-spin" /><div className="agent-git-empty-label">Loading…</div></div>;
	}
	if (root === null) {
		return (
			<div className="agent-git-empty">
				<GitBranch size={22} strokeWidth={1.5} className="agent-git-empty-icon" />
				<div className="agent-git-empty-label">Not a git repository</div>
				<div className="agent-git-empty-detail">Open a folder tracked by git to see and manage changes here.</div>
			</div>
		);
	}

	return (
		<div className="agent-git">
			{/* row 1 — scope / repo / branch / … / primary */}
			<div className="agent-git-topbar">
				<span className="agent-git-scope"><Monitor size={13} strokeWidth={1.75} /> Local</span>
				<span className="agent-git-repo">{repoName}</span>
				<div className="agent-git-branch-wrap" ref={branchRef}>
					<button type="button" className="agent-git-branch" onClick={openBranchMenu} title="Switch branch">
						<span className="agent-git-branch-name">{status?.branch ?? (status?.detachedHead ? status.detachedHead : '…')}</span>
						<ChevronDown size={11} strokeWidth={2} className="agent-git-branch-caret" />
					</button>
					{branchMenuOpen && (
						<div className="agent-git-menu" role="menu">
							<div className="agent-git-menu-item" role="menuitem" tabIndex={0} onClick={createBranchFromMenu}><GitBranch size={13} strokeWidth={2} className="agent-git-menu-lead" /><span className="agent-git-menu-label">Create new branch…</span></div>
							<div className="agent-git-menu-sep" />
							{branches.map(b => (
								<div key={b} className={`agent-git-menu-item${b === status?.branch ? ' active' : ''}`} role="menuitem" tabIndex={0} onClick={() => checkoutBranch(b)}>
									<GitBranch size={13} strokeWidth={1.5} className="agent-git-menu-lead" /><span className="agent-git-menu-label">{b}</span>{b === status?.branch && <Check size={13} strokeWidth={2.5} className="agent-git-menu-check" />}
								</div>
							))}
						</div>
					)}
				</div>
				<span className="agent-git-topbar-spacer" />
				<div className="agent-git-overflow-wrap" ref={overflowRef}>
					<button type="button" className="agent-git-iconbtn" title="More actions" aria-haspopup="menu" aria-expanded={overflowOpen} onClick={() => { setOverflowOpen(v => !v); setLayoutSubOpen(false); }}><MoreHorizontal size={16} strokeWidth={2} /></button>
					{overflowOpen && (
						<div className="agent-git-menu right wide" role="menu">
							<div
								className={`agent-git-menu-item has-sub${layoutSubOpen ? ' open' : ''}`}
								role="menuitem"
								tabIndex={0}
								aria-haspopup="menu"
								aria-expanded={layoutSubOpen}
								onClick={(e) => { e.stopPropagation(); setLayoutSubOpen(v => !v); }}
							>
								<span className="agent-git-menu-label">Layout</span>
								<span className="agent-git-menu-value">{layout === 'unified' ? 'Unified' : 'Split'} <ChevronRight size={12} strokeWidth={2} className={layoutSubOpen ? 'sub-chevron-open' : ''} /></span>
							</div>
							{layoutSubOpen && (
								<>
									<div className="agent-git-menu-item submenu-entry" role="menuitem" tabIndex={0} onClick={(e) => { e.stopPropagation(); setLayout('unified'); setOverflowOpen(false); setLayoutSubOpen(false); }}>
										<span className="agent-git-menu-label">Unified</span>{layout === 'unified' && <Check size={13} strokeWidth={2.5} className="agent-git-menu-check" />}
									</div>
									<div className="agent-git-menu-item submenu-entry" role="menuitem" tabIndex={0} onClick={(e) => { e.stopPropagation(); setLayout('split'); setOverflowOpen(false); setLayoutSubOpen(false); }}>
										<span className="agent-git-menu-label">Split</span>{layout === 'split' && <Check size={13} strokeWidth={2.5} className="agent-git-menu-check" />}
									</div>
								</>
							)}
							<div className="agent-git-menu-item" role="menuitemcheckbox" aria-checked={ignoreWhitespace} tabIndex={0} onClick={() => setIgnoreWhitespace(v => !v)}>
								<span className="agent-git-menu-label">Ignore Whitespace</span><span className={`agent-git-toggle${ignoreWhitespace ? ' on' : ''}`} aria-hidden="true" />
							</div>
							<div className="agent-git-menu-item" role="menuitemcheckbox" aria-checked={wordWrap} tabIndex={0} onClick={() => setWordWrap(v => !v)}>
								<span className="agent-git-menu-label">Word Wrap</span><span className={`agent-git-toggle${wordWrap ? ' on' : ''}`} aria-hidden="true" />
							</div>
							<div className="agent-git-menu-sep" />
							<div className="agent-git-menu-item" role="menuitem" tabIndex={0} onClick={() => { if (count === 0) { return; } stageAll(); setOverflowOpen(false); }} aria-disabled={count === 0}>
								<span className="agent-git-menu-label">{allFullyStaged ? 'Unstage All Changes' : 'Stage All Changes'}</span>
								<SquareCheckBig size={13} strokeWidth={1.75} className="agent-git-menu-trail" />
							</div>
							<div className="agent-git-menu-item" role="menuitem" tabIndex={0} onClick={() => { setFindOpen(true); setOverflowOpen(false); }}>
								<span className="agent-git-menu-label">Find in Changes</span><span className="agent-git-menu-kbd">⌘F</span>
							</div>
							<div className="agent-git-menu-item" role="menuitem" tabIndex={0} onClick={generateMessage}>
								<span className="agent-git-menu-label">Generate Commit Message</span><Sparkles size={13} strokeWidth={1.75} className="agent-git-menu-trail" />
							</div>
							<div className="agent-git-menu-item" role="menuitem" tabIndex={0} onClick={() => { collapseAll(); setOverflowOpen(false); }}>
								<span className="agent-git-menu-label">{allCollapsed ? 'Expand All' : 'Collapse All'}</span>
							</div>
							<div className="agent-git-menu-item" role="menuitem" tabIndex={0} onClick={() => { manualRefresh(); setOverflowOpen(false); }}>
								<span className="agent-git-menu-label">Refresh Changes</span><span className="agent-git-menu-kbd">⌘R</span>
							</div>
						</div>
					)}
				</div>
				<div className="agent-git-primary" ref={commitRef}>
					<button type="button" className="agent-git-primary-btn" onClick={() => doCommit('branch-commit')} disabled={!!busy || count === 0}>
						{busy?.startsWith('commit') ? <Loader2 size={13} className="agent-git-spin" /> : <GitCommitVertical size={14} strokeWidth={1.75} />}
						Create Branch &amp; Commit
					</button>
					<button type="button" className="agent-git-primary-caret" onClick={() => setCommitMenuOpen(v => !v)} disabled={count === 0}><ChevronDown size={13} strokeWidth={2} /></button>
					{commitMenuOpen && (
						<div className="agent-git-menu right" role="menu">
							<div className="agent-git-menu-item" role="menuitem" tabIndex={0} onClick={() => doCommit('branch-commit-push')}><span className="agent-git-menu-label">Create Branch, Commit &amp; Push</span></div>
							<div className="agent-git-menu-item" role="menuitem" tabIndex={0} onClick={() => doCommit('commit-push')}><span className="agent-git-menu-label">Commit &amp; Push</span></div>
							<div className="agent-git-menu-item" role="menuitem" tabIndex={0} onClick={() => doCommit('commit')}><span className="agent-git-menu-label">Commit</span></div>
							<div className="agent-git-menu-item" role="menuitem" tabIndex={0} onClick={() => doCommit('commit-pr')}><span className="agent-git-menu-label">Commit &amp; Create PR</span></div>
						</div>
					)}
				</div>
			</div>

			{/* row 2 — summary */}
			<div className="agent-git-summary">
				<span className="agent-git-summary-count">{count} Uncommitted Change{count === 1 ? '' : 's'}</span>
				<span className="agent-git-summary-totals">
					{totals.added > 0 && <span className="add">+{totals.added}</span>}
					{totals.removed > 0 && <span className="del">-{totals.removed}</span>}
				</span>
				<span className="agent-git-topbar-spacer" />
				<button
					type="button"
					className={`agent-git-stageall${allFullyStaged ? ' on' : ''}${anyStaged && anyUnstaged ? ' partial' : ''}`}
					title={allFullyStaged ? 'Unstage all changes' : 'Stage all changes'}
					aria-pressed={allFullyStaged}
					onClick={stageAll}
					disabled={count === 0 || busy === 'stageAll'}
				>
					<span className="agent-git-stageall-box" aria-hidden="true">
						{allFullyStaged ? <Check size={11} strokeWidth={3} /> : (anyStaged && anyUnstaged) ? <span className="agent-git-check-dash" /> : null}
					</span>
					<span className="agent-git-stageall-label">{allFullyStaged ? 'Unstage All' : 'Stage All'}</span>
				</button>
				<button type="button" className="agent-git-iconbtn" title="Refresh" onClick={manualRefresh} disabled={busy === 'stageAll'}><RefreshCw size={13} strokeWidth={1.75} /></button>
				<button type="button" className="agent-git-iconbtn danger" title="Discard all changes" onClick={discardAll} disabled={count === 0}><Undo2 size={13} strokeWidth={1.75} /></button>
				<button type="button" className={`agent-git-iconbtn${allCollapsed ? ' active' : ''}`} title={allCollapsed ? 'Expand all' : 'Collapse all'} onClick={collapseAll}><ChevronsDownUp size={14} strokeWidth={1.75} /></button>
				<button type="button" className={`agent-git-iconbtn${treeVisible ? ' active' : ''}`} title="Toggle file tree" onClick={() => setTreeVisible(v => !v)}><PanelRight size={14} strokeWidth={1.75} /></button>
			</div>

			{findOpen && (
				<div className="agent-git-find">
					<Search size={13} strokeWidth={1.75} />
					<input autoFocus className="agent-git-find-input" placeholder="Find files in changes…" value={findText} onChange={(e) => setFindText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { setFindOpen(false); setFindText(''); } }} />
					<button type="button" className="agent-git-iconbtn sm" title="Close" onClick={() => { setFindOpen(false); setFindText(''); }}><X size={13} strokeWidth={2} /></button>
				</div>
			)}

			{error && <div className="agent-git-error">{error}</div>}

			<div className="agent-git-body">
				<div className="agent-git-difflist" ref={listRef}>
					{count === 0 && !error && (
						<div className="agent-git-clean"><Check size={18} strokeWidth={1.75} /> No uncommitted changes</div>
					)}
					{visibleFiles.map(f => (
						<FileDiffSection
							key={f.path}
							ref={(el) => { sectionRefs.current[f.path] = el; }}
							f={f}
							root={root}
							accessor={accessor}
							collapsed={collapsedFiles.has(f.path)}
							active={activePath === f.path}
							stats={statsByFile[f.path]}
							refreshKey={refreshKey}
							layout={layout}
							wordWrap={wordWrap}
							ignoreWhitespace={ignoreWhitespace}
							onToggle={() => toggleFile(f.path)}
							onStats={(a, r) => reportStats(f.path, a, r)}
							onOpenTab={() => openFileTab(f)}
							onOpenIDE={() => openInIDE(f)}
							onToggleStage={() => toggleStage(f)}
							onDiscard={() => discardFile(f)}
							onChanged={manualRefresh}
						/>
					))}
				</div>

				{treeVisible && count > 0 && (
					<aside className="agent-git-tree-pane" aria-label="Changed files">
						<ChangesTree files={files} root={root} activePath={activePath} onSelect={scrollToFile} />
					</aside>
				)}
			</div>
		</div>
	);
};

/* ---------------------------------------------------------------------------- */

const FileDiffSection = React.forwardRef<HTMLDivElement, {
	f: GitFileChange;
	root: string;
	accessor: ReturnType<typeof useAccessor>;
	collapsed: boolean;
	active: boolean;
	stats?: { added: number; removed: number };
	refreshKey: number;
	layout: DiffLayout;
	wordWrap: boolean;
	ignoreWhitespace: boolean;
	onToggle: () => void;
	onStats: (added: number, removed: number) => void;
	onOpenTab: () => void;
	onOpenIDE: () => void;
	onToggleStage: () => void;
	onDiscard: () => void;
	onChanged: () => void;
}>((props, ref) => {
	const { f, root, collapsed, active, stats, refreshKey, layout, wordWrap, ignoreWhitespace,
		onToggle, onStats, onOpenTab, onToggleStage, onDiscard, onChanged } = props;
	const badge = badgeFor(f);
	const { name, dir } = splitPath(f.path);
	const fileUri = URI.file(`${root}/${f.path}`);
	const staged = f.staged && !f.unstaged;
	const partial = f.staged && f.unstaged;
	const side = (f.unstaged || f.untracked) ? 'unstaged' : 'staged';

	return (
		<div className={`agent-git-file${active ? ' active' : ''}`} ref={ref}>
			<div className="agent-git-file-head">
				<button type="button" className="agent-git-file-expand" onClick={onToggle} title={collapsed ? 'Expand' : 'Collapse'}>
					{collapsed ? <ChevronRight size={13} strokeWidth={2} /> : <ChevronDown size={13} strokeWidth={2} />}
				</button>
				<button type="button" className="agent-git-file-name" onClick={onOpenTab} title={f.path}>
					<span className="agent-git-file-icon"><VsCodeFileIcon uri={fileUri} filename={name} size={14} /></span>
					<span className="agent-git-file-basename">{name}</span>
					{dir && <span className="agent-git-file-dir">{dir}</span>}
				</button>
				{stats && (stats.added > 0 || stats.removed > 0) && (
					<span className="agent-git-file-stats">
						{stats.added > 0 && <span className="add">+{stats.added}</span>}
						{stats.removed > 0 && <span className="del">-{stats.removed}</span>}
					</span>
				)}
				<div className="agent-git-file-actions">
					<button type="button" className="agent-git-iconbtn sm danger" title="Discard file" onClick={onDiscard}><Undo2 size={12} strokeWidth={1.75} /></button>
				</div>
				<button
					type="button"
					className={`agent-git-check${staged ? ' on' : ''}${partial ? ' partial' : ''}`}
					title={staged ? 'Unstage file' : 'Stage file'}
					aria-pressed={staged}
					onClick={onToggleStage}
				>
					{staged ? <Check size={12} strokeWidth={3} /> : partial ? <span className="agent-git-check-dash" /> : null}
				</button>
				<span className={`agent-git-file-badge ${badge.kind === 'add' ? 'add' : badge.kind === 'del' ? 'del' : badge.kind === 'mod' ? 'mod' : badge.kind === 'rename' ? 'rename' : badge.kind === 'conflict' ? 'conflict' : 'untracked'}`} title={badge.label}>{badge.letter}</span>
			</div>
			{!collapsed && (
				<div className="agent-git-file-diff">
					<GitDiffView
						root={root}
						file={f.path}
						staged={side === 'staged'}
						untracked={side === 'unstaged' && f.untracked}
						refreshKey={refreshKey}
						layout={layout}
						wordWrap={wordWrap}
						ignoreWhitespace={ignoreWhitespace}
						onStats={onStats}
						onChanged={onChanged}
					/>
				</div>
			)}
		</div>
	);
});
