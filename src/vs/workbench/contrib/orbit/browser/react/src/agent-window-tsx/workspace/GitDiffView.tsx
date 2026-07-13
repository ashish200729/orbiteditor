/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as React from 'react';
import { ChevronDown, ChevronUp, Plus, Minus, Undo2 } from 'lucide-react';
import { useAccessor } from '../../util/services.js';
import { useConnectedWindow } from '../../sidebar-tsx/contexts/ConnectedWindowContext.js';
import { buildHunkPatch, diffStats, DiffHunk, DiffRow, parseUnifiedDiff, ParsedDiff } from './gitDiff.js';

const EXPAND_STEP = 20;

export type DiffLayout = 'unified' | 'split';

interface GitDiffViewProps {
	root: string;
	file: string;
	/** Diff the staged (index) side rather than the working tree. */
	staged: boolean;
	untracked: boolean;
	/** Bumped by the parent to force a re-fetch after external changes. */
	refreshKey: number;
	/** Called after a hunk-level stage/unstage/discard so the panel reloads. */
	onChanged: () => void;
	layout?: DiffLayout;
	wordWrap?: boolean;
	ignoreWhitespace?: boolean;
	/** Reports total +added / -removed once the diff parses. */
	onStats?: (added: number, removed: number) => void;
}

interface BandReveal { top: number; bottom: number }

const hunkAdvance = (hunk: DiffHunk): { old: number; new: number } => {
	let o = 0;
	let n = 0;
	for (const r of hunk.rows) {
		if (r.type === 'context') { o++; n++; }
		else if (r.type === 'del') { o++; }
		else { n++; }
	}
	return { old: o, new: n };
};

type Segment =
	| { kind: 'band'; id: string; oldFrom: number; newFrom: number; count: number }
	| { kind: 'hunk'; hunk: DiffHunk; index: number };

