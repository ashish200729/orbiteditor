/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ToolMessage } from '../../../../../../common/chatThreadServiceTypes.js';
import { ToolName } from '../../../../../../common/toolsServiceTypes.js';
import { EditToolCardWrapper } from './EditToolCardWrapper.js';
import { EditToolCardHeader } from './EditToolCardHeader.js';
import { EditToolCardContent } from './EditToolCardContent.js';
import { EditToolErrorMessage } from './EditToolErrorMessage.js';
import { computeDiffStats, estimateDiffStats } from './unifiedDiffUtils.js';
import { pathStringToUri } from '../../utils/fileUtils.js';
import { URI } from '../../../../../../../../../base/common/uri.js';
import { getEditToolDisplayContent, getEditToolPathParam } from './editToolDisplayData.js';
import { ToolApprovalActions } from '../toolApproval/ToolApprovalActions.js';
import { toolApprovalTheme } from '../toolApproval/toolApprovalTheme.js';

type WrapperProps<T extends ToolName> = {
	toolMessage: Exclude<ToolMessage<T>, { type: 'invalid_params' }>,
	messageIdx: number,
	threadId: string
}

type LegacyEditToolName = 'edit_file' | 'rewrite_file' | 'create_file_or_folder'

export type EditToolMessage = Exclude<ToolMessage<'StrReplace' | 'Write'>, { type: 'invalid_params' }> & {
	name: 'StrReplace' | 'Write' | LegacyEditToolName
}

export const EditTool = React.memo(({
	toolMessage,
	threadId,
	messageIdx,
}: WrapperProps<'StrReplace' | 'Write'> & { toolMessage: EditToolMessage }) => {
	const isAwaiting = toolMessage.type === 'tool_request'
	const isExecuting = toolMessage.type === 'running_now'
	const isRunning = isAwaiting || isExecuting
	const isRejected = toolMessage.type === 'rejected'

	const params = toolMessage.type !== 'invalid_params' ? toolMessage.params : undefined
	const { content, oldString, newString, hasContent, type: editToolType } = getEditToolDisplayContent(toolMessage.name, params, toolMessage.rawParams)
	const pathStr = getEditToolPathParam(params, toolMessage.rawParams)
	let uri: URI | undefined
	if (pathStr) {
		try {
			uri = typeof pathStr === 'string' ? pathStringToUri(pathStr) : pathStr
		} catch {
			uri = undefined
		}
	}

	// The exact LCS diff on every streamed chunk is quadratic across the stream, and it duplicates
	// the diff UnifiedDiffView computes for the body. While running, show a cheap line-count
	// estimate; the exact stats are computed once when the tool settles.
	const diffStats = useMemo(() => {
		if (!(editToolType === 'strReplace' || editToolType === 'rewrite') || newString === undefined) {
			return { additions: 0, deletions: 0 }
		}
		return isRunning
			? estimateDiffStats(oldString ?? '', newString)
			: computeDiffStats(oldString ?? '', newString)
	}, [editToolType, oldString, newString, isRunning])

	return (
		<EditToolCardWrapper
			isRunning={isRunning}
			isAwaitingApproval={isAwaiting}
			className={isRejected ? 'opacity-70' : ''}
		>
			<EditToolCardHeader
				toolMessage={toolMessage}
				isRunning={isRunning}
				threadId={threadId}
				messageIdx={messageIdx}
				content={content}
				additions={diffStats.additions}
				deletions={diffStats.deletions}
				hasContent={hasContent || isRunning}
			/>

			{(hasContent || isRunning) && (
				<EditToolCardContent
					uri={uri}
					code={content}
					type={editToolType}
					oldString={oldString}
					newString={newString}
					isRunning={isRunning}
				/>
			)}

			{toolMessage.type === 'tool_error' && (
				<EditToolErrorMessage
					error={toolMessage.result && typeof toolMessage.result === 'string' ? toolMessage.result : 'An error occurred'}
				/>
			)}

			{isAwaiting && (
				<div style={{ borderTop: `1px solid ${toolApprovalTheme.subtleDivider}` }}>
					<ToolApprovalActions
						toolName={toolMessage.name}
						toolId={toolMessage.id}
						threadId={threadId}
					/>
				</div>
			)}

			{hasContent && (toolMessage.type === 'success' || toolMessage.type === 'rejected') &&
				toolMessage.result?.lintErrors && toolMessage.result.lintErrors.length > 0 && (
				<div
					className="px-2.5 py-1.5"
					style={{
						borderTop: '1px solid rgba(var(--vscode-void-border-3-rgb, 64, 64, 64), 0.15)',
						background: 'rgba(var(--vscode-void-bg-2-rgb, 16, 16, 16), 0.25)'
					}}
				>
					<div className="flex items-start gap-2 mb-2">
						<AlertTriangle
							size={11}
							className="text-void-fg-4 opacity-50 flex-shrink-0 mt-0.5"
							strokeWidth={2}
						/>
						<div className="text-void-fg-4 text-[10px] font-medium opacity-65">
							Lint Issues ({toolMessage.result.lintErrors.length})
						</div>
					</div>
					<div className="space-y-2 ml-3.5">
						{toolMessage.result.lintErrors.map((error, i) => (
							<div key={i} className="text-[9.5px] leading-relaxed">
								<div className="text-void-fg-4/35 mb-0.5 text-[9px] font-medium">
									Lines {error.startLineNumber}-{error.endLineNumber}
								</div>
								<div className="text-void-fg-4 opacity-70">
									{error.message}
								</div>
							</div>
						))}
					</div>
				</div>
			)}
		</EditToolCardWrapper>
	)
});
