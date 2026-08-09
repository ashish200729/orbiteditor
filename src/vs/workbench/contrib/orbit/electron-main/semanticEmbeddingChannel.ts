import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { asText, IRequestService } from '../../../../platform/request/common/request.js';
import { IRequestContext } from '../../../../base/parts/request/common/request.js';
import { embeddingEndpoint } from '../common/semanticRetrievalHelpers.js';
import { extractSemanticEmbeddings, semanticEmbeddingProviderError, SemanticEmbeddingRequest, SemanticEmbeddingResponse, validateSemanticEmbeddingRequest } from '../common/semanticEmbeddingProtocol.js';
import { remoteHttpEndpointPolicyError } from '../common/networkSecurity.js';

export class SemanticEmbeddingChannel implements IServerChannel {
	constructor(private readonly requestService: IRequestService) { }

	listen<T>(_: unknown, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_: unknown, command: string, arg?: unknown, cancellationToken: CancellationToken = CancellationToken.None): Promise<T> {
		if (command !== 'embed') throw new Error(`Call not found: ${command}`);
		return this.embed(validateSemanticEmbeddingRequest(arg), cancellationToken) as Promise<T>;
	}

	private async embed(request: SemanticEmbeddingRequest, cancellationToken: CancellationToken): Promise<SemanticEmbeddingResponse> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (request.provider === 'openAICompatible' && request.apiKey?.trim()) headers.Authorization = `Bearer ${request.apiKey.trim()}`;
		const body = request.provider === 'ollama'
			? { model: request.model.trim(), input: request.inputs }
			: { model: request.model.trim(), input: request.inputs, encoding_format: 'float' };
		let method = 'POST';
		let url = embeddingEndpoint(request.provider, request.endpoint);
		let data: string | undefined = JSON.stringify(body);
		let requestHeaders = headers;
		let context: IRequestContext;
		for (let redirects = 0; ; redirects++) {
			const policyError = remoteHttpEndpointPolicyError(url, 'Semantic embedding endpoint');
			if (policyError) throw new Error(policyError);
			context = await this.requestService.request({
				type: method,
				url,
				headers: requestHeaders,
				data,
				followRedirects: 0,
				timeout: 60_000,
			}, cancellationToken);
			const status = context.res.statusCode ?? 0;
			if (![301, 302, 303, 307, 308].includes(status)) break;
			if (redirects >= 5) throw new Error('Semantic embedding endpoint exceeded the maximum redirect count.');
			const rawLocation = context.res.headers.location;
			const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
			if (!location) throw new Error('Semantic embedding endpoint returned a redirect without a Location header.');
			const next = new URL(location, url);
			const nextError = remoteHttpEndpointPolicyError(next.toString(), 'Semantic embedding endpoint redirect');
			if (nextError) throw new Error(nextError);
			await asText(context); // drain the redirect response before issuing another request
			const previousOrigin = new URL(url).origin;
			if (next.origin !== previousOrigin && method !== 'GET' && method !== 'HEAD' && status !== 303 && !((status === 301 || status === 302) && method === 'POST')) {
				throw new Error('Semantic embedding endpoint refused a cross-origin redirect that would forward a request body.');
			}
			if (next.origin !== previousOrigin) {
				requestHeaders = Object.fromEntries(Object.entries(requestHeaders).filter(([name]) => !/authorization|cookie|api[-_]?key|token|secret/i.test(name)));
			}
			if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
				method = 'GET';
				data = undefined;
				requestHeaders = Object.fromEntries(Object.entries(requestHeaders).filter(([name]) => !/^content-(?:length|type)$/i.test(name)));
			}
			url = next.toString();
		}
		const text = await asText(context);
		if (!context.res.statusCode || context.res.statusCode < 200 || context.res.statusCode >= 300) {
			throw semanticEmbeddingProviderError(context.res.statusCode, text);
		}
		let responseData: unknown;
		try { responseData = JSON.parse(text ?? ''); } catch { throw new Error('Embedding provider returned invalid JSON.'); }
		return { embeddings: extractSemanticEmbeddings(request.provider, responseData, request.inputs.length) };
	}
}
