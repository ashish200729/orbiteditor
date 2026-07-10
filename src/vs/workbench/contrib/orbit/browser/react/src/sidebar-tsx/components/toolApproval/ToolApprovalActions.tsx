/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback } from 'react';
import { ToolName, approvalTypeOfBuiltinToolName, ToolApprovalType } from '../../../../../../common/toolsServiceTypes.js';
import { isABuiltinToolName } from '../../../../../../common/prompt/prompts.js';
import { useAccessor, useChatThreadsStreamState } from '../../../util/services.js';
import { useIsReadOnlyChat } from '../../contexts/ReadOnlyChatContext.js';
import { toolApprovalTheme } from './toolApprovalTheme.js';
import {
	getRunActionLabel,
	getSkipLabel,
	getAlwaysRunLabel,
	getSkipAriaLabel,
	getApproveAriaLabel,
	getAlwaysRunAriaLabel,
} from './toolApprovalLabels.js';
import {
	ApprovalGhostButton,
	ApprovalPillButton,
	ApprovalPrimaryButton,
} from './ApprovalButton.js';

/**
 * Footer actions for the tool approval card — compact cluster:
 * `Skip · Always Run · Run ↵` (right-aligned).
 *
 * Same backend calls as before (`approveLatestToolRequest` /
 * `rejectLatestToolRequest`), same metrics events, same `isReadOnlyChat` /
 * `isDisabled` / `isDifferentPending` gating. What changed:
 *  - Copy: Skip / Always Run / Run (or "Approve" for non-terminal categories)
 *    instead of Deny / Approve / "Always allow X".
 *  - The separate auto-approve toggle switch is gone from this footer. It is
 *    collapsed into the single **Always Run** button: one click both flips
 *    the `autoApprove[type]` setting AND approves the current call — the same
 *    two existing service calls, fired together, no new state introduced.
 *    (The `ToolApprovalAutoApproveToggle` component itself is untouched —
 *    Settings.tsx still re-exports it as `ToolApprovalTypeSwitch`.)
 *  - Visuals come from the shared `ApprovalButton` primitives so the generic
 *    card, edit-diff card, and AskQuestion wizard share one button language.
 */
export type ToolApprovalActionsProps = {
	toolName: ToolName;
	toolId: string;
	threadId: string;
	/** Optional override for the primary approve button (e.g. "Open browser"). */
	approveLabelOverride?: string;
	approveAriaOverride?: string;
};

export const ToolApprovalActions = ({
	toolName,
	toolId,
	threadId,
	approveLabelOverride,
	approveAriaOverride,
}: ToolApprovalActionsProps) => {
	const isReadOnlyChat = useIsReadOnlyChat();
	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');
	const metricsService = accessor.get('IMetricsService');
	const voidSettingsService = accessor.get('IVoidSettingsService');
	const streamState = useChatThreadsStreamState(threadId);

	const isAwaiting = streamState?.isRunning === 'awaiting_user';
	const pendingToolRequestId = isAwaiting ? streamState.pendingToolRequestId : undefined;
	const isDifferentPending = !!(pendingToolRequestId && pendingToolRequestId !== toolId);
	const isDisabled = !isAwaiting || isDifferentPending;

	const onAccept = useCallback(() => {
		try {
			chatThreadsService.approveLatestToolRequest(threadId, toolId);
			metricsService.capture('Tool Request Accepted', {});
		} catch (e) { console.error('Error while approving message in chat:', e); }
	}, [chatThreadsService, metricsService, threadId, toolId]);

	const onReject = useCallback(() => {
		try {
			chatThreadsService.rejectLatestToolRequest(threadId, toolId);
		} catch (e) { console.error('Error while approving message in chat:', e); }
		metricsService.capture('Tool Request Rejected', {});
	}, [chatThreadsService, metricsService, threadId, toolId]);

	/**
	 * Combined "Always Run" action: flip the auto-approve setting for this
	 * tool's category to true, then approve the current call. One click, two
	 * existing service calls, no new state. Order matters — set the flag first
	 * so that by the time the approval resolves the setting already reflects
	 * the user's intent (and the Settings page updates in the same render).
	 */
	const onAlwaysRun = useCallback(() => {
		if (isDisabled) return;
		const type = isABuiltinToolName(toolName)
			? approvalTypeOfBuiltinToolName[toolName]
			: 'MCP tools';
		if (!type) return;
		try {
			voidSettingsService.setGlobalSetting('autoApprove', {
				...voidSettingsService.state.globalSettings.autoApprove,
				[type]: true,
			});
			metricsService.capture('Tool Auto-Accept Toggle', { enabled: true });
		} catch (e) { console.error('Error while enabling auto-approve:', e); }
		try {
			chatThreadsService.approveLatestToolRequest(threadId, toolId);
			metricsService.capture('Tool Request Accepted', {});
		} catch (e) { console.error('Error while approving message in chat:', e); }
	}, [isDisabled, toolName, voidSettingsService, metricsService, chatThreadsService, threadId, toolId]);

	if (isReadOnlyChat) return null;

	if (!toolId) {
		console.warn('ToolApprovalActions: Missing tool ID for tool:', toolName);
		return null;
	}

	const approvalType: ToolApprovalType | undefined = isABuiltinToolName(toolName)
		? approvalTypeOfBuiltinToolName[toolName]
		: 'MCP tools';

	const runLabel = approveLabelOverride ?? getRunActionLabel(approvalType);
	const runAria = approveAriaOverride ?? getApproveAriaLabel(approvalType);
	const skipLabel = getSkipLabel();
	const skipAria = getSkipAriaLabel(approvalType);
	const alwaysRunLabel = getAlwaysRunLabel(approvalType);
	const alwaysRunAria = getAlwaysRunAriaLabel(approvalType);

	return (
		<div
			className="flex items-center justify-end gap-2 px-3 py-2 flex-wrap"
			role="group"
			aria-label="Tool approval actions"
		>
			{isDifferentPending && (
				<span
					className="text-[10.5px] italic truncate mr-auto"
					style={{ color: toolApprovalTheme.descFg }}
					data-tooltip-id="void-tooltip"
					data-tooltip-content="Another action is waiting for your response first"
					data-tooltip-place="top"
				>
					Waiting for another action first
				</span>
			)}
			<ApprovalGhostButton
				disabled={isDisabled}
				ariaLabel={skipAria}
				onClick={onReject}
			>
				{skipLabel}
			</ApprovalGhostButton>
			<ApprovalPillButton
				disabled={isDisabled}
				ariaLabel={alwaysRunAria}
				onClick={onAlwaysRun}
				title={`Approve this run and enable auto-approve for ${approvalType ?? 'this tool category'}`}
			>
				{alwaysRunLabel}
			</ApprovalPillButton>
			<ApprovalPrimaryButton
				disabled={isDisabled}
				ariaLabel={runAria}
				onClick={onAccept}
				showEnterHint
			>
				{runLabel}
			</ApprovalPrimaryButton>
		</div>
	);
};
