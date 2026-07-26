/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { GitBranch } from 'lucide-react'
import { VoidCustomDropdownBox } from '../../../util/inputs.js'
import { useAccessor, useSettingsState } from '../../../util/services.js'
import { runnerChromeTriggerClassName } from './runnerChromeStyles.js'
import { parseGitHubOrGitLabRemote } from '../../../../../../common/runner/gitRemoteHelpers.js'

export { runnerChromeTriggerClassName } from './runnerChromeStyles.js'

/**
 * Compact branch picker for Self-hosted Runner mode.
 * Uses VoidCustomDropdownBox (fixed + flip portal) so the menu is visible and
 * the trigger stays a single horizontal row — matching Local | Runner.
 * Selects the remote task base branch without mutating the local checkout.
 */
export const RunnerBranchDropdown = ({
	className,
	root,
	branch,
	branches,
	onSelectBranch,
	disabled,
	loading,
}: {
	className?: string
	root: string | null
	branch: string | null
	branches: string[]
	onSelectBranch: (branch: string) => Promise<void>
	disabled?: boolean
	loading?: boolean
}) => {
	const [busy, setBusy] = useState(false)
	const isDisabled = !!disabled || busy

	const options = useMemo(() => {
		if (branches.length > 0) {
			return branches
		}
		return branch ? [branch] : []
	}, [branches, branch])

	const selected = useMemo(() => {
		if (branch && options.includes(branch)) {
			return branch
		}
		return options[0]
	}, [branch, options])

	const onChangeOption = useCallback((next: string) => {
		if (isDisabled || next === branch) {
			return
		}
		setBusy(true)
		void onSelectBranch(next).finally(() => setBusy(false))
	}, [isDisabled, branch, onSelectBranch])

	const getName = useCallback((b: string) => b, [])
	const getBranchIcon = useCallback(() => GitBranch, [])

	if (loading) {
		return (
			<div
				className={`${runnerChromeTriggerClassName} ${className ?? ''} opacity-60 pointer-events-none`}
				title='Looking for a git repository…'
				aria-label='Loading branches'
			>
				<GitBranch size={12} className='shrink-0 opacity-70' aria-hidden='true' />
				<span className='truncate'>Loading…</span>
			</div>
		)
	}

	if (!root) {
		return (
			<div
				className={`${runnerChromeTriggerClassName} ${className ?? ''} opacity-70 pointer-events-none`}
				title='A self-hosted runner clones your repository, so this window needs an open git repository.'
				aria-label='No git repository open'
			>
				<GitBranch size={12} className='shrink-0 opacity-70' aria-hidden='true' />
				<span className='truncate'>No repository</span>
			</div>
		)
	}

	if (selected === undefined) {
		return (
			<div
				className={`${runnerChromeTriggerClassName} ${className ?? ''} opacity-70 pointer-events-none`}
				title='This repository has no branches on its origin remote. Push a branch first.'
				aria-label='No remote branches'
			>
				<GitBranch size={12} className='shrink-0 opacity-70' aria-hidden='true' />
				<span className='truncate'>No remote branch</span>
			</div>
		)
	}

	return (
		<div
			className={`min-w-0 ${isDisabled ? 'opacity-60 pointer-events-none' : ''} ${className ?? ''}`}
			title={isDisabled ? 'Branch is locked while a remote task is running' : (branch ? `Branch: ${branch}` : 'Select branch')}
		>
			<VoidCustomDropdownBox
				className={runnerChromeTriggerClassName}
				options={options}
				selectedOption={selected}
				onChangeOption={onChangeOption}
				getOptionDisplayName={getName}
				getOptionDropdownName={getName}
				getOptionsEqual={(a, b) => a === b}
				getOptionIcon={getBranchIcon}
				showCheckmarkOnSelected
				matchInputWidth={false}
				arrowTouchesText
				offsetPx={-3}
				opacity={100}
				searchable={options.length > 8}
				searchPlaceholder='Search branches…'
				searchEmptyLabel='No branches match that search'
			/>
		</div>
	)
}

export type WorkspaceGitContext = {
	/** True until the first git resolve settles. Distinguishes "no repo" from "not looked yet". */
	loading: boolean
	root: string | null
	remoteUrl: string | null
	branch: string | null
	commit: string | null
	branches: string[]
	error: string | null
	refresh: () => Promise<void>
	selectBranch: (branch: string) => Promise<void>
}

