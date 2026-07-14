/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { InlineCompletion, } from '../../../../../editor/common/languages.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { isCodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { EditorResourceAccessor } from '../../../../common/editor.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { extractCodeFromRegular } from '../../common/helpers/extractCodeFromResult.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { ILLMMessageService } from '../../common/sendLLMMessageService.js';
import { IVoidSettingsService } from '../../common/orbitSettingsService.js';
import { FeatureName } from '../../common/orbitSettingsTypes.js';
import { IConvertToLLMMessageService } from '../convertToLLMMessageService.js';
import { IContextGatheringService } from '../contextGatheringService.js';
import { LRUCache } from './cache/lruCache.js';
import { createPrefixHash } from './cache/completionCache.js';
import { processStartAndEndSpaces, removeAllWhitespace, getPrefixAndSuffixInfo } from './utils/stringUtils.js';
import { getLanguageInfo, getImportsContext, getEnclosingContext } from './utils/languageAnalysis.js';
import { getAutocompletionMatchup } from './processing/matchup.js';
import { toInlineCompletions } from './processing/postprocessing.js';
import { getCompletionOptions } from './processing/completionOptions.js';
import { _ln, DEBOUNCE_TIME, DEBOUNCE_TIME_FAST, TIMEOUT_TIME, MAX_CACHE_SIZE, MAX_PENDING_REQUESTS, MAX_GLOBAL_CACHE_ITEMS, AUTOCOMPLETE_ACCEPTANCE_WINDOW_MS, MAX_NEWLINES_IN_COMPLETION } from './constants.js';
import type { Autocompletion } from './types.js';

export interface IAutocompleteService {
	readonly _serviceBrand: undefined;
}

export const IAutocompleteService = createDecorator<IAutocompleteService>('AutocompleteService');

export class AutocompleteService extends Disposable implements IAutocompleteService {

	static readonly ID = 'void.autocompleteService'

	_serviceBrand: undefined;

	private _autocompletionId: number = 0;
	private _autocompletionsOfDocument: { [docUriStr: string]: LRUCache<number, Autocompletion> } = {}
	// Hash index for faster cache lookups: normalized prefix -> autocompletion IDs
	private _prefixHashIndex: { [docUriStr: string]: Map<string, number[]> } = {}

	private _lastCompletionStart = 0
	private _lastCompletionAccept = 0
	private _prefetchingActive = false // Track if we're currently prefetching
	// private _lastPrefix: string = ''

	// ✅ FIX: Track global cache size to prevent unbounded memory growth
	private _totalCachedItems: number = 0;

	// ✅ FIX: Add comprehensive telemetry for monitoring production quality
	private _telemetry = {
		totalRequests: 0,
		cacheHits: 0,
		acceptances: 0,
		latencySum: 0,
		latencyCount: 0,
	};

