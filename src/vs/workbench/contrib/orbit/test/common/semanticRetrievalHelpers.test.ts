import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { chunkSemanticFile, cosineSimilarity, embeddingEndpoint, lexicalBoost, matchesSemanticIgnore, normalizeEmbedding, parseSemanticIgnore, shouldIndexSemanticPath } from '../../common/semanticRetrievalHelpers.js';
import { embeddingRetryAfterMs, extractSemanticEmbeddings, isTransientEmbeddingError, semanticEmbeddingProviderError, validateSemanticEmbeddingRequest } from '../../common/semanticEmbeddingProtocol.js';

suite('Semantic retrieval helpers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('excludes dependencies, build output, binary files, and secrets', () => {
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/src/main.ts')), true);
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/node_modules/x.js')), false);
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/.env.local')), false);
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/image.png')), false);
	});

	test('excludes lock files, ignore files, and tooling metadata from indexing', () => {
		// Lock files — auto-generated dependency manifests, no semantic value
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/package-lock.json')), false);
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/yarn.lock')), false);
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/pnpm-lock.yaml')), false);
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/bun.lockb')), false);
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/Cargo.lock')), false);
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/go.sum')), false);
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/Gemfile.lock')), false);
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/poetry.lock')), false);
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/composer.lock')), false);
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/flake.lock')), false);
		// Ignore / VCS config files
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/.gitignore')), false);
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/.gitattributes')), false);
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/.dockerignore')), false);
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/.eslintignore')), false);
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/.prettierignore')), false);
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/.npmignore')), false);
		// Tooling config / build metadata
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/Dockerfile')), false);
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/docker-compose.yml')), false);
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/Makefile')), false);
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/.nvmrc')), false);
		// Normal source files are still indexed
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/src/index.ts')), true);
		assert.strictEqual(shouldIndexSemanticPath(URI.file('/repo/README.md')), true);
	});

	test('creates stable overlapping chunks with symbol metadata', () => {
		const content = ['export function greet() {', ...Array.from({ length: 130 }, (_, i) => `  const v${i} = ${i}`), '}'].join('\n');
		const first = chunkSemanticFile(URI.file('/repo/a.ts'), content, 'typescript');
		const second = chunkSemanticFile(URI.file('/repo/a.ts'), content, 'typescript');
		assert.ok(first.length > 1);
		assert.strictEqual(first[0].symbolName, 'greet');
		assert.deepStrictEqual(first.map(c => c.id), second.map(c => c.id));
		assert.ok(first[1].startLine <= first[0].endLine);
	});

	test('normalizes vectors and computes cosine similarity', () => {
		const vector = normalizeEmbedding([3, 4]);
		assert.ok(Math.abs(cosineSimilarity(vector, vector) - 1) < 1e-10);
		assert.throws(() => normalizeEmbedding([0, 0]));
	});

	test('adds bounded lexical boosts', () => {
		const boost = lexicalBoost('authentication service', { uri: URI.file('/repo/auth/authenticationService.ts'), symbolName: 'AuthenticationService', content: 'creates a session' });
		assert.ok(boost > 0 && boost <= 0.25);
	});

	test('builds provider endpoints', () => {
		assert.strictEqual(embeddingEndpoint('ollama', 'http://localhost:11434/'), 'http://localhost:11434/api/embed');
		assert.strictEqual(embeddingEndpoint('openAICompatible', 'https://example.test/v1'), 'https://example.test/v1/embeddings');
	});

	test('validates embedding IPC requests', () => {
		const request = validateSemanticEmbeddingRequest({ provider: 'ollama', endpoint: 'http://localhost:11434', model: 'nomic-embed-text', inputs: ['hello'] });
		assert.strictEqual(request.inputs.length, 1);
		assert.throws(() => validateSemanticEmbeddingRequest({ provider: 'ollama', endpoint: 'file:///tmp/socket', model: 'model', inputs: ['hello'] }));
		assert.throws(() => validateSemanticEmbeddingRequest({ provider: 'openAICompatible', endpoint: 'http://example.com/v1', apiKey: 'secret', model: 'model', inputs: ['hello'] }), /must use HTTPS/);
		assert.throws(() => validateSemanticEmbeddingRequest({ provider: 'ollama', endpoint: 'http://localhost', model: 'model', inputs: [] }));
	});

	test('extracts and validates Ollama and OpenAI-compatible vectors', () => {
		assert.deepStrictEqual(extractSemanticEmbeddings('ollama', { embeddings: [[1, 2]] }, 1), [[1, 2]]);
		assert.deepStrictEqual(extractSemanticEmbeddings('openAICompatible', { data: [{ embedding: [3, 4] }] }, 1), [[3, 4]]);
		assert.throws(() => extractSemanticEmbeddings('ollama', { embeddings: [[Number.NaN]] }, 1));
		assert.throws(() => extractSemanticEmbeddings('ollama', { embeddings: [[1], [2]] }, 1));
	});

	test('turns provider payloads into actionable bounded errors', () => {
		assert.match(semanticEmbeddingProviderError(400, '{"error":"the input length exceeds the context length"}').message, /context window/);
		assert.match(semanticEmbeddingProviderError(404, '{"error":"missing"}').message, /model was not found/);
		assert.ok(semanticEmbeddingProviderError(500, 'x'.repeat(2_000)).message.length < 600);
	});

	test('classifies transient vs permanent embedding errors', () => {
		// Transient: rate limit, 5xx, timeouts, network blips
		assert.strictEqual(isTransientEmbeddingError(new Error('Embedding provider is rate limited (HTTP 429). Wait briefly, then retry indexing.')), true);
		assert.strictEqual(isTransientEmbeddingError(semanticEmbeddingProviderError(500, 'internal server error')), true);
		assert.strictEqual(isTransientEmbeddingError(semanticEmbeddingProviderError(503, 'service unavailable')), true);
		assert.strictEqual(isTransientEmbeddingError(new Error('Request timed out after 60000ms')), true);
		assert.strictEqual(isTransientEmbeddingError(new Error('fetch failed: ECONNREFUSED')), true);
		assert.strictEqual(isTransientEmbeddingError(new Error('socket hang up')), true);
		// Permanent: auth, model not found, context window, bad request
		assert.strictEqual(isTransientEmbeddingError(semanticEmbeddingProviderError(401, 'unauthorized')), false);
		assert.strictEqual(isTransientEmbeddingError(semanticEmbeddingProviderError(403, 'forbidden')), false);
		assert.strictEqual(isTransientEmbeddingError(semanticEmbeddingProviderError(404, 'not found')), false);
		assert.strictEqual(isTransientEmbeddingError(semanticEmbeddingProviderError(400, '{"error":"input length exceeds the context length"}')), false);
		assert.strictEqual(isTransientEmbeddingError(new Error('Embedding provider returned an invalid vector.')), false);
	});

	test('parses Retry-After hints bounded to 60s', () => {
		assert.strictEqual(embeddingRetryAfterMs(new Error('HTTP 429: retry-after: 5')), 5_000);
		assert.strictEqual(embeddingRetryAfterMs(new Error('Retry-After: 120')), 60_000);
		assert.strictEqual(embeddingRetryAfterMs(new Error('no hint here')), undefined);
		assert.strictEqual(embeddingRetryAfterMs(new Error('retry-after: 0.5')), 500);
	});

	test('honors .orbitignore comments, files, directories, and globs', () => {
		const patterns = parseSemanticIgnore('# private\nsecrets/\n*.generated.ts');
		assert.strictEqual(matchesSemanticIgnore('secrets/token.ts', patterns), true);
		assert.strictEqual(matchesSemanticIgnore('src/api.generated.ts', patterns), true);
		assert.strictEqual(matchesSemanticIgnore('src/api.ts', patterns), false);
	});
});
