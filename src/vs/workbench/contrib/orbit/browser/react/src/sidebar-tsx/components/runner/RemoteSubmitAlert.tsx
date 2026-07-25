/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useEffect, useState } from 'react'
import { AlertTriangle, Info, X, Zap } from 'lucide-react'
import { toolApprovalTheme } from '../toolApproval/toolApprovalTheme.js'

/**
 * Premium inline alert for Self-hosted Runner pre-flight + submit errors.
 *
 * Visual language matches the tool-approval card surface (same panel bg/border,
 * same VS Code theme vars) so remote errors read as a single product surface
 * with approvals, not a bolted-on red text line.
 *
 * - Dismissible (X) — clears the message and notifies the parent so the next
 *   send can re-arm it.
 * - Optional CTA button (e.g. "Open a git repository", "Re-pair runner").
 * - severity: 'error' | 'warning' | 'info' — error tints toward
 *   `--vscode-errorForeground`, warning toward `--vscode-editorWarning-foreground`,
 *   info uses the neutral panel.
 * - Re-renders with a new `message` re-show the alert even if previously dismissed.
 */

type Severity = 'error' | 'warning' | 'info'

export type RemoteSubmitAlertProps = {
	message: string | null | undefined
	severity?: Severity
	/** Optional inline CTA. Rendered as a compact primary pill. */
	ctaLabel?: string
	onCtaClick?: () => void
	/** Fired when the user dismisses the alert (X) so the parent can clear its state. */
	onDismiss?: () => void
	/** Monotonic token; when it changes the alert is re-armed (shown again). */
	armToken?: unknown
	className?: string
}

const severityIcon = (severity: Severity) => {
	if (severity === 'error') return AlertTriangle
	if (severity === 'warning') return Zap
	return Info
}

const severityTint = (severity: Severity): string => {
	if (severity === 'error') {
		return 'color-mix(in srgb, var(--vscode-errorForeground, #f48771) 12%, transparent)'
	}
	if (severity === 'warning') {
		return 'color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 12%, transparent)'
	}
	return 'transparent'
}

const severityBorder = (severity: Severity): string => {
	if (severity === 'error') {
		return 'color-mix(in srgb, var(--vscode-errorForeground, #f48771) 35%, transparent)'
	}
	if (severity === 'warning') {
		return 'color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 35%, transparent)'
	}
	return toolApprovalTheme.panelBorder
}

const severityFg = (severity: Severity): string => {
	if (severity === 'error') return 'var(--vscode-errorForeground, #f48771)'
	if (severity === 'warning') return 'var(--vscode-editorWarning-foreground, #cca700)'
	return toolApprovalTheme.descFg
}

export const RemoteSubmitAlert = ({
	message,
	severity = 'error',
	ctaLabel,
	onCtaClick,
	onDismiss,
	armToken,
	className,
}: RemoteSubmitAlertProps) => {
	// Dismissed state is local but resets whenever `armToken` changes, so a new
	// submit attempt re-arms the alert even if the user dismissed a prior one.
	const [dismissed, setDismissed] = useState(false)
	const [lastArm, setLastArm] = useState(armToken)
	useEffect(() => {
		if (armToken !== lastArm) {
			setDismissed(false)
			setLastArm(armToken)
		}
	}, [armToken, lastArm])

	if (!message || dismissed) {
		return null
	}

	const Icon = severityIcon(severity)
	const tint = severityTint(severity)
	const border = severityBorder(severity)
	const fg = severityFg(severity)

	return (
		<div
			className={`orbit-card-enter flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs ${className ?? ''}`}
			style={{ borderColor: border, background: `linear-gradient(to right, ${tint}, transparent)`, color: toolApprovalTheme.fg }}
			role='alert'
			aria-live='assertive'
		>
			<Icon size={13} className='mt-0.5 shrink-0' style={{ color: fg }} aria-hidden='true' />
			<div className='min-w-0 flex-1 break-words leading-relaxed'>
				{message}
			</div>
			{ctaLabel && onCtaClick && (
				<button
					type='button'
					className='shrink-0 rounded px-2 py-0.5 text-[11px] font-medium enabled:hover:opacity-90 focus-visible:outline-none focus-visible:ring-1'
					style={{
						background: toolApprovalTheme.buttonBg,
						color: toolApprovalTheme.buttonFg,
						boxShadow: toolApprovalTheme.primaryShadow,
					}}
					onClick={() => { onCtaClick() }}
				>
					{ctaLabel}
				</button>
			)}
			<button
				type='button'
				className='shrink-0 rounded p-0.5 text-void-fg-4 hover:text-void-fg-2 hover:bg-black/5 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--vscode-focusBorder,#0078d4)]'
				aria-label='Dismiss'
				onClick={() => { setDismissed(true); onDismiss?.() }}
			>
				<X size={13} aria-hidden='true' />
			</button>
		</div>
	)
}
