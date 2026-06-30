import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js'
import { URI } from '../../../../base/common/uri.js'
import { basename, dirname } from '../../../../base/common/resources.js'
import { IFileService } from '../../../../platform/files/common/files.js'

import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js'
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js'
import { ILogService } from '../../../../platform/log/common/log.js'
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js'
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js'
import { IFileMatch, ISearchService, ITextSearchMatch, resultIsMatch } from '../../../services/search/common/search.js'
import { IEditCodeService } from './editCodeServiceInterface.js'
import { ITerminalToolService } from './terminalToolService.js'
import { LintErrorItem, BuiltinToolCallParams, IToolsService, ValidateBuiltinParams, CallBuiltinTool, BuiltinToolResultToString, GrepContentLine, GrepFileResult } from '../common/toolsServiceTypes.js'
import { TodoWriteItem } from '../common/chatThreadServiceTypes.js'
import { IVoidModelService } from '../common/orbitModelService.js'
import { IVoidCommandBarService } from './orbitCommandBarService.js'

import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js'
import { timeout } from '../../../../base/common/async.js'
import { RawToolParamsObj } from '../common/sendLLMMessageTypes.js'
import { MAX_FILE_CHARS_PAGE, MIN_NOTIFY_DEBOUNCE_MS } from '../common/prompt/prompts.js'
import { extractPdfText } from '../common/pdfTextExtract.js'
import {
	fileExtensionFromUri,
	formatNumberedFileLines,
	imageMimeFromExtension,
	READ_IMAGE_EXTENSIONS,
	sliceFileLines,
	validateReadToolParams,
} from '../common/readFileToolHelpers.js'
import { updatePlanSection, addTodoToChecklist, markTodoComplete, isValidSectionName, PlanSection, injectOverviewIntoPlan, validateTodos, TodoItem as PlanTodoItem } from '../common/planTemplate.js'
import {
	applyStringReplaceToContent,
	buildPlanContentFromDraft,
	createPlanDraftFromParams,
	isPlanFilePath,
	syncPlanChecklistToThreadTodos,
	updateDraftFromPlanContent,
} from '../common/planDraftHelpers.js'
import { planFileLock } from '../common/planFileLock.js'
import { IChatThreadService } from './chatThreadService.js'

import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js'
import { IVoidSettingsService } from '../common/orbitSettingsService.js'
import {
	validateAwaitShellParams,
	validateShellParams,
	stringOfAwaitShellResult,
	stringOfShellResult,
	buildShellCommandWithCwd,
} from '../common/shellToolHelpers.js'
import { Emitter } from '../../../../base/common/event.js'
import { IDisposable } from '../../../../base/common/lifecycle.js'
import { IMetricsService } from '../common/metricsService.js'
import { ISubAgentService } from './subAgentService.js'
import { getSubAgent, listSubAgents } from '../common/subAgentRegistry.js'
import { getSkill, listSkills } from '../common/skillRegistry.js'
import {
	finalizeGlobSearchResults,
	GLOB_MTIME_SORT_CAP,
	normalizeGlobPattern,
} from '../common/globToolHelpers.js'
import {
	formatGrepOutput,
	getEffectiveGrepHeadLimit,
	grepTypeGlobMap,
	GREP_MAX_SEARCH_RESULTS,
	normalizeGrepGlob,
	uriMatchesAnyGrepGlob,
	validateGrepToolParams,
} from '../common/grepToolHelpers.js'
import { validateTodoWriteItems } from '../common/todoToolHelpers.js'
import {
	ASK_QUESTION_MAX_TITLE_LENGTH,
	formatAnswersForLLM,
	validateAskQuestionItems,
} from '../common/askQuestionToolHelpers.js'

const isFalsy = (u: unknown) => {
	return !u || u === 'null' || u === 'undefined'
}

const validateStr = (argName: string, value: unknown) => {
	if (value === null) throw new Error(`Invalid LLM output: ${argName} was null.`)
	if (typeof value !== 'string') throw new Error(`Invalid LLM output format: ${argName} must be a string, but its type is "${typeof value}". Full value: ${JSON.stringify(value)}.`)
	return value
}


// We are NOT checking to make sure in workspace
const pathToURI = (pathUnknown: unknown) => {
	const uriStr = pathUnknown
	if (uriStr === null) throw new Error(`Invalid LLM output: uri was null.`)
	if (typeof uriStr !== 'string') throw new Error(`Invalid LLM output format: Provided uri must be a string, but it's a(n) ${typeof uriStr}. Full value: ${JSON.stringify(uriStr)}.`)

	// Check if it's already a full URI with scheme (e.g., vscode-remote://, file://, etc.)
	// Look for :// pattern which indicates a scheme is present
	// Examples of supported URIs:
	// - vscode-remote://wsl+Ubuntu/home/user/file.txt (WSL)
	// - vscode-remote://ssh-remote+myserver/home/user/file.txt (SSH)
	// - file:///home/user/file.txt (local file with scheme)
	// - /home/user/file.txt (local file path, will be converted to file://)
	// - C:\Users\file.txt (Windows local path, will be converted to file://)
	if (uriStr.includes('://')) {
		try {
			const uri = URI.parse(uriStr)
			return uri
		} catch (e) {
			// If parsing fails, it's a malformed URI
			throw new Error(`Invalid URI format: ${uriStr}. Error: ${e}`)
		}
	} else {
		// No scheme present, treat as file path
		// This handles regular file paths like /home/user/file.txt or C:\Users\file.txt
		const uri = URI.file(uriStr)
		return uri
	}
}

const validateURI = pathToURI

const assertPathIsFile = async (path: URI, toolName: string, fileService: IFileService) => {
	const stat = await fileService.stat(path)
	if (stat.isDirectory) {
		throw new Error(`${toolName}: path is a directory, not a file: ${path.fsPath}`)
	}
}

const validateOptionalStr = (argName: string, str: unknown) => {
	if (isFalsy(str)) return null
	return validateStr(argName, str)
}


const validateNumber = (numStr: unknown, opts: { default: number | null }) => {
	if (typeof numStr === 'number')
		return numStr
	if (isFalsy(numStr)) return opts.default

	if (typeof numStr === 'string') {
		const parsedInt = Number.parseInt(numStr + '')
		if (!Number.isInteger(parsedInt)) return opts.default
		return parsedInt
	}

	return opts.default
}

