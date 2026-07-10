/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { TodoItem } from '../../../../../../../common/chatThreadServiceTypes.js';
import { getTodoDisplayText } from '../../../../../../../common/todoToolHelpers.js';
import { TodoStatusIcon } from './TodoStatusIcon.js';

type TodoRowProps = {
	todo: TodoItem;
	compact?: boolean;
	/** Optional click handler. When provided, the row is wrapped in a clickable
	 * target. TodoCompactCard (the only other consumer) does not pass this, so
	 * existing behavior is unchanged. */
	onClick?: () => void;
};

export const TodoRow = ({ todo, compact = false, onClick }: TodoRowProps) => {
	const isDone = todo.status === 'completed' || todo.status === 'cancelled';
	const isActive = todo.status === 'in_progress';

	const inner = (
		<>
			<TodoStatusIcon status={todo.status} />
			<span
				className={`text-xs flex-1 min-w-0 truncate ${isDone ? 'line-through opacity-60' : ''}`}
				style={{
					color: isActive ? 'var(--vscode-foreground)' : 'var(--vscode-descriptionForeground)',
					fontWeight: isActive ? 500 : 400,
				}}
			>
				{getTodoDisplayText(todo)}
			</span>
		</>
	);

	if (onClick) {
		return (
			<button
				type="button"
				onClick={onClick}
				className={`flex items-center gap-2 min-w-0 w-full text-left ${compact ? 'min-h-[20px]' : 'min-h-[22px]'} cursor-pointer`}
			>
				{inner}
			</button>
		);
	}

	return (
		<div className={`flex items-center gap-2 min-w-0 ${compact ? 'min-h-[20px]' : 'min-h-[22px]'}`}>
			{inner}
		</div>
	);
};
