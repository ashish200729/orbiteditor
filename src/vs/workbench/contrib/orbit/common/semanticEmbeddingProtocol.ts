export const SEMANTIC_EMBEDDING_CHANNEL = 'void-channel-semantic-embedding';

export type SemanticEmbeddingProvider = 'ollama' | 'openAICompatible';

export interface SemanticEmbeddingRequest {
	provider: SemanticEmbeddingProvider;
	endpoint: string;
	model: string;
	apiKey?: string;
	inputs: string[];
}

export interface SemanticEmbeddingResponse {
	embeddings: number[][];
}

const MAX_BATCH_SIZE = 16;
const MAX_INPUT_CHARS = 8_192;
const MAX_EMBEDDING_DIMENSIONS = 16_384;

export function validateSemanticEmbeddingRequest(value: unknown): SemanticEmbeddingRequest {
	if (!value || typeof value !== 'object') throw new Error('Invalid embedding request.');
	const request = value as Partial<SemanticEmbeddingRequest>;
	if (request.provider !== 'ollama' && request.provider !== 'openAICompatible') throw new Error('Unsupported embedding provider.');
	if (typeof request.endpoint !== 'string' || !request.endpoint.trim() || request.endpoint.length > 2_048) throw new Error('A valid embedding endpoint is required.');
	let url: URL;
	try { url = new URL(request.endpoint); } catch { throw new Error('Embedding endpoint must be a valid URL.'); }
	if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Embedding endpoint must use HTTP or HTTPS.');
	if (url.username || url.password) throw new Error('Embedding endpoint must not contain credentials.');
	if (typeof request.model !== 'string' || !request.model.trim() || request.model.length > 256) throw new Error('An embedding model is required.');
	if (!Array.isArray(request.inputs) || request.inputs.length < 1 || request.inputs.length > MAX_BATCH_SIZE) throw new Error(`Embedding requests must contain 1-${MAX_BATCH_SIZE} inputs.`);
	if (request.inputs.some(input => typeof input !== 'string' || !input.trim() || input.length > MAX_INPUT_CHARS)) throw new Error(`Each embedding input must contain 1-${MAX_INPUT_CHARS} characters.`);
	if (request.apiKey !== undefined && (typeof request.apiKey !== 'string' || request.apiKey.length > 16_384)) throw new Error('Invalid embedding API key.');
	return request as SemanticEmbeddingRequest;
}

export function extractSemanticEmbeddings(provider: SemanticEmbeddingProvider, value: unknown, expectedCount: number): number[][] {
	if (!value || typeof value !== 'object') throw new Error('Embedding provider returned an invalid JSON object.');
	const data = value as { embeddings?: unknown; data?: unknown };
	const candidate = provider === 'ollama'
		? data.embeddings
		: Array.isArray(data.data) ? data.data.map(item => (item as { embedding?: unknown })?.embedding) : undefined;
	if (!Array.isArray(candidate) || candidate.length !== expectedCount) throw new Error(`Embedding provider returned ${Array.isArray(candidate) ? candidate.length : 0} vectors for ${expectedCount} inputs.`);
	let dimensions: number | undefined;
	return candidate.map(vector => {
		if (!Array.isArray(vector) || vector.length < 1 || vector.length > MAX_EMBEDDING_DIMENSIONS) throw new Error('Embedding provider returned an invalid vector.');
		if (dimensions === undefined) dimensions = vector.length;
		else if (vector.length !== dimensions) throw new Error('Embedding provider returned vectors with inconsistent dimensions.');
		if (vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Embedding provider returned a non-finite value.');
		return vector as number[];
	});
}

export function semanticEmbeddingProviderError(statusCode: number | undefined, responseText: string | null): Error {
	let detail = responseText?.replace(/\s+/g, ' ').trim().slice(0, 500);
	if (responseText) {
		try {
			const parsed = JSON.parse(responseText) as { error?: unknown; message?: unknown };
			const candidate = typeof parsed.error === 'string' ? parsed.error : typeof parsed.message === 'string' ? parsed.message : undefined;
			if (candidate) detail = candidate.replace(/\s+/g, ' ').trim().slice(0, 500);
		} catch {
			// Plain-text provider errors are already safe and bounded above.
		}
	}
	const status = statusCode ?? 'unknown';
	if (statusCode === 400 && detail && /context length|context window|too many tokens|input length/i.test(detail)) {
		return new Error(`Embedding input exceeds the model context window: ${detail}`);
	}
	if (statusCode === 401 || statusCode === 403) return new Error(`Embedding provider rejected authentication (HTTP ${status}). Check the API key and endpoint permissions.`);
	if (statusCode === 404) return new Error('Embedding endpoint or model was not found (HTTP 404). Check the endpoint URL and model name.');
	if (statusCode === 429) return new Error('Embedding provider is rate limited (HTTP 429). Wait briefly, then retry indexing.');
	if (statusCode && statusCode >= 500) return new Error(`Embedding provider returned HTTP ${status}${detail ? `: ${detail}` : '.'}`);
	return new Error(`Embedding provider returned HTTP ${status}${detail ? `: ${detail}` : '.'}`);
}

/**
 * Returns true when an embedding error is worth retrying after a short backoff.
 * Rate limits, transient 5xx responses, timeouts, and network blips qualify.
 * Auth, schema, model-not-found, and context-window errors do not — they will
 * keep failing until the user changes settings.
 */
export function isTransientEmbeddingError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	if (/HTTP 429|rate limit/i.test(message)) return true;
	if (/HTTP 5\d\d|internal server|bad gateway|service unavailable|gateway timeout/i.test(message)) return true;
	if (/timed out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(message)) return true;
	if (/ECONNRESET|ECONNREFUSED|EPIPE|ENETUNREACH|EHOSTUNREACH|fetch failed|network|socket hang up/i.test(message)) return true;
	return false;
}

/**
 * Extracts a Retry-After hint (in milliseconds) from a provider error message,
 * if present. Returns undefined when no hint is available.
 */
export function embeddingRetryAfterMs(error: unknown): number | undefined {
	const message = error instanceof Error ? error.message : String(error);
	const match = message.match(/retry[- ]?after[:\s]+(\d+(?:\.\d+)?)/i);
	if (match) {
		const seconds = Number(match[1]);
		if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 60_000);
	}
	return undefined;
}
