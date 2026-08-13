/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { Copy, Plus, Search, Trash2, X } from 'lucide-react';
import { useAccessor, useChatThreadsState, useRunningThreadIds, useIsDark } from '../../../util/services.js';
import { IsRunningType, ThreadType } from '../../../../../chatThreadService.js';
import { getConnectedDocument } from '../../contexts/ConnectedWindowContext.js';
import { focusInConnectedWindow } from '../../../util/helpers.js';
import { RunnerThreadCloudIcon } from '../runner/RunnerThreadCloudIcon.js';
import { ThreadStatusIcon } from '../../../util/ThreadStatusIcon.js';

type ThreadHistoryDropdownProps = {
	onClose: () => void;
};

const getDateBucket = (ts: number): string => {
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const yesterday = today - 86400000;

	if (ts >= today) { return 'Today'; }
	if (ts >= yesterday) { return 'Yesterday'; }
	return 'Older';
};

const BUCKET_ORDER = ['Today', 'Yesterday', 'Older'];

export const ThreadHistoryDropdown = ({ onClose }: ThreadHistoryDropdownProps) => {
	const [search, setSearch] = useState('');
	const searchInputRef = useRef<HTMLInputElement>(null);
	const dropdownRef = useRef<HTMLDivElement>(null);

	const isDark = useIsDark();
	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');
	const { allThreads, currentThreadId } = useChatThreadsState();
	const runningThreadIds = useRunningThreadIds();

	useEffect(() => {
		focusInConnectedWindow(searchInputRef.current);
	}, []);

	// Close on outside click — bind to the document the dropdown is actually painted in
	// (the pop-out when hosted there), otherwise clicks in the pop-out never reach this listener.
	useEffect(() => {
		const doc = getConnectedDocument(dropdownRef.current);
		const handleClick = (e: MouseEvent) => {
			if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
				onClose();
			}
		};
		doc.addEventListener('mousedown', handleClick, true);
		return () => doc.removeEventListener('mousedown', handleClick, true);
	}, [onClose]);

	// Close on Escape
	useEffect(() => {
		const doc = getConnectedDocument(dropdownRef.current);
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				onClose();
			}
		};
		doc.addEventListener('keydown', handleKeyDown);
		return () => doc.removeEventListener('keydown', handleKeyDown);
	}, [onClose]);

	const sortedThreads = useMemo(() => {
		if (!allThreads) { return []; }

		return Object.values(allThreads)
			.filter(t => t && t.sessionKind !== 'side-chat' && t.messages.length > 0)
			.sort((a, b) => (b!.lastModified ?? 0) - (a!.lastModified ?? 0)) as ThreadType[];
	}, [allThreads]);

	const filtered = useMemo(() => {
		if (!search.trim()) { return sortedThreads; }

		return sortedThreads.filter(t => {
			const firstUser = t.messages.find(m => m.role === 'user');
			const title = (firstUser?.role === 'user' && firstUser.displayContent) || '';
			return title.toLowerCase().includes(search.toLowerCase());
		});
	}, [sortedThreads, search]);

	const grouped = useMemo(() => {
		const groups: Record<string, ThreadType[]> = {};
		for (const t of filtered) {
			const bucket = getDateBucket(t.lastModified ?? 0);
			if (!groups[bucket]) { groups[bucket] = []; }
			groups[bucket].push(t);
		}
		return groups;
	}, [filtered]);

	const handleNewAgent = useCallback(() => {
		chatThreadsService.openNewThread({ forceNew: true });
		void chatThreadsService.focusSelectedChat(false);
		onClose();
	}, [chatThreadsService, onClose]);

	return (
		<div className={`@@void-scope ${isDark ? 'dark' : ''}`} style={{ width: '100%', height: '100%' }}>
			<div
				ref={dropdownRef}
				style={{
					display: 'flex',
					flexDirection: 'column',
					width: 280,
					maxHeight: 400,
					overflow: 'hidden',
					borderRadius: 6,
					boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
					background: 'var(--vscode-sideBar-background)',
					color: 'var(--vscode-foreground)',
					border: '1px solid var(--vscode-widget-border)',
				}}
			>
				{/* Search */}
				<div style={{ padding: '8px 12px', borderBottom: '1px solid var(--vscode-widget-border)' }}>
					<div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', background: 'var(--vscode-input-background)', borderRadius: 4 }}>
						<Search size={14} style={{ color: 'var(--vscode-descriptionForeground)', flexShrink: 0 }} />
						<input
							ref={searchInputRef}
							type="text"
							value={search}
							onChange={e => setSearch(e.target.value)}
							placeholder="Search Agents..."
							style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: 12, color: 'var(--vscode-foreground)' }}
						/>
						{search && (
							<button onClick={() => setSearch('')} style={{ cursor: 'pointer', flexShrink: 0, background: 'none', border: 'none', padding: 0 }}>
								<X size={12} style={{ color: 'var(--vscode-descriptionForeground)' }} />
							</button>
						)}
					</div>
				</div>

				{/* Thread list */}
				<div style={{ flex: 1, overflowY: 'auto', maxHeight: 320 }}>
					{filtered.length === 0 ? (
						<div style={{ padding: '16px 12px', fontSize: 12, textAlign: 'center', color: 'var(--vscode-descriptionForeground)' }}>
							{search ? 'No agents found' : 'No agents yet'}
						</div>
					) : (
						BUCKET_ORDER.filter(b => grouped[b]?.length).map(bucket => (
							<div key={bucket}>
								<div style={{ padding: '6px 12px 4px', fontSize: 10, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--vscode-descriptionForeground)', userSelect: 'none' }}>
									{bucket}
								</div>
								{grouped[bucket].map(thread => (
									<ThreadItem
										key={thread.id}
										thread={thread}
										isActive={thread.id === currentThreadId}
										isRunning={runningThreadIds[thread.id]}
										onSelect={() => {
											chatThreadsService.switchToThread(thread.id);
											onClose();
										}}
									/>
								))}
							</div>
						))
					)}
				</div>

				{/* New Agent button */}
				<div style={{ padding: '8px 12px', borderTop: '1px solid var(--vscode-widget-border)' }}>
					<button
						onClick={handleNewAgent}
						style={{
							display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
							width: '100%', padding: '6px 12px', fontSize: 12,
							color: 'var(--vscode-foreground)', background: 'none',
							border: 'none', borderRadius: 4, cursor: 'pointer',
						}}
						onMouseEnter={e => (e.currentTarget.style.background = 'var(--vscode-list-hoverBackground)')}
						onMouseLeave={e => (e.currentTarget.style.background = 'none')}
					>
						<Plus size={14} />
						<span>New Agent</span>
					</button>
				</div>
			</div>
		</div>
	);
};