const countGrepMatches = (fileMatch: IFileMatch) => {
	return fileMatch.results?.filter(resultIsMatch).length ?? 0
}

// removed legacy validateProposedTerminalId

const validateBoolean = (b: unknown, opts: { default: boolean }) => {
	if (typeof b === 'string') {
		if (b === 'true') return true
		if (b === 'false') return false
	}
	if (typeof b === 'boolean') {
		return b
	}
	return opts.default
}

export class ToolsService implements IToolsService {

	readonly _serviceBrand: undefined;

	public validateParams: ValidateBuiltinParams;
	public callTool: CallBuiltinTool;
	public stringOfResult: BuiltinToolResultToString;

	private readonly _onShellNotify = new Emitter<{ shellId: string; matchedText: string; reason: string }>();
	public readonly onShellNotify = this._onShellNotify.event;

	/** Set by chatThreadService before Shell callTool so shells can be tied to a thread. */
	public currentShellThreadId: string | null = null;

	// Mutex to serialize mutating/terminal tool calls
	private _mutatingToolInProgress: boolean = false;
	private _currentMutatingTool: string | null = null;

	// Lazily resolved to avoid a circular DI dependency:
	// ChatThreadService → ToolsService → ChatThreadService
	private _chatThreadService: IChatThreadService | null = null;
	private get chatThreadService(): IChatThreadService {
		if (!this._chatThreadService) {
			this._chatThreadService = this._instantiationService.invokeFunction(
				accessor => accessor.get(IChatThreadService)
			);
		}
		return this._chatThreadService!;
	}

	private _getCurrentThreadId(): string | null {
		return this.chatThreadService.state.currentThreadId;
	}

	private _resolveActivePlanPath(): string | null {
		const threadId = this._getCurrentThreadId();
		if (!threadId) {
			return null;
		}
		const thread = this.chatThreadService.state.allThreads[threadId];
		if (thread?.planDraft && !thread.planDraft.savedPlanPath) {
			return null;
		}
		return thread?.linkedPlanPath ?? thread?.planDraft?.savedPlanPath ?? null;
	}

	private _isPlanMode(): boolean {
		return this.voidSettingsService.state.globalSettings.chatMode === 'plan';
	}

	private _applyPlanDraftEdit(
		threadId: string,
		mutate: (content: string) => string,
	): { lintErrors: LintErrorItem[] | null } {
		const existingDraft = this.chatThreadService.getThreadPlanDraft(threadId);
		if (!existingDraft) {
			throw new Error('No active plan draft to edit.');
		}
		const currentContent = buildPlanContentFromDraft(existingDraft);
		const updatedContent = mutate(currentContent);
		const updatedDraft = updateDraftFromPlanContent(updatedContent, existingDraft);
		this.chatThreadService.setThreadPlanDraft(threadId, updatedDraft);
		if (this._isPlanMode()) {
			const threadTodos = syncPlanChecklistToThreadTodos(updatedContent);
			this.chatThreadService.setThreadTodoList(threadId, threadTodos);
		}
		return { lintErrors: null };
	}

	private _syncPlanContentToThread(threadId: string, content: string): void {
		const threadTodos = syncPlanChecklistToThreadTodos(content);
		this.chatThreadService.setThreadTodoList(threadId, threadTodos);
		const existingDraft = this.chatThreadService.getThreadPlanDraft(threadId);
		if (existingDraft) {
			this.chatThreadService.setThreadPlanDraft(threadId, updateDraftFromPlanContent(content, existingDraft));
		}
	}

	private async _syncSavedPlanFileToThread(threadId: string, path: URI): Promise<void> {
		if (!this._isPlanMode()) {
			return;
		}
		try {
			await this.voidModelService.initializeModel(path);
			const { model } = await this.voidModelService.getModelSafe(path);
			const content = model?.getValue();
			if (content) {
				this._syncPlanContentToThread(threadId, content);
			}
		} catch {
			// non-fatal
		}
	}