export const GitDiffView = ({
	root, file, staged, untracked, refreshKey, onChanged,
	layout = 'unified', wordWrap = false, ignoreWhitespace = false, onStats,
}: GitDiffViewProps) => {
	const accessor = useAccessor();
	const gitService = accessor.get('IAgentGitService');
	const notificationService = accessor.get('INotificationService');
	// This panel is portaled into the pop-out Agent Window; the bare global
	// `IntersectionObserver`/`window` resolve to the MAIN window's realm, whose
	// document doesn't contain this element, so the observer would never fire
	// and lazy diffs would never load in the pop-out. Use the window this
	// subtree is actually connected to instead.
	const connectedWindow = useConnectedWindow();

	const hostRef = React.useRef<HTMLDivElement | null>(null);
	const [visible, setVisible] = React.useState(false);
	const [parsed, setParsed] = React.useState<ParsedDiff | null>(null);
	const [fileLines, setFileLines] = React.useState<string[] | null>(null);
	const [loading, setLoading] = React.useState(true);
	const [error, setError] = React.useState<string | null>(null);
	const [reveals, setReveals] = React.useState<Record<string, BandReveal>>({});
	const [busyHunk, setBusyHunk] = React.useState<number | null>(null);
	const onStatsRef = React.useRef(onStats);
	onStatsRef.current = onStats;

	// Lazy fetch: only load once the section scrolls near the viewport. With 70
	// files stacked, this avoids firing 70 git diffs at once.
	React.useEffect(() => {
		const el = hostRef.current;
		if (!el || visible) { return; }
		let cancelled = false;
		const mark = () => {
			if (!cancelled) { setVisible(true); }
		};
		const IO = connectedWindow.IntersectionObserver ?? IntersectionObserver;
		const io = new IO((entries: IntersectionObserverEntry[]) => {
			if (entries.some(e => e.isIntersecting || e.intersectionRatio > 0)) {
				mark();
				io.disconnect();
			}
		}, { root: null, rootMargin: '1200px 0px', threshold: 0 });
		io.observe(el);
		// Immediate check for first-paint items (IO can miss after layout recovery).
		connectedWindow.requestAnimationFrame(() => {
			if (cancelled) { return; }
			const rect = el.getBoundingClientRect();
			const viewH = connectedWindow.innerHeight ?? 2000;
			if (rect.bottom >= -1200 && rect.top <= viewH + 1200) {
				mark();
				io.disconnect();
			}
		});
		return () => { cancelled = true; io.disconnect(); };
	}, [visible, connectedWindow]);

	React.useEffect(() => {
		if (!visible) { return; }
		let cancelled = false;
		setLoading(true);
		setError(null);
		setReveals({});
		(async () => {
			try {
				const diff = await gitService.getDiff(root, { file, staged, untracked, contextLines: 3, ignoreWhitespace });
				if (cancelled) { return; }
				const p = parseUnifiedDiff(diff);
				setParsed(p);
				const st = diffStats(p);
				onStatsRef.current?.(st.added, st.removed);
				if (!p.isBinary) {
					const content = await gitService.getFileContent(root, file, staged);
					if (!cancelled) {
						setFileLines(content.length ? content.split('\n') : []);
					}
				} else {
					setFileLines(null);
				}
			} catch (e: any) {
				if (!cancelled) { setError(String(e?.message ?? e)); }
			} finally {
				if (!cancelled) { setLoading(false); }
			}
		})();
		return () => { cancelled = true; };
	}, [gitService, root, file, staged, untracked, refreshKey, ignoreWhitespace, visible]);

	const segments = React.useMemo<Segment[]>(() => {
		if (!parsed) { return []; }
		const segs: Segment[] = [];
		let prevOldEnd = 1;
		let prevNewEnd = 1;
		parsed.hunks.forEach((hunk, index) => {
			const gap = hunk.newStart - prevNewEnd;
			if (gap > 0) {
				segs.push({ kind: 'band', id: `b${index}`, oldFrom: prevOldEnd, newFrom: prevNewEnd, count: gap });
			}
			segs.push({ kind: 'hunk', hunk, index });
			const adv = hunkAdvance(hunk);
			prevOldEnd = hunk.oldStart + adv.old;
			prevNewEnd = hunk.newStart + adv.new;
		});
		if (fileLines) {
			const total = fileLines.length;
			const trailing = total - prevNewEnd + 1;
			if (trailing > 0) {
				segs.push({ kind: 'band', id: 'btail', oldFrom: prevOldEnd, newFrom: prevNewEnd, count: trailing });
			}
		}
		return segs;
	}, [parsed, fileLines]);

	const applyHunk = React.useCallback(async (hunk: DiffHunk, index: number, action: 'stage' | 'unstage' | 'discard') => {
		if (!parsed) { return; }
		setBusyHunk(index);
		try {
			const patch = buildHunkPatch(parsed, hunk);
			const res = action === 'stage' ? await gitService.applyPatch(root, patch, { cached: true })
				: action === 'unstage' ? await gitService.applyPatch(root, patch, { cached: true, reverse: true })
					: await gitService.applyPatch(root, patch, { reverse: true });
			// `git apply` can reject a hunk (context mismatch, already-applied,
			// etc.) — without this check the UI silently no-ops and the user has
			// no idea their stage/discard click did nothing.
			if (!res.ok) {
				notificationService.error(`${action[0].toUpperCase()}${action.slice(1)} hunk failed: ${res.error ?? 'git apply rejected the change'}`);
			}
			onChanged();
		} finally {
			setBusyHunk(null);
		}
	}, [parsed, gitService, root, onChanged, notificationService]);

	return (
		<div className={`agent-git-diff${layout === 'split' ? ' split' : ''}${wordWrap ? ' wrap' : ''}`} ref={hostRef}>
			{!visible || loading ? (
				<div className="agent-git-diff-status">Loading diff…</div>
			) : error ? (
				<div className="agent-git-diff-status error">{error}</div>
			) : !parsed || parsed.isEmpty ? (
				<div className="agent-git-diff-status">No changes to display.</div>
			) : parsed.isBinary ? (
				<div className="agent-git-diff-status">Binary file — not shown.</div>
			) : (
				segments.map(seg => {
					if (seg.kind === 'band') {
						return (
							<Band
								key={seg.id}
								seg={seg}
								split={layout === 'split'}
								reveal={reveals[seg.id] ?? { top: 0, bottom: 0 }}
								fileLines={fileLines}
								onReveal={(next) => setReveals(prev => ({ ...prev, [seg.id]: next }))}
							/>
						);
					}
					return (
						<Hunk
							key={`h${seg.index}`}
							hunk={seg.hunk}
							split={layout === 'split'}
							staged={staged}
							untracked={untracked}
							busy={busyHunk === seg.index}
							// A "-w" diff's context lines reflect whitespace that no longer
							// matches the real file, so `git apply` on a hunk built from it
							// can reject or mis-apply. Force whole-file stage/discard instead.
							disabledReason={ignoreWhitespace ? 'Turn off Ignore Whitespace to stage/discard individual hunks' : undefined}
							onAction={(action) => applyHunk(seg.hunk, seg.index, action)}
						/>
					);
				})
			)}
		</div>
	);
};

