/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	CHAT_IPC_PAYLOAD_MAX_BYTES,
	CHAT_USER_PROMPT_MAX_CHARS,
	estimateJsonByteSize,
	validateChatIpcPayloadSize,
	validateChatPromptLength,
} from '../../common/chatInputLimits.js';

suite('chatInputLimits', () => {
	test('validateChatPromptLength accepts text at the limit', () => {
		const text = 'a'.repeat(CHAT_USER_PROMPT_MAX_CHARS);
		assert.deepStrictEqual(validateChatPromptLength(text), { ok: true });
	});

	test('validateChatPromptLength rejects text over the limit', () => {
		const text = 'a'.repeat(CHAT_USER_PROMPT_MAX_CHARS + 1);
		const result = validateChatPromptLength(text);
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.ok(result.message.includes('too long'));
		}
	});

	test('estimateJsonByteSize grows with payload size', () => {
		const small = estimateJsonByteSize({ a: 'x' });
		const large = estimateJsonByteSize({ a: 'x'.repeat(10_000) });
		assert.ok(large > small);
	});

	test('validateChatIpcPayloadSize rejects oversized payloads', () => {
		const huge = { data: 'x'.repeat(CHAT_IPC_PAYLOAD_MAX_BYTES) };
		const result = validateChatIpcPayloadSize(huge);
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.ok(result.sizeBytes > CHAT_IPC_PAYLOAD_MAX_BYTES);
			assert.ok(result.message.includes('too large'));
		}
	});

	test('validateChatIpcPayloadSize accepts small payloads', () => {
		const result = validateChatIpcPayloadSize({ messages: [{ role: 'user', content: 'hi' }] });
		assert.deepStrictEqual(result, { ok: true });
	});
});
