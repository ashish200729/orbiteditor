/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useMemo } from 'react';
import { ExecutionTargetPicker } from '../sidebar-tsx/components/chat/ExecutionTargetPicker.js';
import { RunnerBranchDropdown, useWorkspaceGitForRunner } from '../sidebar-tsx/components/chat/RunnerBranchDropdown.js';
import { useChatThreadsState, useRemoteTasks, useSettingsState } from '../util/services.js';
import { parseExecutionTargetId } from '../../../../common/runner/runnerTypes.js';

const REMOTE_TERMINAL_STATES: ReadonlySet<string> = new Set([
	'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LOST',
]);

/**
 * Compact "Run on" + optional branch picker for Self-hosted Runner landing chrome.
 * Branch selection persists via runnerBranchByRepository and stays in sync across
 * hook instances (see useWorkspaceGitForRunner settings subscription).
 */
export const RunnerExecutionChrome = ({
	isAgentWindow = false,
}: {
	isAgentWindow?: boolean;
}) => {
	const settingsState = useSettingsState();
	const isRemoteTarget = parseExecutionTargetId(settingsState.globalSettings.executionTarget) !== 'local';
	const workspaceGit = useWorkspaceGitForRunner(isAgentWindow);
	const remoteTasks = useRemoteTasks();
	const chatThreadsState = useChatThreadsState();
	const threadId = isAgentWindow
		? chatThreadsState.agentWindowThreadId
		: chatThreadsState.currentThreadId;

	const hasInFlightRemoteWork = useMemo(() => {
		if (!threadId) {
			return false;
		}
		return remoteTasks.some(task =>
			task.editorThreadId === threadId
			&& !REMOTE_TERMINAL_STATES.has(task.state),
		);
	}, [remoteTasks, threadId]);

	return (
		<div className="agent-chat-run-header flex flex-row flex-nowrap items-center gap-1.5 min-w-0 w-full">
			<ExecutionTargetPicker className="min-w-0 shrink" />
			{isRemoteTarget ? (
				<RunnerBranchDropdown
					className="shrink"
					loading={workspaceGit.loading}
					root={workspaceGit.root}
					branch={workspaceGit.branch}
					branches={workspaceGit.branches}
					onSelectBranch={workspaceGit.selectBranch}
					disabled={hasInFlightRemoteWork}
				/>
			) : null}
		</div>
	);
};