/* ---------------- unified rows ---------------- */

const LineRow = ({ row }: { row: DiffRow }) => {
	const marker = row.type === 'add' ? '+' : row.type === 'del' ? '-' : '';
	return (
		<div className={`agent-git-diff-row ${row.type === 'add' ? 'add' : row.type === 'del' ? 'del' : 'ctx'}`}>
			<span className="agent-git-diff-ln">{row.oldLine ?? ''}</span>
			<span className="agent-git-diff-ln">{row.newLine ?? ''}</span>
			<span className="agent-git-diff-marker" aria-hidden="true">{marker}</span>
			<span className="agent-git-diff-code">{row.content === '' ? ' ' : row.content}</span>
		</div>
	);
};

/* ---------------- split rows ---------------- */

interface SplitRow {
	left?: { ln: number; content: string; type: 'context' | 'del' };
	right?: { ln: number; content: string; type: 'context' | 'add' };
}

const toSplitRows = (rows: DiffRow[]): SplitRow[] => {
	const out: SplitRow[] = [];
	let i = 0;
	while (i < rows.length) {
		const r = rows[i];
		if (r.type === 'context') {
			out.push({
				left: { ln: r.oldLine!, content: r.content, type: 'context' },
				right: { ln: r.newLine!, content: r.content, type: 'context' },
			});
			i++;
			continue;
		}
		// gather a run of del then add
		const dels: DiffRow[] = [];
		const adds: DiffRow[] = [];
		while (i < rows.length && rows[i].type === 'del') { dels.push(rows[i]); i++; }
		while (i < rows.length && rows[i].type === 'add') { adds.push(rows[i]); i++; }
		const n = Math.max(dels.length, adds.length);
		for (let k = 0; k < n; k++) {
			const d = dels[k];
			const a = adds[k];
			out.push({
				left: d ? { ln: d.oldLine!, content: d.content, type: 'del' } : undefined,
				right: a ? { ln: a.newLine!, content: a.content, type: 'add' } : undefined,
			});
		}
	}
	return out;
};

const SplitLineRow = ({ row }: { row: SplitRow }) => (
	<div className="agent-git-split-row">
		<div className={`agent-git-split-cell ${!row.left ? 'empty' : row.left.type === 'del' ? 'del' : 'ctx'}`}>
			<span className="agent-git-diff-ln">{row.left?.ln ?? ''}</span>
			<span className="agent-git-split-code">{row.left ? (row.left.content === '' ? ' ' : row.left.content) : ''}</span>
		</div>
		<div className={`agent-git-split-cell ${!row.right ? 'empty' : row.right.type === 'add' ? 'add' : 'ctx'}`}>
			<span className="agent-git-diff-ln">{row.right?.ln ?? ''}</span>
			<span className="agent-git-split-code">{row.right ? (row.right.content === '' ? ' ' : row.right.content) : ''}</span>
		</div>
	</div>
);

