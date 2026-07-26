/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import {
	REMOTE_SUBMIT_STAGES,
	remoteSubmitStageLabel,
	type RemoteSubmitStage,
} from '../../../../../../common/runner/remoteTaskUiStatus.js'
import { TextShimmer } from '../../../util/TextShimmer.js'
import { toolApprovalTheme } from '../toolApproval/toolApprovalTheme.js'

/**
 * Inline pre-flight indicator shown between pressing Send and the task
 * appearing in the thread.
 *
 * Against a remote runner this window is several seconds of network round
 * trips. Naming the current step keeps it legible as work-in-progress rather
 * than a freeze, and the elapsed counter appears only once the wait is long
 * enough to be worth explaining.
 */

/** Elapsed time is noise on a fast runner; only surface it once the wait is notable. */
const ELAPSED_VISIBLE_AFTER_MS = 2_500

/** Point at which we stop implying things are fine and hint at the likely cause. */
const SLOW_HINT_AFTER_MS = 8_000

export type RemoteSubmitProgressProps = {
	stage: RemoteSubmitStage
	/** Name of the target runner, shown so multi-runner users know where this is going. */
	runnerName?: string
	onCancel?: () => void
	className?: string
}

const formatElapsed = (ms: number): string => {
	const seconds = Math.floor(ms / 1000)
	if (seconds < 60) return `${seconds}s`
	return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

export const RemoteSubmitProgress = ({
	stage,
	runnerName,
	onCancel,
	className,
}: RemoteSubmitProgressProps) => {
	const [elapsedMs, setElapsedMs] = useState(0)

	useEffect(() => {
		const startedAt = Date.now()
		setElapsedMs(0)
		const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 500)
		return () => clearInterval(timer)
	}, [])

	const activeIndex = Math.max(0, REMOTE_SUBMIT_STAGES.indexOf(stage))
	const showElapsed = elapsedMs >= ELAPSED_VISIBLE_AFTER_MS
	const isSlow = elapsedMs >= SLOW_HINT_AFTER_MS

	return (
		<div
			className={`orbit-card-enter rounded-md border px-2.5 py-2 ${className ?? ''}`}
			style={{
				borderColor: toolApprovalTheme.panelBorder,
				background: toolApprovalTheme.panelBg,
				color: toolApprovalTheme.fg,
			}}
			role='status'
			aria-live='polite'
			aria-label={`Sending to runner: ${remoteSubmitStageLabel(stage)}`}
		>
			<div className='flex items-center gap-2 min-w-0'>
				<div className='min-w-0 flex-1 text-xs leading-relaxed truncate'>
					<TextShimmer duration={1.5} spread={2}>
						{remoteSubmitStageLabel(stage)}
					</TextShimmer>
					{runnerName ? (
						<span className='ml-1 text-void-fg-4'>· {runnerName}</span>
					) : null}
				</div>

				{showElapsed ? (
					<span
						className='shrink-0 text-[11px] tabular-nums text-void-fg-4'
						aria-label={`Elapsed ${formatElapsed(elapsedMs)}`}
					>
						{formatElapsed(elapsedMs)}
					</span>
				) : null}

				{onCancel ? (
					<button
						type='button'
						className='shrink-0 rounded px-1.5 py-0.5 text-[11px] text-void-fg-4 hover:text-void-fg-2 hover:bg-black/5 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--vscode-focusBorder,#0078d4)]'
						onClick={onCancel}
					>
						Cancel
					</button>
				) : null}
			</div>

			{/* Segmented stepper: one segment per pre-flight round trip. */}
			<div className='mt-2 flex items-center gap-1' aria-hidden='true'>
				{REMOTE_SUBMIT_STAGES.map((s, index) => {
					const isDone = index < activeIndex
					const isActive = index === activeIndex
					return (
						<span
							key={s}
							className={`h-0.5 flex-1 rounded-full transition-colors duration-300 ease-out ${isActive ? 'orbit-submit-segment-active' : ''}`}
							style={{
								background: isDone
									? 'var(--vscode-progressBar-background, #0078d4)'
									: isActive
										? 'color-mix(in srgb, var(--vscode-progressBar-background, #0078d4) 55%, transparent)'
										: 'color-mix(in srgb, currentColor 12%, transparent)',
							}}
						/>
					)
				})}
			</div>

			{isSlow ? (
				<div className='mt-1.5 flex items-start gap-1.5 text-[11px] text-void-fg-4 leading-snug'>
					<Check size={11} className='mt-[3px] shrink-0 opacity-50' aria-hidden='true' />
					<span>
						Still working. A remote runner on a slow link can take a moment for the first
						turn — later turns in this thread reuse the connection and are faster.
					</span>
				</div>
			) : null}
		</div>
	)
}
