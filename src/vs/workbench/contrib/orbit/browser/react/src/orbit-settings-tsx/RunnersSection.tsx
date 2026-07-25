/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, RefreshCw, Trash2, Wifi, Pencil, Copy } from 'lucide-react'
import { useAccessor, useRunnerList, useSettingsState } from '../util/services.js'
import { VoidButtonBgDarken, VoidSimpleInputBox } from '../util/inputs.js'
import type { RunnerConnectionStatus, RunnerInfo } from '../../../../common/runner/runnerTypes.js'
import { RUNNER_DEFAULT_WS_PATH, RUNNER_DEFAULT_WS_PORT } from '../../../../common/runner/runnerProtocol.js'
import { buildProviderProvisionPayload, computeProviderSyncStatuses, listCopyableProviders, type EnsureChatProviderResult, type ProviderSyncStatus, type SyncResult } from '../../../../common/runner/runnerProviderIntegration.js'
import type { ProviderName } from '../../../../common/orbitSettingsTypes.js'

const statusLabel = (status: RunnerConnectionStatus): string => {
	switch (status) {
		case 'online': return 'Online'
		case 'busy': return 'Busy'
		case 'offline': return 'Offline'
		case 'connecting': return 'Connecting'
		case 'error': return 'Error'
		default: return 'Unknown'
	}
}

const statusDotClass = (status: RunnerConnectionStatus): string => {
	switch (status) {
		case 'online': return 'bg-green-500'
		case 'busy': return 'bg-amber-400'
		case 'offline': return 'bg-void-fg-3'
		case 'connecting': return 'bg-sky-400 animate-pulse'
		case 'error': return 'bg-red-500'
		default: return 'bg-void-fg-3'
	}
}

const syncStatusClass = (state: ProviderSyncStatus['state']): string => {
	switch (state) {
		case 'synced': return 'text-green-400'
		case 'stale': return 'text-amber-400'
		case 'missing': return 'text-void-fg-3'
		case 'unsupported': return 'text-void-fg-3'
		case 'not_configured': return 'text-void-fg-3'
		default: return 'text-void-fg-3'
	}
}

const RunnerRow = ({
	runner,
	onRename,
	onTest,
	onRevoke,
	onForget,
	busyId,
}: {
	runner: RunnerInfo
	onRename: (id: string, name: string) => Promise<void>
	onTest: (id: string) => Promise<void>
	onRevoke: (id: string) => Promise<void>
	onForget: (id: string) => Promise<void>
	busyId: string | null
}) => {
	const [editing, setEditing] = useState(false)
	const [name, setName] = useState(runner.name)
	const [revokeFailed, setRevokeFailed] = useState(false)
	const isBusy = busyId === runner.id

	return (
		<div className='flex flex-col gap-1 px-3 py-2.5 border-b border-void-border-3 last:border-b-0'>
			<div className='flex items-center gap-2 min-w-0'>
				<span className={`inline-block size-2 rounded-full shrink-0 ${statusDotClass(runner.status)}`} title={statusLabel(runner.status)} />
				{editing ? (
					<input
						className='flex-1 min-w-0 bg-void-bg-1 border border-void-border-2 rounded px-2 py-0.5 text-sm text-void-fg-1'
						value={name}
						onChange={e => setName(e.target.value)}
						onKeyDown={async e => {
							if (e.key === 'Enter') {
								await onRename(runner.id, name)
								setEditing(false)
							} else if (e.key === 'Escape') {
								setName(runner.name)
								setEditing(false)
							}
						}}
						autoFocus
					/>
				) : (
					<span className='flex-1 min-w-0 truncate text-sm text-void-fg-1 font-medium'>{runner.name}</span>
				)}
				<span className='text-xs text-void-fg-3 shrink-0'>{statusLabel(runner.status)}</span>
			</div>
			<div className='text-xs text-void-fg-3 truncate pl-4'>{runner.hostUrl}</div>
			{runner.lastError && (
				<div className='text-xs text-red-400 pl-4'>{runner.lastError}</div>
			)}
			{revokeFailed && (
				<div className='text-xs text-amber-400 pl-4'>
					Could not revoke on the runner. Use Forget to remove local credentials.
				</div>
			)}
			<div className='flex items-center gap-1 pl-4 pt-1'>
				<button
					type='button'
					className='p-1 rounded hover:bg-void-bg-1 text-void-fg-3 hover:text-void-fg-1 disabled:opacity-50'
					title='Test connection'
					disabled={isBusy}
					onClick={() => onTest(runner.id)}
				>
					{isBusy ? <Loader2 className='size-3.5 animate-spin' /> : <Wifi className='size-3.5' />}
				</button>
				<button
					type='button'
					className='p-1 rounded hover:bg-void-bg-1 text-void-fg-3 hover:text-void-fg-1'
					title='Rename'
					onClick={() => { setName(runner.name); setEditing(true) }}
				>
					<Pencil className='size-3.5' />
				</button>
				<button
					type='button'
					className='p-1 rounded hover:bg-void-bg-1 text-void-fg-3 hover:text-red-400'
					title='Revoke pairing'
					onClick={async () => {
						setRevokeFailed(false)
						try {
							await onRevoke(runner.id)
						} catch {
							setRevokeFailed(true)
						}
					}}
				>
					<Trash2 className='size-3.5' />
				</button>
				{revokeFailed && (
					<button
						type='button'
						className='px-1.5 py-0.5 rounded text-xs text-amber-400 hover:bg-void-bg-1'
						title='Forget locally without contacting the runner'
						onClick={() => void onForget(runner.id)}
					>
						Forget
					</button>
				)}
			</div>
		</div>
	)
}

