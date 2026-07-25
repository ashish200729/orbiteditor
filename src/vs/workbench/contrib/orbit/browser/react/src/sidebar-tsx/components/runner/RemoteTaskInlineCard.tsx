/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { URI } from '../../../../../../../../../base/common/uri.js'
import { useAccessor } from '../../../util/services.js'
import { ToolApprovalCardShell } from '../toolApproval/ToolApprovalCardShell.js'
import { toolApprovalTheme } from '../toolApproval/toolApprovalTheme.js'
import { ShellApprovalPreview } from '../toolApproval/previews/ShellApprovalPreview.js'
import { GenericApprovalPreview } from '../toolApproval/previews/GenericApprovalPreview.js'
import {
	ApprovalGhostButton,
	ApprovalPillButton,
	ApprovalPrimaryButton,
} from '../toolApproval/ApprovalButton.js'
import {
	getAlwaysRunLabel,
	getRunActionLabel,
	getSkipLabel,
} from '../toolApproval/toolApprovalLabels.js'
import { normalizeRemoteToolStartParams } from '../../../../../../common/runner/remoteToolResultHelpers.js'
import { parseGitHubOrGitLabRemote } from '../../../../../../common/runner/gitRemoteHelpers.js'
import {
	parseArtifactBranch,
	parseArtifactPatch,
	parseArtifactPr,
} from '../../../../../../common/runner/remoteHandoffArtifacts.js'
import { approvalTypeOfBuiltinToolName, type BuiltinToolName, type ToolApprovalType, type ToolName } from '../../../../../../common/toolsServiceTypes.js'
import { resolveBuiltinToolNameLoose } from '../../../../../../common/prompt/prompts.js'
import type { BuiltinToolCallParams } from '../../../../../../common/toolsServiceTypes.js'

/**
 * Inline remote-task actions rendered at the end of a remote turn in the chat
 * transcript — approvals, Cursor-like handoff (Open PR / Checkout / Apply), reconnect.
 *
 * Approval UI matches the local agent: Shell gets a terminal preview card with
 * Skip · Always Run · Run (Always Run remembers for this remote run only).
 */
