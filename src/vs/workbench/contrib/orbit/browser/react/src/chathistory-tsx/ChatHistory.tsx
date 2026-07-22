/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { useState, useMemo, memo, useEffect, useRef, useCallback } from 'react';
import { useIsDark, useAccessor, useChatThreadsState, useRunningThreadIds, useIsChatHistoryVisible, useAgentWorkspaceState } from '../util/services.js';
import '../styles.css';
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js';
import { IconShell1 } from '../markdown/ApplyBlockHoverButtons.js';
import { IconLoadingSpinner } from '../sidebar-tsx/components/icons/IconLoadingSpinner.js';
import { OrbitUserProfileFooter } from '../shared/OrbitUserProfileFooter.js';
import { Check, CheckCircle2, CircleDashed, Copy, FolderPlus, MessageCircleQuestion, MessageSquarePlus, Trash2, X, MoreHorizontal, LayoutGrid, Search, ListFilter, ChevronDown } from 'lucide-react';
import { IsRunningType, ThreadType } from '../../../chatThreadService.js';
import { filterThreadsByWorkspaceId } from '../../../../common/agentWorkspaceHelpers.js';
import {
	AgentHistoryListPrefs,
	compareThreadsByOrdering,
	DEFAULT_AGENT_HISTORY_LIST_PREFS,
	groupThreads,
	parseAgentHistoryListPrefs,
} from '../../../../common/agentHistoryListHelpers.js';
import { AGENT_HISTORY_LIST_PREFS_STORAGE_KEY } from '../../../../common/storageKeys.js';
import { AgentChatHistoryFilterMenu } from '../agent-window-tsx/AgentChatHistoryFilterMenu.js';
import { AgentWorkspacePicker } from '../agent-window-tsx/AgentWorkspacePicker.js';
import { StorageScope, StorageTarget } from '../../../../../../../platform/storage/common/storage.js';

export const ChatHistory = ({ className, isAgentWindow = false }: { className?: string; isAgentWindow?: boolean }) => {
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
						<ChatHistoryContent inAgentWindow={isAgentWindow} />
					</ErrorBoundary>
				</div>
			</div>
		</div>
	);
};

// A thread is a "draft" when the user has sent a message but no assistant response exists yet.
const isDraftThread = (t: ThreadType): boolean => {
	const hasUser = t.messages.some(m => m.role === 'user');
	const hasAssistant = t.messages.some(m => m.role === 'assistant');
	return hasUser && !hasAssistant;
};

