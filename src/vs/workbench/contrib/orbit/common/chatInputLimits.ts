/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export const CHAT_USER_PROMPT_MAX_CHARS = 32_000;
export const CHAT_USER_PROMPT_WARN_CHARS = 16_000;

export const CHAT_IPC_PAYLOAD_WARN_BYTES = 4_000_000;
export const CHAT_IPC_PAYLOAD_MAX_BYTES = 8_000_000;

export const CHAT_SELECTION_TRUNCATION_NOTICE = '\n\n…[additional selections omitted — total attachment budget exceeded]';

export type ChatPromptValidationResult =
	| { ok: true }
	| { ok: false; message: string };

export const validateChatPromptLength = (text: string): ChatPromptValidationResult => {
	if (text.length > CHAT_USER_PROMPT_MAX_CHARS) {
		return {
			ok: false,
			message: `Message is too long (${text.length.toLocaleString()} characters). Maximum is ${CHAT_USER_PROMPT_MAX_CHARS.toLocaleString()} characters. Shorten your prompt or start a new chat.`,
		};
	}
	return { ok: true };
};

export const isChatPromptNearLimit = (text: string): boolean => {
	return text.length >= CHAT_USER_PROMPT_WARN_CHARS;
};

/** UTF-16 length of JSON.stringify output — good enough for IPC payload budgeting. */
export const estimateJsonByteSize = (value: unknown): number => {
	try {
		return JSON.stringify(value).length;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
};

export type ChatIpcPayloadValidationResult =
	| { ok: true }
	| { ok: false; message: string; sizeBytes: number };

export const validateChatIpcPayloadSize = (payload: unknown): ChatIpcPayloadValidationResult => {
	const sizeBytes = estimateJsonByteSize(payload);
	if (sizeBytes > CHAT_IPC_PAYLOAD_MAX_BYTES) {
		return {
			ok: false,
			sizeBytes,
			message: `Request is too large to send (${Math.round(sizeBytes / 1_000_000)}MB). Shorten your prompt, remove large attachments, or start a new chat.`,
		};
	}
	return { ok: true };
};

export type TruncateSelectionsResult = {
	included: string[];
	truncated: boolean;
};

/** Accumulate selection strings up to a total character budget, preserving order. */
export const truncateSelectionsToBudget = (
	selectionStrings: string[],
	budget: number,
	truncationNotice: string = CHAT_SELECTION_TRUNCATION_NOTICE,
): TruncateSelectionsResult => {
	const included: string[] = [];
	let used = 0;
	let truncated = false;

	for (const sel of selectionStrings) {
		const separatorLen = included.length > 0 ? 2 : 0; // '\n\n'
		const nextLen = separatorLen + sel.length;
		if (used + nextLen > budget) {
			truncated = true;
			break;
		}
		included.push(sel);
		used += nextLen;
	}

	if (truncated && truncationNotice.length > 0) {
		const noticeLen = (included.length > 0 ? 2 : 0) + truncationNotice.length;
		if (used + noticeLen <= budget) {
			included.push(truncationNotice);
		}
	}

	return { included, truncated };
};
