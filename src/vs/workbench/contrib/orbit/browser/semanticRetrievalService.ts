import { RunOnceScheduler } from '../../../../base/common/async.js';
import { decodeBase64, encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname, relativePath } from '../../../../base/common/resources.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { IVoidSettingsService } from '../common/orbitSettingsService.js';
import { SEMANTIC_EMBEDDING_CHANNEL, embeddingRetryAfterMs, isTransientEmbeddingError, SemanticEmbeddingResponse } from '../common/semanticEmbeddingProtocol.js';
import {
	chunkSemanticFile,
	cosineSimilarity,
	lexicalBoost,
	looksLikeBinaryContent,
	matchesSemanticIgnore,
	normalizeEmbedding,
	parseSemanticIgnore,
	SEMANTIC_INDEX_SCHEMA_VERSION,
	SEMANTIC_MAX_FILE_BYTES,
	SEMANTIC_MAX_FILES,
	SEMANTIC_MAX_CHUNKS,
	SEMANTIC_MAX_RESULTS,
	shouldIndexSemanticPath,
} from '../common/semanticRetrievalHelpers.js';
import { SemanticChunk, SemanticIndexStatus, SemanticSearchResult } from '../common/semanticRetrievalTypes.js';
import { SemanticVectorIndex } from '../common/semanticVectorIndex.js';
import { IAgentProjectWorkspaceService } from './agentProjectWorkspaceService.js';

interface IndexedChunk extends SemanticChunk { vector: number[] }
interface PersistedIndex {
	schemaVersion: number;
	provider: string;
	model: string;
	fingerprint: string;
	chunks: Array<Omit<IndexedChunk, 'uri' | 'vector'> & { uri: string; vector: string }>;
	lastIndexedAt: number;
}

const SEMANTIC_EMBEDDING_MAX_TRANSIENT_RETRIES = 4;
const SEMANTIC_EMBEDDING_BASE_BACKOFF_MS = 400;
const SEMANTIC_EMBEDDING_MAX_BACKOFF_MS = 8_000;

