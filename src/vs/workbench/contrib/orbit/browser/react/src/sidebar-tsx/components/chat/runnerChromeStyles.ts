/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Shared trigger chrome for Local | Self-hosted Runner + branch pickers.
 * Applied to VoidCustomDropdownBox's outer wrapper (not the inner button).
 * Do not add `agent-run-on-btn` here: that class forces `> * { display: block }`,
 * which collapses the inner flex button into a stacked column.
 */
export const runnerChromeTriggerClassName = `
	inline-flex flex-row items-center gap-1
	h-5 max-w-[160px]
	min-w-0
	px-1.5
	rounded
	bg-transparent
	text-[11px] leading-none font-medium
	text-void-fg-3
	cursor-pointer select-none
	hover:text-void-fg-1 hover:bg-black/5 dark:hover:bg-white/5
	transition-colors
	overflow-hidden whitespace-nowrap
`
