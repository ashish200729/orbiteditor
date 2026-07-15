import { URI } from '../../../../base/common/uri.js';

export type SemanticEmbeddingProvider = 'ollama' | 'openAICompatible';
export type SemanticIndexState = 'disabled' | 'empty' | 'loading' | 'indexing' | 'paused' | 'ready' | 'error';
export type SemanticIndexPhase = 'loading' | 'scanning' | 'embedding' | 'saving';

export interface SemanticChunk {
	id: string;
	uri: URI;
	startLine: number;
	endLine: number;
	languageId: string;
	symbolName?: string;
	content: string;
	contentHash: string;
}

export interface SemanticSearchMatch extends SemanticChunk {
	score: number;
}

export interface SemanticSearchResult {
	state: SemanticIndexState;
	matches: SemanticSearchMatch[];
	indexedFiles: number;
	indexedChunks: number;
	message?: string;
}

export interface SemanticIndexStatus {
	state: SemanticIndexState;
	indexedFiles: number;
	indexedChunks: number;
	lastIndexedAt?: number;
	error?: string;
	phase?: SemanticIndexPhase;
	progress?: number;
	processedFiles?: number;
	totalFiles?: number;
	currentFile?: string;
	recentFiles?: string[];
	startedAt?: number;
	operation?: 'full' | 'incremental';
}
