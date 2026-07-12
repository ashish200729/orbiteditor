/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, FolderDown, ListChecks } from 'lucide-react';
import { CollapsibleSection } from '../wrappers/CollapsibleSection.js';
import { URI } from '../../../../../../../../../base/common/uri.js';
import { ToolChildrenWrapper } from '../toolWrappers/ToolChildrenWrapper.js';
import { EditToolCardWrapper } from '../editTool/EditToolCardWrapper.js';
import { ApprovalGhostButton } from '../toolApproval/ApprovalButton.js';
import { PlanTodoItem } from '../../../../../../common/toolsServiceTypes.js';
import { TodoItem } from '../../../../../../common/chatThreadServiceTypes.js';
import { TodoRow } from './todo/TodoRow.js';
import { PlanBuildButton } from '../../../plan-editor-tsx/PlanBuildButton.js';
import { useAccessor } from '../../../util/services.js';
import { ModelDropdown } from '../../../orbit-settings-tsx/ModelDropdown.js';
import '../../../styles.css';

const TODO_PREVIEW_ROWS = 3;

type PlanCardTodo = TodoItem & { content: string };

export const PlanCard = ({
	threadId,
	planName,
	overview,
	todos: initialTodos,
	planPath,
	isDraft,
}: {
	threadId: string;
	planName: string;
	overview: string;
	todos: PlanTodoItem[];
	planMarkdown?: string;
	planPath?: string;
	isDraft: boolean;
}) => {
	const accessor = useAccessor();
	const chatThreadService = accessor.get('IChatThreadService');
	const commandService = accessor.get('ICommandService');

	const [draftVersion, setDraftVersion] = useState(0);
	const [collapsed, setCollapsed] = useState(false);
	const [showAllTodos, setShowAllTodos] = useState(false);

	useEffect(() => {
		const disposable = chatThreadService.onDidChangeThreadPlanDraft(({ threadId: changedId }) => {
			if (changedId === threadId) setDraftVersion(v => v + 1);
		});
		return () => disposable.dispose();
	}, [chatThreadService, threadId]);

	useEffect(() => {
		const disposable = chatThreadService.onDidChangeThreadLinkedPlanPath(({ threadId: changedId }) => {
			if (changedId === threadId) setDraftVersion(v => v + 1);
		});
		return () => disposable.dispose();
	}, [chatThreadService, threadId]);

	const thread = chatThreadService.state.allThreads[threadId];
	const liveDraft = thread?.planDraft;
	const linkedPlanPath = thread?.linkedPlanPath;
	const savedPath = liveDraft?.savedPlanPath ?? planPath ?? linkedPlanPath;

	const displayTitle = liveDraft?.name ?? planName;
	const displayOverview = liveDraft?.overview ?? overview;

	const displayTodos = useMemo<PlanCardTodo[]>(() => {
		const base = liveDraft?.todos?.length ? liveDraft.todos : initialTodos;
		return base.map(t => ({
			...t,
			status: thread?.todoList?.find(td => td.id === t.id)?.status ?? 'pending',
		}));
	}, [liveDraft, initialTodos, thread?.todoList, draftVersion]);

	const isSaved = !!(savedPath && (!isDraft || liveDraft?.savedPlanPath));

	const displayFilename = useMemo(() => {
		if (savedPath) {
			const sep = savedPath.includes('/') ? '/' : '\\';
			return savedPath.split(sep).pop() ?? savedPath;
		}
		return isDraft ? 'Unsaved draft' : planName;
	}, [savedPath, isDraft, planName]);

	const visibleTodos = showAllTodos ? displayTodos : displayTodos.slice(0, TODO_PREVIEW_ROWS);
	const hasMoreTodos = displayTodos.length > TODO_PREVIEW_ROWS;
	const completedCount = displayTodos.filter(t => t.status === 'completed').length;

	const handleViewPlan = () => {
		if (savedPath) {
			commandService.executeCommand('vscode.open', URI.file(savedPath));
			return;
		}
		if (!isSaved && (isDraft || liveDraft)) {
			commandService.executeCommand('orbit.plan.openDraft', threadId);
		}
	};

	const handleSave = () => {
		commandService.executeCommand('orbit.plan.saveToWorkspace', threadId);
	};

	const handleBuild = () => {
		commandService.executeCommand('orbit.plan.buildFromDraft', threadId);
	};

	const hasOverview = !!displayOverview?.trim();
	const hasTodos = displayTodos.length > 0;
	const isEmpty = !hasOverview && !hasTodos;

	return (
		<ToolChildrenWrapper disableOverflowY disableMaxHeight>
			<EditToolCardWrapper className="relative overflow-hidden">
				{/* Header */}
				<div
					className="flex items-center gap-2 px-2.5 py-1.5 select-none group cursor-pointer"
					onClick={() => setCollapsed(v => !v)}
					style={{ minHeight: '26px' }}
				>
					<ChevronDown
						size={10}
						strokeWidth={2.5}
						className={`text-void-fg-4/40 flex-shrink-0 transition-all duration-200 ease-out ${collapsed ? '' : 'rotate-180 text-void-fg-4/60'}`}
						aria-hidden
					/>
					<ListChecks
						size={13}
						className="shrink-0 text-void-fg-4/60"
						strokeWidth={2}
						aria-hidden
					/>
					<span
						className="text-[12px] font-medium text-void-fg-2/90 flex-1 min-w-0 truncate"
						title={savedPath ?? displayTitle}
					>
						{displayFilename}
					</span>
					<div className="flex items-center gap-0.5 shrink-0 ml-auto" onClick={(e) => e.stopPropagation()}>
						{!isSaved && (
							<button
								type="button"
								className="p-1.5 rounded text-void-fg-4/60 hover:text-void-fg-1 hover:bg-white/5 transition-colors duration-150"
								onClick={handleSave}
								aria-label="Save to workspace"
								title="Save to workspace"
							>
								<FolderDown size={13} strokeWidth={1.75} />
							</button>
						)}
						<div className="w-px h-3.5 bg-void-border-3/40" aria-hidden />
						<button
							type="button"
							className="p-1.5 rounded text-void-fg-4/60 hover:text-void-fg-1 hover:bg-white/5 transition-colors duration-150"
							onClick={() => setCollapsed(v => !v)}
							aria-label={collapsed ? 'Expand plan' : 'Collapse plan'}
							aria-expanded={!collapsed}
							title={collapsed ? 'Expand' : 'Collapse'}
						>
							<ChevronDown
								size={13}
								strokeWidth={1.75}
								className={`transition-transform duration-200 ${collapsed ? '' : 'rotate-180'}`}
							/>
						</button>
					</div>
				</div>

				{/* Body — window-agnostic collapse (framer height:'auto' measures via the
				    main-window getComputedStyle and hides content in the Agents pop-out). */}
				<CollapsibleSection isOpen={!collapsed} duration={0.2}>
					<div
						className="border-t"
						style={{ borderColor: 'rgba(var(--vscode-void-border-3-rgb, 64, 64, 64), 0.15)' }}
					>
						<div
								className="orbit-card-enter flex flex-col gap-2 px-2.5 pt-2.5 pb-2"
							>
								<h3 className="text-void-fg-0 text-[13px] font-semibold leading-tight tracking-tight m-0">
									{displayTitle}
								</h3>

								{hasOverview && (
									<p
										className="text-void-fg-2 text-[12px] leading-[1.5] m-0 break-words line-clamp-2"
										title={displayOverview}
									>
										{displayOverview}
									</p>
								)}

								{hasTodos && (
									<div
										className="rounded-lg border px-2.5 py-2 flex flex-col gap-1"
										style={{
											borderColor: 'rgba(var(--vscode-void-border-3-rgb, 64, 64, 64), 0.2)',
											backgroundColor: 'color-mix(in srgb, var(--vscode-editor-background) 60%, transparent)',
										}}
									>
										<div className="flex items-center justify-between text-void-fg-4 text-[11px] font-medium tracking-wide">
											<span>{displayTodos.length} To-do{displayTodos.length !== 1 ? 's' : ''}</span>
											<span className="tabular-nums">{completedCount}/{displayTodos.length}</span>
										</div>
										<div className="flex flex-col gap-1">
											{visibleTodos.map(todo => (
												<TodoRow key={todo.id} todo={todo} compact />
											))}
										</div>
										{hasMoreTodos && (
											<button
												type="button"
												className="self-start mt-0.5 rounded px-1 py-0.5 transition-colors hover:bg-[var(--vscode-list-hoverBackground)] text-[11px] text-void-fg-4"
												onClick={() => setShowAllTodos(v => !v)}
												aria-expanded={showAllTodos}
											>
												{showAllTodos ? 'Show less' : `Show all ${displayTodos.length} steps`}
											</button>
										)}
									</div>
								)}

								{isEmpty && (
									<p className="text-void-fg-4 text-[11.5px] leading-[1.5] m-0 italic">
										This plan has no overview or steps yet. Open the plan to add detail.
									</p>
								)}
							</div>

							{/* Footer */}
							<div
								className="flex items-center justify-between gap-2 border-t px-2.5 py-1.5"
								style={{ borderColor: 'rgba(var(--vscode-void-border-3-rgb, 64, 64, 64), 0.15)' }}
							>
								<ApprovalGhostButton
									onClick={handleViewPlan}
									ariaLabel="View plan"
									title={savedPath ?? 'Open plan'}
								>
									View Plan
								</ApprovalGhostButton>
								<div className="flex items-center gap-2 min-w-0 shrink-0">
									<ModelDropdown featureName="Chat" className="text-[11px]" />
									<PlanBuildButton
										threadId={threadId}
										isDraft={isDraft}
										onBuild={handleBuild}
									/>
								</div>
							</div>
					</div>
				</CollapsibleSection>
			</EditToolCardWrapper>
		</ToolChildrenWrapper>
	);
};
