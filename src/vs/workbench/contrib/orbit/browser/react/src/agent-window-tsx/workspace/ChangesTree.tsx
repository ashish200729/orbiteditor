/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { URI } from '../../../../../../../../base/common/uri.js';
import { VsCodeFileIcon } from '../../sidebar-tsx/utils/fileIcons.js';
import type { GitFileChange } from '../../../../../common/orbitSCMTypes.js';
import { badgeFor } from './ChangesPanel.js';

/**
 * Compact folder tree of the changed files, shown on the right of the diff
 * column (toggleable) — mirrors the main-window Changes explorer. Collapses
 * single-child folder chains (`a › b › c`) like VS Code's compact folders.
 */

interface TreeNode {
	name: string;
	/** Full repo-relative path for files; folder path for folders. */
	path: string;
	isFile: boolean;
	change?: GitFileChange;
	children: Map<string, TreeNode>;
}

const buildTree = (files: GitFileChange[]): TreeNode => {
	const root: TreeNode = { name: '', path: '', isFile: false, children: new Map() };
	for (const f of files) {
		const parts = f.path.split('/');
		let node = root;
		let acc = '';
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			acc = acc ? `${acc}/${part}` : part;
			const isFile = i === parts.length - 1;
			let child = node.children.get(part);
			if (!child) {
				child = { name: part, path: acc, isFile, change: isFile ? f : undefined, children: new Map() };
				node.children.set(part, child);
			}
			node = child;
		}
	}
	return root;
};

/** Collapse folder chains with a single folder child into one row. */
const compact = (node: TreeNode): { label: string; node: TreeNode } => {
	let label = node.name;
	let cur = node;
	while (!cur.isFile && cur.children.size === 1) {
		const only = [...cur.children.values()][0];
		if (only.isFile) { break; }
		label = `${label}/${only.name}`;
		cur = only;
	}
	return { label, node: cur };
};

const sortedChildren = (node: TreeNode): TreeNode[] => {
	return [...node.children.values()].sort((a, b) => {
		if (a.isFile !== b.isFile) { return a.isFile ? 1 : -1; }
		return a.name.localeCompare(b.name);
	});
};

const Row = ({
	node, depth, root, activePath, collapsed, onToggle, onSelect,
}: {
	node: TreeNode;
	depth: number;
	root: string;
	activePath: string | null;
	collapsed: Set<string>;
	onToggle: (path: string) => void;
	onSelect: (path: string) => void;
}) => {
	if (node.isFile) {
		const f = node.change!;
		// Same helper as the diff list header so the two badges never disagree
		// (they used different staged/worktree precedence before).
		const badge = badgeFor(f);
		const uri = URI.file(`${root}/${f.path}`);
		return (
			<button
				type="button"
				className={`agent-git-tree-row file${activePath === f.path ? ' active' : ''}`}
				style={{ paddingLeft: `${8 + depth * 12}px` }}
				title={f.path}
				onClick={() => onSelect(f.path)}
			>
				<span className="agent-git-tree-icon"><VsCodeFileIcon uri={uri} filename={node.name} size={14} /></span>
				<span className="agent-git-tree-name">{node.name}</span>
				<span className={`agent-git-tree-badge ${badge.kind === 'add' ? 'add' : badge.kind === 'del' ? 'del' : badge.kind === 'mod' ? 'mod' : badge.kind === 'rename' ? 'rename' : badge.kind === 'conflict' ? 'conflict' : 'untracked'}`}>{badge.letter}</span>
			</button>
		);
	}

	const { label, node: folder } = compact(node);
	const isCollapsed = collapsed.has(folder.path);
	return (
		<>
			<button
				type="button"
				className="agent-git-tree-row folder"
				style={{ paddingLeft: `${8 + depth * 12}px` }}
				onClick={() => onToggle(folder.path)}
			>
				{isCollapsed ? <ChevronRight size={13} strokeWidth={2} /> : <ChevronDown size={13} strokeWidth={2} />}
				<span className="agent-git-tree-foldername">{label}</span>
			</button>
			{!isCollapsed && sortedChildren(folder).map(child => (
				<Row
					key={child.path}
					node={child}
					depth={depth + 1}
					root={root}
					activePath={activePath}
					collapsed={collapsed}
					onToggle={onToggle}
					onSelect={onSelect}
				/>
			))}
		</>
	);
};

export const ChangesTree = ({
	files, root, activePath, onSelect,
}: {
	files: GitFileChange[];
	root: string;
	activePath: string | null;
	onSelect: (path: string) => void;
}) => {
	const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
	const tree = React.useMemo(() => buildTree(files), [files]);
	const toggle = React.useCallback((path: string) => {
		setCollapsed(prev => {
			const next = new Set(prev);
			if (next.has(path)) { next.delete(path); } else { next.add(path); }
			return next;
		});
	}, []);

	return (
		<div className="agent-git-tree">
			{sortedChildren(tree).map(child => (
				<Row
					key={child.path}
					node={child}
					depth={0}
					root={root}
					activePath={activePath}
					collapsed={collapsed}
					onToggle={toggle}
					onSelect={onSelect}
				/>
			))}
		</div>
	);
};