const ThreadItem = ({ thread, isActive, isRunning, onSelect }: {
	thread: ThreadType;
	isActive: boolean;
	isRunning: IsRunningType | undefined;
	onSelect: () => void;
}) => {
	const [isHovered, setIsHovered] = useState(false);
	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');

	const firstUserMsg = thread.messages.find(m => m.role === 'user');
	const title = (firstUserMsg?.role === 'user' && firstUserMsg.displayContent) || '(empty)';

	const activeBg = 'var(--vscode-list-activeSelectionBackground)';
	const activeFg = 'var(--vscode-list-activeSelectionForeground)';
	const normalFg = 'var(--vscode-foreground)';
	const hoverBg = 'var(--vscode-list-hoverBackground)';

	return (
		<div
			style={{
				display: 'flex', alignItems: 'center', gap: 8,
				padding: '6px 12px', marginInline: 4, borderRadius: 4,
				fontSize: 12, cursor: 'pointer', userSelect: 'none',
				background: isActive ? activeBg : 'transparent',
				color: isActive ? activeFg : normalFg,
			}}
			onClick={onSelect}
			onMouseEnter={(e) => { setIsHovered(true); if (!isActive) e.currentTarget.style.background = hoverBg; }}
			onMouseLeave={(e) => { setIsHovered(false); if (!isActive) e.currentTarget.style.background = 'transparent'; }}
		>
			{/* Status icon */}
			<div style={{ flexShrink: 0, width: 12, height: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
				<ThreadStatusIcon
					isRunning={isRunning}
					isDraft={false}
					idleDisplay="completed"
					size="xs"
				/>
			</div>

		{/* Title */}
		{thread.runnerProfile?.hasRemoteTurns && (
			<RunnerThreadCloudIcon
				size={11}
				title={thread.runnerProfile.lastRunnerName
					? `Self-hosted Runner · ${thread.runnerProfile.lastRunnerName}`
					: 'Self-hosted Runner'}
			/>
		)}
			<span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title.slice(0, 35)}{title.length > 35 ? '…' : ''}</span>

			{/* Hover actions */}
			{isHovered && !isActive && (
				<div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
					<button
						onClick={() => chatThreadsService.duplicateThread(thread.id)}
						style={{ padding: 2, borderRadius: 4, cursor: 'pointer', background: 'none', border: 'none', color: 'inherit' }}
						onMouseEnter={e => (e.currentTarget.style.background = 'var(--vscode-toolbar-hoverBackground)')}
						onMouseLeave={e => (e.currentTarget.style.background = 'none')}
						title="Duplicate"
					>
						<Copy size={11} />
					</button>
					<button
						onClick={() => chatThreadsService.deleteThread(thread.id)}
						style={{ padding: 2, borderRadius: 4, cursor: 'pointer', background: 'none', border: 'none', color: 'inherit' }}
						onMouseEnter={e => (e.currentTarget.style.background = 'var(--vscode-toolbar-hoverBackground)')}
						onMouseLeave={e => (e.currentTarget.style.background = 'none')}
						title="Delete"
					>
						<Trash2 size={11} />
					</button>
				</div>
			)}
		</div>
	);
};
