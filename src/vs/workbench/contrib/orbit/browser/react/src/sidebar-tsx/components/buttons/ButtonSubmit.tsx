/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { ButtonHTMLAttributes } from 'react';
import { IconArrowUp } from '../icons/IconArrowUp.js';
import { DEFAULT_BUTTON_SIZE } from './constants.js';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement>

interface ButtonSubmitProps extends ButtonProps {
	disabled: boolean;
	tooltip?: string;
}

export const ButtonSubmit = ({ className, disabled, tooltip = 'Send', ...props }: ButtonSubmitProps) => {

	return <button
		type='button'
		className={`void-composer-action void-composer-action--send flex-shrink-0 ${disabled ? 'opacity-60 cursor-default' : 'cursor-pointer'} ${className ?? ''}`}
		disabled={disabled}
		data-tooltip-id='void-tooltip'
		data-tooltip-content={tooltip}
		data-tooltip-place='top'
		aria-label={props['aria-label'] ?? tooltip}
		{...props}
	>
		<IconArrowUp size={DEFAULT_BUTTON_SIZE} className="stroke-[2] p-[3px] text-current" />
	</button>
}
