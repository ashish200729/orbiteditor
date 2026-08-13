/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { StagingSelectionItem, TextQuoteAttachment } from './chatThreadServiceTypes.js';
import { cloneTextQuote, textQuotesEqual } from './textQuoteAttachments.js';

export type QueuedUserMessage = {
	userMessage: string;
	llmInstructions?: string;
	_chatSelections?: StagingSelectionItem[];
	_images?: string[];
	_textQuotes?: TextQuoteAttachment[];
};

export const cloneQueuedTextQuotes = (quotes: readonly TextQuoteAttachment[] | undefined): TextQuoteAttachment[] | undefined =>
	quotes?.map(cloneTextQuote);

export const cloneStagingSelection = (selection: StagingSelectionItem): StagingSelectionItem => {
	switch (selection.type) {
		case 'File':
			return { ...selection, state: { ...selection.state } };
		case 'CodeSelection':
			return { ...selection, range: [...selection.range], state: { ...selection.state } };
		case 'Folder':
			return { ...selection };
		case 'BrowserElement':
			return {
				...selection,
				selectorChain: selection.selectorChain ? [...selection.selectorChain] : undefined,
				elementData: {
					...selection.elementData,
					classes: [...selection.elementData.classes],
					attributes: { ...selection.elementData.attributes },
				},
			};
	}
};

const arraysEqual = <T>(left: readonly T[] | undefined, right: readonly T[] | undefined, equals: (a: T, b: T) => boolean): boolean => {
	if (left === right) return true;
	if (!left || !right || left.length !== right.length) return false;
	return left.every((value, index) => equals(value, right[index]!));
};

const stagingSelectionsEqual = (left: StagingSelectionItem, right: StagingSelectionItem): boolean => {
	if (left.type !== right.type) return false;
	switch (left.type) {
		case 'File':
			return right.type === 'File' && left.uri.toString() === right.uri.toString() && left.language === right.language && left.state.wasAddedAsCurrentFile === right.state.wasAddedAsCurrentFile;
		case 'CodeSelection':
			return right.type === 'CodeSelection' && left.uri.toString() === right.uri.toString() && left.language === right.language
				&& left.range[0] === right.range[0] && left.range[1] === right.range[1] && left.state.wasAddedAsCurrentFile === right.state.wasAddedAsCurrentFile;
		case 'Folder':
			return right.type === 'Folder' && left.uri.toString() === right.uri.toString();
		case 'BrowserElement':
			return right.type === 'BrowserElement' && left.selector === right.selector && left.pageUrl === right.pageUrl
				&& left.timestamp === right.timestamp && left.screenshot === right.screenshot
				&& JSON.stringify(left.selectorChain) === JSON.stringify(right.selectorChain)
				&& JSON.stringify(left.elementData) === JSON.stringify(right.elementData);
	}
};

export const queuedUserMessagesEqual = (left: QueuedUserMessage, right: QueuedUserMessage): boolean => {
	return left.userMessage === right.userMessage
		&& left.llmInstructions === right.llmInstructions
		&& arraysEqual(left._images, right._images, (a, b) => a === b)
		&& arraysEqual(left._chatSelections, right._chatSelections, stagingSelectionsEqual)
		&& arraysEqual(left._textQuotes, right._textQuotes, textQuotesEqual);
};