export const RunnersSection = () => {
	const accessor = useAccessor()
	const runnerService = accessor.get('IRunnerService')
	const runners = useRunnerList()
	const settingsState = useSettingsState()

	const [code, setCode] = useState('')
	const [hostUrl, setHostUrl] = useState(`ws://127.0.0.1:${RUNNER_DEFAULT_WS_PORT}${RUNNER_DEFAULT_WS_PATH}`)
	const [pairing, setPairing] = useState(false)
	const [pairError, setPairError] = useState<string | null>(null)
	const [pairOk, setPairOk] = useState<string | null>(null)
	const [busyId, setBusyId] = useState<string | null>(null)
	const [refreshing, setRefreshing] = useState(false)

	const [copyRunnerId, setCopyRunnerId] = useState('')
	const [copyProviderId, setCopyProviderId] = useState('')
	const [copyConfirm, setCopyConfirm] = useState(false)
	const [copyBusy, setCopyBusy] = useState(false)
	const [copyMsg, setCopyMsg] = useState<string | null>(null)
	const [copyErr, setCopyErr] = useState<string | null>(null)
	const [catalogText, setCatalogText] = useState<string | null>(null)
	const [syncStatuses, setSyncStatuses] = useState<ProviderSyncStatus[]>([])
	const [lastSyncResult, setLastSyncResult] = useState<SyncResult | null>(null)
	const [syncBusy, setSyncBusy] = useState(false)
	const [autoCopyResult, setAutoCopyResult] = useState<EnsureChatProviderResult | null>(null)

	const copyable = useMemo(
		() => listCopyableProviders(settingsState.settingsOfProvider),
		[settingsState.settingsOfProvider],
	)
	const selectedCopyable = copyable.find(c => c.providerId === copyProviderId)

	// Prefer an online runner so status/catalog show without forcing the manual form.
	useEffect(() => {
		if (copyRunnerId && runners.some(r => r.id === copyRunnerId)) {
			return
		}
		const preferred = runners.find(r => r.status === 'online' || r.status === 'busy')
			?? runners[0]
		if (preferred) {
			setCopyRunnerId(preferred.id)
		}
	}, [runners, copyRunnerId])

	useEffect(() => {
		const disposable = runnerService.onDidSyncProviders(({ runnerId, result }) => {
			if (!copyRunnerId || runnerId === copyRunnerId) {
				setLastSyncResult(result)
				if (!copyRunnerId) {
					setCopyRunnerId(runnerId)
				}
			}
		})
		return () => disposable.dispose()
	}, [runnerService, copyRunnerId])

	useEffect(() => {
		const disposable = runnerService.onDidAutoCopyChatProvider(({ runnerId, result }) => {
			if (!copyRunnerId || runnerId === copyRunnerId) {
				setAutoCopyResult(result)
				if (!copyRunnerId) {
					setCopyRunnerId(runnerId)
				}
			}
		})
		return () => disposable.dispose()
	}, [runnerService, copyRunnerId])

	useEffect(() => {
		if (!copyRunnerId) {
			return
		}
		const last = runnerService.getLastAutoCopyChatProviderResult(copyRunnerId)
		if (last) {
			setAutoCopyResult(last)
		}
		void (async () => {
			const cat = await runnerService.fetchProviderCatalog(copyRunnerId)
			if (!cat.ok) {
				return
			}
			setCatalogText(
				cat.providers.length === 0
					? 'No providers on runner yet.'
					: cat.providers.map(p => `${p.displayName} (${p.providerId}) · ${p.models.length} models · credential=${p.hasCredential ? 'yes' : 'no'}`).join('\n'),
			)
			const statuses = await computeProviderSyncStatuses(settingsState.settingsOfProvider, cat.providers)
			setSyncStatuses(statuses)
		})()
	}, [runnerService, copyRunnerId, settingsState.settingsOfProvider])

	const onPair = useCallback(async () => {
		setPairing(true)
		setPairError(null)
		setPairOk(null)
		try {
			const result = await runnerService.pairRunner({ code, hostUrl })
			if (result.ok) {
				setPairOk(`Paired “${result.runner.name}”.`)
				setCode('')
				setCopyRunnerId(result.runner.id)
				const sync = await runnerService.syncProvidersToRunner(result.runner.id, { mode: 'all_copyable' })
				setLastSyncResult(sync)
				const auto = await runnerService.ensureChatProviderOnRunner(result.runner.id)
				setAutoCopyResult(auto)
			} else {
				setPairError(result.error)
			}
		} catch (e) {
			setPairError(e instanceof Error ? e.message : String(e))
		} finally {
			setPairing(false)
		}
	}, [runnerService, code, hostUrl])

	const onRename = useCallback(async (id: string, name: string) => {
		await runnerService.renameRunner(id, name)
	}, [runnerService])

	const onTest = useCallback(async (id: string) => {
		setBusyId(id)
		try {
			await runnerService.testConnection(id)
		} finally {
			setBusyId(null)
		}
	}, [runnerService])

	const onRevoke = useCallback(async (id: string) => {
		setBusyId(id)
		setPairError(null)
		try {
			await runnerService.revokeRunner(id)
		} catch (error) {
			setPairError(error instanceof Error ? error.message : String(error))
			throw error
		} finally {
			setBusyId(null)
		}
	}, [runnerService])

	const onForget = useCallback(async (id: string) => {
		setBusyId(id)
		setPairError(null)
		try {
			await runnerService.forgetRunnerLocally(id)
		} catch (error) {
			setPairError(error instanceof Error ? error.message : String(error))
		} finally {
			setBusyId(null)
		}
	}, [runnerService])

	const onRefreshAll = useCallback(async () => {
		setRefreshing(true)
		try {
			await runnerService.refreshAllHeartbeats()
		} finally {
			setRefreshing(false)
		}
	}, [runnerService])

	const onFetchCatalog = useCallback(async () => {
		if (!copyRunnerId) { return }
		setCopyErr(null)
		const cat = await runnerService.fetchProviderCatalog(copyRunnerId)
		if (!cat.ok) {
			setCopyErr(cat.error)
			setCatalogText(null)
			setSyncStatuses([])
			return
		}
		setCatalogText(
			cat.providers.length === 0
				? 'No providers on runner yet.'
				: cat.providers.map(p => `${p.displayName} (${p.providerId}) · ${p.models.length} models · credential=${p.hasCredential ? 'yes' : 'no'}`).join('\n'),
		)
		const statuses = await computeProviderSyncStatuses(settingsState.settingsOfProvider, cat.providers)
		setSyncStatuses(statuses)
	}, [runnerService, copyRunnerId, settingsState.settingsOfProvider])

	const onSyncAll = useCallback(async () => {
		if (!copyRunnerId) { return }
		setSyncBusy(true)
		setCopyErr(null)
		try {
			const result = await runnerService.syncProvidersToRunner(copyRunnerId, { mode: 'all_copyable', force: true })
			setLastSyncResult(result)
			await onFetchCatalog()
		} finally {
			setSyncBusy(false)
		}
	}, [copyRunnerId, runnerService, onFetchCatalog])

	const onCopyProvider = useCallback(async () => {
		setCopyErr(null)
		setCopyMsg(null)
		if (!copyRunnerId || !copyProviderId) {
			setCopyErr('Select a runner and a provider.')
			return
		}
		if (!copyConfirm) {
			setCopyErr('Confirm the transfer checkbox first.')
			return
		}
		const built = buildProviderProvisionPayload(
			settingsState.settingsOfProvider,
			copyProviderId as ProviderName,
		)
		if (!built.ok) {
			setCopyErr(built.error)
			return
		}
		setCopyBusy(true)
		try {
			const result = await runnerService.copyProviderToRunner(copyRunnerId, built.payload)
			if (!result.ok) {
				setCopyErr(result.error)
				return
			}
			setCopyMsg(`Copied “${built.payload.displayName}” to the runner (fingerprint ${result.fingerprint || 'ok'}). Future remote tasks only send providerId + modelId.`)
			setCopyConfirm(false)
			await onFetchCatalog()
		} finally {
			setCopyBusy(false)
		}
	}, [copyRunnerId, copyProviderId, copyConfirm, settingsState.settingsOfProvider, runnerService, onFetchCatalog])

	return (
		<div className='flex flex-col gap-4'>
			<p className='text-void-fg-3 text-sm leading-relaxed'>
				Pair a self-hosted Orbit Runner. All configured BYOK providers
				sync automatically when the runner connects — you do not need the form below for normal use.
				Remote tasks send only providerId + modelId (never API keys).
				Orbit Provider / OAuth / native Anthropic / Google Vertex models cannot run on the runner — switch Chat to a BYOK or OpenAI-Compatible model.
			</p>

			<div className='rounded-lg border border-void-border-3 bg-void-bg-2 p-3 flex flex-col gap-2.5'>
				<div className='text-sm font-medium text-void-fg-1 flex items-center gap-1.5'>
					<Plus className='size-3.5' />
					Pair runner
				</div>
				<label className='text-xs text-void-fg-3'>Pairing code</label>
				<VoidSimpleInputBox
					value={code}
					onChangeValue={setCode}
					placeholder='ABCD1234'
					className='font-mono tracking-wider uppercase'
				/>
				<label className='text-xs text-void-fg-3'>Runner WebSocket URL</label>
				<VoidSimpleInputBox
					value={hostUrl}
					onChangeValue={setHostUrl}
					placeholder={`ws://127.0.0.1:${RUNNER_DEFAULT_WS_PORT}${RUNNER_DEFAULT_WS_PATH}`}
				/>
				<div className='flex items-center gap-2 pt-1'>
					<VoidButtonBgDarken
						className='px-3 py-1.5 text-sm'
						disabled={pairing || !code.trim()}
						onClick={() => void onPair()}
					>
						{pairing ? 'Pairing…' : 'Pair'}
					</VoidButtonBgDarken>
				</div>
				{pairError && <div className='text-xs text-red-400'>{pairError}</div>}
				{pairOk && <div className='text-xs text-green-400'>{pairOk}</div>}
			</div>

			<div className='rounded-lg border border-void-border-3 bg-void-bg-2 p-3 flex flex-col gap-2.5'>
				<div className='text-sm font-medium text-void-fg-1 flex items-center gap-1.5'>
					<Copy className='size-3.5' />
					Providers on this runner
				</div>
				<p className='text-xs text-void-fg-3 leading-relaxed'>
					Providers sync automatically on pair / connect and when you change API keys or models in Orbit Settings.
				</p>
				{runners.length > 0 && (
					<select
						className='bg-void-bg-1 border border-void-border-2 rounded px-2 py-1.5 text-sm text-void-fg-1'
						value={copyRunnerId}
						onChange={e => setCopyRunnerId(e.target.value)}
						aria-label='Runner for provider catalog'
					>
						{runners.map(r => (
							<option key={r.id} value={r.id}>{r.name} ({statusLabel(r.status)})</option>
						))}
					</select>
				)}
				{lastSyncResult && (
					<div className={`text-xs ${lastSyncResult.ok ? 'text-green-400' : 'text-amber-400'}`}>
						Last sync: {lastSyncResult.synced.length} updated
						{lastSyncResult.failed.length > 0 ? ` · ${lastSyncResult.failed.length} failed` : ''}
						{lastSyncResult.skipped.length > 0 ? ` · ${lastSyncResult.skipped.length} unchanged` : ''}
					</div>
				)}
				{autoCopyResult && (
					<div className={`text-xs ${syncStatusClass(autoCopyResult.status === 'failed' ? 'stale' : autoCopyResult.status === 'copied' || autoCopyResult.status === 'already_present' ? 'synced' : 'missing')}`}>
						Chat provider: {autoCopyResult.message}
					</div>
				)}
				{syncStatuses.length > 0 && (
					<ul className='text-[11px] text-void-fg-3 space-y-1 bg-void-bg-1/50 rounded px-2 py-1.5'>
						{syncStatuses.map(s => (
							<li key={s.providerId} className={syncStatusClass(s.state)}>
								{s.displayName}: {s.state}{s.message ? ` — ${s.message}` : ''}
							</li>
						))}
					</ul>
				)}
				{catalogText && (
					<pre className='text-[11px] text-void-fg-3 whitespace-pre-wrap bg-void-bg-1/50 rounded px-2 py-1.5'>{catalogText}</pre>
				)}
				<div className='flex items-center gap-2 flex-wrap'>
					<VoidButtonBgDarken
						className='px-3 py-1.5 text-sm'
						disabled={syncBusy || !copyRunnerId}
						onClick={() => void onSyncAll()}
					>
						{syncBusy ? 'Syncing…' : 'Sync all providers now'}
					</VoidButtonBgDarken>
					<button
						type='button'
						className='text-xs text-void-fg-3 hover:text-void-fg-1 underline disabled:opacity-50'
						disabled={!copyRunnerId}
						onClick={() => void onFetchCatalog()}
					>
						Refresh runner catalog
					</button>
				</div>

				<details className='pt-1 border-t border-void-border-3'>
					<summary className='text-xs text-void-fg-3 cursor-pointer select-none py-2 hover:text-void-fg-1'>
						Copy another provider (advanced)
					</summary>
					<div className='flex flex-col gap-2.5 pb-1'>
						<p className='text-xs text-void-fg-3 leading-relaxed'>
							Only needed for a second provider or a forced re-copy. Local endpoints (Ollama / LM Studio) mean the <em>runner</em> machine’s localhost.
						</p>
						<label className='text-xs text-void-fg-3'>Provider from Orbit Settings</label>
						<select
							className='bg-void-bg-1 border border-void-border-2 rounded px-2 py-1.5 text-sm text-void-fg-1'
							value={copyProviderId}
							onChange={e => { setCopyProviderId(e.target.value); setCopyConfirm(false) }}
						>
							<option value=''>Select provider…</option>
							{copyable.map(c => (
								<option key={c.providerId} value={c.providerId} disabled={!!c.reasonUnavailable}>
									{c.displayName}{c.reasonUnavailable ? ' (unavailable)' : ''}
								</option>
							))}
						</select>
						{selectedCopyable && (
							<div className='text-xs text-void-fg-3 rounded bg-void-bg-1/60 px-2 py-1.5'>
								{selectedCopyable.summary}
							</div>
						)}
						<label className='flex items-start gap-2 text-xs text-void-fg-2'>
							<input
								type='checkbox'
								className='mt-0.5'
								checked={copyConfirm}
								onChange={e => setCopyConfirm(e.target.checked)}
								disabled={!selectedCopyable || !!selectedCopyable.reasonUnavailable}
							/>
							<span>
								I confirm copying this provider’s credentials to the selected runner.
								Keys will not appear in task payloads or logs.
							</span>
						</label>
						<div className='flex items-center gap-2 flex-wrap'>
							<VoidButtonBgDarken
								className='px-3 py-1.5 text-sm'
								disabled={copyBusy || !copyRunnerId || !copyProviderId || !copyConfirm || !!selectedCopyable?.reasonUnavailable}
								onClick={() => void onCopyProvider()}
							>
								{copyBusy ? 'Copying…' : 'Copy provider'}
							</VoidButtonBgDarken>
						</div>
						{copyErr && <div className='text-xs text-red-400'>{copyErr}</div>}
						{copyMsg && <div className='text-xs text-green-400'>{copyMsg}</div>}
					</div>
				</details>
			</div>

			<div className='flex items-center justify-between'>
				<div className='text-sm font-medium text-void-fg-1'>Paired runners</div>
				<button
					type='button'
					className='flex items-center gap-1 text-xs text-void-fg-3 hover:text-void-fg-1 disabled:opacity-50'
					disabled={refreshing || runners.length === 0}
					onClick={() => void onRefreshAll()}
				>
					<RefreshCw className={`size-3 ${refreshing ? 'animate-spin' : ''}`} />
					Refresh
				</button>
			</div>

			{runners.length === 0 ? (
				<div className='text-sm text-void-fg-3 rounded-lg border border-dashed border-void-border-3 px-3 py-4'>
					No runners paired yet. Start the Orbit Runner, open its dashboard, generate a pairing code, then pair above.
				</div>
			) : (
				<div className='rounded-lg border border-void-border-3 bg-void-bg-2 overflow-hidden'>
					{runners.map(r => (
						<RunnerRow
							key={r.id}
							runner={r}
							onRename={onRename}
							onTest={onTest}
							onRevoke={onRevoke}
							onForget={onForget}
							busyId={busyId}
						/>
					))}
				</div>
			)}
		</div>
	)
}
