/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { useState, useMemo, memo, useEffect, useRef } from 'react';
import { useIsDark, useAccessor, useChatThreadsState, useRunningThreadIds, useIsChatHistoryVisible } from '../util/services.js';
import '../styles.css';
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js';
import { IconShell1 } from '../markdown/ApplyBlockHoverButtons.js';
import { IconLoadingSpinner } from '../sidebar-tsx/components/icons/IconLoadingSpinner.js';
import { getConnectedWindow } from '../util/connectedWindow.js';
import { Check, CheckCircle2, CircleDashed, Copy, MessageCircleQuestion, MessageSquarePlus, Trash2, X, MoreHorizontal, LayoutGrid, Search } from 'lucide-react';
import { IsRunningType, ThreadType } from '../../../chatThreadService.js';

export const ChatHistory = ({ className }: { className?: string }) => {
	const isDark = useIsDark();

	return (
		<div
			className={`@@void-scope ${isDark ? 'dark' : ''}`}
			style={{ width: '100%', height: '100%' }}
		>
			<div
				className={`
					w-full h-full
					bg-void-bg-2
					text-void-fg-0
				`}
			>
				<div className={`w-full h-full flex flex-col`}>
					<ErrorBoundary>
						<ChatHistoryContent />
					</ErrorBoundary>
				</div>
			</div>
		</div>
	);
};

const DAY_MS = 86_400_000;

const getDateBucket = (ts: number): string => {
	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const startOfYesterday = startOfToday - DAY_MS;
	const startOfSevenDaysAgo = startOfToday - 7 * DAY_MS;

	if (ts >= startOfToday) return 'Today';
	if (ts >= startOfYesterday) return 'Yesterday';
	if (ts >= startOfSevenDaysAgo) return 'Last 7 Days';
	return 'Older';
};

const BUCKET_ORDER: string[] = ['Today', 'Yesterday', 'Last 7 Days', 'Older'];

// A thread is a "draft" when the user has sent a message but no assistant response exists yet.
const isDraftThread = (t: ThreadType): boolean => {
	const hasUser = t.messages.some(m => m.role === 'user');
	const hasAssistant = t.messages.some(m => m.role === 'assistant');
	return hasUser && !hasAssistant;
};