const Hunk = ({
	hunk, split, staged, untracked, busy, disabledReason, onAction,
}: {
	hunk: DiffHunk;
	split: boolean;
	staged: boolean;
	untracked: boolean;
	busy: boolean;
	disabledReason?: string;
	onAction: (action: 'stage' | 'unstage' | 'discard') => void;
}) => {
	const splitRows = React.useMemo(() => (split ? toSplitRows(hunk.rows) : []), [split, hunk.rows]);
	const disabled = !!disabledReason;
	return (
		<div className={`agent-git-diff-hunk${busy ? ' busy' : ''}`}>
			{!untracked && (
				<div className="agent-git-diff-hunk-actions" role="toolbar" aria-label={staged ? 'Unstage hunk' : 'Stage hunk'}>
					{staged ? (
						<button type="button" className="agent-git-hunk-btn unstage" title={disabledReason ?? 'Unstage hunk'} disabled={disabled} onClick={() => onAction('unstage')}>
							<Minus size={12} strokeWidth={2.25} />
							<span>Unstage</span>
						</button>
					) : (
						<>
							<button type="button" className="agent-git-hunk-btn stage" title={disabledReason ?? 'Stage hunk'} disabled={disabled} onClick={() => onAction('stage')}>
								<Plus size={12} strokeWidth={2.25} />
								<span>Stage</span>
							</button>
							<button type="button" className="agent-git-hunk-btn danger" title={disabledReason ?? 'Discard hunk'} disabled={disabled} onClick={() => onAction('discard')}>
								<Undo2 size={12} strokeWidth={2.25} />
								<span>Discard</span>
							</button>
						</>
					)}
				</div>
			)}
			{split
				? splitRows.map((r, i) => <SplitLineRow key={i} row={r} />)
				: hunk.rows.map((row, i) => <LineRow key={i} row={row} />)}
		</div>
	);
};

const Band = ({
	seg, split, reveal, fileLines, onReveal,
}: {
	seg: { kind: 'band'; id: string; oldFrom: number; newFrom: number; count: number };
	split: boolean;
	reveal: BandReveal;
	fileLines: string[] | null;
	onReveal: (next: BandReveal) => void;
}) => {
	const remaining = seg.count - reveal.top - reveal.bottom;
	const lineAt = (newLine: number): DiffRow => ({
		type: 'context',
		oldLine: seg.oldFrom + (newLine - seg.newFrom),
		newLine,
		content: fileLines ? (fileLines[newLine - 1] ?? '') : '',
	});

	const topRows: DiffRow[] = [];
	for (let k = 0; k < reveal.top; k++) { topRows.push(lineAt(seg.newFrom + k)); }
	const bottomRows: DiffRow[] = [];
	for (let k = reveal.bottom; k > 0; k--) { bottomRows.push(lineAt(seg.newFrom + seg.count - k)); }

	const canExpand = !!fileLines;
	const expandDown = () => onReveal({ ...reveal, top: Math.min(reveal.top + EXPAND_STEP, seg.count - reveal.bottom) });
	const expandUp = () => onReveal({ ...reveal, bottom: Math.min(reveal.bottom + EXPAND_STEP, seg.count - reveal.top) });
	const expandAll = () => onReveal({ top: seg.count, bottom: 0 });

	const renderCtx = (r: DiffRow, key: string) => split
		? <SplitLineRow key={key} row={{ left: { ln: r.oldLine!, content: r.content, type: 'context' }, right: { ln: r.newLine!, content: r.content, type: 'context' } }} />
		: <LineRow key={key} row={r} />;

	return (
		<>
			{topRows.map((r, i) => renderCtx(r, `t${i}`))}
			{remaining > 0 && (
				<div className="agent-git-diff-band">
					{canExpand && (
						<span className="agent-git-diff-band-chevrons">
							<button type="button" title="Expand down" onClick={expandDown}><ChevronDown size={12} strokeWidth={2} /></button>
							<button type="button" title="Expand up" onClick={expandUp}><ChevronUp size={12} strokeWidth={2} /></button>
						</span>
					)}
					<button
						type="button"
						className="agent-git-diff-band-label"
						onClick={canExpand ? expandAll : undefined}
						title={canExpand ? 'Expand all' : undefined}
						style={{ cursor: canExpand ? 'pointer' : 'default' }}
					>
						{remaining} unmodified line{remaining === 1 ? '' : 's'}
					</button>
				</div>
			)}
			{bottomRows.map((r, i) => renderCtx(r, `b${i}`))}
		</>
	);
};
