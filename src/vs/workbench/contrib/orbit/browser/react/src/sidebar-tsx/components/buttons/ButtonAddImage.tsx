/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { ButtonHTMLAttributes } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { DEFAULT_BUTTON_SIZE } from './constants.js';

export const ButtonAddImage = ({ className, onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => {
	return <button
		type='button'
		className={`void-composer-action void-composer-action--ghost flex-shrink-0 cursor-pointer ${className ?? ''}`}
		onClick={onClick}
		{...props}
		data-tooltip-id='void-tooltip'
		data-tooltip-content='Add image (or drag & drop)'
		data-tooltip-place='top'
	>
		<ImageIcon size={DEFAULT_BUTTON_SIZE} className="stroke-[2] p-[3px]" />
	</button>
}
