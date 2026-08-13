/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { TextQuoteAttachment } from './chatThreadServiceTypes.js';

export const normalizeSelectedQuoteText = (value: string): string =>
	value.replace(/\r\n?/g, '\n').trim();

export const cloneTextQuote = (quote: TextQuoteAttachment): TextQuoteAttachment => ({ ...quote });

export const textQuotesEqual = (left: TextQuoteAttachment, right: TextQuoteAttachment): boolean =>
	left.text === right.text
	&& left.sourceKind === right.sourceKind
	&& left.sourceThreadId === right.sourceThreadId
	&& left.sourceMessageIdx === right.sourceMessageIdx;

const escapePromptMarkup = (value: string): string => value
	.replace(/&/g, '&amp;')
	.replace(/</g, '&lt;')
	.replace(/>/g, '&gt;');

export const appendTextQuotesToPrompt = (message: string, quotes: readonly TextQuoteAttachment[] | undefined): string => {
	const usable = (quotes ?? []).filter(quote => quote.text.trim().length > 0);
	if (usable.length === 0) {
		return message;
	}
	const blocks = usable.map((quote, index) => [
		`<selected-${quote.sourceKind} index="${index + 1}">`,
		escapePromptMarkup(quote.text),
		`</selected-${quote.sourceKind}>`,
	].join('\n'));
	return [message.trim(), 'Selected chat excerpts provided by the user:', ...blocks]
		.filter(Boolean)
		.join('\n\n');
};

export const quotePreviewTitle = (message: string, quotes: readonly TextQuoteAttachment[] | undefined): string => {
	const source = message.trim() || quotes?.[0]?.text.trim() || 'New Side Chat';
	const singleLine = source.replace(/\s+/g, ' ').trim();
	return singleLine.length > 42 ? `${singleLine.slice(0, 41).trimEnd()}…` : singleLine;
};
