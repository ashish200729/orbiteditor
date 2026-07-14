/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { ButtonHTMLAttributes, useCallback, useState } from 'react';
import { IconSquare } from '../icons/IconSquare.js';
import { DEFAULT_BUTTON_SIZE } from './constants.js';

export const ButtonStop = ({ className, onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => {
	// Aborting is async; without an in-flight guard the button stays clickable and
	// fires abortRunning repeatedly. Disable + dim until the abort settles.
	const [isAborting, setIsAborting] = useState(false)
	const handleClick = useCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
		if (isAborting) return
		setIsAborting(true)
		try {
			await onClick?.(e)
		} finally {
			setIsAborting(false)
		}
	}, [isAborting, onClick])

	return <button
		className={`void-composer-action void-composer-action--stop flex-shrink-0 ${isAborting ? 'opacity-50 cursor-default' : 'cursor-pointer'} ${className ?? ''}`}
		type='button'
		disabled={isAborting}
		onClick={handleClick}
		data-tooltip-id='void-tooltip'
		data-tooltip-content='Stop'
		data-tooltip-place='top'
		aria-label={props['aria-label'] ?? 'Stop generating'}
		{...props}
	>
		<IconSquare size={DEFAULT_BUTTON_SIZE} className="stroke-[3] p-[6px] text-current" />
	</button>
}
