import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { normalizeEmbedding } from '../../common/semanticRetrievalHelpers.js';
import { SemanticVectorIndex } from '../../common/semanticVectorIndex.js';

suite('SemanticVectorIndex', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('returns all candidates for small indexes', () => {
		const index = new SemanticVectorIndex();
		index.rebuild([[1, 0], [0, 1]]);
		assert.deepStrictEqual(index.candidates([1, 0]), [0, 1]);
	});

	test('keeps the identical vector in candidates for large indexes', () => {
		const vectors = Array.from({ length: 2100 }, (_, row) => normalizeEmbedding(Array.from({ length: 64 }, (_, column) => ((row * 31 + column * 17) % 101) - 50)));
		const index = new SemanticVectorIndex();
		index.rebuild(vectors);
		assert.ok(index.candidates(vectors[777]).includes(777));
	});
});
