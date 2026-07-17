/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useMemo, useRef } from 'react';
import { TodoItem, TodoWriteItem } from '../../../../../../../common/chatThreadServiceTypes.js';
import { useTodoContext } from '../../../contexts/TodoContext.js';
import { TodoCompactCard } from './TodoCompactCard.js';
import { TodoUpdateStatusLine } from './TodoUpdateStatusLine.js';
import { getTodoUpdatePresentation } from './todoLabels.js';
import { applyTodoWrite, getBubbleTodoProgress, TODO_CARD_PREVIEW_ROWS } from './todoState.js';

export const TodoToolWithState = ({
	todos,
	threadId,
	toolCallId,
	isStreaming = false,
	previousTodosAtMessage,
	merge = false,
}: {
	todos: TodoWriteItem[];
	threadId: string;
	toolCallId: string;
	isStreaming?: boolean;
	previousTodosAtMessage: TodoItem[];
	merge?: boolean;
}) => {
	const { updateTodoState, getTodoState, liveTodos, isAgentRunning } = useTodoContext();
	const lastPushedRef = useRef<string>('');

	const afterTodos = useMemo(
		() => applyTodoWrite(previousTodosAtMessage, todos, merge),
		[previousTodosAtMessage, todos, merge],
	);

	useEffect(() => {
		if (!isStreaming) {
			return;
		}
		const key = JSON.stringify(afterTodos);
		if (lastPushedRef.current === key) {
			return;
		}
		lastPushedRef.current = key;
		updateTodoState(threadId, afterTodos, toolCallId, true);
	}, [isStreaming, afterTodos, threadId, toolCallId, updateTodoState]);

	const todoState = getTodoState(threadId);
	const isCreation = todoState.creationToolCallId === toolCallId;

	const presentation = useMemo(
		() => getTodoUpdatePresentation(afterTodos, previousTodosAtMessage),
		[afterTodos, previousTodosAtMessage],
	);

	const showCompactCard = isCreation || presentation.kind === 'created';
	const previewMode = isCreation || !merge ? 'creation' : 'update';

	const todosForDisplay = useMemo(() => {
		if (!showCompactCard || !isCreation || liveTodos.length === 0) {
			return afterTodos;
		}
		const localProgress = getBubbleTodoProgress(afterTodos).current;
		const liveProgress = getBubbleTodoProgress(liveTodos).current;
		if (isAgentRunning || liveProgress > localProgress) {
			return liveTodos;
		}
		return afterTodos;
	}, [showCompactCard, isCreation, isAgentRunning, liveTodos, afterTodos]);

	if (showCompactCard) {
		return (
			<TodoCompactCard
				todos={todosForDisplay}
				variant="bubble"
				previewMode={previewMode}
				maxPreviewRows={TODO_CARD_PREVIEW_ROWS}
				defaultExpanded={isStreaming}
				isStreaming={isStreaming}
			/>
		);
	}

	return (
		<TodoUpdateStatusLine presentation={presentation} isStreaming={isStreaming} />
	);
};
