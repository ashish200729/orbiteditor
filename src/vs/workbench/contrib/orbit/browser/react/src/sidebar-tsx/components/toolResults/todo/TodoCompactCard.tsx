/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useMemo, useState } from 'react';
import { ChevronDown, ListTodo } from 'lucide-react';
import { TodoItem } from '../../../../../../../common/chatThreadServiceTypes.js';
import { getTodoDisplayText, normalizeTodoList } from '../../../../../../../common/todoToolHelpers.js';
import { TextShimmer } from '../../../../util/TextShimmer.js';
import {
	getBubbleExpandedTodos,
	getBubbleTodoProgress,
	getCardPreviewTodos,
	getNextActiveTodo,
	TODO_CARD_PREVIEW_ROWS,
	TodoCardPreviewMode,
} from './todoState.js';
import { TodoRow } from './TodoRow.js';
import { TodoStatusIcon } from './TodoStatusIcon.js';
import { CollapsibleSection } from '../../wrappers/CollapsibleSection.js';

const BUBBLE_EXPANDED_MAX_ROWS = 8;

export type TodoCompactCardProps = {
	todos: TodoItem[];
	variant?: 'bubble' | 'inline';
	previewMode?: TodoCardPreviewMode;
	maxPreviewRows?: number;
	defaultExpanded?: boolean;
	isStreaming?: boolean;
};

const InlineTodoCompactCard = ({
	todos,
	previewMode,
	maxPreviewRows,
	defaultExpanded = false,
	isStreaming = false,
}: Omit<TodoCompactCardProps, 'variant'>) => {
	const [isExpanded, setIsExpanded] = useState(defaultExpanded);

	const normalizedTodos = useMemo(() => normalizeTodoList(todos), [todos]);
	const resolvedPreviewMode = previewMode ?? 'update';
	const resolvedMaxRows = maxPreviewRows ?? TODO_CARD_PREVIEW_ROWS;

	const previewTodos = useMemo(
		() => getCardPreviewTodos(normalizedTodos, { maxRows: resolvedMaxRows, mode: resolvedPreviewMode }),
		[normalizedTodos, resolvedMaxRows, resolvedPreviewMode],
	);

	const visibleTodos = isExpanded ? normalizedTodos : previewTodos;
	const activeCount = normalizedTodos.filter(
		t => t.status !== 'completed' && t.status !== 'cancelled',
	).length;
	const displayCount = activeCount > 0 ? activeCount : normalizedTodos.length;
	const hasMore = normalizedTodos.length > previewTodos.length;

	const handleToggle = useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
		setIsExpanded(prev => !prev);
	}, []);

	if (!normalizedTodos.length && !isStreaming) {
		return null;
	}

	return (
		<div
			className="w-full min-w-0 my-1"
			data-todo-card
			onClick={(e) => e.stopPropagation()}
			onKeyDown={(e) => e.stopPropagation()}
		>
			<div
				className="rounded-xl border overflow-hidden w-full min-w-0"
				style={{
					borderColor: 'var(--vscode-panel-border)',
					backgroundColor: 'var(--vscode-sideBar-background)',
				}}
			>
				<div className="flex items-center gap-2 min-w-0 px-3 py-2.5">
					<ListTodo
						className="w-4 h-4 flex-shrink-0"
						style={{ color: 'var(--vscode-descriptionForeground)' }}
						strokeWidth={1.75}
						aria-hidden
					/>
					{isStreaming && normalizedTodos.length === 0 ? (
						<TextShimmer duration={2} spread={2} className="text-sm flex-shrink-0">
							To-dos
						</TextShimmer>
					) : (
						<span
							className="flex-shrink-0 text-sm"
							style={{ color: 'var(--vscode-foreground)' }}
						>
							To-dos
						</span>
					)}
					{displayCount > 0 && (
						<span
							className="tabular-nums flex-shrink-0 text-sm"
							style={{ color: 'var(--vscode-descriptionForeground)' }}
						>
							{displayCount}
						</span>
					)}
					{(hasMore || isExpanded) && normalizedTodos.length > 0 && (
						<button
							type="button"
							className="ml-auto flex-shrink-0 rounded px-1 py-0.5 transition-colors hover:bg-[var(--vscode-list-hoverBackground)] text-xs"
							style={{ color: 'var(--vscode-descriptionForeground)' }}
							onClick={handleToggle}
							aria-expanded={isExpanded}
						>
							{isExpanded ? 'Show less' : 'View all'}
						</button>
					)}
				</div>

				{visibleTodos.length > 0 && (
					<CollapsibleSection isOpen={visibleTodos.length > 0} duration={0.18}>
						<div
							className="overflow-y-auto overflow-x-hidden py-0.5 max-h-[280px] border-t"
							style={{ borderColor: 'var(--vscode-panel-border)' }}
						>
							{visibleTodos.map(todo => (
								<div key={todo.id} className="px-1">
									<TodoRow todo={todo} />
								</div>
							))}
						</div>
					</CollapsibleSection>
				)}
			</div>
		</div>
	);
};