export const RemoteTaskInlineCard = ({
	taskId,
	workspaceRoot,
}: {
	taskId: string
	workspaceRoot: string | null
}) => {
	const accessor = useAccessor()
	const remoteTaskService = accessor.get('IRemoteTaskService')
	const [live, setLive] = useState(() => remoteTaskService.getLiveState(taskId))
	const [handoffStatus, setHandoffStatus] = useState<string | null>(null)
	const [handoffOk, setHandoffOk] = useState(false)

	useEffect(() => {
		const refresh = () => setLive(remoteTaskService.getLiveState(taskId))
		refresh()
		const d1 = remoteTaskService.onDidChangeTasks(refresh)
		const d2 = remoteTaskService.onDidReceiveEvent(({ taskId: id }) => {
			if (id === taskId) {
				refresh()
			}
		})
		return () => {
			d1.dispose()
			d2.dispose()
		}
	}, [taskId, remoteTaskService])

	const onReconnect = useCallback(async () => {
		await remoteTaskService.reconnect(taskId)
	}, [taskId, remoteTaskService])

	const pending = live?.pendingPermission
	const resolvedToolName = useMemo(() => {
		if (!pending?.toolName) return undefined
		return resolveBuiltinToolNameLoose(pending.toolName) ?? pending.toolName
	}, [pending?.toolName])

	const approvalType: ToolApprovalType | undefined = useMemo(() => {
		if (!resolvedToolName) return undefined
		return approvalTypeOfBuiltinToolName[resolvedToolName as BuiltinToolName]
	}, [resolvedToolName])

	const normalizedParams = useMemo(() => {
		if (!pending?.toolName) return undefined
		const rawArgs = (pending.toolArgs && typeof pending.toolArgs === 'object' && !Array.isArray(pending.toolArgs)
			? pending.toolArgs
			: {}) as Record<string, unknown>
		const name = (resolvedToolName ?? pending.toolName) as ToolName
		try {
			return normalizeRemoteToolStartParams(name, rawArgs)
		} catch {
			return undefined
		}
	}, [pending?.toolArgs, pending?.toolName, resolvedToolName])

	const onApprove = useCallback(async (decision: 'allow' | 'deny', remember?: boolean) => {
		if (!pending) {
			return
		}
		// Remote "Always Run" only remembers for this runner task — do not flip
		// the editor's global Settings autoApprove (E2).
		await remoteTaskService.approvePermission({
			taskId: pending.taskId,
			approvalId: pending.approvalId,
			decision,
			remember,
		})
	}, [pending, remoteTaskService])

	const eventsNewestFirst = useMemo(
		() => (live ? [...live.events].reverse() : []),
		[live],
	)
	const branchData = useMemo(() => {
		const ev = eventsNewestFirst.find(e => e.kind === 'artifact.branch')
		return ev ? parseArtifactBranch(ev.data) : undefined
	}, [eventsNewestFirst])
	const prData = useMemo(() => {
		const ev = eventsNewestFirst.find(e => e.kind === 'artifact.pr')
		return ev ? parseArtifactPr(ev.data) : undefined
	}, [eventsNewestFirst])
	const patchData = useMemo(() => {
		const ev = eventsNewestFirst.find(e => e.kind === 'artifact.patch')
		return ev ? parseArtifactPatch(ev.data) : undefined
	}, [eventsNewestFirst])

	const canOpenPr = !!prData?.url || (!!branchData?.pushed && !!branchData.name)
	const canCheckout = !!workspaceRoot && !!branchData?.pushed && !!branchData.name
	const canApplyPatch = !!workspaceRoot
		&& typeof patchData?.patch === 'string'
		&& patchData.patch.length > 0
		&& patchData.truncated !== true
		&& patchData.exitCode === 0
		&& branchData?.hasChanges !== false

	const normalizeRemote = (value: string | null | undefined): string => {
		try {
			const url = new URL(value ?? '')
			return `${url.hostname.toLowerCase()}${url.pathname.replace(/\.git$/i, '').replace(/\/$/, '')}`
		} catch { return '' }
	}

	const assertSameRepo = useCallback(async (): Promise<boolean> => {
		if (!workspaceRoot) {
			setHandoffOk(false)
			setHandoffStatus('Open the repository workspace to use handoff actions.')
			return false
		}
		const git = accessor.get('IAgentGitService')
		const currentRemote = await git.getRemoteUrl(workspaceRoot, 'origin')
		const parsed = currentRemote ? parseGitHubOrGitLabRemote(currentRemote) : null
		if (!parsed?.ok || normalizeRemote(parsed.repoUrl) !== normalizeRemote(live?.summary.git?.repoUrl)) {
			setHandoffOk(false)
			setHandoffStatus(
				parsed && !parsed.ok
					? parsed.error.message
					: 'The active workspace is not the repository used by this remote task.',
			)
			return false
		}
		return true
	}, [accessor, live?.summary.git?.repoUrl, workspaceRoot])

	const onOpenPr = useCallback(async () => {
		setHandoffStatus(null)
		setHandoffOk(false)
		const opener = accessor.get('IOpenerService')
		if (prData?.url) {
			void opener.open(URI.parse(prData.url), { openExternal: true })
			setHandoffOk(true)
			setHandoffStatus('Opened pull request / compare page.')
			return
		}
		if (!workspaceRoot || !branchData?.name) {
			setHandoffStatus('No pull request URL is available yet. Ensure the runner can push (credential allowlist).')
			return
		}
		if (!(await assertSameRepo())) return
		const git = accessor.get('IAgentGitService')
		const base = branchData.baseBranch || branchData.baseCommit
		const url = await git.getCompareUrl(workspaceRoot, { base, head: branchData.name })
		if (!url) {
			setHandoffStatus('Could not build a compare URL for this repository.')
			return
		}
		void opener.open(URI.parse(url), { openExternal: true })
		setHandoffOk(true)
		setHandoffStatus('Opened compare page.')
	}, [accessor, assertSameRepo, branchData, prData?.url, workspaceRoot])

	const onCheckout = useCallback(async () => {
		if (!workspaceRoot || !branchData?.name) return
		setHandoffStatus(null)
		setHandoffOk(false)
		if (!(await assertSameRepo())) return
		const git = accessor.get('IAgentGitService')
		const status = await git.getStatus(workspaceRoot)
		const dirty = status.files.length > 0
		if (dirty) {
			const repoName = workspaceRoot.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || 'repo'
			const short = branchData.name.replace(/^orbit\//, '')
			const parentDir = workspaceRoot.replace(/[/\\]+$/, '').replace(/[/\\][^/\\]+$/, '') || workspaceRoot
			const sep = workspaceRoot.includes('\\') ? '\\' : '/'
			const worktreePath = `${parentDir}${sep}${repoName}-orbit-${short}`
			const result = await git.checkoutRemoteBranch(workspaceRoot, {
				remoteBranch: branchData.name,
				localBranch: branchData.name,
				createWorktreePath: worktreePath,
			})
			if (!result.ok) {
				setHandoffStatus(
					result.error
						?? 'Could not create a worktree. Commit or stash local changes, or use Open PR.',
				)
				return
			}
			setHandoffOk(true)
			setHandoffStatus(`Created worktree at ${worktreePath} on ${branchData.name}. Open that folder to review.`)
			return
		}
		const result = await git.checkoutRemoteBranch(workspaceRoot, {
			remoteBranch: branchData.name,
			localBranch: branchData.name,
		})
		if (!result.ok) {
			setHandoffStatus(result.error ?? 'Could not check out the agent branch.')
			return
		}
		setHandoffOk(true)
		setHandoffStatus(`Checked out ${branchData.name}.`)
	}, [accessor, assertSameRepo, branchData, workspaceRoot])

	const onApplyPatch = useCallback(async () => {
		if (!workspaceRoot || typeof patchData?.patch !== 'string') return
		setHandoffStatus(null)
		setHandoffOk(false)
		if (!(await assertSameRepo())) return
		const git = accessor.get('IAgentGitService')
		const status = await git.getStatus(workspaceRoot)
		if (status.files.length > 0) {
			setHandoffStatus('Commit or stash local changes before applying, or use Checkout locally / Open PR.')
			return
		}
		const head = await git.getHeadCommit(workspaceRoot)
		const base = typeof patchData.baseCommit === 'string' ? patchData.baseCommit : undefined
		if (!base || head !== base) {
			setHandoffStatus(
				branchData?.pushed
					? 'Local HEAD no longer matches the task base. Use Checkout locally or Open PR instead of Apply.'
					: 'Local HEAD no longer matches the remote task base. Switch to the shown base commit before applying.',
			)
			return
		}
		const applied = await git.applyPatch(workspaceRoot, patchData.patch, {})
		if (applied.ok) {
			setHandoffOk(true)
			setHandoffStatus('Remote changes applied to the local working tree.')
		} else {
			setHandoffStatus(applied.error ?? 'Could not apply remote changes.')
		}
	}, [accessor, assertSameRepo, branchData?.pushed, patchData, workspaceRoot])

	if (!live) {
		return null
	}

	const state = live.summary.state
	const isTerminal = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LOST'].includes(state)
	const isCompleted = state === 'COMPLETED'

	const showReconnect = !isTerminal && !live.connected && !live.reconnecting
	const showHandoff = isCompleted && (!!branchData || !!patchData || !!prData)
	const showError = !!live.summary.lastError
	const showApproval = !!pending

	if (!showApproval && !showHandoff && !showError && !showReconnect && !handoffStatus) {
		return null
	}

	const isShellTool = resolvedToolName === 'Shell' || resolvedToolName === 'AwaitShell'
	const runLabel = getRunActionLabel(approvalType)
	const alwaysLabel = getAlwaysRunLabel(approvalType)
	const skipLabel = getSkipLabel()
	const headerTitle = pending?.summary || resolvedToolName || 'Tool approval'

	const applyDisabledReason = !canApplyPatch
		? (patchData?.truncated
			? 'Patch truncated — use Checkout or Open PR.'
			: branchData?.hasChanges === false
				? 'No code changes to apply.'
				: !patchData?.patch
					? 'No patch available.'
					: 'Patch cannot be applied.')
		: undefined
	const pushDisabledReason = branchData && !branchData.pushed
		? (branchData.reason || 'Branch was not pushed. Configure ORBIT_RUNNER_CREDENTIALED_REPOSITORIES and host git credentials.')
		: undefined

	return (
		<div className='mt-1 mb-2 max-w-full orbit-card-enter' role='region' aria-label='Remote task actions'>
			{showApproval && pending && (
				<ToolApprovalCardShell
					isActive
					header={(
						<div className='flex items-center gap-2 px-3 py-1.5 select-none' style={{ color: toolApprovalTheme.fg }}>
							<span className='text-[12px] font-medium truncate'>
								{headerTitle}
							</span>
						</div>
					)}
					footer={(
						<div className='flex flex-wrap items-center justify-end gap-1.5 px-3 py-2 border-t' style={{ borderColor: toolApprovalTheme.panelBorder }}>
							<ApprovalGhostButton onClick={() => void onApprove('deny')}>
								{skipLabel}
							</ApprovalGhostButton>
							{approvalType && (
								<ApprovalPillButton onClick={() => void onApprove('allow', true)}>
									{alwaysLabel}
								</ApprovalPillButton>
							)}
							<ApprovalPrimaryButton onClick={() => void onApprove('allow')}>
								{runLabel}
							</ApprovalPrimaryButton>
						</div>
					)}
				>
					{isShellTool && normalizedParams ? (
						<ShellApprovalPreview
							toolName={resolvedToolName as 'Shell' | 'AwaitShell'}
							params={normalizedParams as BuiltinToolCallParams['Shell'] | BuiltinToolCallParams['AwaitShell']}
						/>
					) : normalizedParams && resolvedToolName ? (
						<GenericApprovalPreview
							toolMessage={{
								role: 'tool',
								type: 'tool_request',
								name: resolvedToolName as ToolName,
								params: normalizedParams,
								result: null,
								content: '',
								id: pending.approvalId,
								rawParams: (pending.toolArgs && typeof pending.toolArgs === 'object' && !Array.isArray(pending.toolArgs)
									? pending.toolArgs
									: {}) as Record<string, unknown>,
								mcpServerName: undefined,
							} as never}
						/>
					) : (
						<div className='px-3 py-2.5 text-[12px] text-void-fg-3'>
							{pending.summary || 'This action requires your approval.'}
						</div>
					)}
				</ToolApprovalCardShell>
			)}

			{showError && (
				<div className='my-1 rounded-md border border-[color-mix(in_srgb,var(--vscode-errorForeground)_35%,transparent)] bg-[color-mix(in_srgb,var(--vscode-errorForeground)_6%,transparent)] px-3 py-2 text-xs text-[var(--vscode-errorForeground)]'>
					{live.summary.lastError}
				</div>
			)}

			{showReconnect && (
				<div className='my-1 text-xs text-void-fg-3'>
					<span>Connection to the self-hosted runner was lost. </span>
					<button type='button' className='inline-flex items-center gap-1 text-void-fg-2 hover:underline' onClick={() => void onReconnect()}>
						<RefreshCw className='size-3' aria-hidden='true' /> Reconnect
					</button>
				</div>
			)}

			{showHandoff && (
				<div className='my-1 rounded-md border px-3 py-2 text-xs' style={{ borderColor: toolApprovalTheme.panelBorder, background: toolApprovalTheme.panelBg }}>
					<div className='text-void-fg-2 mb-1.5'>
						{branchData?.hasChanges === false
							? 'Remote task completed with no code changes.'
							: branchData?.pushed
								? <>Remote changes on <span className='font-medium text-void-fg-1'>{branchData.name}</span> — bring them into review:</>
								: 'Remote changes are ready. Push was unavailable — Apply locally if your tree matches the base commit:'}
					</div>
					<div className='flex flex-wrap items-center gap-1.5'>
						<button
							type='button'
							disabled={!canOpenPr}
							title={pushDisabledReason}
							className='px-2 py-1 rounded border text-xs enabled:hover:bg-void-bg-1 disabled:opacity-50'
							style={{ borderColor: toolApprovalTheme.panelBorder }}
							onClick={() => void onOpenPr()}
						>
							Open PR
						</button>
						<button
							type='button'
							disabled={!canCheckout}
							title={pushDisabledReason || (!workspaceRoot ? 'Open the repository workspace first.' : undefined)}
							className='px-2 py-1 rounded border text-xs enabled:hover:bg-void-bg-1 disabled:opacity-50'
							style={{ borderColor: toolApprovalTheme.panelBorder }}
							onClick={() => void onCheckout()}
						>
							Checkout locally
						</button>
						<button
							type='button'
							disabled={!canApplyPatch}
							title={applyDisabledReason}
							className='px-2 py-1 rounded border text-xs enabled:hover:bg-void-bg-1 disabled:opacity-50'
							style={{ borderColor: toolApprovalTheme.panelBorder }}
							onClick={() => void onApplyPatch()}
						>
							Apply locally
						</button>
					</div>
					{pushDisabledReason && !branchData?.pushed && branchData?.hasChanges !== false && (
						<div className='mt-1.5 text-void-fg-3'>{pushDisabledReason}</div>
					)}
					{handoffStatus && (
						<div className={`mt-1.5 ${handoffOk ? 'text-[var(--vscode-testing-iconPassed)]' : 'text-[var(--vscode-errorForeground)]'}`}>
							{handoffStatus}
						</div>
					)}
				</div>
			)}
		</div>
	)
}