/** Abort-aware sleep used for retry backoff. Resolves immediately if aborted. */
function semanticDelay(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted || ms <= 0) return Promise.resolve();
	return new Promise(resolve => {
		const timer = setTimeout(resolve, ms);
		const onAbort = () => { clearTimeout(timer); resolve(); };
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

export interface ISemanticRetrievalService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeStatus: Event<SemanticIndexStatus>;
	getStatus(): SemanticIndexStatus;
	search(query: string, opts?: { path?: URI | null; folderRoots?: URI[]; topK?: number; signal?: AbortSignal }): Promise<SemanticSearchResult>;
	rebuild(): Promise<void>;
	pause(): void;
	deleteIndex(): Promise<void>;
}

export const ISemanticRetrievalService = createDecorator<ISemanticRetrievalService>('semanticRetrievalService');

export class SemanticRetrievalService extends Disposable implements ISemanticRetrievalService {
	readonly _serviceBrand: undefined;
	private readonly queryBuilder: QueryBuilder;
	private readonly changeScheduler: RunOnceScheduler;
	private readonly onDidChangeStatusEmitter = this._register(new Emitter<SemanticIndexStatus>());
	readonly onDidChangeStatus = this.onDidChangeStatusEmitter.event;
	private chunks: IndexedChunk[] = [];
	private readonly vectorIndex = new SemanticVectorIndex();
	private indexedFiles = 0;
	private indexedRootKeys = new Set<string>();
	private generation = 0;
	private abortController: AbortController | undefined;
	private lastSettingsFingerprint = '';
	private wasEnabled = false;
	private readonly pendingChangedResources = new Map<string, URI>();
	private fullRebuildScheduled = false;
	private status: SemanticIndexStatus = { state: 'disabled', indexedFiles: 0, indexedChunks: 0 };
	private readonly embeddingChannel: IChannel;
	private lastProgressReportAt = 0;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IFileService private readonly fileService: IFileService,
		@ISearchService private readonly searchService: ISearchService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustService: IWorkspaceTrustManagementService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IModelService private readonly modelService: IModelService,
		@IVoidSettingsService private readonly settingsService: IVoidSettingsService,
		@ILogService private readonly logService: ILogService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@IAgentProjectWorkspaceService private readonly agentProjectWorkspaceService: IAgentProjectWorkspaceService,
	) {
		super();
		this.embeddingChannel = mainProcessService.getChannel(SEMANTIC_EMBEDDING_CHANNEL);
		this.queryBuilder = instantiationService.createInstance(QueryBuilder);
		this.changeScheduler = this._register(new RunOnceScheduler(() => void this.processScheduledChanges(), 900));
		this._register(this.fileService.onDidFilesChange(event => {
			if (!this.settingsService.state.globalSettings.semanticSearchEnabled || !this.indexRoots().some(folder => event.affects(folder))) return;
			const resources = [...event.rawAdded, ...event.rawUpdated, ...event.rawDeleted];
			if (resources.some(resource => resource.path.endsWith('/.orbitignore'))) this.fullRebuildScheduled = true;
			else for (const resource of resources) this.pendingChangedResources.set(resource.toString(), resource);
			this.changeScheduler.schedule();
		}));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this.fullRebuildScheduled = true;
			this.changeScheduler.schedule(0);
		}));
		this._register(this.agentProjectWorkspaceService.onDidChangeState(() => {
			this.fullRebuildScheduled = true;
			this.changeScheduler.schedule(0);
		}));
		this._register(this.settingsService.onDidChangeState(() => this.handleSettingsChange()));
		for (const model of this.modelService.getModels()) this.subscribeModel(model);
		this._register(this.modelService.onModelAdded(model => this.subscribeModel(model)));
		void this.settingsService.waitForInitState.then(() => this.initialize());
	}

	private subscribeModel(model: ITextModel): void {
		const schedule = () => {
			if (!this.settingsService.state.globalSettings.semanticSearchEnabled || !this.workspaceRootFor(model.uri)) return;
			this.pendingChangedResources.set(model.uri.toString(), model.uri);
			this.changeScheduler.schedule();
		};
		this._register(model.onDidChangeContent(schedule));
		this._register(model.onWillDispose(schedule));
	}

	getStatus(): SemanticIndexStatus { return { ...this.status }; }

	private setStatus(status: SemanticIndexStatus): void {
		this.status = status;
		this.onDidChangeStatusEmitter.fire({ ...status });
	}

	private reportProgress(status: SemanticIndexStatus, force = false): void {
		const now = Date.now();
		if (!force && now - this.lastProgressReportAt < 100) return;
		this.lastProgressReportAt = now;
		this.setStatus(status);
	}

	private configFingerprint(): string {
		const settings = this.settingsService.state.globalSettings;
		return `${settings.semanticEmbeddingProvider}:${settings.semanticEmbeddingEndpoint}:${settings.semanticEmbeddingModel}`;
	}

	private indexRoots(): URI[] {
		const roots: URI[] = [];
		const seen = new Set<string>();
		const add = (uri: URI) => {
			const key = uri.toString();
			if (!seen.has(key)) {
				seen.add(key);
				roots.push(uri);
			}
		};
		for (const folder of this.workspaceContextService.getWorkspace().folders) add(folder.uri);
		for (const workspace of Object.values(this.agentProjectWorkspaceService.getState().workspaces)) {
			for (const folder of workspace.folders) {
				try { add(URI.parse(folder.uri)); } catch { /* skip stale serialized URI */ }
			}
		}
		return roots;
	}

	private async initialize(): Promise<void> {
		if (!this.settingsService.state.globalSettings.semanticSearchEnabled) return;
		this.wasEnabled = true;
		this.lastSettingsFingerprint = this.configFingerprint();
		if (!this.workspaceTrustService.isWorkspaceTrusted()) {
			this.setStatus({ state: 'error', indexedFiles: 0, indexedChunks: 0, error: 'Semantic indexing requires a trusted workspace.' });
			return;
		}
		this.setStatus({ state: 'loading', phase: 'loading', indexedFiles: 0, indexedChunks: 0 });
		await this.loadPersistedIndex();
		if (!this.settingsService.state.globalSettings.semanticSearchEnabled) return; // disabled during load
		void this.rebuild();
	}

	private handleSettingsChange(): void {
		const enabled = this.settingsService.state.globalSettings.semanticSearchEnabled;
		if (!enabled) {
			this.generation++;
			this.abortController?.abort();
			this.chunks = [];
			this.vectorIndex.rebuild([]);
			this.indexedFiles = 0;
			this.indexedRootKeys.clear();
			this.setStatus({ state: 'disabled', indexedFiles: 0, indexedChunks: 0 });
			this.wasEnabled = false;
			return;
		}
		const fingerprint = this.configFingerprint();
		if (!this.wasEnabled) {
			// Re-enabling from disabled: reload the persisted index (when still valid)
			// before rebuilding so unchanged chunks reuse their cached vectors instead
			// of being re-embedded from scratch. initialize() also handles the
			// fingerprint-change case — loadPersistedIndex rejects mismatched indices.
			void this.initialize();
		} else if (fingerprint !== this.lastSettingsFingerprint) {
			this.lastSettingsFingerprint = fingerprint;
			// Discard vectors from the previous provider/model/endpoint so the rebuild
			// re-embeds every chunk with the new model. Reusing old-model vectors would
			// produce a mixed-dimension index and meaningless cosine rankings.
			this.chunks = [];
			this.vectorIndex.rebuild([]);
			this.indexedFiles = 0;
			this.indexedRootKeys.clear();
			this.fullRebuildScheduled = true;
			this.changeScheduler.schedule(0);
		}
	}

	private async processScheduledChanges(): Promise<void> {
		if (this.fullRebuildScheduled || !this.chunks.length || this.pendingChangedResources.size > 100) {
			this.fullRebuildScheduled = false;
			this.pendingChangedResources.clear();
			await this.rebuild();
			return;
		}
		const resources = [...this.pendingChangedResources.values()];
		this.pendingChangedResources.clear();
		if (resources.length) await this.updateResources(resources);
	}

	private indexResource(): URI {
		return URI.joinPath(this.environmentService.workspaceStorageHome, this.workspaceContextService.getWorkspace().id, 'orbit-semantic-index', 'index.json');
	}

	private async loadPersistedIndex(): Promise<void> {
		try {
			const raw = (await this.fileService.readFile(this.indexResource())).value.toString();
			const parsed = JSON.parse(raw) as PersistedIndex;
			const settings = this.settingsService.state.globalSettings;
			if (parsed.schemaVersion !== SEMANTIC_INDEX_SCHEMA_VERSION || parsed.fingerprint !== this.configFingerprint() || parsed.provider !== settings.semanticEmbeddingProvider || parsed.model !== settings.semanticEmbeddingModel) {
				this.logService.debug('[semantic-index] Persisted index skipped: schema/provider/model changed. Rebuilding from source.');
				return;
			}
			this.chunks = parsed.chunks.map(chunk => ({ ...chunk, uri: URI.parse(chunk.uri), vector: this.decodeVector(chunk.vector) }));
			this.vectorIndex.rebuild(this.chunks.map(chunk => chunk.vector));
			this.indexedFiles = new Set(this.chunks.map(chunk => chunk.uri.toString())).size;
			this.indexedRootKeys = new Set(this.indexRoots()
				.filter(root => this.chunks.some(chunk => relativePath(root, chunk.uri) !== undefined))
				.map(root => root.toString()));
			this.setStatus({ state: 'ready', indexedFiles: this.indexedFiles, indexedChunks: this.chunks.length, lastIndexedAt: parsed.lastIndexedAt });
		} catch (error) {
			// A missing cache is the normal first-run path; a corrupt one is safe to rebuild from source.
			const code = error instanceof Error ? error.message : String(error);
			const isMissing = /FileNotFound|ENOENT|not found/i.test(code);
			if (!isMissing) this.logService.debug(`[semantic-index] Persisted index could not be loaded and will be rebuilt: ${code}`);
		}
	}

	private async persistIndex(lastIndexedAt: number): Promise<void> {
		const target = this.indexResource();
		const temp = target.with({ path: `${target.path}.tmp` });
		const settings = this.settingsService.state.globalSettings;
		const payload: PersistedIndex = {
			schemaVersion: SEMANTIC_INDEX_SCHEMA_VERSION,
			provider: settings.semanticEmbeddingProvider,
			model: settings.semanticEmbeddingModel,
			fingerprint: this.configFingerprint(),
			chunks: this.chunks.map(({ vector, ...chunk }) => ({ ...chunk, uri: chunk.uri.toString(), vector: this.encodeVector(vector) })),
			lastIndexedAt,
		};
		await this.fileService.createFolder(dirname(target));
		await this.fileService.writeFile(temp, VSBuffer.fromString(JSON.stringify(payload)));
		await this.fileService.move(temp, target, true);
	}

	private encodeVector(vector: readonly number[]): string {
		const floats = Float32Array.from(vector);
		return encodeBase64(VSBuffer.wrap(new Uint8Array(floats.buffer)));
	}

	private decodeVector(encoded: string): number[] {
		const bytes = decodeBase64(encoded).buffer;
		if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) throw new Error('Invalid persisted embedding vector.');
		const copy = bytes.slice().buffer;
		return Array.from(new Float32Array(copy));
	}

	private async embed(inputs: string[], signal: AbortSignal): Promise<number[][]> {
		const settings = this.settingsService.state.globalSettings;
		let preparedInputs = inputs;
		// Outer loop: shrink oversized inputs when the provider reports a context-window error.
		for (let shrinkAttempt = 0; shrinkAttempt < 7; shrinkAttempt++) {
			// Inner loop: retry transient errors (rate limits, 5xx, timeouts, network blips)
			// with exponential backoff and jitter before giving up on this batch.
			for (let transientAttempt = 0; transientAttempt <= SEMANTIC_EMBEDDING_MAX_TRANSIENT_RETRIES; transientAttempt++) {
				if (signal.aborted) throw new Error('Embedding cancelled.');
				const tokenSource = new CancellationTokenSource();
				const abort = () => tokenSource.cancel();
				signal.addEventListener('abort', abort, { once: true });
				try {
					const response = await this.embeddingChannel.call<SemanticEmbeddingResponse>('embed', {
						provider: settings.semanticEmbeddingProvider,
						endpoint: settings.semanticEmbeddingEndpoint,
						model: settings.semanticEmbeddingModel,
						apiKey: settings.semanticEmbeddingApiKey,
						inputs: preparedInputs,
					}, tokenSource.token);
					return response.embeddings.map(normalizeEmbedding);
				} catch (error) {
					if (signal.aborted) throw error;
					const message = error instanceof Error ? error.message : String(error);
					// Context-window errors: shrink inputs and restart the transient loop.
					const longest = Math.max(...preparedInputs.map(input => input.length));
					if (/context length|context window|too many tokens|input length/i.test(message) && longest > 320) {
						const nextLimit = Math.max(320, Math.floor(longest * 0.65));
						preparedInputs = preparedInputs.map(input => input.length > nextLimit ? `${input.slice(0, nextLimit - 22)}\n…[chunk shortened]` : input);
						this.logService.debug(`[semantic-index] Retrying an oversized embedding batch with a ${nextLimit}-character input limit.`);
						break; // restart outer (shrink) loop
					}
					// Transient errors: back off and retry the same batch.
					if (isTransientEmbeddingError(error) && transientAttempt < SEMANTIC_EMBEDDING_MAX_TRANSIENT_RETRIES) {
						const hint = embeddingRetryAfterMs(error);
						const exp = SEMANTIC_EMBEDDING_BASE_BACKOFF_MS * Math.pow(2, transientAttempt);
						const capped = Math.min(exp, SEMANTIC_EMBEDDING_MAX_BACKOFF_MS);
						const jitter = Math.floor(Math.random() * (capped * 0.25));
						const delay = hint ?? (capped + jitter);
						this.logService.debug(`[semantic-index] Transient embedding error (${message.slice(0, 120)}). Retrying in ${delay}ms (attempt ${transientAttempt + 1}/${SEMANTIC_EMBEDDING_MAX_TRANSIENT_RETRIES}).`);
						await semanticDelay(delay, signal);
						continue;
					}
					throw error;
				} finally {
					signal.removeEventListener('abort', abort);
					tokenSource.dispose();
				}
			}
		}
		throw new Error('The embedding model context window is too small for code indexing. Choose a model with a larger context window.');
	}

	private workspaceRootFor(uri: URI): URI | undefined {
		return this.indexRoots().find(folder => relativePath(folder, uri) !== undefined);
	}

	private async isIgnoredByOrbitFile(uri: URI, root: URI): Promise<boolean> {
		try {
			const patterns = parseSemanticIgnore((await this.fileService.readFile(URI.joinPath(root, '.orbitignore'))).value.toString());
			return matchesSemanticIgnore(relativePath(root, uri) ?? '', patterns);
		} catch { return false; }
	}

	private async updateResources(resources: URI[]): Promise<void> {
		const generation = ++this.generation;
		this.abortController?.abort();
		this.abortController = new AbortController();
		const signal = this.abortController.signal;
		const startedAt = Date.now();
		let processedFiles = 0;
		const recentFiles: string[] = [];
		this.setStatus({ state: 'indexing', phase: 'embedding', operation: 'incremental', progress: 0, processedFiles: 0, totalFiles: resources.length, indexedFiles: this.indexedFiles, indexedChunks: this.chunks.length, startedAt, lastIndexedAt: this.status.lastIndexedAt });
		let needsFullRebuild = false;
		try {
			const prefixes = resources.map(resource => resource.toString());
			const retained = this.chunks.filter(chunk => !prefixes.some(prefix => chunk.uri.toString() === prefix || chunk.uri.toString().startsWith(`${prefix}/`)));
			const replacement: IndexedChunk[] = [];
			for (const uri of resources) {
				if (signal.aborted || generation !== this.generation) return;
				const root = this.workspaceRootFor(uri);
				const displayPath = root ? (relativePath(root, uri) ?? uri.path) : uri.path;
				recentFiles.unshift(displayPath);
				if (recentFiles.length > 4) recentFiles.pop();
				this.reportProgress({ state: 'indexing', phase: 'embedding', operation: 'incremental', progress: resources.length ? processedFiles / resources.length * 100 : 100, processedFiles, totalFiles: resources.length, currentFile: displayPath, recentFiles: [...recentFiles], indexedFiles: this.indexedFiles, indexedChunks: this.chunks.length + replacement.length, startedAt, lastIndexedAt: this.status.lastIndexedAt }, processedFiles === 0);
				if (!root || !shouldIndexSemanticPath(uri) || await this.isIgnoredByOrbitFile(uri, root)) {
					processedFiles++;
					continue;
				}
				let fileChunks: SemanticChunk[] = [];
				try {
					const stat = await this.fileService.stat(uri);
					if (stat.isDirectory) {
						// A directory in the change set means we can't reason about which
						// descendants changed. Defer to a full rebuild, but still commit the
						// incremental work we already completed so it isn't lost.
						needsFullRebuild = true;
						break;
					}
					if (typeof stat.size === 'number' && stat.size > SEMANTIC_MAX_FILE_BYTES) { processedFiles++; continue; }
					const openModel = this.modelService.getModel(uri);
					const content = openModel?.getValue() ?? (await this.fileService.readFile(uri)).value.toString();
					if (content && !looksLikeBinaryContent(content)) fileChunks = chunkSemanticFile(uri, content, openModel?.getLanguageId() ?? '');
				} catch (error) {
					// Deleted/unavailable files remain removed from the next generation.
					this.logService.debug(`[semantic-index] Skipping ${uri.toString()}: ${error instanceof Error ? error.message : String(error)}`);
				}
				for (let offset = 0; offset < fileChunks.length; offset += 16) {
					if (signal.aborted || generation !== this.generation) return;
					const batch = fileChunks.slice(offset, offset + 16);
					const vectors = await this.embed(batch.map(chunk => `${chunk.uri.path}\n${chunk.symbolName ? `symbol: ${chunk.symbolName}\n` : ''}${chunk.content}`), signal);
					for (let i = 0; i < batch.length; i++) replacement.push({ ...batch[i], vector: vectors[i] });
					const fileProgress = fileChunks.length ? Math.min(1, (offset + batch.length) / fileChunks.length) : 1;
					this.reportProgress({ state: 'indexing', phase: 'embedding', operation: 'incremental', progress: resources.length ? (processedFiles + fileProgress) / resources.length * 100 : 100, processedFiles, totalFiles: resources.length, currentFile: displayPath, recentFiles: [...recentFiles], indexedFiles: this.indexedFiles, indexedChunks: this.chunks.length + replacement.length, startedAt, lastIndexedAt: this.status.lastIndexedAt });
				}
				processedFiles++;
				this.reportProgress({ state: 'indexing', phase: 'embedding', operation: 'incremental', progress: resources.length ? processedFiles / resources.length * 100 : 100, processedFiles, totalFiles: resources.length, currentFile: displayPath, recentFiles: [...recentFiles], indexedFiles: this.indexedFiles, indexedChunks: this.chunks.length + replacement.length, startedAt, lastIndexedAt: this.status.lastIndexedAt });
			}
			if (signal.aborted || generation !== this.generation) return;
			this.chunks = [...retained, ...replacement].slice(0, SEMANTIC_MAX_CHUNKS);
			this.vectorIndex.rebuild(this.chunks.map(chunk => chunk.vector));
			this.indexedFiles = new Set(this.chunks.map(chunk => chunk.uri.toString())).size;
			const lastIndexedAt = Date.now();
			this.reportProgress({ state: 'indexing', phase: 'saving', operation: 'incremental', progress: 100, processedFiles, totalFiles: resources.length, recentFiles: [...recentFiles], indexedFiles: this.indexedFiles, indexedChunks: this.chunks.length, startedAt, lastIndexedAt: this.status.lastIndexedAt }, true);
			await this.persistIndex(lastIndexedAt);
			if (generation !== this.generation) return; // a newer run superseded us during persist
			this.setStatus({ state: 'ready', indexedFiles: this.indexedFiles, indexedChunks: this.chunks.length, lastIndexedAt });
			if (needsFullRebuild) {
				this.fullRebuildScheduled = true;
				this.changeScheduler.schedule(0);
			}
		} catch (error) {
			if (signal.aborted) return;
			const message = error instanceof Error ? error.message : String(error);
			this.logService.warn(`[semantic-index] Incremental update failed: ${message}`);
			this.setStatus({ state: this.chunks.length ? 'ready' : 'error', indexedFiles: this.indexedFiles, indexedChunks: this.chunks.length, error: message });
		}
	}

	async rebuild(): Promise<void> {
		const settings = this.settingsService.state.globalSettings;
		if (!settings.semanticSearchEnabled) return;
		if (!this.workspaceTrustService.isWorkspaceTrusted()) {
			this.setStatus({ state: 'error', indexedFiles: 0, indexedChunks: 0, error: 'Semantic indexing requires a trusted workspace.' });
			return;
		}
		if (!settings.semanticEmbeddingEndpoint.trim()) {
			this.setStatus({ state: 'error', indexedFiles: this.indexedFiles, indexedChunks: this.chunks.length, error: 'Enter an embedding endpoint before indexing.' });
			return;
		}
		if (!settings.semanticEmbeddingModel.trim()) {
			this.setStatus({ state: 'error', indexedFiles: this.indexedFiles, indexedChunks: this.chunks.length, error: 'Enter an embedding model before indexing.' });
			return;
		}
		const workspaceFolders = this.indexRoots();
		if (!workspaceFolders.length) {
			this.setStatus({ state: 'error', indexedFiles: 0, indexedChunks: 0, error: 'Open a folder or workspace to build a semantic index.' });
			return;
		}
		const generation = ++this.generation;
		this.fullRebuildScheduled = false;
		this.pendingChangedResources.clear();
		this.abortController?.abort();
		this.abortController = new AbortController();
		const signal = this.abortController.signal;
		const startedAt = Date.now();
		const previousLastIndexedAt = this.status.lastIndexedAt;
		this.setStatus({ state: 'indexing', phase: 'scanning', operation: 'full', indexedFiles: this.indexedFiles, indexedChunks: this.chunks.length, startedAt, lastIndexedAt: previousLastIndexedAt });
		try {
			const query = this.queryBuilder.file(workspaceFolders, { includePattern: '**/*', maxResults: SEMANTIC_MAX_FILES });
			const result = await this.searchService.fileSearch(query, CancellationToken.None);
			const ignoreByFolder = new Map<string, string[]>();
			for (const folder of workspaceFolders) {
				try {
					ignoreByFolder.set(folder.toString(), parseSemanticIgnore((await this.fileService.readFile(URI.joinPath(folder, '.orbitignore'))).value.toString()));
				} catch { ignoreByFolder.set(folder.toString(), []); }
			}
			const uris = result.results.map(item => item.resource).filter(uri => {
				if (!shouldIndexSemanticPath(uri)) return false;
				const root = workspaceFolders.find(folder => relativePath(folder, uri) !== undefined);
				if (!root) return false;
				return !matchesSemanticIgnore(relativePath(root, uri) ?? '', ignoreByFolder.get(root.toString()) ?? []);
			});
			this.reportProgress({ state: 'indexing', phase: 'embedding', operation: 'full', progress: 0, processedFiles: 0, totalFiles: uris.length, indexedFiles: 0, indexedChunks: 0, startedAt, lastIndexedAt: previousLastIndexedAt }, true);
			const existing = new Map(this.chunks.map(chunk => [`${chunk.uri.toString()}:${chunk.contentHash}:${chunk.startLine}`, chunk]));
			const next: IndexedChunk[] = [];
			let indexedFiles = 0;
			let processedFiles = 0;
			let reachedChunkLimit = false;
			const recentFiles: string[] = [];
			let pending: SemanticChunk[] = [];
			const flush = async () => {
				if (!pending.length) return;
				const batch = pending;
				pending = [];
				const vectors = await this.embed(batch.map(chunk => `${chunk.uri.path}\n${chunk.symbolName ? `symbol: ${chunk.symbolName}\n` : ''}${chunk.content}`), signal);
				for (let i = 0; i < batch.length; i++) next.push({ ...batch[i], vector: vectors[i] });
			};
			for (const uri of uris) {
				if (signal.aborted || generation !== this.generation) return;
				const root = workspaceFolders.find(folder => relativePath(folder, uri) !== undefined);
				const displayPath = root ? (relativePath(root, uri) ?? uri.path) : uri.path;
				recentFiles.unshift(displayPath);
				if (recentFiles.length > 4) recentFiles.pop();
				this.reportProgress({ state: 'indexing', phase: 'embedding', operation: 'full', progress: uris.length ? processedFiles / uris.length * 100 : 100, processedFiles, totalFiles: uris.length, currentFile: displayPath, recentFiles: [...recentFiles], indexedFiles, indexedChunks: next.length + pending.length, startedAt, lastIndexedAt: previousLastIndexedAt }, processedFiles === 0);
				let fileChunks: SemanticChunk[] = [];
				try {
					const stat = await this.fileService.stat(uri);
					if (typeof stat.size === 'number' && stat.size > SEMANTIC_MAX_FILE_BYTES) throw new Error('File exceeds semantic indexing size limit.');
					const openModel = this.modelService.getModel(uri);
					const content = openModel?.getValue() ?? (await this.fileService.readFile(uri)).value.toString();
					if (content && !looksLikeBinaryContent(content)) fileChunks = chunkSemanticFile(uri, content, openModel?.getLanguageId() ?? '');
				} catch (error) {
					this.logService.debug(`[semantic-index] Skipping ${uri.toString()}: ${error instanceof Error ? error.message : String(error)}`);
				}
				if (fileChunks.length) indexedFiles++;
				for (let chunkIndex = 0; chunkIndex < fileChunks.length; chunkIndex++) {
					const chunk = fileChunks[chunkIndex];
					if (next.length + pending.length >= SEMANTIC_MAX_CHUNKS) {
						reachedChunkLimit = true;
						break;
					}
					const reused = existing.get(`${uri.toString()}:${chunk.contentHash}:${chunk.startLine}`);
					if (reused) next.push({ ...chunk, vector: reused.vector });
					else pending.push(chunk);
					if (pending.length >= 16) await flush();
					const fileProgress = fileChunks.length ? (chunkIndex + 1) / fileChunks.length : 1;
					this.reportProgress({ state: 'indexing', phase: 'embedding', operation: 'full', progress: uris.length ? (processedFiles + fileProgress) / uris.length * 100 : 100, processedFiles, totalFiles: uris.length, currentFile: displayPath, recentFiles: [...recentFiles], indexedFiles, indexedChunks: next.length + pending.length, startedAt, lastIndexedAt: previousLastIndexedAt });
				}
				processedFiles++;
				this.reportProgress({ state: 'indexing', phase: 'embedding', operation: 'full', progress: uris.length ? processedFiles / uris.length * 100 : 100, processedFiles, totalFiles: uris.length, currentFile: displayPath, recentFiles: [...recentFiles], indexedFiles, indexedChunks: next.length + pending.length, startedAt, lastIndexedAt: previousLastIndexedAt });
				if (reachedChunkLimit) break;
			}
			await flush();
			if (signal.aborted || generation !== this.generation) return;
			this.chunks = next;
			this.vectorIndex.rebuild(next.map(chunk => chunk.vector));
			this.indexedFiles = new Set(next.map(chunk => chunk.uri.toString())).size;
			this.indexedRootKeys = new Set(workspaceFolders.map(root => root.toString()));
			const lastIndexedAt = Date.now();
			this.reportProgress({ state: 'indexing', phase: 'saving', operation: 'full', progress: 100, processedFiles, totalFiles: uris.length, recentFiles: [...recentFiles], indexedFiles: this.indexedFiles, indexedChunks: next.length, startedAt, lastIndexedAt: previousLastIndexedAt }, true);
			await this.persistIndex(lastIndexedAt);
			if (signal.aborted || generation !== this.generation) return; // a newer run superseded us during persist
			this.setStatus({ state: 'ready', indexedFiles: this.indexedFiles, indexedChunks: next.length, lastIndexedAt });
		} catch (error) {
			if (signal.aborted) return;
			const message = error instanceof Error ? error.message : String(error);
			this.logService.warn(`[semantic-index] Indexing failed for ${this.configFingerprint()}: ${message}`);
			this.setStatus({ state: this.chunks.length ? 'ready' : 'error', indexedFiles: this.indexedFiles, indexedChunks: this.chunks.length, error: message });
		}
	}

	pause(): void {
		if (this.status.state !== 'indexing' && this.status.state !== 'loading') return;
		this.generation++;
		this.abortController?.abort();
		this.setStatus({ ...this.status, state: 'paused', phase: undefined, indexedFiles: this.indexedFiles, indexedChunks: this.chunks.length, currentFile: undefined });
	}

	async deleteIndex(): Promise<void> {
		this.generation++;
		this.abortController?.abort();
		this.chunks = [];
		this.vectorIndex.rebuild([]);
		this.indexedFiles = 0;
		this.indexedRootKeys.clear();
		const target = this.indexResource();
		await Promise.all([
			this.fileService.del(target).catch(() => undefined),
			this.fileService.del(target.with({ path: `${target.path}.tmp` })).catch(() => undefined),
		]);
		this.setStatus({ state: this.settingsService.state.globalSettings.semanticSearchEnabled ? 'empty' : 'disabled', indexedFiles: 0, indexedChunks: 0 });
	}

	async search(query: string, opts?: { path?: URI | null; folderRoots?: URI[]; topK?: number; signal?: AbortSignal }): Promise<SemanticSearchResult> {
		const trimmed = query.trim();
		if (!trimmed) throw new Error('CodebaseSearch query must not be empty.');
		if (opts?.folderRoots?.length && opts.folderRoots.some(root => !this.indexedRootKeys.has(root.toString()))) {
			await this.rebuild();
		}
		if (this.status.state !== 'ready' || !this.chunks.length) {
			return { ...this.status, matches: [], message: this.status.error ?? 'Semantic index is not ready. Continue with Grep, Glob, and Read.' };
		}
		let queryVector: number[];
		try {
			[queryVector] = await this.embed([trimmed], opts?.signal ?? new AbortController().signal);
		} catch (error) {
			if (opts?.signal?.aborted) throw error;
			// If the provider is unavailable mid-search, don't hard-fail the tool.
			// Return a graceful result so the agent falls back to Grep/Glob/Read.
			const message = error instanceof Error ? error.message : String(error);
			this.logService.debug(`[semantic-index] Search embedding failed: ${message}`);
			return { state: 'ready', matches: [], indexedFiles: this.indexedFiles, indexedChunks: this.chunks.length, message: `Semantic search is temporarily unavailable (${message}). Use Grep, Glob, and Read instead.` };
		}
		const pathPrefix = opts?.path?.toString();
		// Distinguish "not provided" (unconstrained) from "explicitly empty"
		// (No Repo threads — fail closed, match nothing; an unconstrained search
		// would leak the IDE workspace's semantic index into the thread).
		if (opts?.folderRoots !== undefined && opts.folderRoots.length === 0) {
			return { state: 'ready', matches: [], indexedFiles: this.indexedFiles, indexedChunks: this.chunks.length, message: 'No workspace folder is available to search.' };
		}
		const folderPrefixes = (opts?.folderRoots ?? []).map(u => u.toString());
		const topK = Math.max(1, Math.min(SEMANTIC_MAX_RESULTS, opts?.topK ?? 8));
		const inFolderRoots = (uriStr: string): boolean => {
			if (opts?.folderRoots === undefined) {
				return true;
			}
			return folderPrefixes.some(prefix => uriStr === prefix || uriStr.startsWith(`${prefix}/`));
		};
		const candidateChunks = pathPrefix
			? this.chunks.filter(chunk => {
				const uriStr = chunk.uri.toString();
				return (uriStr === pathPrefix || uriStr.startsWith(`${pathPrefix}/`)) && inFolderRoots(uriStr);
			})
			: this.vectorIndex.candidates(queryVector)
				.map(index => this.chunks[index])
				.filter(chunk => inFolderRoots(chunk.uri.toString()));
		const matches = candidateChunks
			.map(chunk => ({ ...chunk, score: cosineSimilarity(queryVector, chunk.vector) + lexicalBoost(trimmed, chunk) }))
			.sort((a, b) => b.score - a.score)
			.filter((candidate, index, all) => all.findIndex(other => other.uri.toString() === candidate.uri.toString() && Math.abs(other.startLine - candidate.startLine) < 10) === index)
			.slice(0, topK)
			.map(({ vector: _vector, ...match }) => match);
		return { state: 'ready', matches, indexedFiles: this.indexedFiles, indexedChunks: this.chunks.length };
	}
}

registerSingleton(ISemanticRetrievalService, SemanticRetrievalService, InstantiationType.Eager);
