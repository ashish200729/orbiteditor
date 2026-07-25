/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useMemo } from 'react';
import { RotateCcw } from 'lucide-react';
import { useAccessor, useRemoteTasks, useThreadRunningState } from '../../../util/services.js';

type CheckpointProps = {
	threadId: string;
	userMessageIdx: number;
	checkpointIdx: number;
	currCheckpointIdx: number | undefined;
	isFirstUserMessage: boolean;
};

export const Checkpoint = ({
	threadId,
	userMessageIdx,
	checkpointIdx,
	currCheckpointIdx,
	isFirstUserMessage,
}: CheckpointProps) => {
	const accessor = useAccessor();
	const chatThreadService = accessor.get('IChatThreadService');
	const isRunning = useThreadRunningState(threadId);
	const remoteTasks = useRemoteTasks();
	const remoteIsRunning = remoteTasks.some(task => task.editorThreadId === threadId
		&& !['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LOST'].includes(task.state));

	const isDisabled = useMemo(() => {
		// U4: disable restore only when THIS thread is running (local or remote),
		// not when any other thread is running. Restoring an idle thread while
		// another runs in the background is safe and expected.
		if (isRunning || remoteIsRunning) return true;
		return false;
	}, [isRunning, remoteIsRunning]);

	const isActive = currCheckpointIdx !== undefined && currCheckpointIdx === checkpointIdx;

	const handleRestore = () => {
		if (isDisabled) return;
		chatThreadService.jumpToCheckpointBeforeMessageIdx({
			threadId,
			messageIdx: userMessageIdx,
			jumpToUserModified: false,
		});
	};

	return (
		<div
			className={`group/checkpoint flex items-center gap-2 w-full select-none ${isFirstUserMessage ? 'mt-1' : 'mt-4 mb-1'}`}
		>
			<div className="flex-1 h-px bg-void-border-2 opacity-60 group-hover/checkpoint:opacity-100 transition-opacity" />
			<button
				type="button"
				disabled={isDisabled}
				onClick={handleRestore}
				className={`
					flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium
					border transition-all duration-150 shrink-0
					${isActive
						? 'border-void-border-1 bg-void-bg-2 text-void-fg-2'
						: 'border-transparent bg-transparent text-void-fg-3 group-hover/checkpoint:border-void-border-2 group-hover/checkpoint:bg-void-bg-2 group-hover/checkpoint:text-void-fg-2'
					}
					${isDisabled ? 'cursor-default opacity-50' : 'cursor-pointer'}
				`}
			{...(isDisabled ? {
				'data-tooltip-id': 'void-tooltip',
				'data-tooltip-content': `Disabled while agent is running`,
				'data-tooltip-place': 'top',
			} : {
					'data-tooltip-id': 'void-tooltip',
					'data-tooltip-content': 'Restore code to before this message',
					'data-tooltip-place': 'top',
				})}
			>
				<RotateCcw size={11} className={isActive ? 'opacity-80' : 'opacity-60 group-hover/checkpoint:opacity-80'} />
				<span>{isActive ? 'Restored here' : 'Restore checkpoint'}</span>
			</button>
			<div className="flex-1 h-px bg-void-border-2 opacity-60 group-hover/checkpoint:opacity-100 transition-opacity" />
		</div>
	);
};
