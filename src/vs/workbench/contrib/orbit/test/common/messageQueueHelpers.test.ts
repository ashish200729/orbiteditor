/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { QueuedUserMessage, queuedUserMessagesEqual } from '../../common/messageQueueHelpers.js';

suite('messageQueueHelpers', () => {
	const fileMessage = (path: string): QueuedUserMessage => ({
		userMessage: 'Review this',
		_chatSelections: [{
			type: 'File',
			uri: URI.file(path),
			language: 'typescript',
			state: { wasAddedAsCurrentFile: false },
		}],
	});

	test('treats equivalent messages and attachments as duplicates', () => {
		assert.strictEqual(queuedUserMessagesEqual(fileMessage('/workspace/a.ts'), fileMessage('/workspace/a.ts')), true);
	});

	test('does not discard a message with a different same-count attachment', () => {
		assert.strictEqual(queuedUserMessagesEqual(fileMessage('/workspace/a.ts'), fileMessage('/workspace/b.ts')), false);
	});

	test('compares image content rather than only image count', () => {
		const left: QueuedUserMessage = { userMessage: 'Review', _images: ['data:image/png;base64,aaa'] };
		const right: QueuedUserMessage = { userMessage: 'Review', _images: ['data:image/png;base64,bbb'] };
		assert.strictEqual(queuedUserMessagesEqual(left, right), false);
	});

	test('includes immutable quote attachments in duplicate detection', () => {
		const left: QueuedUserMessage = { userMessage: '', _textQuotes: [{ id: 'first', text: 'quoted', sourceKind: 'assistant' }] };
		const sameText: QueuedUserMessage = { userMessage: '', _textQuotes: [{ id: 'second', text: 'quoted', sourceKind: 'assistant' }] };
		const differentSource: QueuedUserMessage = { userMessage: '', _textQuotes: [{ id: 'third', text: 'quoted', sourceKind: 'tool' }] };
		assert.strictEqual(queuedUserMessagesEqual(left, sameText), true);
		assert.strictEqual(queuedUserMessagesEqual(left, differentSource), false);
	});
});