/** Resolve the active Agent workspace (or IDE folder) git root, origin URL, and branches. */
export const useWorkspaceGitForRunner = (isAgentWindow = false): WorkspaceGitContext => {
	const accessor = useAccessor()
	const git = accessor.get('IAgentGitService')
	const workspaceService = accessor.get('IWorkspaceContextService')
	const settingsService = accessor.get('IVoidSettingsService')
	const settingsState = useSettingsState()
	const branchByRepo = settingsState.globalSettings.runnerBranchByRepository

	const [root, setRoot] = useState<string | null>(null)
	const [remoteUrl, setRemoteUrl] = useState<string | null>(null)
	const [branch, setBranch] = useState<string | null>(null)
	const [branches, setBranches] = useState<string[]>([])
	const [commit, setCommit] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	// Starts true: `root` is null before the first resolve, and rendering that as
	// "No git repo" made every open flash a false error.
	const [loading, setLoading] = useState(true)

	const refresh = useCallback(async () => {
		setError(null)
		try {
			const resolved = isAgentWindow
				? await git.resolveRepoRoot()
				: await (async () => {
					const startPath = workspaceService.getWorkspace().folders[0]?.uri.fsPath
					return startPath ? git.resolveRepoRootFromPath(startPath) : null
				})()
			if (!resolved) {
				setRoot(null)
				setRemoteUrl(null)
				setBranch(null)
				setBranches([])
				setCommit(null)
				setError(isAgentWindow
					? 'Select an Agent workspace containing a git repository.'
					: 'Open a folder containing a git repository.')
				return
			}

			const [status, brs, rawRemote] = await Promise.all([
				git.getStatus(resolved),
				git.getRemoteBranches(resolved),
				git.getRemoteUrl(resolved, 'origin'),
			])
			setRoot(resolved)

			let remote: string | null = null
			let remoteError: string | null = null
			if (!rawRemote) {
				remoteError = 'No GitHub/GitLab remote found (expected origin). Add a remote to use Self-hosted Runner.'
			} else {
				const parsed = parseGitHubOrGitLabRemote(rawRemote)
				if (!parsed.ok) {
					remoteError = parsed.error.message
				} else {
					remote = parsed.repoUrl
				}
			}

			const saved = settingsService.state.globalSettings.runnerBranchByRepository[remote ?? '']
			const selectedBranch = saved && brs.includes(saved)
				? saved
				: (status.branch && brs.includes(status.branch) ? status.branch : (brs[0] ?? null))
			const selectedCommit = selectedBranch ? await git.getRemoteBranchCommit(resolved, selectedBranch) : null
			setBranch(selectedBranch)
			setCommit(selectedCommit)
			setBranches(brs)
			setRemoteUrl(remote)
			setError(remoteError)
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
		} finally {
			setLoading(false)
		}
	}, [git, workspaceService, settingsService, isAgentWindow])

	useEffect(() => {
		void refresh()
		const d = git.onDidChange(() => { void refresh() })
		return () => d.dispose()
	}, [git, refresh])

	// Keep every hook instance in sync when another surface (header branch picker)
	// updates runnerBranchByRepository — selectBranch does not fire git.onDidChange.
	const branchByRepoKey = JSON.stringify(branchByRepo)
	useEffect(() => {
		void refresh()
	}, [branchByRepoKey, refresh])

	const selectBranch = useCallback(async (name: string) => {
		if (!remoteUrl || !branches.includes(name)) { return }
		const selectedCommit = root ? await git.getRemoteBranchCommit(root, name) : null
		if (!selectedCommit) {
			setError(`Could not resolve origin/${name}. Fetch or push the branch and try again.`)
			return
		}
		setBranch(name)
		setCommit(selectedCommit)
		setError(null)
		await settingsService.setGlobalSetting('runnerBranchByRepository', {
			...settingsService.state.globalSettings.runnerBranchByRepository,
			[remoteUrl]: name,
		})
	}, [remoteUrl, branches, settingsService, root, git])

	return { loading, root, remoteUrl, branch, commit, branches, error, refresh, selectBranch }
}
