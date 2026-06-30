import { URI } from '../../../../base/common/uri.js'
import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { RawMCPToolCall } from './mcpServiceTypes.js';
import { builtinTools } from './prompt/prompts.js';
import { RawToolParamsObj } from './sendLLMMessageTypes.js';



export type LintErrorItem = { code: string, message: string, startLineNumber: number, endLineNumber: number }

export type GrepOutputMode = 'content' | 'files_with_matches' | 'count'

export type GrepContentLine = {
	lineNumber: number;
	text: string;
	isMatch: boolean;
}

export type GrepFileResult = {
	uri: URI;
	matchCount: number;
	lines?: GrepContentLine[];
}

export const approvalTypeOfBuiltinToolName: Partial<{ [T in BuiltinToolName]?: 'edits' | 'terminal' | 'MCP tools' }> = {
	'StrReplace': 'edits',
	'Write': 'edits',
	'Shell': 'terminal',
	'AwaitShell': 'terminal',
}


export type ToolApprovalType = NonNullable<(typeof approvalTypeOfBuiltinToolName)[keyof typeof approvalTypeOfBuiltinToolName]>;


export const toolApprovalTypes = new Set<ToolApprovalType>([
	...Object.values(approvalTypeOfBuiltinToolName),
	'MCP tools',
])


// Plan todo item with unique ID for tracking (for create_plan tool only)
export interface PlanTodoItem {
	id: string;
	content: string;
}

// Import TodoWriteItem from chatThreadServiceTypes for TodoWrite patches
import type { AskQuestionItem, AskQuestionResult, TodoWriteItem } from './chatThreadServiceTypes.js';


// PARAMS OF TOOL CALL
export type BuiltinToolCallParams = {
	'Read': { uri: URI, offset: number, limit: number },
	'Glob': { globPattern: string, targetDirectory: URI | null },
	'Grep': { pattern: string, path: URI | null, glob: string | null, outputMode: GrepOutputMode, beforeContext: number, afterContext: number, caseInsensitive: boolean, type: string | null, headLimit: number | null, offset: number, multiline: boolean },
	'read_lint_errors': { uri: URI },
	// ---
	'StrReplace': { path: URI, oldString: string, newString: string, replaceAll: boolean },
	'Write': { path: URI, contents: string },
	// ---
	'Shell': {
		command: string;
		workingDirectory: string | null;
		blockUntilMs: number;
		description: string | null;
		notifyOnOutput: { pattern: string; debounceMs: number; reason: string } | null;
		requestSmartModeApproval: boolean;
		shellId: string;
	},
	'AwaitShell': {
		shellId: string | null;
		blockUntilMs: number;
		pattern: string | null;
	},
	// ---
	'TodoWrite': { todos: TodoWriteItem[], merge: boolean },
	'AskQuestion': {
		title: string | null;
		questions: AskQuestionItem[];
	},
	// --- plan tools
	'create_plan': { name: string | null, overview: string | null, plan: string, todos: PlanTodoItem[] },
	'read_plan': {},
	'update_plan_section': { sectionName: string, content: string },
	'add_plan_todo': { todoText: string, category: string | null },
	'mark_plan_item_complete': { itemIndex: number },
	// --- sub-agent delegation
	'task': { subagent_type: string, description: string, prompt: string, model?: string, run_in_background?: boolean, internalToolId?: string, internalThreadId?: string },
	// --- skills
	'skill': { name: string },
}

// RESULT OF TOOL CALL
export type BuiltinToolResultType = {
	'Read': { kind: 'text'; fileContents: string; totalNumLines: number; firstLineNumber: number }
	| { kind: 'image'; mime: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; base64: string; sizeBytes: number }
	| { kind: 'pdf'; textContent: string; totalPages: number },
	'Glob': { uris: URI[], hasNextPage: boolean, totalMatches: number, mtimeSortTruncated: boolean },
	'Grep': { output: string, results: GrepFileResult[], totalMatchCount: number, shownMatchCount: number, totalFileCount: number, shownFileCount: number, truncated: boolean, outputMode: GrepOutputMode },
	'read_lint_errors': { lintErrors: LintErrorItem[] | null },
	// ---
	'StrReplace': Promise<{ lintErrors: LintErrorItem[] | null }>,
	'Write': Promise<{ lintErrors: LintErrorItem[] | null }>,
	// ---
	'Shell': {
		kind: 'done' | 'timeout' | 'backgrounded';
		result?: string;
		exitCode?: number;
		shellId: string;
		durationMs?: number;
		elapsedMs?: number;
		pid?: number;
	},
	'AwaitShell': {
		kind: 'done' | 'timeout' | 'notfound';
		result?: string;
		exitCode?: number;
		runningForMs: number;
		matchedPattern?: boolean;
		error?: string;
	},
	// ---
	'TodoWrite': { success: boolean, todosCount: number, mergeMode: boolean },
	'AskQuestion': AskQuestionResult,
	// --- plan tools
	'create_plan': { planPath: string, planName: string, isDraft: boolean, overview: string | null, todos: PlanTodoItem[] },
	'read_plan': { planContent: string, planPath: string, exists: boolean },
	'update_plan_section': { success: boolean, updatedSection: string },
	'add_plan_todo': { success: boolean, todoCount: number },
	'mark_plan_item_complete': { success: boolean, completedItem: string },
	// --- sub-agent delegation
	'task': { output: string, agentType: string, durationMs: number, toolUseCount: number, status: 'completed' | 'background_launched' | 'failed' | 'cancelled' },
	// --- skills
	'skill': { content: string, skillName: string },
}


export type ToolCallParams<T extends BuiltinToolName | (string & {})> = T extends BuiltinToolName ? BuiltinToolCallParams[T] : RawToolParamsObj
export type ToolResult<T extends BuiltinToolName | (string & {})> = T extends BuiltinToolName ? BuiltinToolResultType[T] : RawMCPToolCall

export type BuiltinToolName = keyof BuiltinToolResultType

/** Built-in tools safe for parallel read-only use (includes legacy hidden search tools). */
export const READ_ONLY_BUILTIN_TOOL_NAMES = [
	'Read',
	'Glob',
	'Grep',
	'read_lint_errors',
] as const satisfies readonly BuiltinToolName[]

export type ReadOnlyBuiltinToolName = (typeof READ_ONLY_BUILTIN_TOOL_NAMES)[number]

export type ValidateBuiltinParams = { [T in BuiltinToolName]: (p: RawToolParamsObj) => BuiltinToolCallParams[T] }
export type CallBuiltinTool = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T]) => Promise<{ result: BuiltinToolResultType[T] | Promise<BuiltinToolResultType[T]>, interruptTool?: () => void }> }
export type BuiltinToolResultToString = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T], result: Awaited<BuiltinToolResultType[T]>) => string }

export interface IToolsService {
	readonly _serviceBrand: undefined;
	validateParams: ValidateBuiltinParams;
	callTool: CallBuiltinTool;
	stringOfResult: BuiltinToolResultToString;
	readonly onShellNotify: Event<{ shellId: string; matchedText: string; reason: string }>;
	currentShellThreadId: string | null;
}

export const IToolsService = createDecorator<IToolsService>('ToolsService');

type BuiltinToolParamNameOfTool<T extends BuiltinToolName> = keyof (typeof builtinTools)[T]['params']
export type BuiltinToolParamName = { [T in BuiltinToolName]: BuiltinToolParamNameOfTool<T> }[BuiltinToolName]


export type ToolName = BuiltinToolName | (string & {})
export type ToolParamName<T extends ToolName> = T extends BuiltinToolName ? BuiltinToolParamNameOfTool<T> : string