/** Flat, Cursor-style todo strip merged into the user message bubble (not a nested card). */
const BubbleTodoCompactCard = ({
	todos,
	defaultExpanded = false,
	isStreaming = false,
}: Pick<TodoCompactCardProps, 'todos' | 'defaultExpanded' | 'isStreaming'>) => {
	const [isExpanded, setIsExpanded] = useState(defaultExpanded);

	const normalizedTodos = useMemo(() => normalizeTodoList(todos), [todos]);
	const headerTodo = useMemo(() => getNextActiveTodo(normalizedTodos), [normalizedTodos]);
	const progress = useMemo(() => getBubbleTodoProgress(normalizedTodos), [normalizedTodos]);

	const hasOpenWork = normalizedTodos.some(
		t => t.status === 'pending' || t.status === 'in_progress',
	);
	const allDone = normalizedTodos.length > 0 && !hasOpenWork;

	const headerTodoId = allDone ? null : (headerTodo?.id ?? null);

	const expandedTodos = useMemo(
		() => getBubbleExpandedTodos(normalizedTodos, headerTodoId, BUBBLE_EXPANDED_MAX_ROWS),
		[normalizedTodos, headerTodoId],
	);

	const headerLabel = useMemo(() => {
		if (isStreaming && normalizedTodos.length === 0) {
			return null;
		}
		if (allDone) {
			return 'All done';
		}
		if (headerTodo) {
			return getTodoDisplayText(headerTodo);
		}
		return null;
	}, [allDone, headerTodo, isStreaming, normalizedTodos.length]);

	const headerIconStatus = allDone
		? 'completed' as const
		: (headerTodo?.status ?? 'pending');

	const isHeaderActive = headerTodo?.status === 'in_progress';

	const handleToggle = useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
		if (normalizedTodos.length === 0 || expandedTodos.length === 0) {
			return;
		}
		setIsExpanded(prev => !prev);
	}, [expandedTodos.length, normalizedTodos.length]);

	if (!normalizedTodos.length && !isStreaming) {
		return null;
	}

	const showProgress = normalizedTodos.length > 0;
	const canExpand = expandedTodos.length > 0;

	return (
		<div
			className="w-full min-w-0"
			data-todo-card
			data-todo-variant="bubble"
			onClick={(e) => e.stopPropagation()}
			onKeyDown={(e) => e.stopPropagation()}
		>
			{isStreaming && normalizedTodos.length === 0 ? (
				<div className="py-1.5">
					<TextShimmer duration={2} spread={2} className="text-sm text-void-fg-4">
						To-dos
					</TextShimmer>
				</div>
			) : (
				<>
					<button
						type="button"
						className={`w-full flex items-center gap-1.5 min-w-0 py-1.5 text-left ${canExpand ? 'cursor-pointer hover:opacity-90' : 'cursor-default'}`}
						onClick={handleToggle}
						aria-expanded={isExpanded}
						disabled={!canExpand}
					>
						{canExpand ? (
							<ChevronDown
								className={`h-3.5 w-3.5 flex-shrink-0 text-void-fg-4 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
								aria-hidden
							/>
						) : (
							<span className="w-3.5 flex-shrink-0" aria-hidden />
						)}
						{!isStreaming && normalizedTodos.length > 0 && (
							<TodoStatusIcon status={headerIconStatus} />
						)}
						<span
							className={`flex-1 min-w-0 truncate text-sm ${allDone ? 'text-void-fg-4' : isHeaderActive ? 'text-void-fg-1 font-medium' : 'text-void-fg-1'}`}
						>
							{headerLabel}
						</span>
						{showProgress && (
							<span className="text-xs tabular-nums text-void-fg-4 flex-shrink-0">
								{progress.current}/{progress.total}
							</span>
						)}
					</button>

					<CollapsibleSection isOpen={isExpanded && expandedTodos.length > 0} duration={0.18}>
						<div className="overflow-y-auto overflow-x-hidden pb-0.5 max-h-[140px] space-y-0.5">
							{expandedTodos.map(todo => (
								<div key={`${todo.id}-${todo.status}`} className="pl-0.5">
									<TodoRow todo={todo} compact />
								</div>
							))}
						</div>
					</CollapsibleSection>
				</>
			)}
		</div>
	);
};

/** Premium compact To-dos card (message bubble + tool stream). */
export const TodoCompactCard = ({
	todos,
	variant = 'bubble',
	previewMode,
	maxPreviewRows,
	defaultExpanded = false,
	isStreaming = false,
}: TodoCompactCardProps) => {
	if (variant === 'bubble') {
		return (
			<BubbleTodoCompactCard
				todos={todos}
				defaultExpanded={defaultExpanded}
				isStreaming={isStreaming}
			/>
		);
	}

	return (
		<InlineTodoCompactCard
			todos={todos}
			previewMode={previewMode}
			maxPreviewRows={maxPreviewRows}
			defaultExpanded={defaultExpanded}
			isStreaming={isStreaming}
		/>
	);
};