	constructor(
		@IFileService fileService: IFileService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@ISearchService searchService: ISearchService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IVoidModelService private readonly voidModelService: IVoidModelService,
		@IEditCodeService editCodeService: IEditCodeService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IVoidCommandBarService private readonly commandBarService: IVoidCommandBarService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IMetricsService private readonly _metricsService: IMetricsService,
		@ISubAgentService private readonly _subAgentService: ISubAgentService,
		@ILogService private readonly logService: ILogService,
	) {
		const queryBuilder = this._instantiationService.createInstance(QueryBuilder);

		this.validateParams = {
			Read: (params: RawToolParamsObj) => {
				return validateReadToolParams(params)
			},
			Glob: (params: RawToolParamsObj) => {
				const {
					glob_pattern: globUnknown,
					target_directory: dirUnknown,
				} = params

				const globPattern = validateStr('glob_pattern', globUnknown)
				const targetDirectory = (dirUnknown === undefined || dirUnknown === null)
					? null
					: validateURI(dirUnknown)

				return { globPattern, targetDirectory }
			},
			Grep: validateGrepToolParams,

			read_lint_errors: (params: RawToolParamsObj) => {
				const {
					uri: uriUnknown,
				} = params
				const uri = validateURI(uriUnknown)
				return { uri }
			},

			// ---

			StrReplace: (params: RawToolParamsObj) => {
				const { path: pathUnknown, old_string: oldStringUnknown, new_string: newStringUnknown, replace_all: replaceAllUnknown } = params
				const path = pathToURI(pathUnknown)
				const oldString = validateStr('old_string', oldStringUnknown)
				const newString = validateStr('new_string', newStringUnknown)
				if (oldString.length === 0) {
					throw new Error('StrReplace: old_string must not be empty.')
				}
				if (oldString === newString) {
					throw new Error('StrReplace: old_string and new_string must be different.')
				}
				const replaceAll = validateBoolean(replaceAllUnknown, { default: false })
				return { path, oldString, newString, replaceAll }
			},

			Write: (params: RawToolParamsObj) => {
				const { path: pathUnknown, contents: contentsUnknown } = params
				const path = pathToURI(pathUnknown)
				const contents = validateStr('contents', contentsUnknown)
				return { path, contents }
			},

			// ---

			Shell: (params: RawToolParamsObj) => validateShellParams(params),
			AwaitShell: (params: RawToolParamsObj) => validateAwaitShellParams(params),

			AskQuestion: (params: RawToolParamsObj): BuiltinToolCallParams['AskQuestion'] => {
				if (params.title != null && typeof params.title !== 'string') {
					throw new Error('title must be a string');
				}
				const title = params.title ? params.title.trim() || null : null;
				if (title && title.length > ASK_QUESTION_MAX_TITLE_LENGTH) {
					throw new Error(`title must be ${ASK_QUESTION_MAX_TITLE_LENGTH} characters or fewer`);
				}

				let rawQuestions: unknown;
				if (typeof params.questions === 'string') {
					try {
						rawQuestions = JSON.parse(params.questions);
					} catch (e: any) {
						throw new Error(`Invalid questions parameter: must be valid JSON. ${e?.message ?? e}`);
					}
				} else if (Array.isArray(params.questions)) {
					rawQuestions = params.questions;
				} else {
					throw new Error('questions must be a JSON array string or array');
				}

				const validation = validateAskQuestionItems(rawQuestions);
				if (!validation.valid) {
					throw new Error(validation.error);
				}
				return { title, questions: validation.items };
			},

			TodoWrite: (params: RawToolParamsObj): BuiltinToolCallParams['TodoWrite'] => {
				let todos: TodoWriteItem[];
				if (typeof params.todos === 'string') {
					try {
						todos = JSON.parse(params.todos);
					} catch (e) {
						throw new Error(`Invalid todos parameter: must be valid JSON array. ${e}`);
					}
				} else if (Array.isArray(params.todos)) {
					todos = params.todos;
				} else {
					throw new Error('todos must be a JSON array string or array');
				}

				const merge = validateBoolean(params.merge, { default: false });
				const validation = validateTodoWriteItems(todos, { merge });
				if (!validation.valid) {
					throw new Error(validation.error);
				}

				return { todos: validation.todos, merge };
			},

			// --- Plan tools ---

			create_plan: (params: RawToolParamsObj): BuiltinToolCallParams['create_plan'] => {
				const name = validateOptionalStr('name', params.name);
				const overview = validateOptionalStr('overview', params.overview);
				const plan = validateStr('plan', params.plan);
				let todos: PlanTodoItem[] = [];

				if (params.todos) {
					if (typeof params.todos === 'string') {
						try {
							todos = JSON.parse(params.todos);
						} catch (e) {
							throw new Error(`Invalid todos parameter: must be valid JSON array. ${e}`);
						}
					} else if (Array.isArray(params.todos)) {
						todos = params.todos;
					}

					// Validate todo structure
					if (!Array.isArray(todos)) {
						throw new Error('Todos must be an array');
					}
					for (const todo of todos) {
						if (!todo.id || typeof todo.id !== 'string') {
							throw new Error('Each todo must have an "id" field (string)');
						}
						if (!todo.content || typeof todo.content !== 'string') {
							throw new Error('Each todo must have a "content" field (string)');
						}
					}

					const todosValidation = validateTodos(todos);
					if (!todosValidation.valid) {
						throw new Error(todosValidation.error);
					}
				}

				return { name, overview, plan, todos };
			},

			read_plan: (_params: RawToolParamsObj): BuiltinToolCallParams['read_plan'] => {
				return {};
			},

			update_plan_section: (params: RawToolParamsObj): BuiltinToolCallParams['update_plan_section'] => {
				const sectionName = validateStr('section_name', params.section_name);
				if (!isValidSectionName(sectionName)) {
					throw new Error(`Invalid section name: "${sectionName}". Must be one of: overview, files, steps, checklist, testing, notes`);
				}
				const content = validateStr('content', params.content);
				return { sectionName, content };
			},

			add_plan_todo: (params: RawToolParamsObj): BuiltinToolCallParams['add_plan_todo'] => {
				const todoText = validateStr('todo_text', params.todo_text);
				const category = validateOptionalStr('category', params.category);
				return { todoText, category };
			},

			mark_plan_item_complete: (params: RawToolParamsObj): BuiltinToolCallParams['mark_plan_item_complete'] => {
				const itemIndex = validateNumber(params.item_index, { default: null });
				if (itemIndex === null || itemIndex < 1) {
					throw new Error(`Invalid item_index: "${params.item_index}". Must be a positive integer (1-based).`);
				}
				return { itemIndex };
			},

			task: (params: RawToolParamsObj): BuiltinToolCallParams['task'] => {
				const subagent_type = typeof params.subagent_type === 'string' ? params.subagent_type.trim() : '';
				if (!subagent_type) throw new Error('subagent_type is required');
				if (!getSubAgent(subagent_type)) throw new Error(`Unknown agent type '${subagent_type}'. Available: ${listSubAgents().map(a => a.agentType).join(', ')}`);
				const description = typeof params.description === 'string' ? params.description.trim() : '';
				if (!description) throw new Error('description is required');
				const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : '';
				if (!prompt) throw new Error('prompt is required');
				const model = typeof params.model === 'string' && params.model.trim() ? params.model.trim() : undefined;
				const run_in_background = params.run_in_background === 'true' || String(params.run_in_background) === 'true';
				return { subagent_type, description, prompt, model, run_in_background };
			},

			skill: (params: RawToolParamsObj): BuiltinToolCallParams['skill'] => {
				const name = typeof params.name === 'string' ? params.name.trim() : '';
				if (!name) throw new Error('skill name is required');
				return { name };
			},

		}


		this.callTool = {
			Read: async ({ uri, offset, limit }) => {
				const ext = fileExtensionFromUri(uri)

				if (READ_IMAGE_EXTENSIONS.has(ext)) {
					const data = await fileService.readFile(uri)
					const mime = imageMimeFromExtension(ext)
					if (!mime) {
						throw new Error(`Unsupported image format: .${ext}`)
					}
					return {
						result: {
							kind: 'image',
							mime,
							base64: encodeBase64(data.value),
							sizeBytes: data.value.byteLength,
						},
					}
				}

				if (ext === 'pdf') {
					const data = await fileService.readFile(uri)
					const { textContent, totalPages } = await extractPdfText(data.value)
					return { result: { kind: 'pdf', textContent, totalPages } }
				}

				const data = await fileService.readFile(uri)
				const raw = data.value.toString()
				if (raw.length === 0) {
					return { result: { kind: 'text', fileContents: '', totalNumLines: 0, firstLineNumber: 1 } }
				}

				const { contentLines, startLineIndex, totalNumLines } = sliceFileLines(raw, offset, limit)
				return {
					result: {
						kind: 'text',
						fileContents: contentLines.join('\n'),
						totalNumLines,
						firstLineNumber: startLineIndex + 1,
					},
				}
			},

			Glob: async ({ globPattern, targetDirectory }) => {
				const workspaceFolders = workspaceContextService.getWorkspace().folders.map(f => f.uri)
				const searchFolders = targetDirectory ? [targetDirectory] : workspaceFolders

				if (searchFolders.length === 0) {
					throw new Error('Glob requires either a workspace folder or an explicit target_directory.')
				}

				const normalizedPattern = normalizeGlobPattern(globPattern)

				// Push the glob to ripgrep via includePattern so matching happens at the engine level (fast).
				const query = queryBuilder.file(searchFolders, {
					includePattern: normalizedPattern,
				})
				const data = await searchService.fileSearch(query, CancellationToken.None)

				const rawUris = data.results.map(({ resource }) => resource)
				const { uris, totalMatches, hasNextPage, mtimeSortTruncated } = await finalizeGlobSearchResults(fileService, rawUris)

				return { result: { uris, hasNextPage, totalMatches, mtimeSortTruncated } }
			},

			Grep: async ({ pattern, path, glob: globPattern, outputMode, beforeContext, afterContext, caseInsensitive, type, headLimit, offset, multiline }) => {
				const tokenSource = new CancellationTokenSource()
				const resultPromise = (async () => {
					const workspaceFolders = workspaceContextService.getWorkspace().folders.map(f => f.uri)
					let searchFolders = workspaceFolders
					let exactFilePath: string | null = null

					if (path) {
						try {
							const stat = await fileService.stat(path)
							if (stat.isDirectory) {
								searchFolders = [path]
							} else {
								exactFilePath = path.fsPath
								searchFolders = [dirname(path)]
							}
						} catch (statError) {
							throw new Error(`Grep: cannot stat path "${path.fsPath}": ${statError instanceof Error ? statError.message : String(statError)}`)
						}
					}

					if (searchFolders.length === 0) {
						throw new Error('Grep requires either a workspace folder or an explicit path.')
					}

					const typeGlobs = type ? grepTypeGlobMap[type] : null
					const explicitGlobs = globPattern ? [globPattern] : null
					const includePatterns = exactFilePath ? [basename(path!)]
						: explicitGlobs ? explicitGlobs
							: typeGlobs

					const effectiveHeadLimit = getEffectiveGrepHeadLimit(headLimit, outputMode)
					const requestedSearchResults = outputMode === 'content'
						? offset + effectiveHeadLimit + 1
						: GREP_MAX_SEARCH_RESULTS
					const searchMaxResults = Math.max(1, Math.min(requestedSearchResults, GREP_MAX_SEARCH_RESULTS))
					// (?s:...) enables dotall (. matches newline); isMultiline sets ripgrep multiline ^/$ behavior.
					const effectivePattern = multiline ? `(?s:${pattern})` : pattern

					const query = queryBuilder.text({
						pattern: effectivePattern,
						isRegExp: true,
						isCaseSensitive: !caseInsensitive,
						isMultiline: multiline,
					}, searchFolders, {
						includePattern: includePatterns?.length ? includePatterns.map(normalizeGrepGlob).filter(Boolean) : undefined,
						maxResults: searchMaxResults,
					})

					const data = await searchService.textSearch(query, tokenSource.token)

					const allFileMatches = data.results
						.filter(fileMatch => {
							if (exactFilePath && fileMatch.resource.fsPath !== exactFilePath) return false
							if (explicitGlobs && !uriMatchesAnyGrepGlob(fileMatch.resource, searchFolders, explicitGlobs)) return false
							if (typeGlobs && !uriMatchesAnyGrepGlob(fileMatch.resource, searchFolders, typeGlobs)) return false
							return countGrepMatches(fileMatch) > 0
						})
						.map(fileMatch => ({
							uri: fileMatch.resource,
							matches: fileMatch.results?.filter(resultIsMatch) ?? [],
						}))

					const totalMatchCount = allFileMatches.reduce((total, fileMatch) => total + fileMatch.matches.length, 0)
					const totalFileCount = allFileMatches.length

					let shownMatchCount = 0
					let selectedResults: GrepFileResult[] = []

					if (outputMode === 'content') {
						let matchesToSkip = offset
						let matchesRemaining = effectiveHeadLimit
						const fileMatchJobs: { uri: URI; matchCount: number; selectedMatches: ITextSearchMatch[] }[] = []

						for (const fileMatch of allFileMatches) {
							if (matchesRemaining <= 0) break
							const selectedMatches: ITextSearchMatch[] = []
							for (const match of fileMatch.matches) {
								if (matchesToSkip > 0) {
									matchesToSkip--
									continue
								}
								if (matchesRemaining <= 0) break
								selectedMatches.push(match)
								matchesRemaining--
							}
							if (selectedMatches.length === 0) continue
							fileMatchJobs.push({ uri: fileMatch.uri, matchCount: fileMatch.matches.length, selectedMatches })
						}

						const contentResults = await Promise.all(fileMatchJobs.map(async ({ uri, matchCount, selectedMatches }) => {
							try {
								await voidModelService.initializeModel(uri)
							} catch (modelInitErr) {
								this.logService.warn(`[Grep] Failed to initialize model for ${uri.fsPath}: ${modelInitErr instanceof Error ? modelInitErr.message : String(modelInitErr)}`)
								return null
							}
							const { model } = await voidModelService.getModelSafe(uri)
							if (!model) {
								this.logService.warn(`[Grep] Model unavailable for ${uri.fsPath}`)
								return null
							}

							const linesByNumber = new Map<number, GrepContentLine>()
							for (const match of selectedMatches) {
								const ranges = match.rangeLocations.map(rl => rl.source).filter(Boolean)
								if (ranges.length === 0) continue
								const matchStartLine = Math.min(...ranges.map(r => r.startLineNumber))
								const matchEndLine = Math.max(...ranges.map(r => r.endLineNumber))
								const startLine = Math.max(1, matchStartLine - beforeContext)
								const endLine = Math.min(model.getLineCount(), matchEndLine + afterContext)
								for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
									const existing = linesByNumber.get(lineNumber)
									const isMatch = lineNumber >= matchStartLine && lineNumber <= matchEndLine
									if (existing) {
										existing.isMatch = existing.isMatch || isMatch
										continue
									}
									linesByNumber.set(lineNumber, {
										lineNumber,
										text: model.getLineContent(lineNumber),
										isMatch,
									})
								}
							}

							const lines = [...linesByNumber.values()].sort((a, b) => a.lineNumber - b.lineNumber)
							return { uri, matchCount, lines, selectedMatchCount: selectedMatches.length }
						}))

						for (const fileResult of contentResults) {
							if (!fileResult) continue
							shownMatchCount += fileResult.selectedMatchCount
							selectedResults.push({ uri: fileResult.uri, matchCount: fileResult.matchCount, lines: fileResult.lines })
						}
					} else {
						const selectedFileMatches = allFileMatches.slice(offset, offset + effectiveHeadLimit)
						shownMatchCount = selectedFileMatches.reduce((total, fileMatch) => total + fileMatch.matches.length, 0)
						selectedResults = selectedFileMatches.map(fileMatch => ({
							uri: fileMatch.uri,
							matchCount: fileMatch.matches.length,
						}))
					}

					const truncatedBySearch = !!data.limitHit
					const truncatedByWindow = outputMode === 'content'
						? totalMatchCount > offset + shownMatchCount
						: allFileMatches.length > offset + selectedResults.length
					const truncated = truncatedBySearch || truncatedByWindow
					const output = formatGrepOutput(selectedResults, outputMode, truncated)

					return {
						output,
						results: selectedResults,
						totalMatchCount,
						shownMatchCount,
						totalFileCount,
						shownFileCount: selectedResults.length,
						truncated,
						outputMode,
					}
				})()

				return {
					result: resultPromise,
					interruptTool: () => tokenSource.cancel(),
				}
			},

			read_lint_errors: async ({ uri }) => {
				await timeout(1000)
				const { lintErrors } = this._getLintErrors(uri)
				return { result: { lintErrors } }
			},

			// ---

			StrReplace: async ({ path, oldString, newString, replaceAll }) => {
				this._acquireMutatingLock('StrReplace');
				try {
					const threadId = this._getCurrentThreadId();
					if (this._isPlanMode() && threadId) {
						const draft = this.chatThreadService.getThreadPlanDraft(threadId);
						const linkedPath = this.chatThreadService.state.allThreads[threadId]?.linkedPlanPath ?? null;
						if (draft && !draft.savedPlanPath) {
							const result = this._applyPlanDraftEdit(threadId, content =>
								applyStringReplaceToContent(content, oldString, newString, replaceAll));
							this._releaseMutatingLock();
							return { result: Promise.resolve(result) };
						}
						if (!isPlanFilePath(path.fsPath, linkedPath)) {
							throw new Error('Plan mode only allows editing the plan. Switch to Agent mode to edit code.');
						}
					}

					if (!(await fileService.exists(path))) {
						throw new Error(`StrReplace: file not found: ${path.fsPath}`)
					}
					await assertPathIsFile(path, 'StrReplace', fileService)
					await voidModelService.initializeModel(path)
					const { model } = await voidModelService.getModelSafe(path)
					if (!model) {
						throw new Error(`Could not open file: ${path.fsPath}`)
					}
					if (this.commandBarService.getStreamState(path) === 'streaming') {
						throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
					}
					await editCodeService.callBeforeApplyOrEdit(path)
					editCodeService.instantlyApplyStrReplace({ uri: path, oldString, newString, replaceAll })

					const lintErrorsPromise = Promise.resolve().then(async () => {
						// The mutating lock MUST be released here even if computing lint
						// errors or syncing the plan throws — otherwise every subsequent
						// mutating/terminal tool is permanently blocked for the session.
						try {
							await timeout(2000)
							const { lintErrors } = this._getLintErrors(path)
							if (threadId && this._isPlanMode() && isPlanFilePath(path.fsPath, this.chatThreadService.state.allThreads[threadId]?.linkedPlanPath)) {
								await this._syncSavedPlanFileToThread(threadId, path);
							}
							return { lintErrors }
						} finally {
							this._releaseMutatingLock();
						}
					})

					return { result: lintErrorsPromise }
				} catch (error) {
					this._releaseMutatingLock();
					throw error;
				}
			},

			Write: async ({ path, contents }) => {
				this._acquireMutatingLock('Write');
				try {
					const threadId = this._getCurrentThreadId();
					if (this._isPlanMode() && threadId) {
						const draft = this.chatThreadService.getThreadPlanDraft(threadId);
						const linkedPath = this.chatThreadService.state.allThreads[threadId]?.linkedPlanPath ?? null;
						if (draft && !draft.savedPlanPath) {
							const result = this._applyPlanDraftEdit(threadId, () => contents);
							this._releaseMutatingLock();
							return { result: Promise.resolve(result) };
						}
						if (!isPlanFilePath(path.fsPath, linkedPath)) {
							throw new Error('Plan mode only allows editing the plan. Switch to Agent mode to edit code.');
						}
					}

					const exists = await fileService.exists(path)
					let didCreateFile = false
					if (!exists) {
						try {
							await fileService.createFile(path, VSBuffer.fromString(''))
							didCreateFile = true
						} catch (e) {
							const msg = e instanceof Error ? e.message : String(e)
							if (msg.includes('ENOENT') || msg.toLowerCase().includes('no such file')) {
								throw new Error(`Write: parent directory does not exist for ${path.fsPath}. Create it first (e.g. Shell with mkdir -p) before using Write.`)
							}
							throw e
						}
					}

					try {
						await assertPathIsFile(path, 'Write', fileService)
						await voidModelService.initializeModel(path)
						if (this.commandBarService.getStreamState(path) === 'streaming') {
							throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
						}
						await editCodeService.callBeforeApplyOrEdit(path)
						editCodeService.instantlyWriteFile({ uri: path, contents })
					} catch (writeError) {
						// If we created an empty file but never wrote real contents into it,
						// don't leave a stray 0-byte file behind.
						if (didCreateFile) {
							try { await fileService.del(path) } catch { /* best-effort cleanup */ }
						}
						throw writeError
					}

					const lintErrorsPromise = Promise.resolve().then(async () => {
						// Always release the mutating lock, even if lint computation or plan
						// sync throws — otherwise all future mutating tools deadlock.
						try {
							await timeout(2000)
							const { lintErrors } = this._getLintErrors(path)
							if (threadId && this._isPlanMode() && isPlanFilePath(path.fsPath, this.chatThreadService.state.allThreads[threadId]?.linkedPlanPath)) {
								await this._syncSavedPlanFileToThread(threadId, path);
							}
							return { lintErrors }
						} finally {
							this._releaseMutatingLock();
						}
					})
					return { result: lintErrorsPromise }
				} catch (error) {
					this._releaseMutatingLock();
					throw error;
				}
			},
			// ---
			Shell: async (params) => {
				this._acquireMutatingLock('Shell');
				try {
					const threadId = this.currentShellThreadId;
					if (!threadId) {
						throw new Error('Shell requires an active chat thread.');
					}

					const { shellId, pid } = await this.terminalToolService.getOrCreateShellForThread({
						threadId,
						proposedShellId: params.shellId,
						workingDirectory: params.workingDirectory,
					});

					const shell = this.terminalToolService.getShell(shellId);
					const { command, workingDirectory } = buildShellCommandWithCwd(
						params.command,
						params.workingDirectory,
						shell?.workingDirectory ?? null,
					);

					const notifyDisposables: IDisposable[] = [];
					if (params.notifyOnOutput) {
						const d = this.terminalToolService.addNotifyWatcher(shellId, {
							pattern: params.notifyOnOutput.pattern,
							debounceMs: Math.max(MIN_NOTIFY_DEBOUNCE_MS, params.notifyOnOutput.debounceMs),
							reason: params.notifyOnOutput.reason,
							onMatch: (matchedText) => {
								this._onShellNotify.fire({ shellId, matchedText, reason: params.notifyOnOutput!.reason });
							},
						});
						notifyDisposables.push(d);
					}

					const startedAt = Date.now();
					const interrupt = () => { this.terminalToolService.interruptShell(shellId); };

					if (params.blockUntilMs === 0) {
						const resPromise = this.terminalToolService.runShell(shellId, command, { blockUntilMs: 0, workingDirectory })
							.then(() => {
								this._releaseMutatingLock();
							})
							.catch((error) => {
								this._releaseMutatingLock();
								throw error;
							});
						void resPromise;
						return {
							result: { kind: 'backgrounded' as const, shellId, pid: pid ?? undefined },
							interruptTool: interrupt,
						};
					}

					const resPromise = this.terminalToolService.runShell(shellId, command, { blockUntilMs: params.blockUntilMs, workingDirectory })
						.then((runRes) => {
							notifyDisposables.forEach(d => d.dispose());
							const durationMs = Date.now() - startedAt;
							this._releaseMutatingLock();
							if (runRes.kind === 'done') {
								return {
									kind: 'done' as const,
									result: runRes.result,
									exitCode: runRes.exitCode ?? 0,
									shellId,
									durationMs,
								};
							}
							if (runRes.kind === 'backgrounded') {
								return {
									kind: 'backgrounded' as const,
									shellId,
									pid: runRes.pid ?? pid ?? undefined,
									durationMs,
								};
							}
							return {
								kind: 'timeout' as const,
								result: runRes.result ?? '',
								shellId,
								durationMs,
								elapsedMs: params.blockUntilMs,
							};
						})
						.catch((error) => {
							this._releaseMutatingLock();
							throw error;
						});

					return { result: resPromise, interruptTool: interrupt };
				} catch (error) {
					this._releaseMutatingLock();
					throw error;
				}
			},
			AwaitShell: async (params) => {
				this._acquireMutatingLock('AwaitShell');
				try {
					if (params.shellId && !this.terminalToolService.shellExists(params.shellId)) {
						this._releaseMutatingLock();
						return { result: { kind: 'notfound' as const, error: `Shell with id "${params.shellId}" does not exist.`, runningForMs: 0 } };
					}

					const resPromise = this.terminalToolService.awaitShell(params.shellId, {
						blockUntilMs: params.blockUntilMs,
						pattern: params.pattern,
					}).then((awaitRes) => {
						this._releaseMutatingLock();
						return awaitRes;
					}).catch((error) => {
						this._releaseMutatingLock();
						throw error;
					});

					return { result: resPromise };
				} catch (error) {
					this._releaseMutatingLock();
					throw error;
				}
			},

			AskQuestion: async (_params: BuiltinToolCallParams['AskQuestion']) => {
				throw new Error('AskQuestion requires user interaction — finalize via submitAskQuestionAnswer or skipAskQuestion in the chat thread service');
			},

			TodoWrite: async (params: BuiltinToolCallParams['TodoWrite']) => {
				const { todos, merge } = params;

				this._metricsService.capture('TodoWrite', {
					todosCount: todos.length,
					completedCount: todos.filter(t => t.status === 'completed').length,
					isMerge: merge,
				});

				// The actual merge logic is handled in chatThreadService
				// This tool just validates and returns success
				const result = {
					success: true,
					todosCount: todos.length,
					mergeMode: merge
				};

				return { result };
			},

			// --- Plan tools ---

			create_plan: async (params: BuiltinToolCallParams['create_plan']) => {
				const { name, overview, plan, todos } = params;

				const folders = workspaceContextService.getWorkspace().folders;
				if (folders.length === 0) {
					throw new Error('No workspace folder open. Please open a folder to create a plan.');
				}

				const threadId = this._getCurrentThreadId();
				const existingDraft = threadId ? this.chatThreadService.getThreadPlanDraft(threadId) : undefined;
				const planBody = injectOverviewIntoPlan(plan, overview);

				let draft;
				try {
					draft = createPlanDraftFromParams(
						name,
						overview,
						planBody,
						todos,
						existingDraft,
						this.voidSettingsService.state.modelSelectionOfFeature.Chat?.modelName,
					);
					buildPlanContentFromDraft(draft, 'planning', this.voidSettingsService.state.modelSelectionOfFeature.Chat?.modelName);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new Error(message);
				}

				if (threadId) {
					const fullContent = buildPlanContentFromDraft(
						draft,
						'planning',
						this.voidSettingsService.state.modelSelectionOfFeature.Chat?.modelName,
					);
					const syncedDraft = updateDraftFromPlanContent(fullContent, draft);
					this.chatThreadService.setThreadPlanDraft(threadId, syncedDraft);
					const executionTodos = syncPlanChecklistToThreadTodos(fullContent);
					this.chatThreadService.setThreadTodoList(threadId, executionTodos);
				}

				this._metricsService.capture('Create Plan', {
					planName: draft.name,
					todosCount: todos.length,
					reusedExistingPlan: false,
					isDraft: true,
				});

				return {
					result: {
						planPath: '',
						planName: draft.name,
						isDraft: true,
						overview,
						todos,
					}
				};
			},

			read_plan: async (_params: BuiltinToolCallParams['read_plan']) => {
				const threadId = this._getCurrentThreadId();
				const draft = threadId ? this.chatThreadService.getThreadPlanDraft(threadId) : undefined;
				if (draft && !draft.savedPlanPath && !this.chatThreadService.state.allThreads[threadId ?? '']?.linkedPlanPath) {
					const planContent = buildPlanContentFromDraft(
						draft,
						'planning',
						this.voidSettingsService.state.modelSelectionOfFeature.Chat?.modelName,
					);
					return {
						result: {
							planContent,
							planPath: '',
							exists: true,
						}
					};
				}

				const activePlanPath = this._resolveActivePlanPath();
				if (!activePlanPath) {
					return {
						result: {
							planContent: 'No active plan. Use create_plan to create a new implementation plan.',
							planPath: '',
							exists: false,
						}
					};
				}

				const planUri = URI.file(activePlanPath);

				try {
					const content = await fileService.readFile(planUri);
					const planContent = content.value.toString();

					return {
						result: {
							planContent,
							planPath: activePlanPath,
							exists: true,
						}
					};
				} catch {
					// File might have been deleted
					const threadId = this.chatThreadService.state.currentThreadId;
					if (threadId) {
						this.chatThreadService.clearLinkedPlanPath(threadId);
					}
					return {
						result: {
							planContent: 'Active plan file no longer exists. Use create_plan to create a new plan.',
							planPath: '',
							exists: false,
						}
					};
				}
			},

			update_plan_section: async (params: BuiltinToolCallParams['update_plan_section']) => {
				const { sectionName, content } = params;

				const activePlanPath = this._resolveActivePlanPath();
				if (!activePlanPath) {
					throw new Error('No active plan. Use create_plan first to create a plan.');
				}

				const planUri = URI.file(activePlanPath);

				await planFileLock.withLock(activePlanPath, async () => {
					const fileContent = await fileService.readFile(planUri);
					const currentContent = fileContent.value.toString();
					const updatedContent = updatePlanSection(currentContent, sectionName as PlanSection, content);
					await fileService.writeFile(planUri, VSBuffer.fromString(updatedContent));
				});

				this._metricsService.capture('Update Plan Section', {
					sectionName,
					contentLength: content.length,
				});

				return {
					result: {
						success: true,
						updatedSection: sectionName,
					}
				};
			},

			add_plan_todo: async (params: BuiltinToolCallParams['add_plan_todo']) => {
				const { todoText, category } = params;

				const activePlanPath = this._resolveActivePlanPath();
				if (!activePlanPath) {
					throw new Error('No active plan. Use create_plan first to create a plan.');
				}

				const planUri = URI.file(activePlanPath);
				let todoCount = 0;

				await planFileLock.withLock(activePlanPath, async () => {
					const fileContent = await fileService.readFile(planUri);
					const currentContent = fileContent.value.toString();
					const result = addTodoToChecklist(currentContent, todoText, category ?? undefined);
					todoCount = result.todoCount;
					await fileService.writeFile(planUri, VSBuffer.fromString(result.content));
				});

				this._metricsService.capture('Add Plan Todo', {
					hasCategory: !!category,
					todoCount,
				});

				return {
					result: {
						success: true,
						todoCount,
					}
				};
			},

			mark_plan_item_complete: async (params: BuiltinToolCallParams['mark_plan_item_complete']) => {
				const { itemIndex } = params;

				const activePlanPath = this._resolveActivePlanPath();
				if (!activePlanPath) {
					throw new Error('No active plan. Use create_plan first to create a plan.');
				}

				const planUri = URI.file(activePlanPath);
				let completedItem = '';

				await planFileLock.withLock(activePlanPath, async () => {
					const fileContent = await fileService.readFile(planUri);
					const currentContent = fileContent.value.toString();
					const result = markTodoComplete(currentContent, itemIndex);
					completedItem = result.completedItem;
					await fileService.writeFile(planUri, VSBuffer.fromString(result.content));
				});

				this._metricsService.capture('Mark Plan Item Complete', {
					itemIndex,
					completedItem,
				});

				return {
					result: {
						success: true,
						completedItem,
					}
				};
			},

			task: async ({ subagent_type, description, prompt, model, run_in_background, internalToolId, internalThreadId }: BuiltinToolCallParams['task']) => {
				if (this._isPlanMode() && subagent_type !== 'explore') {
					throw new Error(`Plan mode only allows the 'explore' subagent for read-only research. Got '${subagent_type}'.`);
				}
				const agent = getSubAgent(subagent_type)!;
				const toolId = internalToolId ?? this._subAgentService.pendingToolId;
				const threadId = internalThreadId ?? this._subAgentService.pendingThreadId;
				if (!toolId || !threadId) {
					throw new Error('Internal error: task tool is missing chat thread context.');
				}
				const abortRef: { current: (() => void) | null } = { current: null };
				const result = this._subAgentService.runSubAgent({ agent, prompt, description, toolId, threadId, modelOverride: model, runInBackground: run_in_background, abortRef });
				return {
					result,
					interruptTool: () => abortRef.current?.(),
				};
			},

			skill: async ({ name }: BuiltinToolCallParams['skill']) => {
				const skill = getSkill(name);
				if (!skill) {
					const available = listSkills().filter(s => s.enabled).map(s => s.name).join(', ') || '(none)';
					return { result: { content: `Skill "${name}" not found. Available skills: ${available}.`, skillName: name } };
				}
				if (!skill.enabled) {
					return { result: { content: `Skill "${name}" is currently disabled. Enable it in Settings → Skills to use it.`, skillName: name } };
				}
				return { result: { content: skill.body, skillName: skill.name } };
			},
		}