const ChatHistoryContent = ({ inAgentWindow }: { inAgentWindow: boolean }) => {
	const [visibleCount, setVisibleCount] = useState(5);
	const [searchQuery, setSearchQuery] = useState('');
	const [isSearchFocused, setIsSearchFocused] = useState(false);
	const [filterMenuOpen, setFilterMenuOpen] = useState(false);
	const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
	const [dismissedUnassignedBanner, setDismissedUnassignedBanner] = useState(false);
	const [collapsedGroups, setCollapsedGroups] = useState<Record<string, true>>({});
	const filterBtnRef = useRef<HTMLButtonElement>(null);
	const workspaceButtonRef = useRef<HTMLButtonElement>(null);

	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');
	const workspaceService = accessor.get('IAgentProjectWorkspaceService');
	const storageService = accessor.get('IStorageService');
	const agentWorkspaceState = useAgentWorkspaceState();

	const [listPrefs, setListPrefs] = useState<AgentHistoryListPrefs>(() => {
		try {
			return parseAgentHistoryListPrefs(
				storageService.get(AGENT_HISTORY_LIST_PREFS_STORAGE_KEY, StorageScope.APPLICATION),
			);
		} catch {
			return { ...DEFAULT_AGENT_HISTORY_LIST_PREFS };
		}
	});

	const updateListPrefs = useCallback((next: AgentHistoryListPrefs) => {
		setListPrefs(next);
		setVisibleCount(5);
		try {
			storageService.store(
				AGENT_HISTORY_LIST_PREFS_STORAGE_KEY,
				JSON.stringify(next),
				StorageScope.APPLICATION,
				StorageTarget.USER,
			);
		} catch {
			// Preference persistence is best-effort; list still updates in-memory.
		}
	}, [storageService]);

	const filterMode = listPrefs.filterMode;
	const effectiveListPrefs = inAgentWindow ? listPrefs : DEFAULT_AGENT_HISTORY_LIST_PREFS;

	const threadsState = useChatThreadsState();
	const { allThreads } = threadsState;
	const currentThreadId = inAgentWindow ? threadsState.agentWindowThreadId : threadsState.currentThreadId;

	const runningThreadIds = useRunningThreadIds();
	const composerWorkspacePickerAvailable = inAgentWindow
		&& !!allThreads?.[currentThreadId]
		&& allThreads[currentThreadId].messages.length === 0;

	useEffect(() => {
		if (!inAgentWindow) {
			setFilterMenuOpen(false);
			setWorkspacePickerOpen(false);
		}
	}, [inAgentWindow]);

	useEffect(() => {
		// The landing-page composer owns command-triggered picker requests while
		// mounted. For active threads, this always-mounted compact history control
		// is the fallback host. The service request is one-shot, so only one portal
		// opens even as the composer and history update across a thread transition.
		if (!inAgentWindow || composerWorkspacePickerAvailable) {
			return;
		}
		const openRequestedPicker = () => {
			if (workspaceService.consumePendingOpenPicker()) {
				setFilterMenuOpen(false);
				setWorkspacePickerOpen(true);
			}
		};
		openRequestedPicker();
		const disposable = workspaceService.onDidRequestOpenPicker(openRequestedPicker);
		return () => disposable.dispose();
	}, [inAgentWindow, composerWorkspacePickerAvailable, workspaceService]);

	// Handle new thread creation — attach agent workspace when in Agents window
	const handleNewThread = () => {
		try {
			if (inAgentWindow) {
				chatThreadsService.openNewThread({
					agentWorkspaceId: agentWorkspaceState.activeWorkspaceId,
				});
			} else {
				chatThreadsService.openNewThread();
			}
		} catch (error) {
			console.error('Error creating new thread:', error);
		}
	};

	// Filtered and sorted threads with memoization for performance
	const sortedThreads = useMemo<ThreadType[]>(() => {
		if (!allThreads) {
			return [];
		}

		let threads = (Object.values(allThreads) as ThreadType[])
			.filter((thread) => {
				if (!thread || thread.messages.length === 0) return false;

				if (searchQuery.trim()) {
					const firstUserMsg = thread.messages.find((msg) => msg.role === 'user');
					const content = (firstUserMsg?.role === 'user' && firstUserMsg.displayContent) || '';
					return content.toLowerCase().includes(searchQuery.toLowerCase().trim());
				}

				return true;
			});

		// Agent window: scope by workspace (main IDE shows all threads unchanged)
		if (inAgentWindow) {
			threads = filterThreadsByWorkspaceId(
				threads,
				agentWorkspaceState.activeWorkspaceId,
				filterMode,
			);
		}

		return threads.sort((a, b) => compareThreadsByOrdering(a, b, effectiveListPrefs.ordering));
	}, [allThreads, searchQuery, inAgentWindow, agentWorkspaceState.activeWorkspaceId, filterMode, effectiveListPrefs.ordering]);

	const unassignedCount = useMemo(() => {
		if (!inAgentWindow || !allThreads) {
			return 0;
		}
		return filterThreadsByWorkspaceId(
			(Object.values(allThreads) as ThreadType[]).filter(t => t && t.messages.length > 0),
			agentWorkspaceState.activeWorkspaceId,
			'unassigned',
		).length;
	}, [allThreads, inAgentWindow, agentWorkspaceState.activeWorkspaceId]);

	// Group sorted threads by the selected grouping mode
	const { order: groupOrder, groups: groupedThreads } = useMemo(() => {
		return groupThreads(sortedThreads, effectiveListPrefs.grouping, agentWorkspaceState.workspaces);
	}, [sortedThreads, effectiveListPrefs.grouping, agentWorkspaceState.workspaces]);

	// Flatten visible threads in group order, respecting visibleCount and collapsed sections
	const visibleGrouped = useMemo<Record<string, ThreadType[]>>(() => {
		const result: Record<string, ThreadType[]> = {};
		let remaining = visibleCount;
		for (const bucket of groupOrder) {
			if (remaining <= 0) break;
			const threads = groupedThreads[bucket];
			if (!threads || threads.length === 0) continue;
			if (effectiveListPrefs.grouping !== 'none' && collapsedGroups[bucket]) {
				result[bucket] = [];
				continue;
			}
			const visibleInBucket = threads.slice(0, remaining);
			result[bucket] = visibleInBucket;
			remaining -= visibleInBucket.length;
		}
		return result;
	}, [groupedThreads, groupOrder, visibleCount, collapsedGroups, effectiveListPrefs.grouping]);
	const firstVisibleBucket = groupOrder.find(bucket => {
		const threads = groupedThreads[bucket];
		return !!threads && threads.length > 0;
	});

	const canCollapseAll = effectiveListPrefs.grouping !== 'none'
		&& groupOrder.some(key => (groupedThreads[key]?.length ?? 0) > 0 && !collapsedGroups[key]);

	const handleCollapseAll = useCallback(() => {
		const next: Record<string, true> = {};
		for (const key of groupOrder) {
			if ((groupedThreads[key]?.length ?? 0) > 0) {
				next[key] = true;
			}
		}
		setCollapsedGroups(next);
	}, [groupOrder, groupedThreads]);

	const toggleGroupCollapsed = useCallback((key: string) => {
		if (effectiveListPrefs.grouping === 'none' || !key) {
			return;
		}
		setCollapsedGroups(prev => {
			if (prev[key]) {
				const next = { ...prev };
				delete next[key];
				return next;
			}
			return { ...prev, [key]: true };
		});
	}, [effectiveListPrefs.grouping]);

	// Drop collapsed keys that no longer exist when grouping/filter changes
	useEffect(() => {
		setCollapsedGroups(prev => {
			const keys = new Set(groupOrder);
			let changed = false;
			const next: Record<string, true> = {};
			for (const key of Object.keys(prev)) {
				if (keys.has(key)) {
					next[key] = true;
				} else {
					changed = true;
				}
			}
			return changed ? next : prev;
		});
	}, [groupOrder]);

	const historyActions = inAgentWindow ? (
		<div className="agent-history-section-actions" role="toolbar" aria-label="Chat history actions">
			<button
				ref={filterBtnRef}
				type="button"
				className={`agent-history-icon-btn${filterMenuOpen ? ' active' : ''}`}
				aria-label="Organize chat history"
				aria-haspopup="menu"
				aria-expanded={filterMenuOpen}
				data-tooltip-id="void-tooltip"
				data-tooltip-place="top"
				data-tooltip-content="Organize"
				onClick={() => {
					setWorkspacePickerOpen(false);
					setFilterMenuOpen(open => !open);
				}}
			>
				<ListFilter size={14} strokeWidth={1.75} aria-hidden />
			</button>
			<button
				ref={workspaceButtonRef}
				type="button"
				className={`agent-history-icon-btn agent-history-workspace-btn${workspacePickerOpen ? ' active' : ''}`}
				aria-label="Open workspace"
				aria-haspopup="dialog"
				aria-expanded={workspacePickerOpen}
				data-tooltip-id="void-tooltip"
				data-tooltip-place="top"
				data-tooltip-content="Open Workspace"
				onClick={() => {
					setFilterMenuOpen(false);
					setWorkspacePickerOpen(open => !open);
				}}
			>
				<FolderPlus size={15} strokeWidth={1.75} aria-hidden />
			</button>
		</div>
	) : null;
	const historyOverlays = inAgentWindow ? (
		<>
			<AgentChatHistoryFilterMenu
				open={filterMenuOpen}
				onClose={() => setFilterMenuOpen(false)}
				prefs={listPrefs}
				onChangePrefs={updateListPrefs}
				onCollapseAll={handleCollapseAll}
				canCollapseAll={canCollapseAll}
				anchorRef={filterBtnRef}
			/>
			<AgentWorkspacePicker
				open={workspacePickerOpen}
				onClose={() => setWorkspacePickerOpen(false)}
				anchorRef={workspaceButtonRef}
			/>
		</>
	) : null;

	const hasMoreThreads = useMemo(() => {
		let available = 0;
		let shown = 0;
		for (const key of groupOrder) {
			if (effectiveListPrefs.grouping !== 'none' && collapsedGroups[key]) {
				continue;
			}
			available += groupedThreads[key]?.length ?? 0;
			shown += visibleGrouped[key]?.length ?? 0;
		}
		return available > shown;
	}, [groupOrder, groupedThreads, visibleGrouped, collapsedGroups, effectiveListPrefs.grouping]);

	// Keep all hooks above this branch: thread state is populated asynchronously,
	// so returning before the grouping hooks would change hook order on hydration.
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
					inAgentWindow={inAgentWindow}
				/>
				{inAgentWindow && (
					<div className="agent-history-section-toolbar agent-history-section-toolbar--empty">
						{historyActions}
					</div>
				)}
				<div className="flex-1 overflow-auto px-2">
					<div className="flex flex-col items-center justify-center h-full text-void-fg-0">
						<MessageSquarePlus size={48} className="opacity-50 mb-4" />
						<p className="text-sm">Error accessing chat history.</p>
					</div>
				</div>
				{historyOverlays}
				<OrbitUserProfileFooter />
			</div>
		);
	}

	const isSearching = searchQuery.trim().length > 0;
	const showWorkspaceBadge = inAgentWindow && filterMode === 'all';

	return (
		<div className="flex flex-col h-full relative">
			<ChatHistoryTopBar />
			<ChatHistoryHeader
				onNewThread={handleNewThread}
				searchQuery={searchQuery}
				setSearchQuery={setSearchQuery}
				isSearchFocused={isSearchFocused}
				setIsSearchFocused={setIsSearchFocused}
				threadCount={sortedThreads.length}
				inAgentWindow={inAgentWindow}
			/>

			{inAgentWindow && unassignedCount > 0 && !dismissedUnassignedBanner && filterMode !== 'unassigned' && (
				<div className="agent-history-unassigned-banner">
					These agents were created before workspace support.{' '}
					<button
						type="button"
						className="underline opacity-90"
						onClick={() => updateListPrefs({ ...listPrefs, filterMode: 'unassigned' })}
					>
						View unassigned
					</button>
					{' · '}
					<button
						type="button"
						className="underline opacity-70"
						onClick={() => setDismissedUnassignedBanner(true)}
					>
						Dismiss
					</button>
				</div>
			)}

			<div className="flex-1 overflow-y-auto overflow-x-hidden">
				{inAgentWindow && sortedThreads.length === 0 && (
					<div className="agent-history-section-toolbar agent-history-section-toolbar--empty">
						{historyActions}
					</div>
				)}
				{sortedThreads.length === 0 ? (
					isSearching ? (
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
						{groupOrder.map((bucket, groupIdx) => {
							const allInBucket = groupedThreads[bucket] ?? [];
							if (allInBucket.length === 0) return null;
							const isCollapsed = effectiveListPrefs.grouping !== 'none' && !!collapsedGroups[bucket];
							const threadsInBucket = isCollapsed ? [] : (visibleGrouped[bucket] ?? []);
							// Skip groups that are past the "More" pagination window (unless collapsed,
							// so Collapse All still reveals every section header).
							if (!isCollapsed && threadsInBucket.length === 0) return null;
							const showHeader = effectiveListPrefs.grouping !== 'none' && bucket !== '';
							const isFirstActionsBucket = inAgentWindow && bucket === firstVisibleBucket;
							return (
								<div key={bucket || 'flat'} className="flex flex-col">
									{(showHeader || isFirstActionsBucket) && (
										<div className={`agent-history-bucket-header ${isFirstActionsBucket ? 'agent-history-bucket-header--with-actions' : ''}`}>
											{showHeader ? (
												<button
													type="button"
													className={`
														agent-history-bucket-toggle
														text-[11px] font-medium text-void-fg-3 opacity-70
														px-3 mx-1 pb-1 select-none
														${isFirstActionsBucket ? 'pt-1' : groupIdx === 0 ? 'pt-2' : 'pt-4'}
													`}
													aria-expanded={!isCollapsed}
													onClick={() => toggleGroupCollapsed(bucket)}
												>
													<ChevronDown
														size={12}
														strokeWidth={2}
														aria-hidden
														className={`agent-history-bucket-chevron${isCollapsed ? ' collapsed' : ''}`}
													/>
													<span>{bucket}</span>
													{isCollapsed && (
														<span className="agent-history-bucket-count">{allInBucket.length}</span>
													)}
												</button>
											) : (
												<div className={`${isFirstActionsBucket ? 'pt-1' : 'pt-2'} px-3 mx-1 pb-1`} />
											)}
											{isFirstActionsBucket ? historyActions : null}
										</div>
									)}
									{threadsInBucket.map((thread) => (
										<PastThreadElement
											key={thread.id}
											pastThread={thread}
											isRunning={runningThreadIds[thread.id]}
											isActive={currentThreadId === thread.id}
											inAgentWindow={inAgentWindow}
											workspaceBadge={showWorkspaceBadge
												? (thread.agentWorkspaceId
													? (agentWorkspaceState.workspaces[thread.agentWorkspaceId]?.name ?? 'Workspace')
													: (thread.agentWorkspaceId === null ? 'No Repo' : 'Unassigned'))
												: undefined}
										/>
									))}
								</div>
							);
						})}

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
			{historyOverlays}
			<OrbitUserProfileFooter />
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
	inAgentWindow,
}: {
	onNewThread: () => void;
	searchQuery: string;
	setSearchQuery: (query: string) => void;
	isSearchFocused: boolean;
	setIsSearchFocused: (focused: boolean) => void;
	threadCount: number;
	inAgentWindow: boolean;
}) => {
	const accessor = useAccessor();
	const commandService = accessor.get('ICommandService');
	const keybindingService = accessor.get('IKeybindingService');

	const newThreadKeybindLabel = keybindingService.lookupKeybinding('void.cmdShiftL')?.getLabel();

	const handleCustomize = () => {
		try { commandService.executeCommand('workbench.action.openVoidCustomize'); }
		catch (error) { console.error('Error opening Customize:', error); }
	};

	return (
		<div className="flex flex-col gap-0.5 mb-1 flex-shrink-0 p-3 pb-2">
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
	inAgentWindow,
	workspaceBadge,
}: {
	pastThread: ThreadType;
	isRunning: IsRunningType | undefined;
	isActive?: boolean;
	inAgentWindow: boolean;
	workspaceBadge?: string;
}) => {
	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');
	const agentWorkspaceService = accessor.get('IAgentProjectWorkspaceService');
	const dialogService = accessor.get('IDialogService');

	const firstUserMsgIdx = pastThread.messages.findIndex((msg) => msg.role === 'user');
	const firstMsg = firstUserMsgIdx !== -1
		? (pastThread.messages[firstUserMsgIdx].role === 'user' && pastThread.messages[firstUserMsgIdx].displayContent) || ''
		: 'New Chat';

	const handleClick = async (e: React.MouseEvent) => {
		// Prevent click if clicking on action buttons
		if ((e.target as HTMLElement).closest('[data-action-button]')) {
			return;
		}
		try {
			// Only the Agents (auxiliary) window should mutate its own workspace
			// selection from a thread click. The main IDE sidebar must NOT silently
			// switch the agent workspace behind the user's back — an IDE click is a
			// browse action, not a workspace-switch command. S1/#13.
			if (inAgentWindow && pastThread.agentWorkspaceId !== undefined) {
				const current = agentWorkspaceService.getState().activeWorkspaceId;
				const next = pastThread.agentWorkspaceId;
				if (current !== next) {
					// Match AgentWorkspacePicker: confirm before leaving a workspace
					// that still has a running (or background) agent.
					if (chatThreadsService.hasRunningThreadInWorkspace(current)) {
						const result = await dialogService.confirm({
							type: 'warning',
							message: 'An agent is still running in this workspace.',
							detail: 'Switching will leave it running in the background and open a new agent in the selected workspace.',
							primaryButton: 'Switch Anyway',
							cancelButton: 'Stay',
						});
						if (!result.confirmed) {
							return;
						}
					}
					agentWorkspaceService.setActiveWorkspace(next);
				}
			}
			chatThreadsService.switchToThread(pastThread.id, { inAgentWindow });
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
				{workspaceBadge && (
					<span className="agent-history-workspace-badge" title={workspaceBadge}>{workspaceBadge}</span>
				)}
			</div>

			{/* Action buttons on hover (duplicate + delete) */}
			<div className="flex items-center gap-1 pl-2 flex-shrink-0 h-4 opacity-0 group-hover:opacity-100 transition-opacity duration-150" data-action-button>
				<DuplicateButton threadId={pastThread.id} />
				<TrashButton threadId={pastThread.id} />
			</div>
		</div>
	);
});
