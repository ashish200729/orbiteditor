import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { asText, IRequestService } from '../../../../platform/request/common/request.js';
import { embeddingEndpoint } from '../common/semanticRetrievalHelpers.js';
import { extractSemanticEmbeddings, semanticEmbeddingProviderError, SemanticEmbeddingRequest, SemanticEmbeddingResponse, validateSemanticEmbeddingRequest } from '../common/semanticEmbeddingProtocol.js';

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
		const context = await this.requestService.request({
			type: 'POST',
			url: embeddingEndpoint(request.provider, request.endpoint),
			headers,
			data: JSON.stringify(body),
			timeout: 60_000,
		}, cancellationToken);
		const text = await asText(context);
		if (!context.res.statusCode || context.res.statusCode < 200 || context.res.statusCode >= 300) {
			throw semanticEmbeddingProviderError(context.res.statusCode, text);
		}
		let data: unknown;
		try { data = JSON.parse(text ?? ''); } catch { throw new Error('Embedding provider returned invalid JSON.'); }
		return { embeddings: extractSemanticEmbeddings(request.provider, data, request.inputs.length) };
	}
}
