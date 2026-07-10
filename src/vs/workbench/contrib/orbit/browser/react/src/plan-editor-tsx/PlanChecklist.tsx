/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import {
	parseNumberedTodoMarkdown,
	parseTodosFromMarkdown,
	togglePlanChecklistTodoStatus,
	addPlanChecklistTodo,
} from '../../../../common/planTemplate.js';
import { TodoRow } from '../sidebar-tsx/components/toolResults/todo/TodoRow.js';
import { ApprovalGhostButton } from '../sidebar-tsx/components/toolApproval/ApprovalButton.js';
import '../styles.css';

type ChecklistTodo = {
	id: string;
	content: string;
	status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
};

/**
 * Extract checklist todos from a plan's raw markdown. Falls back to generic
 * markdown todo parsing if the numbered checklist format yields nothing.
 */
const parseChecklistTodos = (rawContent: string): ChecklistTodo[] => {
	const body = rawContent.replace(/^---\n[\s\S]*?\n---\n*/, '');
	const checklistMatch = body.match(/## Implementation Checklist\n([\s\S]*?)(?=\n## |\n*$)/i);
	const checklistContent = checklistMatch?.[1]?.trim() ?? '';
	let todos = parseNumberedTodoMarkdown(checklistContent);
	if (todos.length === 0) {
		todos = parseTodosFromMarkdown(checklistContent || body);
	}
	return todos;
};

export interface PlanChecklistProps {
	rawContent: string;
	onContentChange: (content: string) => void;
}

/**
 * Interactive checklist for the Plan Editor's preview mode — replaces the dead
 * `PlanChecklistPanel.tsx` (which had a `window.prompt` dialog, a hardcoded
 * fake "Referenced by 1 Agent" string, and dead unused selection state).
 *
 * Renders each todo via the shared `TodoRow` + `TodoStatusIcon` components
 * (same ones `TodoCompactCard` uses), wrapped in a click target that toggles
 * status through `togglePlanChecklistTodoStatus` → `onContentChange` (which
 * feeds the editor's auto-save). Adding a step is an inline input revealed by
 * the "+ Add step" ghost button — no native `window.prompt`.
 */
export const PlanChecklist: React.FC<PlanChecklistProps> = ({ rawContent, onContentChange }) => {
	const todos = useMemo(() => parseChecklistTodos(rawContent), [rawContent]);
	const [isAdding, setIsAdding] = useState(false);
	const [newStepText, setNewStepText] = useState('');

	const handleToggleStatus = useCallback((id: string) => {
		const updated = togglePlanChecklistTodoStatus(rawContent, id);
		onContentChange(updated);
	}, [rawContent, onContentChange]);

	const commitAddStep = useCallback(() => {
		const text = newStepText.trim();
		if (!text) {
			setIsAdding(false);
			return;
		}
		const updated = addPlanChecklistTodo(rawContent, text);
		onContentChange(updated);
		setNewStepText('');
		setIsAdding(false);
	}, [newStepText, rawContent, onContentChange]);

	const cancelAddStep = useCallback(() => {
		setNewStepText('');
		setIsAdding(false);
	}, []);

	const completedCount = todos.filter(t => t.status === 'completed').length;

	return (
		<section
			className="mt-6 max-w-4xl mx-auto px-12 pb-12"
			aria-label="Implementation checklist"
		>
			<div
				className="rounded-xl border overflow-hidden"
				style={{
					borderColor: 'var(--vscode-panel-border)',
					backgroundColor: 'var(--vscode-sideBar-background)',
				}}
			>
				<div className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: 'var(--vscode-panel-border)' }}>
					<span className="text-sm font-medium" style={{ color: 'var(--vscode-foreground)' }}>
						Checklist
					</span>
					<span className="text-xs tabular-nums" style={{ color: 'var(--vscode-descriptionForeground)' }}>
						{completedCount}/{todos.length}
					</span>
					<div className="ml-auto">
						<ApprovalGhostButton
							onClick={() => setIsAdding(true)}
							ariaLabel="Add step to checklist"
							title="Add step"
						>
							<Plus size={11} strokeWidth={2.25} aria-hidden />
							<span>Add step</span>
						</ApprovalGhostButton>
					</div>
				</div>

				{todos.length === 0 && !isAdding && (
					<div className="px-4 py-6 text-center">
						<p className="text-xs" style={{ color: 'var(--vscode-descriptionForeground)' }}>
							No steps yet. Click <span className="font-medium">Add step</span> to build the checklist.
						</p>
					</div>
				)}

				{todos.length > 0 && (
					<div className="py-1">
						{todos.map(todo => (
							<div
								key={todo.id}
								className="px-3 py-0.5 transition-colors hover:bg-[var(--vscode-list-hoverBackground)]"
								style={{ cursor: 'pointer' }}
								onClick={(e) => {
									e.stopPropagation();
									handleToggleStatus(todo.id);
								}}
							>
								<TodoRow todo={todo} />
							</div>
						))}
					</div>
				)}

				{isAdding && (
					<div className="px-3 py-2 border-t" style={{ borderColor: 'var(--vscode-panel-border)' }}>
						<input
							type="text"
							value={newStepText}
							autoFocus
							placeholder="Describe the step…"
							onChange={(e) => setNewStepText(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter') {
									e.preventDefault();
									commitAddStep();
								} else if (e.key === 'Escape') {
									e.preventDefault();
									cancelAddStep();
								}
							}}
							onBlur={commitAddStep}
							className="w-full bg-transparent text-sm outline-none border-b border-transparent focus:border-[var(--vscode-focusBorder)] py-1"
							style={{ color: 'var(--vscode-input-foreground)' }}
						/>
					</div>
				)}
			</div>
		</section>
	);
};
