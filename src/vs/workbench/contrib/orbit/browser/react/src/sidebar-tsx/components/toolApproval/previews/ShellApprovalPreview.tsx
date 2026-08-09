/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { BuiltinToolCallParams } from '../../../../../../../common/toolsServiceTypes.js';
import {
	getShellCardCommandLine,
	getShellCardMetaTags,
	ShellCommandHighlight,
} from '../../toolResults/shellToolCardHelpers.js';
import { toolApprovalTheme } from '../toolApprovalTheme.js';

/**
 * Shell / AwaitShell preview for the approval card.
 *
 * Reuses the existing `shellToolCardHelpers` (same command-line extractor,
 * meta-tag builder, and syntax highlighter) so the approval preview matches
 * the post-approval `ShellToolCard` exactly. The command renders in a
 * monospace terminal block with a `$` prefix; meta tags (cwd, background, notify…)
 * appear as a compact pill row beneath it.
 */
export const ShellApprovalPreview = ({
	toolName,
	params,
}: {
	toolName: 'Shell' | 'AwaitShell',
	params: BuiltinToolCallParams['Shell'] | BuiltinToolCallParams['AwaitShell'],
}) => {
	const commandLine = getShellCardCommandLine(toolName, params);
	const metaTags = getShellCardMetaTags(toolName, params);
	const workingDirectory = toolName === 'Shell'
		? (params as BuiltinToolCallParams['Shell']).workingDirectory
		: null;

	return (
		<div className="px-3 py-2.5 flex flex-col gap-2">
			{workingDirectory && (
				<div
					className="flex items-start gap-2 rounded-md px-2.5 py-1.5 text-[11px]"
					style={{ color: toolApprovalTheme.descFg, border: `1px solid ${toolApprovalTheme.terminalBorder}` }}
					title={workingDirectory}
				>
					<span className="font-medium flex-shrink-0">cwd</span>
					<code className="min-w-0 break-all" style={{ color: toolApprovalTheme.fg }}>{workingDirectory}</code>
				</div>
			)}
			{commandLine ? (
				<div
					className="rounded-md px-2.5 py-2 overflow-x-auto void-custom-scrollable"
					style={{
						background: toolApprovalTheme.terminalBg,
						border: `1px solid ${toolApprovalTheme.terminalBorder}`,
					}}
				>
					<div
						className="flex items-start gap-1.5 font-mono text-[12px] leading-relaxed whitespace-pre"
						style={{ color: toolApprovalTheme.fg }}
					>
						{toolName === 'Shell' && (
							<span
								className="select-none flex-shrink-0"
								style={{ color: toolApprovalTheme.descFg }}
							>
								$
							</span>
						)}
						<span className="min-w-0 break-words">
							{toolName === 'Shell' && commandLine
								? <ShellCommandHighlight command={commandLine} />
								: <span style={{ color: toolApprovalTheme.descFg }}>{commandLine}</span>
							}
						</span>
					</div>
				</div>
			) : (
				<div
					className="text-[11.5px] italic px-1"
					style={{ color: toolApprovalTheme.descFg }}
				>
					No command specified
				</div>
			)}

			{metaTags.length > 0 && (
				<div className="flex items-center flex-wrap gap-1.5">
					{metaTags.map((tag, i) => (
						<span
							key={`${tag}-${i}`}
							className="text-[10.5px] px-1.5 py-0.5 rounded font-medium whitespace-nowrap"
							style={{
								color: toolApprovalTheme.descFg,
								background: 'rgba(128, 128, 128, 0.1)',
								border: `1px solid ${toolApprovalTheme.terminalBorder}`,
							}}
						>
							{tag}
						</span>
					))}
				</div>
			)}
		</div>
	);
};