		const stringifyLintErrors = (lintErrors: LintErrorItem[]) => {
			return lintErrors
				.map((e, i) => `Error ${i + 1}:\nLines Affected: ${e.startLineNumber}-${e.endLineNumber}\nError message:${e.message}`)
				.join('\n\n')
				.substring(0, MAX_FILE_CHARS_PAGE)
		}

		// given to the LLM after the call for successful tool calls
		this.stringOfResult = {
			Read: (params, result) => {
				if (result.kind === 'image') {
					return `[Image: ${params.uri.fsPath} (${result.mime}, ${(result.sizeBytes / 1024).toFixed(1)} KB)]`
				}
				if (result.kind === 'pdf') {
					const numbered = formatNumberedFileLines(result.textContent.split('\n'), 1)
					const pageNote = result.totalPages > 0 ? ` (${result.totalPages} page${result.totalPages !== 1 ? 's' : ''})` : ''
					return `${params.uri.fsPath}${pageNote}\n\`\`\`\n${numbered}\n\`\`\``
				}
				if (result.totalNumLines === 0 && result.fileContents === '') {
					return 'File is empty.'
				}
				const lines = result.fileContents.split('\n')
				const numbered = formatNumberedFileLines(lines, result.firstLineNumber)
				let out = `${params.uri.fsPath}\n\`\`\`\n${numbered}\n\`\`\``
				const returnedLines = lines.length
				if (returnedLines > 0 && result.firstLineNumber + returnedLines - 1 < result.totalNumLines) {
					out += `\n[Showing lines ${result.firstLineNumber}-${result.firstLineNumber + returnedLines - 1} of ${result.totalNumLines}. Use offset to read more.]`
				}
				return out
			},
			Glob: (_params, result) => {
				const paths = result.uris.map(uri => uri.fsPath).join('\n')
				const notes: string[] = []
				if (result.hasNextPage) {
					notes.push(`[Showing first ${result.uris.length} of ${result.totalMatches} matches. Refine your glob_pattern (e.g. add a directory prefix) to narrow the results.]`)
				}
				if (result.mtimeSortTruncated) {
					notes.push(`[Found ${result.totalMatches} matches; mtime sorting applied to the first ${GLOB_MTIME_SORT_CAP}. Narrow your glob_pattern for faster, complete results.]`)
				}
				if (notes.length === 0) {
					return paths
				}
				return paths ? `${paths}\n\n${notes.join('\n')}` : notes.join('\n')
			},
		Grep: (_params, result) => {
			return result.output
			},
			read_lint_errors: (params, result) => {
				return result.lintErrors ?
					stringifyLintErrors(result.lintErrors)
					: 'No lint errors found.'
			},
			// ---
			StrReplace: (params, result) => {
				const lintErrsString = (
					this.voidSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')

				return `Change successfully made to ${params.path.fsPath}.${lintErrsString}`
			},
			Write: (params, result) => {
				const lintErrsString = (
					this.voidSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')

				return `Successfully wrote ${params.path.fsPath}.${lintErrsString}`
			},
			Shell: stringOfShellResult,
			AwaitShell: stringOfAwaitShellResult,

			AskQuestion: (params, result) => {
				return formatAnswersForLLM(params.title, params.questions, result.answers, result.wasSkipped);
			},

			TodoWrite: (params, result) => {
				const mergeStr = result.mergeMode ? ' (merged)' : ' (replaced)';
				return `Successfully updated TODO list with ${result.todosCount} items${mergeStr}.`;
			},

			// --- Plan tools ---

			create_plan: (params, result) => {
				const todoNote = params.todos.length > 0
					? `\nIncluded ${params.todos.length} implementation todo(s) in the plan checklist.`
					: '';
				if (result.isDraft) {
					return `Plan "${result.planName}" is ready for review as an ephemeral draft.${todoNote}\nThe user can Save to workspace, edit the draft with StrReplace/Write, or click Build to start execution. Calling create_plan again replaces the draft before save. After save, update via read_plan + StrReplace/Write on the plan file.`;
				}
				return `Plan "${result.planName}" created successfully at ${result.planPath}.${todoNote}\nTo update the plan, read and edit the plan file directly using your file editing tools.`;
			},

			read_plan: (params, result) => {
				if (!result.exists) {
					return result.planContent;
				}
				return `Plan file at ${result.planPath}:\n\n${result.planContent}`;
			},

			update_plan_section: (params, result) => {
				return `Successfully updated the "${result.updatedSection}" section of the plan.`;
			},

			add_plan_todo: (params, result) => {
				return `Successfully added TODO item. The plan now has ${result.todoCount} checklist item(s).`;
			},

			mark_plan_item_complete: (params, result) => {
				return `Successfully marked item as complete: "${result.completedItem}"`;
			},

			task: (_params, result) => {
				if (result.status === 'background_launched') {
					return result.output;
				}
				if (result.status === 'failed' || result.status === 'cancelled') {
					const meta = `[Agent: ${result.agentType} | Status: ${result.status} | Tools used: ${result.toolUseCount} | Duration: ${result.durationMs < 1000 ? `${result.durationMs}ms` : `${(result.durationMs / 1000).toFixed(1)}s`}]`;
					return `${result.output}\n\n${meta}`;
				}
				const meta = `[Agent: ${result.agentType} | Tools used: ${result.toolUseCount} | Duration: ${result.durationMs < 1000 ? `${result.durationMs}ms` : `${(result.durationMs / 1000).toFixed(1)}s`}]`;
				return `${result.output}\n\n${meta}`;
			},

			skill: (_params, result) => {
				return result.content;
			},
		}



	}


	private _acquireMutatingLock(toolName: string): void {
		if (this._mutatingToolInProgress) {
			throw new Error(`Cannot run ${toolName} while another mutating/terminal tool (${this._currentMutatingTool}) is in progress. Mutating and terminal tools must run sequentially and alone. Please wait for the current operation to complete.`);
		}
		this._mutatingToolInProgress = true;
		this._currentMutatingTool = toolName;
	}

	private _releaseMutatingLock(): void {
		this._mutatingToolInProgress = false;
		this._currentMutatingTool = null;
	}

	private _getLintErrors(uri: URI): { lintErrors: LintErrorItem[] | null } {
		const lintErrors = this.markerService
			.read({ resource: uri })
			.filter(l => l.severity === MarkerSeverity.Error || l.severity === MarkerSeverity.Warning)
			.slice(0, 100)
			.map(l => ({
				code: typeof l.code === 'string' ? l.code : l.code?.value || '',
				message: (l.severity === MarkerSeverity.Error ? '(error) ' : '(warning) ') + l.message,
				startLineNumber: l.startLineNumber,
				endLineNumber: l.endLineNumber,
			} satisfies LintErrorItem))

		if (!lintErrors.length) return { lintErrors: null }
		return { lintErrors, }
	}

}

registerSingleton(IToolsService, ToolsService, InstantiationType.Delayed);
