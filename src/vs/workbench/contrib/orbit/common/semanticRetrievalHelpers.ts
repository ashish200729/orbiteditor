import { hash } from '../../../../base/common/hash.js';
import { match } from '../../../../base/common/glob.js';
import { URI } from '../../../../base/common/uri.js';
import { SemanticChunk } from './semanticRetrievalTypes.js';

export const SEMANTIC_INDEX_SCHEMA_VERSION = 2;
export const SEMANTIC_MAX_FILE_BYTES = 512 * 1024;
export const SEMANTIC_MAX_FILES = 20_000;
export const SEMANTIC_MAX_CHUNKS = 50_000;
// Keep chunks below common local embedding context windows. Dense source code can
// approach one token per character, so a character cap near a model's advertised
// token cap is not safe.
export const SEMANTIC_MAX_CHUNK_CHARS = 1_800;
export const SEMANTIC_MAX_RESULTS = 20;

const excludedDirectories = new Set([
	'.git', '.hg', '.svn', 'node_modules', 'bower_components', 'dist', 'build', 'out',
	'coverage', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.next', '.turbo',
]);

const excludedFileNames = /^(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials(?:\.json)?|.*\.(?:pem|p12|pfx|key))$/i;
const excludedNonSemanticFileNames = /^(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-lock\.yml|bun\.lockb|bun\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|poetry\.lock|go\.sum|go\.mod|flake\.lock|gradle\.lockfile|Pipfile\.lock|\.gitignore|\.gitattributes|\.gitmodules|\.gitkeep|\.dockerignore|\.eslintignore|\.prettierignore|\.stylelintignore|\.npmignore|\.hgignore|\.svnignore|\.dockerignore|\.npmrc|\.yarnrc|\.yarnrc\.yml|\.node-version|\.nvmrc|\.ruby-version|\.python-version|Dockerfile|docker-compose\.yml|docker-compose\.yaml|Makefile)$/i;
const binaryExtensions = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|7z|rar|mp[34]|mov|avi|woff2?|ttf|eot|wasm|class|jar|exe|dll|dylib|so|bin)$/i;

export function shouldIndexSemanticPath(uri: URI): boolean {
	const segments = uri.path.split('/').filter(Boolean);
	if (segments.some(segment => excludedDirectories.has(segment))) return false;
	const name = segments.at(-1) ?? '';
	if (excludedFileNames.test(name) || binaryExtensions.test(name)) return false;
	if (excludedNonSemanticFileNames.test(name)) return false;
	return true;
}

export function parseSemanticIgnore(content: string): string[] {
	return content.split(/\r?\n/).map(line => line.trim()).filter(line => !!line && !line.startsWith('#'));
}

export function matchesSemanticIgnore(relativePath: string, patterns: readonly string[]): boolean {
	const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
	return patterns.some(raw => {
		const pattern = raw.replace(/^\/+/, '').replace(/\/$/, '/**');
		return match(pattern.includes('/') || pattern.startsWith('**') ? pattern : `**/${pattern}`, normalized)
			|| match(pattern, normalized);
	});
}

export function looksLikeBinaryContent(content: string): boolean {
	return content.includes('\0');
}

function symbolAtLine(line: string): string | undefined {
	const match = line.match(/^\s*(?:export\s+)?(?:async\s+)?(?:class|interface|type|enum|function|def|fn|struct|trait|impl)\s+([\w$]+)/)
		?? line.match(/^\s*(?:public|private|protected|static|async|final|override|abstract|export|const|let|var|function|fun|func|def|fn|void|[A-Z][\w<>?, ]*)\s+([A-Za-z_$][\w$]*)\s*\(/);
	return match?.[1];
}

export function chunkSemanticFile(uri: URI, content: string, languageId = ''): SemanticChunk[] {
	const lines = content.replace(/\r\n/g, '\n').split('\n');
	const chunks: SemanticChunk[] = [];
	let start = 0;
	let currentSymbol: string | undefined;
	while (start < lines.length) {
		const endExclusive = Math.min(lines.length, start + 100);
		for (let i = start; i < endExclusive; i++) currentSymbol = symbolAtLine(lines[i]) ?? currentSymbol;
		let end = endExclusive;
		let text = lines.slice(start, end).join('\n');
		while (text.length > SEMANTIC_MAX_CHUNK_CHARS && end > start + 1) {
			end--;
			text = lines.slice(start, end).join('\n');
		}
		if (text.trim()) {
			const contentHash = String(hash(text));
			chunks.push({
				id: `${String(hash(uri.toString()))}:${start + 1}:${end}:${contentHash}`,
				uri,
				startLine: start + 1,
				endLine: end,
				languageId,
				symbolName: currentSymbol,
				content: text,
				contentHash,
			});
		}
		if (end >= lines.length) break;
		start = Math.max(start + 1, end - 15);
	}
	return chunks;
}

export function normalizeEmbedding(values: readonly number[]): number[] {
	let magnitude = 0;
	for (const value of values) {
		if (!Number.isFinite(value)) throw new Error('Embedding provider returned a non-finite value.');
		magnitude += value * value;
	}
	if (magnitude === 0) throw new Error('Embedding provider returned a zero vector.');
	const divisor = Math.sqrt(magnitude);
	return values.map(value => value / divisor);
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
	if (a.length !== b.length) return -1;
	let score = 0;
	for (let i = 0; i < a.length; i++) score += a[i] * b[i];
	return score;
}

export function lexicalBoost(query: string, chunk: Pick<SemanticChunk, 'uri' | 'symbolName' | 'content'>): number {
	const terms = query.toLowerCase().split(/[^a-z0-9_$]+/).filter(term => term.length > 1);
	if (!terms.length) return 0;
	const path = chunk.uri.path.toLowerCase();
	const symbol = chunk.symbolName?.toLowerCase() ?? '';
	const content = chunk.content.toLowerCase();
	let score = 0;
	for (const term of terms) {
		if (symbol === term) score += 0.12;
		else if (symbol.includes(term)) score += 0.06;
		if (path.includes(term)) score += 0.04;
		if (content.includes(term)) score += 0.015;
	}
	return Math.min(score, 0.25);
}

export function embeddingEndpoint(provider: 'ollama' | 'openAICompatible', endpoint: string): string {
	const base = endpoint.trim().replace(/\/+$/, '');
	if (provider === 'ollama') return /\/api\/embed$/.test(base) ? base : `${base}/api/embed`;
	if (/\/embeddings$/.test(base)) return base;
	return /\/v1$/.test(base) ? `${base}/embeddings` : `${base}/v1/embeddings`;
}