const ChatHistoryContent = () => {
	const [visibleCount, setVisibleCount] = useState(5);
	const [searchQuery, setSearchQuery] = useState('');
	const [isSearchFocused, setIsSearchFocused] = useState(false);

	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');

	const threadsState = useChatThreadsState();
	const { allThreads, currentThreadId } = threadsState;

	const runningThreadIds = useRunningThreadIds();

	// Handle new thread creation
	const handleNewThread = () => {
		try {
			chatThreadsService.openNewThread();
		} catch (error) {
			console.error('Error creating new thread:', error);
		}
	};

	// Filtered and sorted threads with memoization for performance
	const sortedThreads = useMemo<ThreadType[]>(() => {
		if (!allThreads) {
			return [];
		}

		// Filter threads: non-empty and matching search query
		return (Object.values(allThreads) as ThreadType[])
			.filter((thread) => {
				if (!thread || thread.messages.length === 0) return false;

				// Apply search filter
				if (searchQuery.trim()) {
					const firstUserMsg = thread.messages.find((msg) => msg.role === 'user');
					const content = (firstUserMsg?.role === 'user' && firstUserMsg.displayContent) || '';
					return content.toLowerCase().includes(searchQuery.toLowerCase().trim());
				}

				return true;
			})
			.sort((a, b) => {
				const time1 = a.lastModified ? new Date(a.lastModified).getTime() : 0;
				const time2 = b.lastModified ? new Date(b.lastModified).getTime() : 0;
				return time1 > time2 ? -1 : 1;
			});
	}, [allThreads, searchQuery]);

	if (!allThreads) {
		return (
			<div className="flex flex-col h-full">
				<ChatHistoryTopBar />
				<ChatHistoryHeader
					onNewThread={handleNewThread}
					searchQuery={searchQuery}
					setSearchQuery={setSearchQuery}
					isSearchFocused={isSearchFocused}
					setIsSearchFocused={setIsSearchFocused}
					threadCount={0}
				/>
				<div className="flex-1 overflow-auto px-2">
					<div className="flex flex-col items-center justify-center h-full text-void-fg-0">
						<MessageSquarePlus size={48} className="opacity-50 mb-4" />
						<p className="text-sm">Error accessing chat history.</p>
					</div>
				</div>
			</div>
		);
	}

	// Group sorted threads by date bucket (Today / Yesterday / Last 7 Days / Older)
	const groupedThreads = useMemo<Record<string, ThreadType[]>>(() => {
		const groups: Record<string, ThreadType[]> = {};
		for (const thread of sortedThreads) {
			const ts = thread.lastModified ? new Date(thread.lastModified).getTime() : 0;
			const bucket = getDateBucket(ts);
			if (!groups[bucket]) groups[bucket] = [];
			groups[bucket].push(thread);
		}
		return groups;
	}, [sortedThreads]);

	// Flatten visible threads in bucket order, respecting visibleCount
	const visibleGrouped = useMemo<Record<string, ThreadType[]>>(() => {
		const result: Record<string, ThreadType[]> = {};
		let remaining = visibleCount;
		for (const bucket of BUCKET_ORDER) {
			if (remaining <= 0) break;
			const threads = groupedThreads[bucket];
			if (!threads || threads.length === 0) continue;
			const visibleInBucket = threads.slice(0, remaining);
			result[bucket] = visibleInBucket;
			remaining -= visibleInBucket.length;
		}
		return result;
	}, [groupedThreads, visibleCount]);

	const hasMoreThreads = sortedThreads.length > visibleCount;
	const isSearching = searchQuery.trim().length > 0;

	return (
		<div className="flex flex-col h-full">
			<ChatHistoryTopBar />
			<ChatHistoryHeader
				onNewThread={handleNewThread}
				searchQuery={searchQuery}
				setSearchQuery={setSearchQuery}
				isSearchFocused={isSearchFocused}
				setIsSearchFocused={setIsSearchFocused}
				threadCount={sortedThreads.length}
			/>

			<div className="flex-1 overflow-y-auto overflow-x-hidden">
				{sortedThreads.length === 0 ? (
					isSearching ? (
						// No search results
						<div className="flex flex-col items-center justify-center h-full text-void-fg-0 px-4 text-center">
							<p className="text-[13px]">No agents match "{searchQuery}"</p>
							<button
								onClick={() => setSearchQuery('')}
								className="mt-2 text-[10px] text-void-fg-0 hover:opacity-100 underline opacity-80"
							>
								Clear search
							</button>
						</div>
					) : (
						// Empty state - no threads at all
						<div className="flex flex-col items-center justify-center h-full text-void-fg-0 px-4 text-center">
							<p className="text-[13px] mb-1">No agents found</p>
							<button
								onClick={handleNewThread}
								className="text-[10px] opacity-60 hover:opacity-100 hover:underline"
							>
								Create New Agent
							</button>
						</div>
					)
				) : (
					<div className="flex flex-col w-full select-none pb-2">
						{BUCKET_ORDER.map((bucket, groupIdx) => {
							const threadsInBucket = visibleGrouped[bucket];
							if (!threadsInBucket || threadsInBucket.length === 0) return null;
							return (
								<div key={bucket} className="flex flex-col">
									<div
										className={`
											text-[11px] font-medium text-void-fg-3 opacity-70
											px-3 mx-1 pb-1 select-none
											${groupIdx === 0 ? 'pt-2' : 'pt-4'}
										`}
									>
										{bucket}
									</div>
									{threadsInBucket.map((thread) => (
										<PastThreadElement
											key={thread.id}
											pastThread={thread}
											isRunning={runningThreadIds[thread.id]}
											isActive={currentThreadId === thread.id}
										/>
									))}
								</div>
							);
						})}

						{/* More button */}
						{hasMoreThreads && (
							<div
								className="flex items-center gap-2 py-1.5 px-2 mx-1 rounded-md text-[13px] cursor-pointer text-void-fg-0 hover:bg-zinc-700/5 dark:hover:bg-zinc-300/5 transition-all opacity-80 hover:opacity-100"
								onClick={() => setVisibleCount((prev) => prev + 5)}
							>
								<MoreHorizontal size={14} className="flex-shrink-0 opacity-60" />
								<span className="truncate">More</span>
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
};

const ChatHistoryTopBar = () => {
	const accessor = useAccessor();
	const commandService = accessor.get('ICommandService');
	const isChatHistoryVisible = useIsChatHistoryVisible();

	const handleToggle = () => {
		commandService.executeCommand('workbench.action.toggleChatHistory');
	};

	return (
		<div className="@@chat-history-topbar">
			<button
				type="button"
				onClick={handleToggle}
				aria-label="Toggle Chat History"
				data-tooltip-id="void-tooltip"
				data-tooltip-place="bottom"
				data-tooltip-content={isChatHistoryVisible ? 'Hide Chat History' : 'Show Chat History'}
				className={`@@chat-history-toggle ${isChatHistoryVisible ? '@@chat-history-toggle-off' : ''}`}
			/>
		</div>
	);
};

// Header component with controls (search + new agent button)
const ChatHistoryHeader = ({
	onNewThread,
	searchQuery,
	setSearchQuery,
	isSearchFocused,
	setIsSearchFocused,
	threadCount,
}: {
	onNewThread: () => void;
	searchQuery: string;
	setSearchQuery: (query: string) => void;
	isSearchFocused: boolean;
	setIsSearchFocused: (focused: boolean) => void;
	threadCount: number;
}) => {
	const accessor = useAccessor();
	const commandService = accessor.get('ICommandService');
	const agentWindowService = accessor.get('IAgentWindowService');
	const keybindingService = accessor.get('IKeybindingService');
	const rootRef = useRef<HTMLDivElement>(null);
	// Hide the Customize affordance in the pop-out Agent window (main IDE only),
	// mirroring SidebarChat's browser-button detection.
	const [inAgentWindow, setInAgentWindow] = useState(false);
	useEffect(() => {
		const node = rootRef.current;
		setInAgentWindow(!!node && getConnectedWindow(node) !== window && agentWindowService.isOpen());
	}, [agentWindowService]);

	const newThreadKeybindLabel = keybindingService.lookupKeybinding('void.cmdShiftL')?.getLabel();

	const handleCustomize = () => {
		try { commandService.executeCommand('workbench.action.openVoidCustomize'); }
		catch (error) { console.error('Error opening Customize:', error); }
	};

	return (
		<div ref={rootRef} className="flex flex-col gap-0.5 mb-1 flex-shrink-0 p-3 pb-2">
			{/* Search Bar */}
			<div
				className={`
					flex items-center gap-2 px-2 py-1.5 mb-1.5 rounded-md
					bg-zinc-700/5 dark:bg-zinc-300/5
				`}
			>
				<Search size={13} className="flex-shrink-0 text-void-fg-3 opacity-60" />
				<input
					type="text"
					placeholder="Search Agents..."
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
					onFocus={() => setIsSearchFocused(true)}
					onBlur={() => setIsSearchFocused(false)}
					className="@@chat-history-search-input flex-1 bg-transparent outline-none text-[13px] text-void-fg-0 placeholder:text-void-fg-3 placeholder:opacity-50"
				/>
			</div>

			{/* New Agent Row */}
			<button
				onClick={onNewThread}
				className={`
					w-full py-1.5 px-2 rounded-md
					hover:bg-zinc-700/5 dark:hover:bg-zinc-300/5
					text-[13px] text-void-fg-0 transition-colors
					flex items-center gap-2 opacity-85 hover:opacity-100
				`}
			>
				<MessageSquarePlus size={14} className="flex-shrink-0" />
				<span className="flex-1 text-left">New Agent</span>
				{newThreadKeybindLabel && (
					<span className="px-1 rounded bg-[var(--vscode-keybindingLabel-background)] text-[var(--vscode-keybindingLabel-foreground)] border border-[var(--vscode-keybindingLabel-border)] text-[10px] opacity-80">
						{newThreadKeybindLabel}
					</span>
				)}
			</button>

			{/* Customize Row (main window only) */}
			{!inAgentWindow && (
				<button
					onClick={handleCustomize}
					className={`
						chat-history-customize
						w-full py-1.5 px-2 rounded-md
						hover:bg-zinc-700/5 dark:hover:bg-zinc-300/5
						text-[13px] text-void-fg-0 transition-colors
						flex items-center gap-2 opacity-85 hover:opacity-100
					`}
				>
					<LayoutGrid size={14} className="flex-shrink-0" />
					<span className="flex-1 text-left">Customize</span>
				</button>
			)}
		</div>
	);
};

const DuplicateButton = ({ threadId }: { threadId: string }) => {
	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');

	const handleDuplicate = (e: React.MouseEvent) => {
		e.stopPropagation();
		try {
			chatThreadsService.duplicateThread(threadId);
		} catch (error) {
			console.error('Error duplicating thread:', error);
		}
	};

	return (
		<IconShell1
			Icon={Copy}
			className="size-[11px]"
			onClick={handleDuplicate}
			data-tooltip-id="void-tooltip"
			data-tooltip-place="top"
			data-tooltip-content="Duplicate thread"
		/>
	);
};

const TrashButton = ({ threadId }: { threadId: string }) => {
	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');

	const [isTrashPressed, setIsTrashPressed] = useState(false);

	const handleTrashClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		setIsTrashPressed(true);
	};

	const handleCancel = (e: React.MouseEvent) => {
		e.stopPropagation();
		setIsTrashPressed(false);
	};

	const handleConfirm = (e: React.MouseEvent) => {
		e.stopPropagation();
		try {
			chatThreadsService.deleteThread(threadId);
			setIsTrashPressed(false);
		} catch (error) {
			console.error('Error deleting thread:', error);
			setIsTrashPressed(false);
		}
	};

	return isTrashPressed ? (
		<div className="flex flex-nowrap text-nowrap gap-1" onClick={(e) => e.stopPropagation()}>
			<IconShell1
				Icon={X}
				className="size-[11px]"
				onClick={handleCancel}
				data-tooltip-id="void-tooltip"
				data-tooltip-place="top"
				data-tooltip-content="Cancel"
			/>
			<IconShell1
				Icon={Check}
				className="size-[11px]"
				onClick={handleConfirm}
				data-tooltip-id="void-tooltip"
				data-tooltip-place="top"
				data-tooltip-content="Confirm delete"
			/>
		</div>
	) : (
		<IconShell1
			Icon={Trash2}
			className="size-[11px]"
			onClick={handleTrashClick}
			data-tooltip-id="void-tooltip"
			data-tooltip-place="top"
			data-tooltip-content="Delete thread"
		/>
	);
};

const PastThreadElement = memo(({
	pastThread,
	isRunning,
	isActive,
}: {
	pastThread: ThreadType;
	isRunning: IsRunningType | undefined;
	isActive?: boolean;
}) => {
	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');

	const firstUserMsgIdx = pastThread.messages.findIndex((msg) => msg.role === 'user');
	const firstMsg = firstUserMsgIdx !== -1
		? (pastThread.messages[firstUserMsgIdx].role === 'user' && pastThread.messages[firstUserMsgIdx].displayContent) || ''
		: 'New Chat';

	const handleClick = (e: React.MouseEvent) => {
		// Prevent click if clicking on action buttons
		if ((e.target as HTMLElement).closest('[data-action-button]')) {
			return;
		}
		try {
			chatThreadsService.switchToThread(pastThread.id);
		} catch (error) {
			console.error('Error switching thread:', error);
		}
	};

	return (
		<div
			className={`
				group relative flex items-center justify-between
				py-1.5 px-2 mx-1 rounded-md text-[13px] cursor-pointer transition-all
				${isActive
					? 'bg-void-bg-3 text-void-fg-0'
					: 'text-void-fg-0 hover:bg-zinc-700/5 dark:hover:bg-zinc-300/5'
				}
			`}
			onClick={handleClick}
		>
			<div className="flex items-center gap-2 min-w-0 overflow-hidden flex-1">
				{/* Status indicator: running spinner, awaiting user, draft, or completed check */}
				{isRunning === 'LLM' || isRunning === 'tool' || isRunning === 'idle' ? (
					<IconLoadingSpinner className="text-void-fg-0 opacity-70 flex-shrink-0" size={14} />
				) : isRunning === 'awaiting_user' ? (
					<MessageCircleQuestion className="text-void-fg-0 opacity-70 flex-shrink-0" size={14} />
				) : isDraftThread(pastThread) ? (
					<CircleDashed className="text-void-fg-0 opacity-70 flex-shrink-0" size={14} />
				) : (
					<CheckCircle2 className="text-void-fg-0 opacity-80 flex-shrink-0" size={14} />
				)}

				{/* Thread title */}
				<span
					className="truncate opacity-90"
					title={firstMsg}
				>
					{firstMsg}
				</span>
			</div>

			{/* Action buttons on hover (duplicate + delete) */}
			<div className="flex items-center gap-1 pl-2 flex-shrink-0 h-4 opacity-0 group-hover:opacity-100 transition-opacity duration-150" data-action-button>
				<DuplicateButton threadId={pastThread.id} />
				<TrashButton threadId={pastThread.id} />
			</div>
		</div>
	);
});
