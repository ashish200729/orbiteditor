/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CompactionMsgInfo, selectCompactionBoundary } from '../../common/compactionHelpers.js';

suite('compaction boundary selection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const u = (chars: number): CompactionMsgInfo => ({ sendChars: chars, isUserBoundary: true });
	const a = (chars: number): CompactionMsgInfo => ({ sendChars: chars, isUserBoundary: false });

	test('keeps recent ~targetTailChars and snaps boundary to a user message', () => {
		// idx:   0     1      2      3      4      5      6      7
		const messages: CompactionMsgInfo[] = [u(100), a(500), a(500), u(100), a(500), a(500), u(100), a(500)];
		// startIdx 1, want to keep ~600 chars of tail. Walking back: 7(500),6(100)=600 -> boundary=6 (already user).
		const b = selectCompactionBoundary({ messages, startIdx: 1, targetTailChars: 600, minRange: 2 });
		assert.strictEqual(b, 6);
		assert.strictEqual(messages[b!].isUserBoundary, true);
	});

	test('snaps forward past assistant/tool messages to the next user boundary', () => {
		// If the char threshold lands on a non-user message, boundary advances to the next user msg.
		const messages: CompactionMsgInfo[] = [u(50), u(50), a(400), a(400), u(50), a(400), a(400)];
		// startIdx 1, target 500: back 6(400),5(400)=800>=500 -> boundary=5 (assistant) -> snap fwd -> no user
		// after 5 -> 6 assistant -> reaches end -> null (no clean boundary in recent region)
		const b = selectCompactionBoundary({ messages, startIdx: 1, targetTailChars: 500, minRange: 1 });
		assert.strictEqual(b, null);
	});

	test('returns null when the range to summarize is smaller than minRange', () => {
		const messages: CompactionMsgInfo[] = [u(100), u(100), u(100), u(100)];
		// startIdx 2, boundary would be 3 (user), range = 3-2 = 1 < minRange 3 -> null
		const b = selectCompactionBoundary({ messages, startIdx: 2, targetTailChars: 50, minRange: 3 });
		assert.strictEqual(b, null);
	});

	test('never returns a non-user boundary', () => {
		const messages: CompactionMsgInfo[] = [u(10), a(10), a(10), u(10), a(10), a(10), u(10), a(10), a(10)];
		for (let target = 0; target < 100; target += 5) {
			const b = selectCompactionBoundary({ messages, startIdx: 0, targetTailChars: target, minRange: 1 });
			if (b !== null) assert.strictEqual(messages[b].isUserBoundary, true, `target=${target} produced non-user boundary ${b}`);
		}
	});

	test('handles empty / out-of-range startIdx safely', () => {
		assert.strictEqual(selectCompactionBoundary({ messages: [], startIdx: 0, targetTailChars: 10, minRange: 1 }), null);
		assert.strictEqual(selectCompactionBoundary({ messages: [u(10)], startIdx: 5, targetTailChars: 10, minRange: 1 }), null);
	});
});