	// used internally by vscode
	// fires after every keystroke and returns the completion to show
	async _provideInlineCompletionItems(
		model: ITextModel,
		position: Position,
		token?: CancellationToken,
	): Promise<InlineCompletion[]> {
		// ✅ FIX: Add error boundary to prevent crashes
		try {
			const isEnabled = this._settingsService.state.globalSettings.enableAutocomplete
			if (!isEnabled) return []

			const testMode = false

			const docUriStr = model.uri.fsPath;

			const prefixAndSuffix = getPrefixAndSuffixInfo(model, position)
			const { prefix, suffix } = prefixAndSuffix

			// initialize cache if it doesnt exist
			// note that whenever an autocompletion is accepted, it is removed from cache
			if (!this._autocompletionsOfDocument[docUriStr]) {
				this._autocompletionsOfDocument[docUriStr] = new LRUCache<number, Autocompletion>(
					MAX_CACHE_SIZE,
					(autocompletion: Autocompletion) => {
						if (autocompletion.requestId)
							this._llmMessageService.abort(autocompletion.requestId)
						// Remove from hash index when disposing
						this._removeFromHashIndex(docUriStr, autocompletion);
						// ✅ FIX: Decrement global counter when item is evicted
						this._totalCachedItems--;
					}
				)
				this._prefixHashIndex[docUriStr] = new Map();
			}
			// this._lastPrefix = prefix

			// print all pending autocompletions
			// let _numPending = 0
			// this._autocompletionsOfDocument[docUriStr].items.forEach((a: Autocompletion) => { if (a.status === 'pending') _numPending += 1 })
			// console.log('@numPending: ' + _numPending)

			// ✅ FIX: Create atomic snapshots to prevent race conditions
			const cacheSnapshot = Array.from(
				this._autocompletionsOfDocument[docUriStr].items.entries()
			);
			const hashIndexSnapshot = new Map(this._prefixHashIndex[docUriStr]);

			// get autocompletion from cache (optimized with hash index)
			let cachedAutocompletion: Autocompletion | undefined = undefined
			let autocompletionMatchup: ReturnType<typeof getAutocompletionMatchup> | undefined = undefined

			// Fast-path 1: check for exact prefix match first (common case when user continues typing)
			for (const [id, autocompletion] of cacheSnapshot) {
				if (autocompletion.prefix === prefix) {
					// re-validate against the live cache — the snapshot may reference an entry
					// evicted (and its request aborted) since it was taken
					if (!this._autocompletionsOfDocument[docUriStr].items.has(id)) continue;
					cachedAutocompletion = autocompletion;
					autocompletionMatchup = { startIdx: 0, startLine: 0, startCharacter: 0 };
					break;
				}
			}

			// Fast-path 2: use hash index for likely matches
			if (!cachedAutocompletion) {
				const prefixHash = createPrefixHash(prefix);
				const candidateIds = hashIndexSnapshot.get(prefixHash) || [];

				// Check only candidate autocompletions from hash index
				for (const id of candidateIds) {
					// Verify item still exists (not evicted)
					const autocompletion = this._autocompletionsOfDocument[docUriStr].items.get(id);
					if (autocompletion) {
						autocompletionMatchup = getAutocompletionMatchup({ prefix, autocompletion })
						if (autocompletionMatchup !== undefined) {
							cachedAutocompletion = autocompletion
							break;
						}
					}
				}
			}

			// Fallback: if hash index didn't help, do full search (shouldn't happen often)
			if (!cachedAutocompletion) {
				for (const [id, autocompletion] of cacheSnapshot) {
					// if the user's change matches with the autocompletion
					autocompletionMatchup = getAutocompletionMatchup({ prefix, autocompletion })
					if (autocompletionMatchup !== undefined) {
						// re-validate against the live cache — skip entries evicted since the snapshot
						if (!this._autocompletionsOfDocument[docUriStr].items.has(id)) continue;
						cachedAutocompletion = autocompletion
						break;
					}
				}
			}

			// if there is a cached autocompletion, return it
			if (cachedAutocompletion && autocompletionMatchup) {
				// ✅ FIX: Track cache hit
				this._telemetry.cacheHits++;
				const hitRate = (this._telemetry.cacheHits / Math.max(1, this._telemetry.totalRequests)).toFixed(2);
				this._logService.trace('[Autocomplete] Found cached autocompletion', { hitRate });


				// this._logService.trace('[Autocomplete] ID: ' + cachedAutocompletion.id)

				if (cachedAutocompletion.status === 'finished') {
					this._logService.trace('[Autocomplete] Returning finished completion');

					const inlineCompletions = toInlineCompletions({ autocompletionMatchup, autocompletion: cachedAutocompletion, prefixAndSuffix, position, debug: true })
					return inlineCompletions

				} else if (cachedAutocompletion.status === 'pending') {
					this._logService.trace('[Autocomplete] Waiting for pending completion');

					try {
						await cachedAutocompletion.llmPromise;
						const inlineCompletions = toInlineCompletions({ autocompletionMatchup, autocompletion: cachedAutocompletion, prefixAndSuffix, position })
						return inlineCompletions

					} catch (e) {
						this._autocompletionsOfDocument[docUriStr].delete(cachedAutocompletion.id)
						this._logService.error('[Autocomplete] Error creating autocompletion (1):', e);
					}

				} else if (cachedAutocompletion.status === 'error') {
					// An errored entry can never serve a request — drop it so it stops matching
					// and a fresh completion can be generated for this prefix.
					this._logService.trace('[Autocomplete] Cached completion had error, evicting');
					this._removeFromHashIndex(docUriStr, cachedAutocompletion);
					this._autocompletionsOfDocument[docUriStr].delete(cachedAutocompletion.id);
				} else {
					this._logService.trace('[Autocomplete] Cached completion has unknown status');
				}

				return []
			}

			// else if no more typing happens, then go forwards with the request

			// Adaptive debounce: use shorter time if cache hit is likely
			const prefixHash = createPrefixHash(prefix);
			const hasPotentialCacheHit = (this._prefixHashIndex[docUriStr]?.get(prefixHash)?.length || 0) > 0;
			const debounceTime = hasPotentialCacheHit ? DEBOUNCE_TIME_FAST : DEBOUNCE_TIME;

			// wait for the user to stop typing
			const thisTime = Date.now()

			const justAcceptedAutocompletion = thisTime - this._lastCompletionAccept < AUTOCOMPLETE_ACCEPTANCE_WINDOW_MS

			this._lastCompletionStart = thisTime
			const didTypingHappenDuringDebounce = await new Promise((resolve, reject) =>
				setTimeout(() => {
					if (this._lastCompletionStart === thisTime) {
						resolve(false)
					} else {
						resolve(true)
					}
				}, debounceTime)
			)

			// if more typing happened, then do not go forwards with the request
			if (didTypingHappenDuringDebounce) {
				return []
			}

			// the editor may have cancelled this request while we were debouncing (cursor moved,
			// escape pressed, editor switched) — don't fire an LLM request for a stale position
			if (token?.isCancellationRequested) {
				return []
			}


			// if there are too many pending requests, cancel the oldest one
			let numPending = 0
			let oldestPending: Autocompletion | undefined = undefined
			for (const autocompletion of this._autocompletionsOfDocument[docUriStr].items.values()) {
				if (autocompletion.status === 'pending') {
					numPending += 1
					if (oldestPending === undefined) {
						oldestPending = autocompletion
					}
					if (numPending >= MAX_PENDING_REQUESTS) {
						// cancel the oldest pending request and remove it from cache
						this._autocompletionsOfDocument[docUriStr].delete(oldestPending.id)
						break
					}
				}
			}


			// D1: gather relevant nearby/definition snippets from the (already-maintained) context cache.
			const relevantContext = this._buildRelevantContext()

			const cursorOffset = model.getOffsetAt(position);

			const { shouldGenerate, predictionType, llmPrefix, llmSuffix, stopTokens } = getCompletionOptions(prefixAndSuffix, relevantContext, justAcceptedAutocompletion, model, cursorOffset)

			if (!shouldGenerate) return []

			if (testMode && this._autocompletionId !== 0) { // TODO remove this
				return []
			}



			// create a new autocompletion and add it to cache
			const newAutocompletion: Autocompletion = {
				id: this._autocompletionId++,
				prefix: prefix, // the actual prefix and suffix
				suffix: suffix,
				llmPrefix: llmPrefix, // the prefix and suffix the llm sees
				llmSuffix: llmSuffix,
				startTime: Date.now(),
				endTime: undefined,
				type: predictionType,
				status: 'pending',
				llmPromise: undefined,
				insertText: '',
				requestId: null,
				_newlineCount: 0,
			}

			// ✅ FIX: Track new request
			this._telemetry.totalRequests++;
			this._logService.debug('[Autocomplete] Starting completion', { predictionType, totalRequests: this._telemetry.totalRequests });

			const featureName: FeatureName = 'Autocomplete'
			const overridesOfModel = this._settingsService.state.overridesOfModel
			const modelSelection = this._settingsService.state.modelSelectionOfFeature[featureName]
			const modelSelectionOptions = modelSelection ? this._settingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName] : undefined

			// Model-specific optimization: check if model supports FIM
			// If not, log a warning (FIM-capable models like Codestral work much better for autocomplete)
			if (modelSelection) {
				const { getModelCapabilities } = await import('../../common/modelCapabilities.js');
				const capabilities = getModelCapabilities(modelSelection.providerName, modelSelection.modelName, overridesOfModel);
				if (!capabilities.supportsFIM && !testMode) {
					this._logService.warn(`[Autocomplete] Model ${modelSelection.modelName} does not support FIM (Fill-In-Middle). Consider using a FIM-capable model like Codestral for better autocomplete performance.`);
				}
			}

			// Gather rich context metadata for better accuracy (following Copilot/Cursor best practices)
			const { languageId, fileName } = getLanguageInfo(model);
			const fullText = model.getValue();
			const importsContext = getImportsContext(fullText, languageId);
			const enclosingContext = getEnclosingContext(fullText, cursorOffset, languageId);

			// set parameters of `newAutocompletion` appropriately
			newAutocompletion.llmPromise = new Promise((resolve, reject) => {

				const requestId = this._llmMessageService.sendLLMMessage({
					messagesType: 'FIMMessage',
					messages: this._convertToLLMMessageService.prepareFIMMessage({
						messages: {
							prefix: llmPrefix,
							suffix: llmSuffix,
							stopTokens: stopTokens,
						},
						metadata: {
							fileName,
							languageId,
							enclosingContext,
							importsContext,
						}
					}),
					modelSelection,
					modelSelectionOptions,
					overridesOfModel,
					logging: { loggingName: 'Autocomplete' },
					onText: async ({ fullText }) => {
						// Streaming enabled: show partial completions as they arrive

						// Skip if only whitespace so far
						if (!fullText.trim()) return;

						// Critical: Filter out model explanations and instructions immediately.
						// The English phrase list is kept as a (language-specific) supplement, but the primary
						// signal is now structural + language-agnostic, so non-English explanations and markdown
						// wrappers are caught too, without over-rejecting legitimate code/string completions.
						const lowerText = fullText.toLowerCase();
						const badPhrases = [
							'here is', 'here\'s', 'the code', 'complete', 'this code',
							'i can help', 'to complete', 'fill in', '<fill', 'explanation',
							'this will', 'this should', 'the above'
						];
						const firstLine = fullText.trim().split('\n', 1)[0] ?? '';
						const lowerFirst = firstLine.toLowerCase();
						// Language-agnostic wrappers: a markdown code fence or an explicit fill marker.
						const startsWithWrapper = firstLine.startsWith('```') || lowerFirst.startsWith('<fill');
						const startsWithBadPhrase = badPhrases.some(phrase => lowerText.trim().startsWith(phrase));
						// Structural: a COMPLETE natural-language sentence — starts capitalized, ends with
						// sentence punctuation, carries no code punctuation, and is several words long. High
						// precision (real code/string continuations almost always contain code punctuation or
						// don't end a sentence), so this rarely false-rejects.
						const hasCodePunct = /[{}();=<>[\]]/.test(firstLine);
						const looksLikeSentence = !hasCodePunct
							&& /[.:?]$/.test(firstLine)
							&& /^[A-Z]/.test(firstLine)
							&& firstLine.split(/\s+/).filter(Boolean).length >= 5;

						// If model starts explaining instead of coding, reject immediately
						if (startsWithWrapper || startsWithBadPhrase || looksLikeSentence) {
							newAutocompletion.status = 'error'
							if (newAutocompletion.requestId) this._llmMessageService.abort(newAutocompletion.requestId)
							reject('Model provided explanation instead of code')
							return;
						}

						const previousLen = newAutocompletion.insertText.length;
						newAutocompletion.insertText = fullText;
						const newText = fullText.substring(previousLen);

						// count newlines in newText
						const numNewlines = newText.match(/\n|\r\n/g)?.length || 0
						newAutocompletion._newlineCount += numNewlines

						// if too many newlines, resolve up to last newline
						if (newAutocompletion._newlineCount > MAX_NEWLINES_IN_COMPLETION) {
							const lastNewlinePos = fullText.lastIndexOf('\n')
							newAutocompletion.insertText = fullText.substring(0, lastNewlinePos)
							newAutocompletion.status = 'finished'
							if (newAutocompletion.requestId) this._llmMessageService.abort(newAutocompletion.requestId)
							resolve(newAutocompletion.insertText)
							return
						}

						// For single-line completions, stop at first newline
						if (predictionType === 'single-line-fill-middle' || predictionType === 'single-line-redo-suffix') {
							const firstNewlinePos = fullText.indexOf(_ln);
							if (firstNewlinePos > -1) {
								newAutocompletion.insertText = fullText.substring(0, firstNewlinePos);
							}
						}
					},
					onFinalMessage: ({ fullText }) => {

						// console.log('____res: ', JSON.stringify(newAutocompletion.insertText))

						if (newAutocompletion.status !== 'pending') return;
						newAutocompletion.endTime = Date.now()
						newAutocompletion.status = 'finished'
						const [text, _] = extractCodeFromRegular({ text: fullText, recentlyAddedTextLen: 0 })
						newAutocompletion.insertText = processStartAndEndSpaces(text)

						// handle special case for predicting starting on the next line, add a newline character
						if (newAutocompletion.type === 'multi-line-start-on-next-line') {
							newAutocompletion.insertText = _ln + newAutocompletion.insertText
						}

						// ✅ FIX: Track completion latency
						const latency = newAutocompletion.endTime - newAutocompletion.startTime;
						this._telemetry.latencySum += latency;
						this._telemetry.latencyCount++;
						const avgLatency = (this._telemetry.latencySum / this._telemetry.latencyCount).toFixed(0);
						this._logService.debug('[Autocomplete] Completed', { latency: `${latency}ms`, avgLatency: `${avgLatency}ms` });

						resolve(newAutocompletion.insertText)

					},
					onError: ({ message }) => {
						newAutocompletion.endTime = Date.now()
						newAutocompletion.status = 'error'
						reject(message)
					},
					onAbort: () => { reject('Aborted autocomplete') },
				})
				newAutocompletion.requestId = requestId

				// if the request hasnt resolved in TIMEOUT_TIME ms, abort the underlying LLM
				// request (not just the promise — otherwise it keeps streaming into a dead entry)
				setTimeout(() => {
					if (newAutocompletion.status === 'pending') {
						newAutocompletion.status = 'error'
						if (newAutocompletion.requestId) this._llmMessageService.abort(newAutocompletion.requestId)
						reject('Timeout receiving message to LLM.')
					}
				}, TIMEOUT_TIME)

			})



			// ✅ FIX: Check global memory limit before adding
			if (this._totalCachedItems >= MAX_GLOBAL_CACHE_ITEMS) {
				this._evictOldestGlobalCacheEntry();
			}

			// add autocompletion to cache and hash index
			this._autocompletionsOfDocument[docUriStr].set(newAutocompletion.id, newAutocompletion)
			this._totalCachedItems++; // ✅ FIX: Increment global counter
			this._addToHashIndex(docUriStr, newAutocompletion)

			// show autocompletion
			try {
				await newAutocompletion.llmPromise
				// console.log('id: ' + newAutocompletion.id)

				// stale by the time it resolved — keep it cached (a future request can match it),
				// but don't render it at an outdated position
				if (token?.isCancellationRequested) return []

				const autocompletionMatchup = { startIdx: 0, startLine: 0, startCharacter: 0 }
				const inlineCompletions = toInlineCompletions({ autocompletionMatchup, autocompletion: newAutocompletion, prefixAndSuffix, position })
				return inlineCompletions

			} catch (e) {
				this._autocompletionsOfDocument[docUriStr].delete(newAutocompletion.id)
				this._logService.error('[Autocomplete] Error creating autocompletion (2):', e);
				return []
			}

		} catch (error) {
			// ✅ FIX: Top-level error boundary prevents crashes
			this._logService.error('[Autocomplete] Unexpected error:', error);
			return [];
		}
	}

	constructor(
		@ILanguageFeaturesService private _langFeatureService: ILanguageFeaturesService,
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
		@IEditorService private readonly _editorService: IEditorService,
		@IModelService private readonly _modelService: IModelService,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
		@IConvertToLLMMessageService private readonly _convertToLLMMessageService: IConvertToLLMMessageService,
		@ILogService private readonly _logService: ILogService,
		@IContextGatheringService private readonly _contextGatheringService: IContextGatheringService,
	) {
		super();

		// ✅ FIX: Clean up cache when document is closed to prevent memory leaks
		this._register(this._modelService.onModelRemoved((model) => {
			const docUriStr = model.uri.fsPath;

			// Clear LRU cache (disposeCallback will abort pending requests)
			if (this._autocompletionsOfDocument[docUriStr]) {
				this._autocompletionsOfDocument[docUriStr].clear();
				delete this._autocompletionsOfDocument[docUriStr];
			}

			// Clear hash index
			if (this._prefixHashIndex[docUriStr]) {
				this._prefixHashIndex[docUriStr].clear();
				delete this._prefixHashIndex[docUriStr];
			}
		}));

		this._register(this._langFeatureService.inlineCompletionsProvider.register('*', {
			provideInlineCompletions: async (model, position, context, token) => {
				const items = await this._provideInlineCompletionItems(model, position, token)

				// console.log('item: ', items?.[0]?.insertText)
				return { items: items, }
			},
			freeInlineCompletions: (completions) => {
				// get the `docUriStr` and the `position` of the cursor
				const activePane = this._editorService.activeEditorPane;
				if (!activePane) return;
				const control = activePane.getControl();
				if (!control || !isCodeEditor(control)) return;
				const position = control.getPosition();
				if (!position) return;
				const resource = EditorResourceAccessor.getCanonicalUri(this._editorService.activeEditor);
				if (!resource) return;
				const model = this._modelService.getModel(resource)
				if (!model) return;
				const docUriStr = resource.fsPath;
				if (!this._autocompletionsOfDocument[docUriStr]) return;

				const { prefix, } = getPrefixAndSuffixInfo(model, position)

				// go through cached items and remove matching ones
				// autocompletion.prefix + autocompletion.insertedText ~== insertedText
				this._autocompletionsOfDocument[docUriStr].items.forEach((autocompletion: Autocompletion) => {

					// we can do this more efficiently, I just didn't want to deal with all of the edge cases
					const matchup = removeAllWhitespace(prefix) === removeAllWhitespace(autocompletion.prefix + autocompletion.insertText)

					if (matchup) {
						// ✅ FIX: Track acceptance
						this._telemetry.acceptances++;
						const acceptanceRate = (this._telemetry.acceptances / Math.max(1, this._telemetry.totalRequests)).toFixed(2);
						this._logService.info('[Autocomplete] Completion accepted', { id: autocompletion.id, acceptanceRate });
						this._lastCompletionAccept = Date.now()
						this._removeFromHashIndex(docUriStr, autocompletion); // Remove from hash index
						this._autocompletionsOfDocument[docUriStr].delete(autocompletion.id);
						// Note: _totalCachedItems is decremented by the dispose callback

						// Trigger speculative prefetch for next line (async, don't await)
						this._speculativePrefetch(model, position).catch(err => {
							this._logService.error('[Autocomplete] Prefetch error:', err);
						});
					}
				});

			},
		}))
	}

	/**
	 * D1: build the FIM "relevant context" string from the context-gathering service's cache (nearby +
	 * enclosing-scope snippets it already maintains on content change). Read synchronously (no added
	 * latency in the completion hot path) and bounded so it can't bloat the FIM prompt. Empty string
	 * when the cache is cold — identical to the prior behavior, so this only ever adds signal.
	 */
	private _buildRelevantContext(): string {
		try {
			const snippets = this._contextGatheringService.getCachedSnippets()
			if (!snippets || snippets.length === 0) return ''
			const MAX_SNIPPETS = 5
			const MAX_CHARS = 2000
			let out = ''
			for (const s of snippets.slice(0, MAX_SNIPPETS)) {
				if (!s) continue
				if (out.length + s.length > MAX_CHARS) break
				out += (out ? '\n-------------------------------\n' : '') + s
			}
			return out
		} catch {
			return ''
		}
	}

	// Speculative prefetching: start generating next-line completion after accept
	private async _speculativePrefetch(model: ITextModel, position: Position): Promise<void> {
		if (this._prefetchingActive) return; // Don't double-prefetch

		const isEnabled = this._settingsService.state.globalSettings.enableAutocomplete
		if (!isEnabled) return;

		this._prefetchingActive = true;

		try {
			// Simulate cursor moving to end of line for next-line prediction
			const docUriStr = model.uri.fsPath;
			const prefixAndSuffix = getPrefixAndSuffixInfo(model, position);
			const { prefix, suffix } = prefixAndSuffix;

			// Add newline to simulate next line
			const prefixWithNewline = prefix + _ln;
			const relevantContext = this._buildRelevantContext(); // D1
			const cursorOffset = model.getOffsetAt(position);

			const { shouldGenerate, llmPrefix, llmSuffix, stopTokens, predictionType } = getCompletionOptions(
				{ ...prefixAndSuffix, prefix: prefixWithNewline },
				relevantContext,
				true, // justAcceptedAutocompletion = true
				model,
				cursorOffset
			);

			if (!shouldGenerate) {
				this._prefetchingActive = false;
				return;
			}

			// Create prefetch autocompletion
			const prefetchAutocompletion: Autocompletion = {
				id: this._autocompletionId++,
				prefix: prefixWithNewline,
				suffix: suffix,
				llmPrefix: llmPrefix,
				llmSuffix: llmSuffix,
				startTime: Date.now(),
				endTime: undefined,
				type: predictionType,
				status: 'pending',
				llmPromise: undefined,
				insertText: '',
				requestId: null,
				_newlineCount: 0,
			};

			const featureName: FeatureName = 'Autocomplete'
			const overridesOfModel = this._settingsService.state.overridesOfModel
			const modelSelection = this._settingsService.state.modelSelectionOfFeature[featureName]
			const modelSelectionOptions = modelSelection ? this._settingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName] : undefined

			// Gather context for prefetch too
			const { languageId: prefetchLangId, fileName: prefetchFileName } = getLanguageInfo(model);
			const prefetchFullText = model.getValue();
			const prefetchImportsContext = getImportsContext(prefetchFullText, prefetchLangId);
			const prefetchEnclosingContext = getEnclosingContext(prefetchFullText, cursorOffset, prefetchLangId);

			// Start prefetch (fire and forget)
			prefetchAutocompletion.llmPromise = new Promise((resolve, reject) => {
				const requestId = this._llmMessageService.sendLLMMessage({
					messagesType: 'FIMMessage',
					messages: this._convertToLLMMessageService.prepareFIMMessage({
						messages: {
							prefix: llmPrefix,
							suffix: llmSuffix,
							stopTokens: stopTokens,
						},
						metadata: {
							fileName: prefetchFileName,
							languageId: prefetchLangId,
							enclosingContext: prefetchEnclosingContext,
							importsContext: prefetchImportsContext,
						}
					}),
					modelSelection,
					modelSelectionOptions,
					overridesOfModel,
					logging: { loggingName: 'Autocomplete-Prefetch' },
					onText: () => { }, // Don't show prefetch results until requested
					onFinalMessage: ({ fullText }) => {
						prefetchAutocompletion.endTime = Date.now()
						prefetchAutocompletion.status = 'finished'
						const [text, _] = extractCodeFromRegular({ text: fullText, recentlyAddedTextLen: 0 })
						prefetchAutocompletion.insertText = processStartAndEndSpaces(text)

						if (prefetchAutocompletion.type === 'multi-line-start-on-next-line') {
							prefetchAutocompletion.insertText = _ln + prefetchAutocompletion.insertText
						}

						resolve(prefetchAutocompletion.insertText)
					},
					onError: ({ message }) => {
						prefetchAutocompletion.endTime = Date.now()
						prefetchAutocompletion.status = 'error'
						reject(message)
					},
					onAbort: () => { reject('Aborted prefetch') },
				});
				prefetchAutocompletion.requestId = requestId;
			});

			// Add to cache for future use
			if (!this._autocompletionsOfDocument[docUriStr]) {
				this._autocompletionsOfDocument[docUriStr] = new LRUCache<number, Autocompletion>(
					MAX_CACHE_SIZE,
					(autocompletion: Autocompletion) => {
						if (autocompletion.requestId)
							this._llmMessageService.abort(autocompletion.requestId)
						this._removeFromHashIndex(docUriStr, autocompletion);
						// ✅ FIX: Decrement global counter
						this._totalCachedItems--;
					}
				);
				this._prefixHashIndex[docUriStr] = new Map();
			}

			// ✅ FIX: Check global memory limit before adding prefetch
			if (this._totalCachedItems >= MAX_GLOBAL_CACHE_ITEMS) {
				this._evictOldestGlobalCacheEntry();
			}

			this._autocompletionsOfDocument[docUriStr].set(prefetchAutocompletion.id, prefetchAutocompletion);
			this._totalCachedItems++; // ✅ FIX: Increment global counter
			this._addToHashIndex(docUriStr, prefetchAutocompletion);

			// Wait for completion (don't block caller)
			await prefetchAutocompletion.llmPromise;

		} catch (err) {
			this._logService.error('[Autocomplete] Prefetch failed:', err);
		} finally {
			this._prefetchingActive = false;
		}
	}

	// ✅ FIX: Public method to retrieve telemetry metrics
	public getMetricsSummary(): {
		totalRequests: number;
		cacheHitRate: number;
		acceptanceRate: number;
		averageLatency: number;
		totalCachedItems: number;
	} {
		return {
			totalRequests: this._telemetry.totalRequests,
			cacheHitRate: this._telemetry.totalRequests > 0
				? this._telemetry.cacheHits / this._telemetry.totalRequests
				: 0,
			acceptanceRate: this._telemetry.totalRequests > 0
				? this._telemetry.acceptances / this._telemetry.totalRequests
				: 0,
			averageLatency: this._telemetry.latencyCount > 0
				? this._telemetry.latencySum / this._telemetry.latencyCount
				: 0,
			totalCachedItems: this._totalCachedItems,
		};
	}

	// ✅ FIX: Helper method to evict oldest entry when global limit is reached
	private _evictOldestGlobalCacheEntry(): void {
		let oldestDocUri: string | null = null;
		let oldestTime = Infinity;

		// Find oldest autocompletion across all documents
		for (const docUri in this._autocompletionsOfDocument) {
			const cache = this._autocompletionsOfDocument[docUri];
			for (const item of cache.items.values()) {
				if (item.startTime < oldestTime) {
					oldestTime = item.startTime;
					oldestDocUri = docUri;
				}
			}
		}

		// Evict the oldest item
		if (oldestDocUri) {
			const cache = this._autocompletionsOfDocument[oldestDocUri];
			let oldestItem: Autocompletion | undefined;
			for (const item of cache.items.values()) {
				if (item.startTime === oldestTime) {
					oldestItem = item;
					break;
				}
			}
			if (oldestItem) {
				cache.delete(oldestItem.id);
			}
		}
	}

	// Helper methods for hash index management
	private _addToHashIndex(docUriStr: string, autocompletion: Autocompletion): void {
		if (!this._prefixHashIndex[docUriStr]) {
			this._prefixHashIndex[docUriStr] = new Map();
		}

		const hash = createPrefixHash(autocompletion.prefix);
		const existing = this._prefixHashIndex[docUriStr].get(hash) || [];
		// ✅ FIX: Create new array instead of mutating to prevent memory leak
		const updated = [...existing, autocompletion.id];
		this._prefixHashIndex[docUriStr].set(hash, updated);
	}

	private _removeFromHashIndex(docUriStr: string, autocompletion: Autocompletion): void {
		if (!this._prefixHashIndex[docUriStr]) return;

		const hash = createPrefixHash(autocompletion.prefix);
		const existing = this._prefixHashIndex[docUriStr].get(hash);
		if (existing) {
			const filtered = existing.filter(id => id !== autocompletion.id);
			if (filtered.length > 0) {
				this._prefixHashIndex[docUriStr].set(hash, filtered);
			} else {
				this._prefixHashIndex[docUriStr].delete(hash);
			}
		}
	}

}

registerWorkbenchContribution2(AutocompleteService.ID, AutocompleteService, WorkbenchPhase.BlockRestore);
