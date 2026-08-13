/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------*/

import React from 'react';
import { Quote, X } from 'lucide-react';
import { TextQuoteAttachment } from '../../../../../../common/chatThreadServiceTypes.js';

export const TextQuoteCards = ({ quotes, onRemove, compact = false }: {
	quotes: readonly TextQuoteAttachment[];
	onRemove?: (id: string) => void;
	compact?: boolean;
}) => {
	if (quotes.length === 0) return null;
	return <div className={`@@orbit-text-quotes ${compact ? '@@orbit-text-quotes-compact' : ''}`} aria-label='Quoted chat excerpts'>
		{quotes.map((quote, index) => <div key={quote.id} className='@@orbit-text-quote' title={quote.text}>
			<Quote size={12} aria-hidden='true' className='@@orbit-text-quote-icon' />
			<span className='@@orbit-text-quote-copy'>
				<span className='sr-only'>{`${quote.sourceKind} quote ${index + 1}: `}</span>
				{quote.text}
			</span>
			{onRemove && <button type='button' className='@@orbit-text-quote-remove' onClick={(event) => {
				event.stopPropagation();
				onRemove(quote.id);
			}} aria-label={`Remove quote ${index + 1}`}>
				<X size={12} aria-hidden='true' />
			</button>}
		</div>)}
	</div>;
};
