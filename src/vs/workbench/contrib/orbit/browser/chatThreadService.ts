/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

import { URI } from '../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { chat_userMessageContent, isABuiltinToolName, isLLMHiddenBuiltinToolName, llmVisibleBuiltinToolNames, readOnlyToolNames, resolveBuiltinToolName, resolveBuiltinToolNameLoose, InternalToolInfo } from '../common/prompt/prompts.js';
import { parseSlashTokenNames } from '../common/slashCommands/slashTokens.js';
import { AnthropicReasoning, getErrorMessage, LLMUsage, RawToolCallObj, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { FeatureName, ModelSelection, ModelSelectionOptions } from '../common/orbitSettingsTypes.js';
import { getModelCapabilities } from '../common/modelCapabilities.js';
import { selectCompactionBoundary } from '../common/compactionHelpers.js';
import { IVoidSettingsService } from '../common/orbitSettingsService.js';
import { mapWithConcurrency, withTimeout } from '../common/asyncUtils.js';
import { approvalTypeOfBuiltinToolName, BuiltinToolCallParams, BuiltinToolResultType, IToolsService, ToolCallParams, ToolName, ToolResult } from '../common/toolsServiceTypes.js';
import { getEffectiveGrepHeadLimit } from '../common/grepToolHelpers.js';
import { toFilenameSearchGlobPattern } from '../common/globToolHelpers.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { AskQuestionUserAnswer, ChatMessage, CheckpointEntry, CodespanLocationLink, PlanBuildState, PlanDraft, StagingSelectionItem, TodoItem, TodoStatus, ToolMessage } from '../common/chatThreadServiceTypes.js';
import { formatAnswersForLLM, normalizeAnswer } from '../common/askQuestionToolHelpers.js';
import { Position } from '../../../../editor/common/core/position.js';
import { IMetricsService } from '../common/metricsService.js';
import { shorten } from '../../../../base/common/labels.js';
import { IVoidModelService } from '../common/orbitModelService.js';
import { findLast, findLastIdx } from '../../../../base/common/arraysFind.js';
import { IEditCodeService } from './editCodeServiceInterface.js';
import { VoidFileSnapshot } from '../common/editCodeServiceTypes.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { truncate } from '../../../../base/common/strings.js';
import { THREAD_STORAGE_KEY, QUEUED_MESSAGES_STORAGE_KEY } from '../common/storageKeys.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
import { RunOnceScheduler, timeout } from '../../../../base/common/async.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IMCPService } from '../common/mcpService.js';
import { RawMCPToolCall } from '../common/mcpServiceTypes.js';
import { FileAccess } from '../../../../base/common/network.js';
import { IVoidNativeNotificationService } from './nativeNotificationService.js';
import { ISubAgentService } from './subAgentService.js';
import { getSubAgent } from '../common/subAgentRegistry.js';
import { ITerminalToolService } from './terminalToolService.js';
import { IAgentProjectWorkspaceService } from './agentProjectWorkspaceService.js';
import { resolveFoldersForThread } from '../common/agentWorkspaceContext.js';
import { findNewestThreadIdInExactScope, isUriInsideFolders } from '../common/agentWorkspaceHelpers.js';
import { applyTodoWrite, normalizeTodoList, todoListsEqual } from '../common/todoToolHelpers.js';
import { getActiveWindow } from '../../../../base/browser/dom.js';
import { findThreadComposerInWindow, focusInConnectedWindow } from './connectedWindowDom.js';
import { getPathAccessApprovalReason } from '../common/agentToolSecurity.js';
import { cloneStagingSelection, queuedUserMessagesEqual, type QueuedUserMessage } from '../common/messageQueueHelpers.js';

export type { QueuedUserMessage } from '../common/messageQueueHelpers.js';


// related to retrying when LLM message has error
const CHAT_RETRIES = 3
const RETRY_DELAY = 2500

// Hard cap on the agentic tool-use loop so a model that keeps calling tools can't run forever.
const MAX_AGENT_LOOP_ITERATIONS = 150
const MAX_QUEUED_USER_MESSAGES = 20        // cap queue depth so a runaway loop of Enter presses can't grow it unbounded
const MAX_PARALLEL_TOOL_CALLS = 8           // bound filesystem/MCP pressure from one model response

// Upper bound on a provider-supplied Retry-After we'll actually wait before retrying.
const MAX_RETRY_AFTER_MS = 60_000

// ---------------- context compaction (Cursor-style summarization) ----------------
// When the prompt approaches the model's context window, summarize the older part of the
// conversation into a compact progress note and send [task + summary + recent turns] instead of
// the full transcript. The full history is never deleted from the thread (UI/storage keep it);
// only the payload SENT to the model is compacted. This mirrors Cursor's "fresh context window
// with a summary" behavior and prevents context-length failures on long agent sessions.
const COMPACTION_TRIGGER_FRACTION = 0.75   // start compacting when the prompt fills this much of the window
const COMPACTION_TARGET_FRACTION = 0.55    // summarize old turns until the kept transcript is ~this much of the window
const COMPACTION_MIN_MESSAGES = 12         // don't bother compacting very short threads
const COMPACTION_MIN_NEW_MESSAGES = 6      // don't re-summarize until enough new messages accrue since the last compaction
const COMPACTION_CHARS_PER_TOKEN = 4       // rough chars->tokens estimate when no real usage is available yet
const COMPACTION_MAX_PER_MSG_CHARS = 2_000 // cap each message's contribution to the summarization transcript
const COMPACTION_SUMMARY_PREFIX = 'Summary of the earlier conversation (older messages were compacted to fit the context window):\n\n'
const COMPACTION_SYSTEM_PROMPT = `You are compacting the context of an ongoing AI coding-agent session so it fits within the model's context window. You will be given the conversation so far (and possibly a previous summary). Produce a single, self-contained summary that lets the agent continue seamlessly without the original transcript.

Preserve, concisely but completely:
- The user's original goal / task and any explicit requirements or constraints.
- Key decisions made and the reasoning behind them.
- Files created, modified, or investigated, with the important changes to each.
- Important facts discovered about the codebase (APIs, patterns, gotchas, file paths).
- Commands run and their salient results (errors, test outcomes).
- The current state of the work and what remains to be done (next steps / open questions).

Rules:
- Write in the third person about "the agent" and "the user".
- Be specific: keep file paths, symbol names, and concrete values. Do NOT invent details.
- Do NOT include large code blocks verbatim; describe changes instead.
- Output ONLY the summary text — no preamble, no meta commentary.`

class StaleTurnError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'StaleTurnError'
	}
}

const MAX_BROWSER_ELEMENT_SCREENSHOT_CHARS = 1_000_000

// Persistence guardrails. These bound the size of the on-disk chat-history blob so serializing it
// never blocks the renderer. Applied ONLY when writing to storage (see `storageStringifyReplacer`);
// the live in-memory state is never trimmed, so the UI always shows full content during a session.
const PERSIST_STRING_CAP = 24_000 // max chars kept per string field in the persisted copy
// Per-string capping alone doesn't bound the blob: chat history has no eviction, so a
// long-lived install accumulates thousands of threads and the aggregate can still reach
// tens of MB. Reading (JSON.parse) that blob happens SYNCHRONOUSLY in this service's
// constructor, which runs on the workbench startup path — a multi-second parse there
// can outrun the "renderer signaled ready" safety-net timeout (windowImpl.ts) and the
// window is force-shown permanently blank. Cap the PERSISTED thread count by recency;
// the live in-memory state is never trimmed, so nothing disappears from the UI mid-session.
const MAX_PERSISTED_THREADS = 200
const storageStringifyReplacer = (key: string, value: unknown): unknown => {
	// Drop base64 media — screenshots/images are up to ~1MB each and are not needed to restore a chat.
	if (key === 'screenshot') return null
	if (key === 'images' && Array.isArray(value)) return []
	if (typeof value === 'string') {
		if (value.length > 256 && (value.startsWith('data:image/') || value.startsWith('data:application/'))) {
			return ''
		}
		// Cap pathologically large strings (e.g. full file contents in tool results / write params).
		if (value.length > PERSIST_STRING_CAP) {
			return value.slice(0, PERSIST_STRING_CAP) + '\n…[truncated for storage]'
		}
	}
	return value
}

const mergeUniqueImages = (images: Array<string | undefined | null> | undefined): string[] | undefined => {
	if (!images) return undefined
	const unique = Array.from(new Set(images.filter((i): i is string => typeof i === 'string' && i.length > 0)))
	return unique.length ? unique : undefined
}

const imagesOfSelections = (selections: StagingSelectionItem[]): string[] => {
	const imgs: string[] = []
	for (const s of selections) {
		if (s.type !== 'BrowserElement') continue
		if (!s.screenshot) continue
		if (s.screenshot.length > MAX_BROWSER_ELEMENT_SCREENSHOT_CHARS) continue
		imgs.push(`data:image/png;base64,${s.screenshot}`)
	}
	return imgs
}

const normalizeRawToolCallName = (toolCall: RawToolCallObj, mcpToolNames?: Set<string>): RawToolCallObj => {
	const resolved = resolveBuiltinToolNameLoose(toolCall.name, { mcpToolNames })
	if (!resolved) return toolCall
	if (mcpToolNames?.has(toolCall.name)) return toolCall
	if (resolved === toolCall.name) return toolCall
	return { ...toolCall, name: resolved }
}

const normalizeRawToolCalls = (toolCalls: RawToolCallObj[] | null | undefined, mcpToolNames?: Set<string>): RawToolCallObj[] | null => {
	if (!toolCalls) return toolCalls ?? null
	return toolCalls.map(toolCall => normalizeRawToolCallName(toolCall, mcpToolNames))
}


const findStagingSelectionIndex = (currentSelections: StagingSelectionItem[] | undefined, newSelection: StagingSelectionItem): number | null => {
	if (!currentSelections) return null

	for (let i = 0; i < currentSelections.length; i += 1) {
		const s = currentSelections[i]

		if (s.type !== newSelection.type) continue

		if (s.type === 'File' && newSelection.type === 'File') {
			if (s.uri.fsPath !== newSelection.uri.fsPath) continue
			return i
		}
		if (s.type === 'CodeSelection' && newSelection.type === 'CodeSelection') {
			if (s.uri.fsPath !== newSelection.uri.fsPath) continue
			const [oldStart, oldEnd] = s.range
			const [newStart, newEnd] = newSelection.range
			if (oldStart !== newStart || oldEnd !== newEnd) continue
			return i
		}
		if (s.type === 'Folder' && newSelection.type === 'Folder') {
			if (s.uri.fsPath !== newSelection.uri.fsPath) continue
			return i
		}
		if (s.type === 'BrowserElement' && newSelection.type === 'BrowserElement') {
			if (s.pageUrl !== newSelection.pageUrl) continue
			if (s.selector !== newSelection.selector) continue
			return i
		}
	}
	return null
}


/*

Store a checkpoint of all "before" files on each x.
x's show up before user messages and LLM edit tool calls.

x     A          (edited A -> A')
(... user modified changes ...)
User message

x     A' B C     (edited A'->A'', B->B', C->C')
LLM Edit
x
LLM Edit
x
LLM Edit


INVARIANT:
A checkpoint appears before every LLM message, and before every user message (before user really means directly after LLM is done).
*/


type UserMessageType = ChatMessage & { role: 'user' }
type UserMessageState = UserMessageType['state']
const defaultMessageState: UserMessageState = {
	stagingSelections: [],
	isBeingEdited: false,
}

// a 'thread' means a chat message history

type WhenMounted = {
	textAreaRef: { current: HTMLTextAreaElement | null }; // the textarea that this thread has, gets set in SidebarChat
	scrollToBottom: () => void;
}



/** Persisted context-compaction state for a thread. `throughMessageIdx` is always a 'user'
 * message boundary so the compacted tail never orphans a tool_result. */
export type ThreadCompaction = {
	summaryText: string;
	throughMessageIdx: number;
	summarizedMessageCount: number;
	/** Workspace-relative path to the full pre-compaction transcript, so the agent can re-read
	 * details the summary omits (Cursor's "chat history as files"). Undefined if no workspace. */
	historyPath?: string;
}

export type ThreadType = {
	id: string; // store the id here too
	createdAt: string; // ISO string
	lastModified: string; // ISO string

	messages: ChatMessage[];
	filesWithUserChanges: Set<string>;
	todoList?: TodoItem[]; // TODO list for this thread
	linkedPlanPath?: string; // Path to linked plan file for bidirectional sync
	planDraft?: PlanDraft; // Ephemeral plan draft (cleared after save)
	compaction?: ThreadCompaction; // Cursor-style summarization of older turns (persisted)

	/**
	 * Agent-window project workspace this thread belongs to.
	 * - string: scoped to that agent workspace
	 * - null: created in agent window under No Repo
	 * - undefined: legacy / main-IDE thread (not agent-workspace-scoped)
	 */
	agentWorkspaceId?: string | null;

	// this doesn't need to go in a state object, but feels right
	state: {
		currCheckpointIdx: number | null; // the latest checkpoint we're at (null if not at a particular checkpoint, like if the chat is streaming, or chat just finished and we haven't clicked on a checkpt)

		stagingSelections: StagingSelectionItem[];
		stagedSlashTokens?: string[]; // names of /skill and /command tokens explicitly inserted via the slash menu (optional for back-compat with older persisted threads)
		focusedMessageIdx: number | undefined; // index of the user message that is being edited (undefined if none)

		linksOfMessageIdx: { // eg. link = linksOfMessageIdx[4]['RangeFunction']
			[messageIdx: number]: {
				[codespanName: string]: CodespanLocationLink
			}
		}


		mountedInfo?: {
			whenMounted: Promise<WhenMounted>
			_whenMountedResolver: (res: WhenMounted) => void
			mountedIsResolvedRef: { current: boolean };
		}


	};
}


type ChatThreads = {
	[id: string]: undefined | ThreadType;
}


export type ThreadsState = {
	allThreads: ChatThreads;
	currentThreadId: string; // intended for internal use only
	/** Independent selection for the standalone Agents window. */
	agentWindowThreadId: string | null;
}

export type IsRunningType =
	| 'LLM' // the LLM is currently streaming
	| 'tool' // whether a tool is currently running
	| 'awaiting_user' // awaiting user call
	| 'idle' // nothing is running now, but the chat should still appear like it's going (used in-between calls)
	| undefined

/** Live sub-agent / task tool labels without persisting on every progress tick. */
type StreamStateExtras = {
	toolProgressById?: Record<string, string>;
}

type ThreadStreamStateItem =
	{
		isRunning: undefined;
		error?: { message: string, fullError: Error | null, };
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt?: undefined;
	} & StreamStateExtras | { // an assistant message is being written
		isRunning: 'LLM';
		error?: undefined;
		llmInfo: {
			displayContentSoFar: string;
			reasoningSoFar: string;
			toolCallSoFar: RawToolCallObj | null;
			toolCallsSoFar: RawToolCallObj[] | null;
		};
		toolInfo?: undefined;
		interrupt: Promise<() => void>; // calling this should have no effect on state - would be too confusing. it just cancels the tool
	} & StreamStateExtras | { // a tool is being run
		isRunning: 'tool';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo: {
			toolName: ToolName;
			toolParams: ToolCallParams<ToolName>;
			id: string;
			content: string;
			rawParams: RawToolParamsObj;
			mcpServerName: string | undefined;
		};
		interrupt: Promise<() => void>;
	} & StreamStateExtras | {
		isRunning: 'awaiting_user';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: undefined;
		pendingToolRequestId?: string;
		interrupt?: undefined;
	} & StreamStateExtras | {
		isRunning: 'idle';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt: 'not_needed' | Promise<() => void>; // calling this should have no effect on state - would be too confusing. it just cancels the tool
	} & StreamStateExtras

export type ThreadStreamState = {
	[threadId: string]: undefined | ThreadStreamStateItem
}

const newThreadObject = (opts?: { agentWorkspaceId?: string | null }) => {
	const now = new Date().toISOString()
	const thread: ThreadType = {
		id: generateUuid(),
		createdAt: now,
		lastModified: now,
		messages: [],
		state: {
			currCheckpointIdx: null,
			stagingSelections: [],
			stagedSlashTokens: [],
			focusedMessageIdx: undefined,
			linksOfMessageIdx: {},
		},
		filesWithUserChanges: new Set()
	}
	if (opts && 'agentWorkspaceId' in opts) {
		thread.agentWorkspaceId = opts.agentWorkspaceId ?? null
	}
	return thread
}






export interface IChatThreadService {
	readonly _serviceBrand: undefined;

	readonly state: ThreadsState;
	readonly streamState: ThreadStreamState; // not persistent

	onDidChangeCurrentThread: Event<void>;
	onDidChangeStreamState: Event<{ threadId: string }>

	getCurrentThread(): ThreadType;
	getThread(threadId: string): ThreadType | undefined;
	getSelectedThreadId(inAgentWindow: boolean): string | null;
	/** Ensure the Agents window has a thread in exactly this workspace scope. */
	ensureAgentWindowThread(agentWorkspaceId: string | null): string;
	/** Create/switch to an empty thread. Pass agentWorkspaceId when opened from the Agents window. */
	openNewThread(opts?: { agentWorkspaceId?: string | null }): void;
	switchToThread(threadId: string, opts?: { inAgentWindow?: boolean }): void;
	setThreadState(threadId: string, newState: Partial<ThreadType['state']>): void;
	getThreadMessageState(threadId: string, messageIdx: number): UserMessageState;
	setThreadMessageState(threadId: string, messageIdx: number, newState: Partial<UserMessageState>): void;
	setThreadFocusedMessageIdx(threadId: string, messageIdx: number | undefined): void;

	/** Folder URIs for a thread (agent workspace or IDE). */
	getFolderUrisForThread(threadId: string): URI[];

	/** Whether `uri` is contained in the thread's effective workspace (agent workspace or IDE). */
	isUriInsideThreadWorkspace(threadId: string, uri: URI): boolean;

	/** True when any thread scoped to this workspace (or No Repo when null) is currently running. */
	hasRunningThreadInWorkspace(agentWorkspaceId: string | null): boolean;

	// thread selector
	deleteThread(threadId: string): void;
	duplicateThread(threadId: string): void;

	// exposed getters/setters
	// these all apply to current thread
	getCurrentMessageState: (messageIdx: number) => UserMessageState
	setCurrentMessageState: (messageIdx: number, newState: Partial<UserMessageState>) => void
	getCurrentThreadState: () => ThreadType['state']
	setCurrentThreadState: (newState: Partial<ThreadType['state']>) => void

	// you can edit multiple messages - the one you're currently editing is "focused", and we add items to that one when you press cmd+L.
	getCurrentFocusedMessageIdx(): number | undefined;
	isCurrentlyFocusingMessage(): boolean;
	setCurrentlyFocusedMessageIdx(messageIdx: number | undefined): void;

	popStagingSelections(numPops?: number): void;
	addNewStagingSelection(newSelection: StagingSelectionItem): void;
	addStagedSlashToken(name: string): void;

	dangerousSetState: (newState: ThreadsState) => void;
	resetState: () => void;

	// // current thread's staging selections
	// closeCurrentStagingSelectionsInMessage(opts: { messageIdx: number }): void;
	// closeCurrentStagingSelectionsInThread(): void;

	// codespan links (link to symbols in the markdown)
	getCodespanLink(opts: { codespanStr: string, messageIdx: number, threadId: string }): CodespanLocationLink | undefined;
	addCodespanLink(opts: { newLinkText: string, newLinkLocation: CodespanLocationLink, messageIdx: number, threadId: string }): void;
	generateCodespanLink(opts: { codespanStr: string, threadId: string }): Promise<CodespanLocationLink>;
	getRelativeStr(uri: URI): string | undefined

	// entry pts
	abortRunning(threadId: string): Promise<void>;
	/** Stop a single task sub-agent without interrupting the parent agent or sibling sub-agents. */
	cancelTaskTool(threadId: string, toolId: string): void;
	/** Release the current Shell/AwaitShell wait so the agent continues while the command keeps running. */
	releaseRunningShellToBackground(threadId: string): void;
	dismissStreamError(threadId: string): void;

	// call to edit a message
	editUserMessageAndStreamResponse({ userMessage, messageIdx, threadId }: { userMessage: string, messageIdx: number, threadId: string }): Promise<void>;

	// call to add a message
	addUserMessageAndStreamResponse({ userMessage, llmInstructions, _chatSelections, _images, threadId }: { userMessage: string, llmInstructions?: string, _chatSelections?: StagingSelectionItem[], _images?: string[], threadId: string }): Promise<void>;

	// message queueing (Cursor-style: sending while the agent runs queues instead of aborting)
	/** Messages queued while the agent is running; drained FIFO as each run ends. */
	getQueuedUserMessages(threadId: string): readonly QueuedUserMessage[];
	/** Remove a queued message by index (composer × button). */
	removeQueuedUserMessage(threadId: string, idx: number): void;
	/** True when the queue is paused (a run errored / a drained send failed) — messages are kept, not sent. */
	getIsQueuePaused(threadId: string): boolean;
	/** Resume a paused queue: drain the next message if the thread is idle. */
	resumeQueuedUserMessages(threadId: string): void;
	/** Clear the whole queue without aborting the current run. */
	clearQueuedUserMessages(threadId: string): void;
	/** Fires when a thread's queued-message list changes. */
	onDidChangeQueuedMessages: Event<{ threadId: string }>;

	// approve/reject
	approveLatestToolRequest(threadId: string, toolId?: string): void;
	rejectLatestToolRequest(threadId: string, toolId?: string): void;

	/** Submit the user's answers to a pending AskQuestion tool request. */
	submitAskQuestionAnswer(threadId: string, toolId: string, answers: AskQuestionUserAnswer[]): void;
	/** Skip the pending AskQuestion form (Esc / Skip). */
	skipAskQuestion(threadId: string, toolId: string, opts?: { resumeAgent?: boolean }): void;

	// jump to history
	jumpToCheckpointBeforeMessageIdx(opts: { threadId: string, messageIdx: number, jumpToUserModified: boolean }): void;

	focusCurrentChat: () => Promise<void>
	blurCurrentChat: () => Promise<void>

	/** Re-run Grep with an increased offset to load the next page of results. */
	loadMoreGrepResults(threadId: string, params: BuiltinToolCallParams['Grep']): Promise<void>

	/** Live internal conversation for a sub-agent task tool (for popup UI). */
	getSubAgentConversation(toolId: string): Readonly<ChatMessage[]> | undefined;
	getLatestThreadUsage(threadId: string): Readonly<LLMUsage> | undefined;

	/** Live sub-agent labels when there is no active stream state entry. */
	getToolProgressOverlay(threadId: string): Readonly<Record<string, string>> | undefined

	// --- Plan draft + linked plan management ---

	/** Returns the active plan draft for a thread, if any. */
	getThreadPlanDraft(threadId: string): PlanDraft | undefined;
	/** Stores a new (or updated) plan draft on the thread. */
	setThreadPlanDraft(threadId: string, draft: PlanDraft | undefined): void;
	/** Clears the ephemeral plan draft (called after the draft is saved to disk). */
	clearThreadPlanDraft(threadId: string): void;
	/** Fires when a thread's plan draft changes. */
	onDidChangeThreadPlanDraft: Event<{ threadId: string }>;

	/** Sets (or clears, when `path` is null) the linked plan file path for a thread. */
	setLinkedPlanPath(threadId: string, path: string | null): void;
	/** Clears the linked plan path for a thread. */
	clearLinkedPlanPath(threadId: string): void;
	/** Fires when a thread's linked plan path changes. */
	onDidChangeThreadLinkedPlanPath: Event<{ threadId: string }>;

	/** Replaces the thread's todo list (e.g. when syncing from a plan checklist). */
	setThreadTodoList(threadId: string, todos: TodoItem[]): void;
	/** Returns the thread's current todo list, if any. */
	getThreadTodoList(threadId: string): TodoItem[] | undefined;
	/**
	 * Fires when a thread's todo list changes (Phase 1.3 fix: dedicated event so consumers
	 * like PlanTodoSyncService can avoid subscribing to every state change).
	 * Carries the affected threadId.
	 */
	onDidChangeThreadTodoList: Event<{ threadId: string }>;
	/** Updates a single todo item's status. Fires onDidChangeThreadTodoList on change. */
	setThreadTodoItemStatus(threadId: string, todoId: string, status: TodoStatus): void;

	/** Returns the current build phase for a thread (Build button). */
	getPlanBuildState(threadId: string): PlanBuildState;
	/** Updates the build phase for a thread. */
	setPlanBuildState(threadId: string, state: PlanBuildState): void;
	/** Fires when a thread's plan build state changes. */
	onDidChangePlanBuildState: Event<{ threadId: string }>;

	/** Waits until the thread's current agent run finishes (used after plan Build). */
	waitForThreadAgentRunEnd(threadId: string): Promise<void>;
}

export const IChatThreadService = createDecorator<IChatThreadService>('voidChatThreadService');

const HIDDEN_TOOL_REPLACEMENT_MESSAGE = (name: string) =>
	`Tool '${name}' has been replaced by 'Grep'. Use Grep for content search.`

class ChatThreadService extends Disposable implements IChatThreadService {
	_serviceBrand: undefined;

	// this fires when the current thread changes at all (a switch of currentThread, or a message added to it, etc)
	private readonly _onDidChangeCurrentThread = new Emitter<void>();
	readonly onDidChangeCurrentThread: Event<void> = this._onDidChangeCurrentThread.event;

	private readonly _onDidChangeStreamState = new Emitter<{ threadId: string }>();
	readonly onDidChangeStreamState: Event<{ threadId: string }> = this._onDidChangeStreamState.event;

	private readonly _onDidChangeThreadPlanDraft = new Emitter<{ threadId: string }>();
	readonly onDidChangeThreadPlanDraft: Event<{ threadId: string }> = this._onDidChangeThreadPlanDraft.event;

	private readonly _onDidChangeThreadLinkedPlanPath = new Emitter<{ threadId: string }>();
	readonly onDidChangeThreadLinkedPlanPath: Event<{ threadId: string }> = this._onDidChangeThreadLinkedPlanPath.event;

	private readonly _onDidChangePlanBuildState = new Emitter<{ threadId: string }>();
	readonly onDidChangePlanBuildState: Event<{ threadId: string }> = this._onDidChangePlanBuildState.event;

	private readonly _onDidChangeQueuedMessages = new Emitter<{ threadId: string }>();
	readonly onDidChangeQueuedMessages: Event<{ threadId: string }> = this._onDidChangeQueuedMessages.event;
	/** Messages sent while the agent was running; drained FIFO at run end. Not persisted. */
	private readonly _queuedUserMessagesByThread = new Map<string, QueuedUserMessage[]>();
	/** Threads whose queue is paused (a run errored, or a drained send threw). Messages are kept but
	 *  not auto-drained until the user resumes — avoids blasting the next message into a broken turn. */
	private readonly _queuePausedByThread = new Set<string>();
	/** Debounced writer for the persisted message queue (Q4). */
	private _queuePersistScheduler: RunOnceScheduler | null = null;
	/** Threads already warned that compaction summarization failed (A4) — avoids repeating the notice
	 *  every high-fill turn. Cleared when a summary later succeeds for that thread. */
	private readonly _compactionFallbackNotified = new Set<string>();

	/** Per-thread UI build phase (Build button). Not persisted. */
	private readonly _planBuildStateByThread: Map<string, PlanBuildState> = new Map();
	/** In-flight agent runs keyed by thread (for plan Build completion tracking). */
	private readonly _pendingAgentRunByThread = new Map<string, Promise<void>>();

	readonly streamState: ThreadStreamState = {}
	private readonly _turnSequenceOfThread: Record<string, number> = {}
	/** Coalesce high-frequency LLM stream updates for React (flush on final/error/abort). */
	private readonly _llmStreamThrottleByThread = new Map<string, RunOnceScheduler>()
	private readonly _pendingLlmStreamStateByThread = new Map<string, Extract<ThreadStreamStateItem, { isRunning: 'LLM' }>>()
	/** Debounce disk persistence while an agent turn is active. */
	private _storeDebounceScheduler: RunOnceScheduler | undefined
	private _pendingThreadsToStore: ChatThreads | null = null
	/** Sub-agent task labels without synthesizing stream `isRunning` (UI-only overlay). */
	private readonly _toolProgressOverlayByThread: Record<string, Record<string, string>> = {}
	state: ThreadsState // allThreads is persisted, currentThread is not

	// Tracks pending background sub-agent tasks per thread: threadId → Map<toolId, description>
	private readonly _pendingBackgroundTasks: Map<string, Map<string, string>> = new Map();
	// Accumulates completed background results per thread until all are done
	private readonly _completedBackgroundResults: Map<string, Array<{ toolId: string; description: string; result: BuiltinToolResultType['task'] }>> = new Map();
	// Sub-agent internal conversations keyed by parent task tool id
	private readonly _subAgentConversations = new Map<string, ChatMessage[]>();
	private readonly _subAgentConversationThreadByToolId = new Map<string, string>();

	// Latest provider-reported token usage per thread. The last turn's promptTokens is the
	// best real measure of current context size; used by context-window management and the UI.
	private readonly _latestUsageByThread = new Map<string, LLMUsage>();


	// used in checkpointing
	// private readonly _userModifiedFilesToCheckInCheckpoints = new LRUCache<string, null>(50)



	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IVoidModelService private readonly _voidModelService: IVoidModelService,
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
		@IToolsService private readonly _toolsService: IToolsService,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
		@IMetricsService private readonly _metricsService: IMetricsService,
		@IEditCodeService private readonly _editCodeService: IEditCodeService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IConvertToLLMMessageService private readonly _convertToLLMMessagesService: IConvertToLLMMessageService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IDirectoryStrService private readonly _directoryStringService: IDirectoryStrService,
		@IFileService private readonly _fileService: IFileService,
		@IMCPService private readonly _mcpService: IMCPService,
		@IVoidNativeNotificationService private readonly _nativeNotificationService: IVoidNativeNotificationService,
		@ISubAgentService private readonly _subAgentService: ISubAgentService,
		@ITerminalToolService private readonly _terminalToolService: ITerminalToolService,
		@IAgentProjectWorkspaceService private readonly _agentProjectWorkspaceService: IAgentProjectWorkspaceService,
	) {
		super()
		this.state = { allThreads: {}, currentThreadId: null as unknown as string, agentWindowThreadId: null } // default state

		const readThreads = this._readAllThreads() || {}

		const allThreads = readThreads
		this.state = {
			allThreads: allThreads,
			currentThreadId: null as unknown as string, // gets set in startNewThread()
			agentWindowThreadId: null,
		}
		for (const threadId of Object.keys(allThreads)) {
			this._turnSequenceOfThread[threadId] = 0
		}

		// Q4: rehydrate any persisted message queues (as PAUSED — never auto-fire into a cold thread on
		// startup), and persist (debounced) whenever the queue changes.
		this._loadPersistedQueues(new Set(Object.keys(allThreads)))
		this._register(this.onDidChangeQueuedMessages(() => this._schedulePersistQueues()))

		// Self-heal an on-disk blob that predates MAX_PERSISTED_THREADS (or just grew past
		// it) — re-persisting now (pruned by _sanitizeThreadsForStorage) makes the NEXT
		// launch's read fast too, without waiting for the user to naturally trigger a save.
		// Only the persisted copy shrinks; `allThreads` above already has every thread.
		if (Object.keys(allThreads).length > MAX_PERSISTED_THREADS) {
			this._storeAllThreads(allThreads)
		}

		// always be in a thread
		this.openNewThread()

		// Store sub-agent internal conversations for popup UI
		this._register(this._subAgentService.onSubAgentConversationUpdate(({ toolId, threadId, messages }) => {
			this._subAgentConversations.set(toolId, messages);
			this._subAgentConversationThreadByToolId.set(toolId, threadId);
			this._onDidChangeStreamState.fire({ threadId });
		}));

		// Update running task tool label when sub-agent executes a tool (stream-only; persist on completion)
		this._register(this._subAgentService.onProgress(({ toolId, activity }) => {
			const applyToThread = (threadId: string, thread: ChatThreads[string] | undefined) => {
				if (!thread) return;
				const msgs = thread.messages;
				for (let i = msgs.length - 1; i >= 0; i--) {
					const msg = msgs[i];
					if (msg.role !== 'tool' || msg.id !== toolId || msg.name !== 'task') continue;
					const isRunningTask = msg.type === 'running_now'
					const isBackgroundTask = msg.type === 'success'
						&& (msg.result as BuiltinToolResultType['task'] | undefined)?.status === 'background_launched'
					if (isRunningTask || isBackgroundTask) {
						this._setSubAgentToolProgress(threadId, toolId, activity);
					}
					return; // toolId is unique, so the matching message has been found
				}
			};
			// Fast path: O(1) thread lookup via the conversation index populated at sub-agent start.
			// Avoids an O(threads x messages) scan on every progress tick (which compounds per concurrent agent).
			const indexedThreadId = this._subAgentConversationThreadByToolId.get(toolId);
			if (indexedThreadId !== undefined) {
				applyToThread(indexedThreadId, this.state.allThreads[indexedThreadId]);
				return;
			}
			// Fallback: scan all threads (covers a tool that hasn't been indexed yet).
			for (const [threadId, thread] of Object.entries(this.state.allThreads)) {
				applyToThread(threadId, thread);
			}
		}));

		// When a background agent settles, update its tool message and re-trigger the parent agent when all are done
		this._register(this._subAgentService.onBackgroundComplete(({ toolId, threadId, description, result }) => {
			// 1. Update the tool message from background_launched → completed result
			const thread = this.state.allThreads[threadId];
			if (thread) {
				const msgs = thread.messages;
				for (let i = msgs.length - 1; i >= 0; i--) {
					const msg = msgs[i];
					if (msg.role === 'tool' && msg.id === toolId) {
						const statusPart = result.status === 'completed' ? '' : ` | Status: ${result.status}`;
						const toolResultStr = `${result.output}\n\n[Agent: ${result.agentType}${statusPart} | Tools used: ${result.toolUseCount} | Duration: ${result.durationMs < 1000 ? `${result.durationMs}ms` : `${(result.durationMs / 1000).toFixed(1)}s`}]`;
						this._editMessageInThread(threadId, i, { ...msg, type: 'success', result: result as any, content: toolResultStr } as any);
						this._clearToolProgressOverlay(threadId, toolId);
						break;
					}
				}
			} else {
				this._pendingBackgroundTasks.delete(threadId);
				this._completedBackgroundResults.delete(threadId);
				return;
			}

			// 2. Remove from pending set
			const pending = this._pendingBackgroundTasks.get(threadId);
			if (pending) {
				pending.delete(toolId);

				// Accumulate result until the parent thread is idle. This covers the race where
				// a background agent finishes while the parent is still in its own LLM/tool loop.
				this._pushCompletedBackgroundResult(threadId, { toolId, description, result });

				// 3. When all background tasks for this thread are done, re-trigger the parent agent
				if (pending.size === 0) {
					this._pendingBackgroundTasks.delete(threadId);
					this._resumeParentAfterBackgroundCompletion(threadId);
				}
			}
		}));

		this._register(this._toolsService.onShellNotify(({ shellId, matchedText, reason }) => {
			const threadId = this.state.currentThreadId;
			if (!threadId) return;
			if (this.streamState[threadId]?.isRunning) return;
			if (!this.state.allThreads[threadId]) return;

			const content = `[notify_on_output match on ${shellId} — reason: ${reason}]\nMatched: ${matchedText}`;
			this._addMessageToThread(threadId, {
				role: 'tool',
				type: 'success',
				name: 'Shell',
				content,
				result: { kind: 'backgrounded', shellId } as BuiltinToolResultType['Shell'],
				id: generateUuid(),
				rawParams: {},
				params: { command: '', workingDirectory: null, blockUntilMs: 0, description: null, notifyOnOutput: null, requestSmartModeApproval: false, shellId } as BuiltinToolCallParams['Shell'],
				mcpServerName: undefined,
			});

			const turnSequence = this._nextTurnSequence(threadId);
			this._wrapRunAgentToNotify(
				this._runChatAgent({ threadId, ...this._currentModelSelectionProps(), turnSequence }),
				threadId,
			);
		}));

		// keep track of user-modified files
		// const disposablesOfModelId: { [modelId: string]: IDisposable[] } = {}
		// this._register(
		// 	this._modelService.onModelAdded(e => {
		// 		if (!(e.id in disposablesOfModelId)) disposablesOfModelId[e.id] = []
		// 		disposablesOfModelId[e.id].push(
		// 			e.onDidChangeContent(() => { this._userModifiedFilesToCheckInCheckpoints.set(e.uri.fsPath, null) })
		// 		)
		// 	})
		// )
		// this._register(this._modelService.onModelRemoved(e => {
		// 	if (!(e.id in disposablesOfModelId)) return
		// 	disposablesOfModelId[e.id].forEach(d => d.dispose())
		// }))

	}

	async focusCurrentChat() {
		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		// Wait for the composer to actually exist before querying for it — a
		// caller that just called `openViewContainer` (e.g. the "open sidebar" /
		// "new chat" actions) races the React composer's mount, and without this
		// the very first focus after opening the sidebar was silently a no-op.
		if (thread.state.mountedInfo) {
			await thread.state.mountedInfo.whenMounted
		}
		if (!this.isCurrentlyFocusingMessage()) {
			const activeWindow = getActiveWindow()
			const composerToFocus = findThreadComposerInWindow(activeWindow)
			if (composerToFocus) {
				focusInConnectedWindow(composerToFocus)
			}
		}
	}
	async blurCurrentChat() {
		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		if (!this.isCurrentlyFocusingMessage()) {
			const activeWindow = getActiveWindow()
			findThreadComposerInWindow(activeWindow)?.blur()
		}
	}

	loadMoreGrepResults = async (threadId: string, params: BuiltinToolCallParams['Grep']) => {
		const headLimit = getEffectiveGrepHeadLimit(params.headLimit, params.outputMode)
		const nextParams: BuiltinToolCallParams['Grep'] = {
			...params,
			offset: params.offset + headLimit,
		}
		const toolId = generateUuid()
		await this._runToolCall(threadId, 'Grep', toolId, undefined, {
			preapproved: true,
			validatedParams: nextParams,
			unvalidatedToolParams: {},
		})
	}

	/**
	 * Plays the agent completion sound if enabled in settings.
	 * Uses simple HTMLAudioElement for reliability and simplicity.
	 */
	private async _playAgentCompletionSound(): Promise<void> {
		try {
			// Check if sound is enabled in settings
			if (!this._settingsService.state.globalSettings.enableAgentCompletionSound) {
				return;
			}

			// Use FileAccess to get the correct browser URI for the sound file
			const soundUrl = FileAccess.asBrowserUri(
				'vs/platform/accessibilitySignal/browser/media/taskCompleted.mp3'
			).toString(true);

			// Create and play audio
			const audio = new Audio(soundUrl);
			audio.volume = 0.5; // Set to 50% volume (subtle, not jarring)

			// Fire and forget - don't block on audio completion
			audio.play().catch(err => {
				// Silently fail - audio permission issues shouldn't break functionality
				// Only log if it's not the common "user gesture required" error
				if (!err.message?.includes('user gesture')) {
					console.debug('Agent completion sound failed to play:', err);
				}
			});
		} catch (error) {
			// Catch any unexpected errors and fail silently
			console.debug('Error playing agent completion sound:', error);
		}
	}

	/**
	 * Shows a native OS notification when agent completes if enabled in settings.
	 * Only shows when window is not focused.
	 */
	private async _showAgentCompletionNotification(): Promise<void> {
		try {
			// Check if notification is enabled in settings
			if (!this._settingsService.state.globalSettings.enableAgentCompletionNotification) {
				return;
			}

			// Show native OS notification (only if window not focused)
			await this._nativeNotificationService.showNotification(
				'Agent Task Completed',
				'Your agent has finished working and is ready for review.'
			);

		} catch (error) {
			// Catch any unexpected errors and fail silently
			console.debug('Error showing agent completion notification:', error);
		}
	}


	dangerousSetState = (newState: ThreadsState) => {
		this.state = newState
		for (const key of Object.keys(this._turnSequenceOfThread)) {
			delete this._turnSequenceOfThread[key]
		}
		this._onDidChangeCurrentThread.fire()
	}
	resetState = () => {
		this.state = { allThreads: {}, currentThreadId: null as unknown as string, agentWindowThreadId: null } // see constructor
		for (const key of Object.keys(this._turnSequenceOfThread)) {
			delete this._turnSequenceOfThread[key]
		}
		this.openNewThread()
		this._onDidChangeCurrentThread.fire()
	}

	// !!! this is important for properly restoring URIs from storage
	// should probably re-use code from void/src/vs/base/common/marshalling.ts instead. but this is simple enough
	private _parseStorageData<T>(serialized: string): T {
		return JSON.parse(serialized, (_key, value) => {
			if (value && typeof value === 'object' && value.$mid === 1) { // $mid is the MarshalledId. $mid === 1 means it is a URI
				return URI.revive(value); // canonical revive of a marshalled URI (preserves cached fsPath/external markers)
			}
			return value;
		});
	}

	private _readAllThreads(): ChatThreads | null {
		const threadsStr = this._storageService.get(THREAD_STORAGE_KEY, StorageScope.APPLICATION);
		if (!threadsStr) {
			return null
		}
		try {
			return this._parseStorageData<ChatThreads>(threadsStr);
		} catch (error) {
			// This runs in the constructor of an EAGERLY-instantiated singleton — an
			// uncaught throw here doesn't just lose chat history, it can take down
			// workbench startup entirely. Treat truly malformed storage (e.g. a
			// truncated write from a prior crash) the same as "no history" rather than
			// blocking the app from ever opening again.
			console.error('[chatThreadService] Failed to parse persisted chat threads; starting fresh:', getErrorMessage(error))
			return null
		}
	}

	private _sanitizeThreadsForStorage(threads: ChatThreads): ChatThreads {
		const entries = Object.entries(threads).filter((e): e is [string, ThreadType] => !!e[1])
		if (entries.length <= MAX_PERSISTED_THREADS) {
			return threads
		}
		// Keep only the most recently-modified threads on disk (see MAX_PERSISTED_THREADS).
		entries.sort((a, b) => (b[1].lastModified || '').localeCompare(a[1].lastModified || ''))
		const kept: ChatThreads = {}
		for (const [id, thread] of entries.slice(0, MAX_PERSISTED_THREADS)) {
			kept[id] = thread
		}
		return kept
	}

	private _flushStoreAllThreads() {
		const threads = this._pendingThreadsToStore
		this._pendingThreadsToStore = null
		if (!threads) return
		try {
			// IMPORTANT: serialize with a replacer that trims the *persisted* copy only — the live
			// in-memory `state.allThreads` is never mutated, so the UI keeps full fidelity. Chat history
			// accumulates huge tool outputs (full file contents from Read/Glob, command output) and
			// base64 screenshots (~1MB each). Persisting all of that verbatim made JSON.stringify + the
			// IPC serialize block the renderer for 400-650ms (confirmed by the perf profiler). Dropping
			// media and capping oversized strings shrinks the blob ~10-50x so the write no longer janks.
			const serializedThreads = JSON.stringify(this._sanitizeThreadsForStorage(threads), storageStringifyReplacer);
			this._storageService.store(
				THREAD_STORAGE_KEY,
				serializedThreads,
				StorageScope.APPLICATION,
				StorageTarget.USER
			);
		} catch (error) {
			console.error('[chatThreadService] Failed to persist chat threads:', getErrorMessage(error))
		}
	}

	private _scheduleStoreAllThreads() {
		if (!this._storeDebounceScheduler) {
			// Debounce disk persistence while an agent turn is active. Coalesces the many appends a
			// running agent produces into one write. The turn-end / dispose paths flush immediately, so
			// a longer window here only delays persistence of in-flight changes (cheap to lose on crash)
			// while removing most of the serialization work from the busy streaming period.
			this._storeDebounceScheduler = new RunOnceScheduler(() => this._flushStoreAllThreads(), 1200);
			this._register(this._storeDebounceScheduler)
		}
		this._storeDebounceScheduler.schedule()
	}

	private _storeAllThreads(threads: ChatThreads, opts?: { immediate?: boolean }) {
		this._pendingThreadsToStore = threads
		if (opts?.immediate) {
			this._storeDebounceScheduler?.cancel()
			this._flushStoreAllThreads()
			return
		}
		const anyThreadRunning = Object.values(this.streamState).some(s => s?.isRunning !== undefined)
		if (anyThreadRunning) {
			this._scheduleStoreAllThreads()
		} else {
			this._storeDebounceScheduler?.cancel()
			this._flushStoreAllThreads()
		}
	}

	// ---- Q4: persist the message queue across reload / restart ----

	private _schedulePersistQueues() {
		if (!this._queuePersistScheduler) {
			this._queuePersistScheduler = new RunOnceScheduler(() => this._persistQueues(), 800)
			this._register(this._queuePersistScheduler)
		}
		this._queuePersistScheduler.schedule()
	}

	private _persistQueues() {
		try {
			const out: { [threadId: string]: QueuedUserMessage[] } = {}
			for (const [threadId, queue] of this._queuedUserMessagesByThread) {
				if (!queue || queue.length === 0) continue
				// Persist text + file/selection context. Drop heavy image data-URIs from the persisted copy
				// (they can be re-attached after a reload); the string replacer caps any oversized field.
				out[threadId] = queue.map(q => ({ userMessage: q.userMessage, llmInstructions: q.llmInstructions, _chatSelections: q._chatSelections }))
			}
			if (Object.keys(out).length === 0) {
				this._storageService.remove(QUEUED_MESSAGES_STORAGE_KEY, StorageScope.APPLICATION)
				return
			}
			this._storageService.store(QUEUED_MESSAGES_STORAGE_KEY, JSON.stringify(out, storageStringifyReplacer), StorageScope.APPLICATION, StorageTarget.USER)
		} catch (error) {
			console.error('[chatThreadService] Failed to persist message queue:', getErrorMessage(error))
		}
	}

	private _loadPersistedQueues(validThreadIds: Set<string>) {
		try {
			const str = this._storageService.get(QUEUED_MESSAGES_STORAGE_KEY, StorageScope.APPLICATION)
			if (!str) return
			const parsed = this._parseStorageData<{ [threadId: string]: QueuedUserMessage[] }>(str)
			for (const threadId of Object.keys(parsed)) {
				if (!validThreadIds.has(threadId)) continue // thread was deleted since it was persisted
				const queue = parsed[threadId]
				if (!Array.isArray(queue) || queue.length === 0) continue
				const validQueue = queue.filter(q => q && typeof q.userMessage === 'string').slice(0, MAX_QUEUED_USER_MESSAGES)
				if (validQueue.length === 0) continue
				this._queuedUserMessagesByThread.set(threadId, validQueue)
				this._queuePausedByThread.add(threadId) // paused on startup — never auto-fire into a cold thread
			}
		} catch (error) {
			console.error('[chatThreadService] Failed to load persisted message queue:', getErrorMessage(error))
		}
	}

	getToolProgressOverlay(threadId: string): Readonly<Record<string, string>> | undefined {
		return this._toolProgressOverlayByThread[threadId]
	}

	getSubAgentConversation(toolId: string): Readonly<ChatMessage[]> | undefined {
		return this._subAgentConversations.get(toolId);
	}

	/** Store the most recent provider-reported usage for a thread (ignores empty/absent usage). */
	private _recordThreadUsage(threadId: string, usage: LLMUsage | undefined): void {
		if (!usage) return
		if (usage.promptTokens === undefined && usage.completionTokens === undefined && usage.totalTokens === undefined) return
		this._latestUsageByThread.set(threadId, usage)
	}

	/** The latest provider-reported usage for a thread, if any turn has completed with usage data. */
	getLatestThreadUsage(threadId: string): Readonly<LLMUsage> | undefined {
		return this._latestUsageByThread.get(threadId)
	}

	/** Whether an LLM error is worth retrying. Transient (network / 429 / 5xx) => yes;
	 * auth / bad-request / not-found / quota / empty-response => no (retry won't help). */
	private _isRetryableLLMError(error?: { message: string; fullError: Error | null }): boolean {
		if (!error) return true
		const status = (error.fullError as { status?: number; statusCode?: number } | null)?.status
			?? (error.fullError as { status?: number; statusCode?: number } | null)?.statusCode
		if (typeof status === 'number') {
			if (status === 429 || status >= 500) return true
			if (status >= 400) return false // other 4xx are client errors — not retryable
			return true
		}
		// No status code available — classify by message text.
		const msg = (error.message || '').toLowerCase()
		const nonRetryable = ['sign in', 'invalid api key', 'api key', 'unauthorized', 'permission', 'forbidden', 'not found', 'invalid request', 'bad request', 'context length', 'maximum context', 'context_length', 'quota', 'billing', 'insufficient', 'was empty']
		if (nonRetryable.some(s => msg.includes(s))) return false
		return true
	}

	/** Best-effort Retry-After (ms) parsed from a provider error. Returns undefined when absent. */
	private _retryAfterMsFromError(error?: { message: string; fullError: Error | null }): number | undefined {
		if (!error) return undefined
		const headers = (error.fullError as { headers?: Record<string, string> } | null)?.headers
		const raw = headers?.['retry-after'] ?? headers?.['Retry-After']
		if (raw) {
			const secs = Number(raw)
			if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS)
		}
		// Some providers embed "retry after N seconds" / "try again in Ns" in the message.
		const m = (error.message || '').match(/(?:retry after|try again in)\s+(\d+(?:\.\d+)?)\s*(ms|s|seconds?)?/i)
		if (m) {
			const n = Number(m[1])
			if (Number.isFinite(n)) return m[2]?.toLowerCase().startsWith('ms') ? n : n * 1000
		}
		return undefined
	}

	// ---------------- context compaction ----------------

	/** Chars a chat message contributes to the LLM payload (what the converter actually sends). */
	private _messageSendChars(m: ChatMessage): number {
		if (m.role === 'assistant') return (m.displayContent?.length ?? 0) + (m.reasoning?.length ?? 0)
		if (m.role === 'user') return m.content?.length ?? 0
		if (m.role === 'tool') return (m.content?.length ?? 0)
		return 0 // checkpoint / interrupted_streaming_tool are dropped before sending
	}

	/** Estimated prompt tokens for a set of messages (rough chars/token when no real usage exists). */
	private _estimatePromptTokens(messages: ChatMessage[]): number {
		let chars = 0
		for (const m of messages) chars += this._messageSendChars(m)
		return Math.ceil(chars / COMPACTION_CHARS_PER_TOKEN)
	}

	/** Build the message list actually sent to the LLM, substituting a summary for compacted turns.
	 * The thread's real messages are never mutated — only this sent view is compacted. Pure: a stale
	 * compaction (boundary no longer a user message) is simply ignored, never mutated here. */
	private _buildCompactedChatMessages(threadId: string, messages: ChatMessage[]): ChatMessage[] {
		const c = this.state.allThreads[threadId]?.compaction
		if (!c) return messages
		// Ignore stale compaction if the thread was edited/branched such that the boundary is no
		// longer a user message (or the array shrank below it). It gets overwritten on the next
		// compaction; meanwhile the full transcript + deterministic truncation keep us under budget.
		if (messages.length <= c.throughMessageIdx || messages[c.throughMessageIdx]?.role !== 'user') {
			return messages
		}
		const firstUserIdx = messages.findIndex(m => m.role === 'user')
		if (firstUserIdx < 0 || c.throughMessageIdx <= firstUserIdx) return messages

		const head = messages.slice(0, firstUserIdx + 1) // preamble + original task
		const historyNote = c.historyPath
			? `\n\nThe full detail of the earlier conversation is saved at \`${c.historyPath}\`. If you need specifics not captured in this summary, read that file.`
			: ''
		const summaryMsg: ChatMessage = { role: 'assistant', displayContent: COMPACTION_SUMMARY_PREFIX + c.summaryText + historyNote, reasoning: '', anthropicReasoning: null }
		const tail = messages.slice(c.throughMessageIdx) // starts at a user message (safe boundary)
		return [...head, summaryMsg, ...tail]
	}

	/** Serialize messages into a plain-text transcript for the summarizer (no tool-pairing concerns). */
	private _transcriptForSummarization(messages: ChatMessage[]): string {
		const parts: string[] = []
		for (const m of messages) {
			let line: string | undefined
			if (m.role === 'user') line = `USER: ${m.content ?? ''}`
			else if (m.role === 'assistant') {
				const reasoning = m.reasoning ? `\n(thinking: ${m.reasoning})` : ''
				line = `ASSISTANT: ${m.displayContent ?? ''}${reasoning}`
			}
			else if (m.role === 'tool') line = `TOOL[${m.name}] -> ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`
			if (line === undefined) continue
			if (line.length > COMPACTION_MAX_PER_MSG_CHARS) line = line.slice(0, COMPACTION_MAX_PER_MSG_CHARS) + '…(truncated)'
			parts.push(line)
		}
		return parts.join('\n\n')
	}

	/** One-shot, no-tools LLM call that produces the compaction summary. Resolves null on any failure
	 * so the caller can fall back to deterministic truncation. */
	private _summarizeForCompaction(modelSelection: ModelSelection, priorSummary: string | undefined, messagesToSummarize: ChatMessage[]): Promise<string | null> {
		return new Promise<string | null>((resolve) => {
			const transcript = this._transcriptForSummarization(messagesToSummarize)
			if (!transcript.trim()) { resolve(null); return }
			const userContent = (priorSummary ? `Previous summary:\n${priorSummary}\n\n` : '') + `Conversation transcript to fold into the summary:\n\n${transcript}`
			let settled = false
			const done = (v: string | null) => { if (!settled) { settled = true; resolve(v) } }
			const token = this._llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				chatMode: null,
				messages: [{ role: 'user', content: userContent }],
				modelSelection,
				modelSelectionOptions: undefined,
				overridesOfModel: this._settingsService.state.overridesOfModel,
				logging: { loggingName: 'Chat - Compaction' },
				separateSystemMessage: COMPACTION_SYSTEM_PROMPT,
				suppressStreamingEvents: true,
				onText: () => { },
				onFinalMessage: ({ fullText }) => done(fullText?.trim() || null),
				onError: () => done(null),
				onAbort: () => done(null),
			})
			if (!token) done(null)
		})
	}

	/** If the thread's prompt is approaching the model's context window, summarize older turns and
	 * record the compaction so subsequent turns send [task + summary + recent turns]. */
	private async _maybeCompactThread(threadId: string, modelSelection: ModelSelection | null, messages: ChatMessage[]): Promise<void> {
		if (!modelSelection) return
		if (messages.length < COMPACTION_MIN_MESSAGES) return

		const { overridesOfModel } = this._settingsService.state
		const { contextWindow } = getModelCapabilities(modelSelection.providerName, modelSelection.modelName, overridesOfModel)
		if (!contextWindow || contextWindow <= 0) return

		// Estimate the size of what we'd send right now. Prefer the real provider-reported prompt
		// size from the last completed turn (accurate; already reflects any prior compaction); fall
		// back to a char estimate of the already-compacted view when no usage has been recorded yet.
		const recordedPromptTokens = this._latestUsageByThread.get(threadId)?.promptTokens
		const estTokens = (typeof recordedPromptTokens === 'number' && recordedPromptTokens > 0)
			? recordedPromptTokens
			: this._estimatePromptTokens(this._buildCompactedChatMessages(threadId, messages))
		if (estTokens < contextWindow * COMPACTION_TRIGGER_FRACTION) return

		const existing = this.state.allThreads[threadId]?.compaction
		const firstUserIdx = messages.findIndex(m => m.role === 'user')
		if (firstUserIdx < 0) return
		const startIdx = existing ? existing.throughMessageIdx : firstUserIdx + 1

		// Don't re-summarize until enough new messages have accrued since the last compaction.
		if (existing && messages.length - existing.summarizedMessageCount < COMPACTION_MIN_NEW_MESSAGES) return

		// Choose a boundary: keep the most recent messages (~target fraction of the window) verbatim,
		// snapped forward to the next user message so the kept tail never starts with an orphaned
		// tool_result. (Boundary math lives in a pure, unit-tested helper.)
		const targetTailChars = contextWindow * COMPACTION_TARGET_FRACTION * COMPACTION_CHARS_PER_TOKEN
		const boundary = selectCompactionBoundary({
			messages: messages.map(m => ({ sendChars: this._messageSendChars(m), isUserBoundary: m.role === 'user' })),
			startIdx,
			targetTailChars,
			minRange: COMPACTION_MIN_NEW_MESSAGES,
		})
		if (boundary === null) return

		const toSummarize = messages.slice(startIdx, boundary)
		let summary = await this._summarizeForCompaction(modelSelection, existing?.summaryText, toSummarize)
		if (!summary) {
			// A4: retry once — a transient LLM error shouldn't immediately drop us to lossy truncation.
			summary = await this._summarizeForCompaction(modelSelection, existing?.summaryText, toSummarize)
		}
		if (!summary) {
			// Both attempts failed. Deterministic truncation still guarantees a fit, but it trims detail
			// rather than summarizing — surface it once (per thread) so the loss isn't silent.
			if (!this._compactionFallbackNotified.has(threadId)) {
				this._compactionFallbackNotified.add(threadId)
				this._notificationService.info('Orbit couldn\'t summarize earlier messages to fit the context window (model error). Falling back to trimming older detail — some context may be lost.')
			}
			return
		}
		// A summary succeeded — allow the notice to fire again if a future attempt fails.
		this._compactionFallbackNotified.delete(threadId)

		// Re-validate: the thread may have changed while the summary was generating.
		const latest = this.state.allThreads[threadId]?.messages
		if (!latest || latest.length < boundary || latest[boundary]?.role !== 'user') return

		// Persist the full pre-compaction detail to a workspace file so the agent can re-read it.
		const historyPath = await this._appendCompactionHistory(threadId, toSummarize, existing?.historyPath)

		this._setThreadCompaction(threadId, {
			summaryText: summary,
			throughMessageIdx: boundary,
			summarizedMessageCount: boundary,
			historyPath,
		})
	}

	/** Append the given (about-to-be-summarized) messages to the thread's history file under
	 * `.orbit/history/` and return its workspace-relative path. Best-effort: returns the existing
	 * path (or undefined) on any failure so compaction still proceeds. */
	private async _appendCompactionHistory(threadId: string, messages: ChatMessage[], existingPath: string | undefined): Promise<string | undefined> {
		try {
			const folder = this._getFolderUrisForThread(threadId)[0]
			if (!folder) return existingPath
			const relPath = `.orbit/history/thread-${threadId}.md`
			const fileUri = URI.joinPath(folder, '.orbit', 'history', `thread-${threadId}.md`)
			const header = `\n\n---\n## Compacted ${new Date().toISOString()}\n\n`
			const body = this._transcriptForSummarization(messages)
			let prior = ''
			try {
				const existing = await this._fileService.readFile(fileUri)
				prior = existing.value.toString()
			} catch { /* file doesn't exist yet */ }
			await this._fileService.writeFile(fileUri, VSBuffer.fromString(prior + header + body))
			return relPath
		} catch (e) {
			console.error('[chatThreadService] Failed to write compaction history file:', getErrorMessage(e))
			return existingPath
		}
	}

	/** Persist compaction state onto the thread (or clear it). Mirrors the other per-thread setters. */
	private _setThreadCompaction(threadId: string, compaction: ThreadCompaction | undefined): void {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		let updated: ThreadType
		if (compaction === undefined) {
			if (thread.compaction === undefined) return
			const { compaction: _drop, ...rest } = thread
			updated = { ...rest }
		} else {
			updated = { ...thread, compaction }
		}
		const newThreads = { ...this.state.allThreads, [threadId]: updated }
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads })
	}

	private _clearSubAgentConversationsForThread(threadId: string): void {
		for (const [toolId, tid] of this._subAgentConversationThreadByToolId) {
			if (tid === threadId) {
				this._subAgentConversations.delete(toolId);
				this._subAgentConversationThreadByToolId.delete(toolId);
			}
		}
	}

	private _pruneSubAgentConversationsForThread(threadId: string): void {
		const thread = this.state.allThreads[threadId];
		const validToolIds = new Set<string>();
		if (thread) {
			for (const msg of thread.messages) {
				if (msg.role === 'tool' && msg.name === 'task') {
					validToolIds.add(msg.id);
				}
			}
		}
		for (const [toolId, tid] of this._subAgentConversationThreadByToolId) {
			if (tid === threadId && !validToolIds.has(toolId)) {
				this._subAgentConversations.delete(toolId);
				this._subAgentConversationThreadByToolId.delete(toolId);
			}
		}
	}

	private _clearToolProgressOverlay(threadId: string, toolId?: string) {
		const overlay = this._toolProgressOverlayByThread[threadId]
		if (!overlay) return
		if (toolId) {
			delete overlay[toolId]
			if (Object.keys(overlay).length === 0) {
				delete this._toolProgressOverlayByThread[threadId]
			}
		} else {
			delete this._toolProgressOverlayByThread[threadId]
		}
	}

	private _preserveStreamExtras(
		threadId: string,
		state: ThreadStreamState[string],
	): ThreadStreamState[string] {
		if (!state) return state
		if (state.isRunning === undefined && state.error) {
			return state
		}
		const prev = this.streamState[threadId]
		const overlay = this._toolProgressOverlayByThread[threadId]
		const mergedProgress = {
			...prev?.toolProgressById,
			...overlay,
			...state.toolProgressById,
		}
		if (Object.keys(mergedProgress).length === 0) {
			return state
		}
		return { ...state, toolProgressById: mergedProgress }
	}

	private _setSubAgentToolProgress(threadId: string, toolId: string, activity: string) {
		if (!this._toolProgressOverlayByThread[threadId]) {
			this._toolProgressOverlayByThread[threadId] = {}
		}
		this._toolProgressOverlayByThread[threadId][toolId] = activity

		const prev = this.streamState[threadId]
		if (prev) {
			const toolProgressById = {
				...prev.toolProgressById,
				...this._toolProgressOverlayByThread[threadId],
			}
			this._setStreamState(threadId, { ...prev, toolProgressById })
		} else {
			// UI-only update — do not synthesize isRunning: 'idle'
			this._onDidChangeStreamState.fire({ threadId })
		}
	}

	private _scheduleLlmStreamState(threadId: string, state: Extract<ThreadStreamStateItem, { isRunning: 'LLM' }>) {
		this._pendingLlmStreamStateByThread.set(threadId, state)
		let scheduler = this._llmStreamThrottleByThread.get(threadId)
		if (!scheduler) {
			scheduler = new RunOnceScheduler(() => {
				const pending = this._pendingLlmStreamStateByThread.get(threadId)
				if (pending) {
					this._setStreamState(threadId, pending)
				}
			}, 50)
			this._llmStreamThrottleByThread.set(threadId, scheduler)
			this._register(scheduler)
		}
		scheduler.schedule()
	}

	private _applyPendingLlmStreamStateIfAny(threadId: string) {
		const pending = this._pendingLlmStreamStateByThread.get(threadId)
		this._llmStreamThrottleByThread.get(threadId)?.cancel()
		this._pendingLlmStreamStateByThread.delete(threadId)
		if (!pending) {
			return
		}
		if (this.streamState[threadId]?.isRunning === 'LLM') {
			this.streamState[threadId] = this._preserveStreamExtras(threadId, pending)
			this._onDidChangeStreamState.fire({ threadId })
		}
	}

	private _flushLlmStreamState(threadId: string) {
		const pending = this._pendingLlmStreamStateByThread.get(threadId)
		this._llmStreamThrottleByThread.get(threadId)?.cancel()
		this._pendingLlmStreamStateByThread.delete(threadId)
		if (pending) {
			this._setStreamState(threadId, pending)
		}
	}

	private _clearLlmStreamThrottle(threadId: string) {
		const scheduler = this._llmStreamThrottleByThread.get(threadId)
		scheduler?.cancel()
		scheduler?.dispose()
		this._pendingLlmStreamStateByThread.delete(threadId)
		this._llmStreamThrottleByThread.delete(threadId)
	}

	override dispose(): void {
		this._storeDebounceScheduler?.cancel()
		this._flushStoreAllThreads()
		super.dispose()
	}


	// this should be the only place this.state = ... appears besides constructor
	private _setState(state: Partial<ThreadsState>, doNotRefreshMountInfo?: boolean) {
		const newState = {
			...this.state,
			...state
		}

		this.state = newState

		this._onDidChangeCurrentThread.fire()


		// if we just switched to a thread, update its current stream state if it's not streaming to possibly streaming
		const threadId = newState.currentThreadId
		const streamState = this.streamState[threadId]
		if (streamState?.isRunning === undefined && !streamState?.error) {

			// set streamState
			const messages = newState.allThreads[threadId]?.messages
			const lastMessage = messages && messages[messages.length - 1]
			// if awaiting user but stream state doesn't indicate it (happens if restart Void)
			if (lastMessage && lastMessage.role === 'tool' && lastMessage.type === 'tool_request')
				this._setStreamState(threadId, { isRunning: 'awaiting_user', pendingToolRequestId: lastMessage.id })

			// if running now but stream state doesn't indicate it (happens if restart Void), cancel that last tool
			if (lastMessage && lastMessage.role === 'tool' && lastMessage.type === 'running_now') {

				this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', content: lastMessage.content, id: lastMessage.id, rawParams: lastMessage.rawParams, result: null, name: lastMessage.name, params: lastMessage.params, mcpServerName: lastMessage.mcpServerName })
			}

		}


		// if we did not just set the state to true, set mount info
		if (doNotRefreshMountInfo) return

		let whenMountedResolver: (w: WhenMounted) => void
		const whenMountedPromise = new Promise<WhenMounted>((res) => whenMountedResolver = res)

		this._setThreadState(threadId, {
			mountedInfo: {
				whenMounted: whenMountedPromise,
				mountedIsResolvedRef: { current: false },
				_whenMountedResolver: (w: WhenMounted) => {
					whenMountedResolver(w)
					const mountInfo = this.state.allThreads[threadId]?.state.mountedInfo
					if (mountInfo) mountInfo.mountedIsResolvedRef.current = true
				},
			}
		}, true) // do not trigger an update



	}


	private _setStreamState(threadId: string, state: ThreadStreamState[string]) {
		if (!state || state.isRunning !== 'LLM') {
			if (this.streamState[threadId]?.isRunning === 'LLM') {
				this._applyPendingLlmStreamStateIfAny(threadId)
			} else {
				this._clearLlmStreamThrottle(threadId)
			}
		}
		if (!state) {
			this._clearToolProgressOverlay(threadId)
			this.streamState[threadId] = undefined
			this._onDidChangeStreamState.fire({ threadId })
			this._flushStoreIfNoThreadRunning()
			return
		}
		if (state.isRunning === undefined && state.error) {
			this._clearToolProgressOverlay(threadId)
		}
		this.streamState[threadId] = this._preserveStreamExtras(threadId, state)
		this._onDidChangeStreamState.fire({ threadId })
		if (state.isRunning === undefined) {
			this._flushStoreIfNoThreadRunning()
		}
	}

	private _flushStoreIfNoThreadRunning() {
		const anyThreadRunning = Object.values(this.streamState).some(s => s?.isRunning !== undefined)
		if (!anyThreadRunning && this._pendingThreadsToStore) {
			this._storeDebounceScheduler?.cancel()
			this._flushStoreAllThreads()
		}
	}

	private _nextTurnSequence(threadId: string): number {
		const next = (this._turnSequenceOfThread[threadId] ?? 0) + 1
		this._turnSequenceOfThread[threadId] = next
		return next
	}

	private _invalidateActiveTurn(threadId: string): number {
		const next = (this._turnSequenceOfThread[threadId] ?? 0) + 1
		this._turnSequenceOfThread[threadId] = next
		return next
	}

	private _isLatestTurn(threadId: string, turnSequence: number): boolean {
		return (this._turnSequenceOfThread[threadId] ?? 0) === turnSequence
	}

	private _registerPendingBackgroundTask(threadId: string, toolId: string, description: string): void {
		if (!this._pendingBackgroundTasks.has(threadId)) {
			this._pendingBackgroundTasks.set(threadId, new Map());
		}
		this._pendingBackgroundTasks.get(threadId)!.set(toolId, description);
	}

	private _forgetPendingBackgroundTask(threadId: string, toolId: string): void {
		const pending = this._pendingBackgroundTasks.get(threadId);
		if (!pending) return;
		pending.delete(toolId);
		if (pending.size === 0) {
			this._pendingBackgroundTasks.delete(threadId);
		}
	}

	private _pushCompletedBackgroundResult(threadId: string, result: { toolId: string; description: string; result: BuiltinToolResultType['task'] }): void {
		if (!this._completedBackgroundResults.has(threadId)) {
			this._completedBackgroundResults.set(threadId, []);
		}
		const completed = this._completedBackgroundResults.get(threadId)!;
		const existingIdx = completed.findIndex(item => item.toolId === result.toolId);
		if (existingIdx >= 0) {
			completed[existingIdx] = result;
		} else {
			completed.push(result);
		}
	}

	private _resumeParentAfterBackgroundCompletion(threadId: string): void {
		// Phase 1.10 (C10) fix: only resume when nothing else is in flight. The guards below
		// (no pending tasks, not already streaming, thread still exists) prevent double-resumption;
		// the fresh turnSequence taken just before dispatch (via _nextTurnSequence) then makes any
		// concurrently-started newer turn win the StaleTurnError race inside _runChatAgent.
		const completedResults = this._completedBackgroundResults.get(threadId);
		if (!completedResults || completedResults.length === 0) return;
		if (this._pendingBackgroundTasks.get(threadId)?.size) return;
		if (this.streamState[threadId]?.isRunning) return;
		if (!this.state.allThreads[threadId]) {
			this._completedBackgroundResults.delete(threadId);
			return;
		}

		this._completedBackgroundResults.delete(threadId);
		const resultSummaries = completedResults.map(r => {
			const status = r.result.status === 'completed' ? 'completed' : r.result.status;
			return `**${r.description}** (${r.result.agentType}, ${status}, ${r.result.toolUseCount} tools):\n${r.result.output}`;
		}).join('\n\n---\n\n');

		const anyFailed = completedResults.some(r => r.result.status === 'failed' || r.result.status === 'cancelled');
		const notificationMessage = completedResults.length === 1
			? `${anyFailed ? 'Background agent finished with issues' : 'Background agent completed'}.\n\n${resultSummaries}`
			: `${anyFailed ? `All ${completedResults.length} background agents finished; at least one had issues` : `All ${completedResults.length} background agents completed`}.\n\n${resultSummaries}`;

		const userHistoryElt: ChatMessage = {
			role: 'user',
			content: notificationMessage,
			displayContent: completedResults.length === 1
				? `${anyFailed ? 'Background agent issue' : 'Background agent done'}: ${completedResults[0].description}`
				: `${anyFailed ? 'Background agents finished with issues' : `All ${completedResults.length} background agents done`}`,
			selections: [],
			state: { stagingSelections: [], isBeingEdited: false },
		};
		this._addMessageToThread(threadId, userHistoryElt);
		const turnSequence = this._nextTurnSequence(threadId);
		this._wrapRunAgentToNotify(
			this._runChatAgent({ threadId, ...this._currentModelSelectionProps(), turnSequence }),
			threadId,
		);
	}


	// ---------- streaming ----------



	private _currentModelSelectionProps = () => {
		// these settings should not change throughout the loop (eg anthropic breaks if you change its thinking mode and it's using tools)
		const featureName: FeatureName = 'Chat'
		const modelSelection = this._settingsService.state.modelSelectionOfFeature[featureName]
		const modelSelectionOptions = modelSelection ? this._settingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName] : undefined
		return { modelSelection, modelSelectionOptions }
	}



	private _swapOutLatestStreamingToolWithResult = (threadId: string, tool: ChatMessage & { role: 'tool' }) => {
		const messages = this.state.allThreads[threadId]?.messages
		if (!messages) return false

		// Search backwards for a tool with matching ID (supports parallel execution). Match strictly
		// by id — a parallel batch may interleave image user-messages between sibling tool results,
		// so skip over non-tool messages within the batch rather than stopping at the first one. The
		// assistant message that opened the batch bounds the search.
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i]
			if (msg.role === 'tool' && msg.id === tool.id && msg.type !== 'invalid_params') {
				this._editMessageInThread(threadId, i, tool)
				return true
			}
			if (msg.role === 'assistant') break
		}
		return false
	}
	private _updateLatestTool = (threadId: string, tool: ChatMessage & { role: 'tool' }) => {
		const swapped = this._swapOutLatestStreamingToolWithResult(threadId, tool)
		if (swapped) return
		this._addMessageToThread(threadId, tool)
	}

	private _findPendingToolRequest(thread: ThreadType | undefined, toolId?: string): (ChatMessage & { role: 'tool', type: 'tool_request' }) | undefined {
		if (!thread) return undefined
		for (let i = thread.messages.length - 1; i >= 0; i--) {
			const msg = thread.messages[i]
			if (msg.role === 'tool' && msg.type === 'tool_request') {
				if (!toolId || msg.id === toolId) {
					return msg
				}
			}
		}
		return undefined
	}

	approveLatestToolRequest(threadId: string, toolId?: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		const callThisToolFirst = this._findPendingToolRequest(thread, toolId)
		if (!callThisToolFirst) return

		// AskQuestion must be completed via submitAskQuestionAnswer / skipAskQuestion, not approval
		if (callThisToolFirst.name === 'AskQuestion') {
			return
		}

		const turnSequence = this._nextTurnSequence(threadId)
		this._wrapRunAgentToNotify(
			this._runChatAgent({ callThisToolFirst, threadId, ...this._currentModelSelectionProps(), turnSequence })
			, threadId
		)
	}
	rejectLatestToolRequest(threadId: string, toolId?: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		const toolRequest = this._findPendingToolRequest(thread, toolId)
		if (!toolRequest) return

		const { name, id, rawParams, mcpServerName, params } = toolRequest

		const errorMessage = this.toolErrMsgs.rejected
		this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', params: params, name: name, content: errorMessage, result: null, id, rawParams, mcpServerName })
		this._setStreamState(threadId, undefined)
	}

	submitAskQuestionAnswer(threadId: string, toolId: string, answers: AskQuestionUserAnswer[]) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const target = this._findPendingToolRequest(thread, toolId)
		if (!target) {
			console.warn(`submitAskQuestionAnswer: no pending tool_request with id ${toolId} in thread ${threadId}`)
			return
		}
		if (target.name !== 'AskQuestion') {
			console.warn(`submitAskQuestionAnswer: tool id ${toolId} is not AskQuestion`)
			return
		}

		const params = target.params as BuiltinToolCallParams['AskQuestion']
		const normalized = params.questions.map((q) => {
			const a = answers.find((x) => x.questionId === q.id)
			return normalizeAnswer(q, a)
		})
		const result: BuiltinToolResultType['AskQuestion'] = { answers: normalized, wasSkipped: false }

		this._updateLatestTool(threadId, {
			role: 'tool',
			type: 'success',
			params,
			result,
			name: 'AskQuestion',
			content: formatAnswersForLLM(params.title, params.questions, normalized, false),
			id: toolId,
			rawParams: target.rawParams,
			mcpServerName: target.mcpServerName,
		})

		this._setStreamState(threadId, undefined)
		const turnSequence = this._nextTurnSequence(threadId)
		this._wrapRunAgentToNotify(
			this._runChatAgent({ threadId, ...this._currentModelSelectionProps(), turnSequence }),
			threadId,
		)
	}

	skipAskQuestion(threadId: string, toolId: string, opts?: { resumeAgent?: boolean }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const target = this._findPendingToolRequest(thread, toolId)
		if (!target || target.name !== 'AskQuestion') {
			return
		}

		const params = target.params as BuiltinToolCallParams['AskQuestion']
		const result: BuiltinToolResultType['AskQuestion'] = { answers: [], wasSkipped: true }

		this._updateLatestTool(threadId, {
			role: 'tool',
			type: 'success',
			params,
			result,
			name: 'AskQuestion',
			content: formatAnswersForLLM(params.title, params.questions, [], true),
			id: toolId,
			rawParams: target.rawParams,
			mcpServerName: target.mcpServerName,
		})

		this._setStreamState(threadId, undefined)

		if (opts?.resumeAgent !== false) {
			const turnSequence = this._nextTurnSequence(threadId)
			this._wrapRunAgentToNotify(
				this._runChatAgent({ threadId, ...this._currentModelSelectionProps(), turnSequence }),
				threadId,
			)
		}
	}

	private _computeMCPServerOfToolName = (threadId: string, toolName: string) => {
		// Check MCP tools first - if an MCP tool with this name exists, return its server name
		const mcpTool = this._mcpService.getMCPTools(this.state.allThreads[threadId]?.agentWorkspaceId)?.find(t => t.name === toolName)
		if (mcpTool) return mcpTool.mcpServerName
		// If no MCP tool found, it's either a builtin tool or an unknown tool - return undefined
		return undefined
	}

	async abortRunning(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen
		this._invalidateActiveTurn(threadId)
		// explicit stop cancels everything pending, including queued messages
		this._clearQueuedUserMessages(threadId)
		// A child that outlives a stopped parent can still mutate files or wake the parent loop when it
		// completes. Cancel both foreground and background descendants as part of the same stop action.
		this._subAgentService.cancelForegroundRunsForThread(threadId)
		this._subAgentService.cancelBackgroundRunsForThread(threadId)

		if (this._pendingLlmStreamStateByThread.has(threadId) || this.streamState[threadId]?.isRunning === 'LLM') {
			this._applyPendingLlmStreamStateIfAny(threadId)
		}

		// add assistant message
		if (this.streamState[threadId]?.isRunning === 'LLM') {
			const { displayContentSoFar, reasoningSoFar, toolCallSoFar, toolCallsSoFar } = this.streamState[threadId].llmInfo
			this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, anthropicReasoning: null })

			// Handle multiple interrupted tools
			if (toolCallsSoFar && toolCallsSoFar.length > 0) {
				for (const tc of toolCallsSoFar) {
					this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: tc.name, mcpServerName: this._computeMCPServerOfToolName(threadId, tc.name) })
				}
			}
			else if (toolCallSoFar) {
				this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(threadId, toolCallSoFar.name) })
			}
		}
		// add tool that's running
		else if (this.streamState[threadId]?.isRunning === 'tool') {
			const { toolName, toolParams, id, content: content_, rawParams, mcpServerName } = this.streamState[threadId].toolInfo
			const content = content_ || this.toolErrMsgs.interrupted
			this._updateLatestTool(threadId, { role: 'tool', name: toolName, params: toolParams, id, content, rawParams, type: 'rejected', result: null, mcpServerName })
		}
		// reject the tool(s) for the user if relevant. A parallel batch can leave more than one
		// tool awaiting approval, so resolve every pending tool_request — otherwise leftovers would
		// linger as placeholders and stall the next turn.
		else if (this.streamState[threadId]?.isRunning === 'awaiting_user') {
			const pendingRequests = thread.messages.filter((m): m is ToolMessage<ToolName> & { type: 'tool_request' } =>
				m.role === 'tool' && m.type === 'tool_request'
			)
			for (const pending of pendingRequests) {
				if (pending.name === 'AskQuestion') {
					this.skipAskQuestion(threadId, pending.id, { resumeAgent: false })
				} else {
					this.rejectLatestToolRequest(threadId, pending.id)
				}
			}
		}
		else if (this.streamState[threadId]?.isRunning === 'idle') {
			// do nothing
		}

		// A2/A3 defensive sweep: regardless of which branch ran above, ensure NO tool_request lingers.
		// A partially-approved parallel batch can leave pending requests even when the abort happened
		// while isRunning was 'tool' or 'LLM' (not 'awaiting_user'). A lingering tool_request placeholder
		// would stall the next turn. This is idempotent — if none remain, the loop is empty.
		// Deduplicate by tool id so the same request is never skipped/rejected twice in one sweep.
		const remainingRequests = (this.state.allThreads[threadId]?.messages ?? []).filter(
			(m): m is ToolMessage<ToolName> & { type: 'tool_request' } => m.role === 'tool' && m.type === 'tool_request'
		)
		const seen = new Set<string>()
		for (const pending of remainingRequests) {
			if (seen.has(pending.id)) continue
			seen.add(pending.id)
			if (pending.name === 'AskQuestion') {
				this.skipAskQuestion(threadId, pending.id, { resumeAgent: false })
			} else {
				this.rejectLatestToolRequest(threadId, pending.id)
			}
		}

		// interrupt any effects
		const interrupt = await this.streamState[threadId]?.interrupt
		if (typeof interrupt === 'function')
			interrupt()


		this._setStreamState(threadId, undefined)
	}

	cancelTaskTool(threadId: string, toolId: string): void {
		if (this._subAgentService.cancelBackgroundRun(toolId)) {
			this._clearToolProgressOverlay(threadId, toolId);
			return;
		}
		if (this._subAgentService.cancelForegroundRun(toolId)) {
			this._clearToolProgressOverlay(threadId, toolId);
			return;
		}
	}

	releaseRunningShellToBackground(threadId: string): void {
		const state = this.streamState[threadId];
		if (state?.isRunning !== 'tool') return;

		const { toolName, toolParams } = state.toolInfo;
		if (toolName !== 'Shell' && toolName !== 'AwaitShell') return;

		const shellId = toolName === 'Shell'
			? (toolParams as BuiltinToolCallParams['Shell']).shellId
			: (toolParams as BuiltinToolCallParams['AwaitShell']).shellId;

		this._terminalToolService.releaseShellWait(shellId ?? null);
		if (shellId) {
			void this._terminalToolService.focusShell(shellId);
		}
	}



	private readonly toolErrMsgs = {
		rejected: 'Tool call was rejected by the user.',
		interrupted: 'Tool call was interrupted by the user.',
		errWhenStringifying: (error: any) => `Tool call succeeded, but there was an error stringifying the output.\n${getErrorMessage(error)}`
	}


	// private readonly _currentlyRunningToolInterruptor: { [threadId: string]: (() => void) | undefined } = {}


	// returns true when the tool call is waiting for user approval
	private _runToolCall = async (
		threadId: string,
		toolName: ToolName,
		toolId: string,
		mcpServerName: string | undefined,
		opts:
			| {
				preapproved: true;
				unvalidatedToolParams: RawToolParamsObj;
				validatedParams: ToolCallParams<ToolName>;
				executionContext?: { modelSelection: ModelSelection | null; modelSelectionOptions: ModelSelectionOptions | undefined; turnSequence?: number };
				deferImageMessages?: boolean;
			}
			| {
				preapproved: false;
				unvalidatedToolParams: RawToolParamsObj;
				executionContext?: { modelSelection: ModelSelection | null; modelSelectionOptions: ModelSelectionOptions | undefined; turnSequence?: number };
				deferImageMessages?: boolean;
			},
	): Promise<{ awaitingUserApproval?: boolean, interrupted?: boolean, imageMessages?: ChatMessage[] }> => {

		// compute these below
		let toolParams: ToolCallParams<ToolName>
		let toolResult: ToolResult<ToolName>
		let toolResultStr: string

		// Check if an MCP tool with this name exists - if so, prioritize it over builtin tools
		const agentWorkspaceId = this.state.allThreads[threadId]?.agentWorkspaceId
		const mcpTools = this._mcpService.getMCPTools(agentWorkspaceId)
		const mcpTool = mcpTools?.find(t => t.name === toolName)

		// Only resolve as builtin tool if:
		// 1. No MCP tool with this name exists, AND
		// 2. No mcpServerName was explicitly provided (from previous resolution)
		const builtinToolName = mcpTool ? undefined : (resolveBuiltinToolName(toolName) ?? (!mcpServerName ? resolveBuiltinToolNameLoose(toolName) : undefined))
		const effectiveToolName = builtinToolName ?? toolName
		const isBuiltInTool = !!builtinToolName
		const effectiveMcpServerName = isBuiltInTool ? undefined : (mcpServerName ?? mcpTool?.mcpServerName)
		const attachEditToolSnapshot = () => {
			if (builtinToolName === 'StrReplace') {
				this._attachToolSnapshotToLatestCheckpoint({ threadId, uri: (toolParams as BuiltinToolCallParams['StrReplace']).path })
			}
			else if (builtinToolName === 'Write') {
				this._attachToolSnapshotToLatestCheckpoint({ threadId, uri: (toolParams as BuiltinToolCallParams['Write']).path })
			}
		}

		if (builtinToolName && isLLMHiddenBuiltinToolName(builtinToolName)) {
			const errorMessage = HIDDEN_TOOL_REPLACEMENT_MESSAGE(effectiveToolName)
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: {}, result: errorMessage, name: effectiveToolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName: undefined })
			return {}
		}

		if (!opts.preapproved) { // skip this if pre-approved
			// 1. validate tool params
			try {
				if (builtinToolName) {
					const params = this._toolsService.validateParams[builtinToolName](opts.unvalidatedToolParams)
					toolParams = params
				}
				else {
					toolParams = opts.unvalidatedToolParams
				}
			}
			catch (error) {
				const errorMessage = getErrorMessage(error)
				// Use _updateLatestTool (not _addMessageToThread) so that any existing
				// `running_now` placeholder for this tool id (e.g. added by the parallel
				// execution batch) is swapped in-place instead of duplicated. Two tool
				// messages with the same id would produce a duplicate `tool_call_id` in
				// the OpenAI payload and trigger a 400 error.
				this._updateLatestTool(threadId, { role: 'tool', type: 'invalid_params', rawParams: opts.unvalidatedToolParams, result: null, name: effectiveToolName, content: errorMessage, id: toolId, mcpServerName: effectiveMcpServerName })
				return {}
			}
			// once validated, record the snapshot for any mutating tool on the current checkpoint
			attachEditToolSnapshot()

			// AskQuestion always pauses for user input (no autoApprove)
			if (builtinToolName === 'AskQuestion') {
				this._updateLatestTool(threadId, {
					role: 'tool',
					type: 'tool_request',
					content: '(Awaiting user answer...)',
					result: null,
					name: effectiveToolName,
					params: toolParams,
					id: toolId,
					rawParams: opts.unvalidatedToolParams,
					mcpServerName: effectiveMcpServerName,
				})
				return { awaitingUserApproval: true }
			}

		// 1b. Workspace-confinement guard: any path tool (incl. Read/Grep/Glob, which have no
			// approval type) that targets a location outside the workspace or a credential-like path
			// requires explicit approval — even if auto-approve is on. Prevents silent exfiltration of
			// secrets (e.g. ~/.ssh/id_rsa) to the model.
			if (builtinToolName && !opts.preapproved) {
				const pathReason = getPathAccessApprovalReason(builtinToolName, toolParams, uri => this._isUriInsideThreadWorkspace(threadId, uri))
				if (pathReason) {
					this._updateLatestTool(threadId, { role: 'tool', type: 'tool_request', content: `(Awaiting user permission: ${pathReason})`, result: null, name: effectiveToolName, params: toolParams, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName: effectiveMcpServerName })
					return { awaitingUserApproval: true }
				}
			}

			// 2. if tool requires approval, break from the loop, awaiting approval
		const approvalType = builtinToolName ? approvalTypeOfBuiltinToolName[builtinToolName] : 'MCP tools'
		// The built-in browser MCP server (`orbit-ide-browser`) never prompts for
		// approval: opening and driving the integrated browser is a first-class product
		// action, and when no tab is open the server auto-opens one itself (see
		// orbitIdeBrowserMcpServer.callTool). Whether these tools exist at all is gated
		// by the Browser Automation master switch in Settings.
		const isOrbitBrowserTool = !builtinToolName && effectiveMcpServerName === 'orbit-ide-browser'
			if (approvalType && !isOrbitBrowserTool) {
				const autoApprove = this._settingsService.state.globalSettings.autoApprove[approvalType]
				const forceApproval = (builtinToolName === 'Shell'
					&& (toolParams as BuiltinToolCallParams['Shell']).requestSmartModeApproval === true)
				// Use _updateLatestTool (not _addMessageToThread) so that any existing
				// `running_now` placeholder for this tool id (added by the parallel
				// execution batch) is swapped in-place instead of duplicated. Two tool
				// messages with the same id would produce a duplicate `tool_call_id` in
				// the OpenAI payload and trigger a 400 error.
				this._updateLatestTool(threadId, { role: 'tool', type: 'tool_request', content: '(Awaiting user permission...)', result: null, name: effectiveToolName, params: toolParams, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName: effectiveMcpServerName })
				if (!autoApprove || forceApproval) {
					return { awaitingUserApproval: true }
				}
			}
		}
		else {
			toolParams = opts.validatedParams

			// preapproved path still needs to record the pre-edit snapshot
			attachEditToolSnapshot()

			if (builtinToolName === 'AskQuestion') {
				throw new Error('AskQuestion cannot run on the preapproved path — use submitAskQuestionAnswer or skipAskQuestion')
			}
		}






		// 3. call the tool
		// this._setStreamState(threadId, { isRunning: 'tool' }, 'merge')
		const runningTool = { role: 'tool', type: 'running_now', name: effectiveToolName, params: toolParams, content: '(value not received yet...)', result: null, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName: effectiveMcpServerName } as const
		this._updateLatestTool(threadId, runningTool)


		let interrupted = false
		let resolveInterruptor: (r: () => void) => void = () => { }
		const interruptorPromise = new Promise<() => void>(res => { resolveInterruptor = res })
		const isBackgroundTaskTool = builtinToolName === 'task' && (toolParams as BuiltinToolCallParams['task']).run_in_background === true
		try {

			// set stream state
			this._setStreamState(threadId, { isRunning: 'tool', interrupt: interruptorPromise, toolInfo: { toolName: effectiveToolName, toolParams, id: toolId, content: 'interrupted...', rawParams: opts.unvalidatedToolParams, mcpServerName: effectiveMcpServerName } })

			if (builtinToolName) {
				if (builtinToolName === 'task' && isBackgroundTaskTool) {
					this._registerPendingBackgroundTask(threadId, toolId, (toolParams as BuiltinToolCallParams['task']).description);
				}
				if (builtinToolName === 'Shell') {
					this._toolsService.currentShellThreadId = threadId;
				}
				// Tie workspace-folder resolution (Glob/Grep/CodebaseSearch/Shell cwd)
				// to THIS executing thread, not whichever thread the user is viewing.
				this._toolsService.currentToolThreadId = threadId;
				const toolParamsForCall = builtinToolName === 'task'
					? { ...(toolParams as BuiltinToolCallParams['task']), internalToolId: toolId, internalThreadId: threadId }
					: toolParams
				let result: ToolResult<ToolName> | Promise<ToolResult<ToolName>>
				let interruptTool: (() => void) | undefined
				try {
					const callResult = await this._toolsService.callTool[builtinToolName](toolParamsForCall as any)
					result = callResult.result
					interruptTool = callResult.interruptTool
				} finally {
					if (builtinToolName === 'Shell') {
						this._toolsService.currentShellThreadId = null;
					}
					this._toolsService.currentToolThreadId = null;
				}
				const interruptor = () => { interrupted = true; interruptTool?.() }
				resolveInterruptor(interruptor)
				toolResult = await result
			}
			else if (mcpTool) {
				// Use the MCP tool we found at the start.
				// Bridge cancellation: a user interrupt and the timeout both cancel the token, which the
				// MCP channel turns into an AbortSignal so the in-flight call is actually aborted.
				const mcpCts = new CancellationTokenSource()
				resolveInterruptor(() => { mcpCts.cancel() })

				const mcpTimeoutMs = this._settingsService.state.globalSettings.mcpToolTimeoutMs ?? 60_000
				const mcpTimer = setTimeout(() => mcpCts.cancel(), mcpTimeoutMs)
				try {
					toolResult = (await withTimeout(
						this._mcpService.callMCPTool({
							serverName: mcpTool.mcpServerName ?? 'unknown_mcp_server',
							toolName: effectiveToolName,
							params: toolParams
						}, mcpCts.token, agentWorkspaceId),
						mcpTimeoutMs,
						effectiveToolName,
					)).result
				} finally {
					clearTimeout(mcpTimer)
					mcpCts.dispose(true)
				}
			}
			else {
				// Tool is neither builtin nor MCP - this is an unknown tool
				// This should not happen if filtering is done correctly upstream, but handle gracefully
				console.error(`[chatThreadService] Unknown tool '${effectiveToolName}' reached _runToolCall. This should have been filtered out.`)
				const errorMessage = `Tool '${effectiveToolName}' is not available. Available tools include built-in tools (${llmVisibleBuiltinToolNames.join(', ')})${mcpTools && mcpTools.length > 0 ? ' and configured MCP tools' : ''}.`
				this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: effectiveToolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName: effectiveMcpServerName })
				return {}
			}

			if (interrupted) { return { interrupted: true } } // the tool result is added where we interrupt, not here

			// If the turn was aborted/superseded while this tool was in flight (e.g. an MCP
			// tool whose interruptor is a no-op), drop the late result instead of writing it back.
			const ts = opts.executionContext?.turnSequence
			if (ts !== undefined && !this._isLatestTurn(threadId, ts)) { return { interrupted: true } }
		}
		catch (error) {
			if (isBackgroundTaskTool) {
				this._forgetPendingBackgroundTask(threadId, toolId);
			}
			resolveInterruptor(() => { }) // resolve for the sake of it
			if (interrupted) { return { interrupted: true } } // the tool result is added where we interrupt, not here

			const errorMessage = getErrorMessage(error)
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: effectiveToolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName: effectiveMcpServerName })
			return {}
		} finally {
			// Background task progress-overlay entries are cleared by the onBackgroundComplete
			// handler once the sub-agent actually finishes (see constructor). Only the foreground
			// path needs cleanup here, since it's fully done by the time this finally block runs.
			if (builtinToolName === 'task' && !isBackgroundTaskTool) {
				this._clearToolProgressOverlay(threadId, toolId);
			}
		}

		// 4. stringify the result to give to the LLM
		try {
			if (builtinToolName) {
				toolResultStr = this._toolsService.stringOfResult[builtinToolName](toolParams as any, toolResult as any)
			}
			// For MCP tools, handle the result based on its type
			else {
				toolResultStr = this._mcpService.stringifyResult(toolResult as RawMCPToolCall)
			}
		} catch (error) {
			const errorMessage = this.toolErrMsgs.errWhenStringifying(error)
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: effectiveToolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName: effectiveMcpServerName })
			return {}
		}

		// 5. add to history and keep going
		this._updateLatestTool(threadId, { role: 'tool', type: 'success', params: toolParams, result: toolResult, name: effectiveToolName, content: toolResultStr, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName: effectiveMcpServerName })

		// Vision models: deliver image bytes as a user multimodal message (after the tool result).
		// During a parallel batch these are buffered (deferImageMessages) and appended by the caller
		// only after the whole batch settles, so they can't interleave between sibling tool results
		// (which would split the tool block and leave placeholders un-swapped).
		const imageUserMessages: ChatMessage[] = []
		if (builtinToolName === 'Read' && toolResult && typeof toolResult === 'object' && 'kind' in toolResult && (toolResult as BuiltinToolResultType['Read']).kind === 'image') {
			const imageResult = toolResult as Extract<BuiltinToolResultType['Read'], { kind: 'image' }>
			const readParams = toolParams as BuiltinToolCallParams['Read']
			const dataUri = `data:${imageResult.mime};base64,${imageResult.base64}`
			imageUserMessages.push({
				role: 'user',
				content: '',
				displayContent: `(Image: ${readParams.uri.fsPath})`,
				selections: [],
				images: [dataUri],
				state: { stagingSelections: [], isBeingEdited: false },
			})
		}

		// Vision models: deliver MCP image results (e.g. browser_take_screenshot) the same
		// way. Without this, stringifyResult collapses images to `[Image: image/png]` and
		// the model never receives pixels — breaking the advertised screenshot workflow.
		if (!builtinToolName && toolResult && typeof toolResult === 'object' && (toolResult as RawMCPToolCall).event === 'image') {
			const mcpImage = toolResult as Extract<RawMCPToolCall, { event: 'image' }>
			if (mcpImage.image?.data) {
				const mime = mcpImage.image.mimeType || 'image/png'
				const dataUri = `data:${mime};base64,${mcpImage.image.data}`
				imageUserMessages.push({
					role: 'user',
					content: mcpImage.text?.trim() ? mcpImage.text : '',
					displayContent: `(Image: ${effectiveToolName})`,
					selections: [],
					images: [dataUri],
					state: { stagingSelections: [], isBeingEdited: false },
				})
			}
		}
		if (imageUserMessages.length > 0 && !opts.deferImageMessages) {
			for (const msg of imageUserMessages) this._addMessageToThread(threadId, msg)
		}

		if (isBackgroundTaskTool && (toolResult as any)?.status !== 'background_launched') {
			this._forgetPendingBackgroundTask(threadId, toolId);
			}

			// Special handling for TodoWrite tool
			if (effectiveToolName === 'TodoWrite') {
				const thread = this.state.allThreads[threadId];
				if (thread) {
					const { todos, merge } = toolParams as BuiltinToolCallParams['TodoWrite'];
					const finalTodoList = applyTodoWrite(thread.todoList ?? [], todos, merge);

					const newThreads = {
						...this.state.allThreads,
						[threadId]: {
							...thread,
							todoList: finalTodoList,
							lastModified: new Date().toISOString(),
						}
					};

				this._storeAllThreads(newThreads);
				this._setState({ allThreads: newThreads });
			}
		}

		return opts.deferImageMessages && imageUserMessages.length > 0 ? { imageMessages: imageUserMessages } : {}
	};




	private async _runChatAgent({
		threadId,
		modelSelection,
		modelSelectionOptions,
		callThisToolFirst,
		additionalSystemContext,
		turnSequence,
	}: {
		threadId: string,
		modelSelection: ModelSelection | null,
		modelSelectionOptions: ModelSelectionOptions | undefined,

		callThisToolFirst?: ToolMessage<ToolName> & { type: 'tool_request' }
		additionalSystemContext?: string;
		turnSequence?: number;
	}) {

		if (turnSequence !== undefined && !this._isLatestTurn(threadId, turnSequence)) {
			throw new StaleTurnError(`Turn ${turnSequence} is no longer the latest turn for thread ${threadId}`)
		}

		let interruptedWhenIdle = false
		const idleInterruptor = Promise.resolve(() => { interruptedWhenIdle = true })
		// _runToolCall does not need setStreamState({idle}) before it, but it needs it after it. (handles its own setStreamState)

		// above just defines helpers, below starts the actual function
		const { chatMode } = this._settingsService.state.globalSettings // should not change as we loop even if user changes it, so it goes here
		const { overridesOfModel } = this._settingsService.state
		const parentToolPolicy = undefined

		let nMessagesSent = 0
		let shouldSendAnotherMessage = true
		let isRunningWhenEnd: IsRunningType = undefined
		let pendingToolRequestId: string | undefined

		// before enter loop, call tool
		if (callThisToolFirst) {
			const { interrupted } = await this._runToolCall(threadId, callThisToolFirst.name, callThisToolFirst.id, callThisToolFirst.mcpServerName, {
				preapproved: true,
				unvalidatedToolParams: callThisToolFirst.rawParams,
				validatedParams: callThisToolFirst.params,
				executionContext: { modelSelection, modelSelectionOptions, turnSequence },
			})
			if (interrupted) {
				this._setStreamState(threadId, undefined)
			}
		}
		this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' })  // just decorative, for clarity


		// tool use loop
		while (shouldSendAnotherMessage) {
			if (turnSequence !== undefined && !this._isLatestTurn(threadId, turnSequence)) {
				throw new StaleTurnError(`Turn ${turnSequence} is no longer the latest turn for thread ${threadId}`)
			}
			// false by default each iteration
			shouldSendAnotherMessage = false
			isRunningWhenEnd = undefined
			pendingToolRequestId = undefined

			// Serialize multi-tool approval: a prior (parallel) batch may have left more than one
			// approval-gated tool awaiting the user. Each approval resumes the loop here; pause again
			// on the earliest still-pending request instead of sending a premature LLM message with
			// unresolved tool_requests (which would be forwarded as placeholder text). Bounded to the
			// current tool batch — walk back to the assistant message that opened it, skipping any
			// interleaved image user-messages.
			{
				const msgs = this.state.allThreads[threadId]?.messages ?? []
				let earliestPendingId: string | undefined
				for (let i = msgs.length - 1; i >= 0; i--) {
					const msg = msgs[i]
					if (msg.role === 'assistant') break
					if (msg.role === 'tool' && msg.type === 'tool_request') earliestPendingId = msg.id
				}
				if (earliestPendingId) {
					isRunningWhenEnd = 'awaiting_user'
					pendingToolRequestId = earliestPendingId
					break
				}
			}

			// Stop a runaway agent: once the loop has sent this many turns, end gracefully with a
			// notice instead of looping forever.
			if (nMessagesSent >= MAX_AGENT_LOOP_ITERATIONS) {
				this._addMessageToThread(threadId, { role: 'assistant', displayContent: `Reached the maximum number of tool-use iterations (${MAX_AGENT_LOOP_ITERATIONS}). Send a message to continue.`, reasoning: '', anthropicReasoning: null })
				break
			}

			nMessagesSent += 1

			this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })

			const allThreadMessages = this.state.allThreads[threadId]?.messages ?? []
			// Cursor-style compaction: if the prompt is nearing the context window, summarize older
			// turns first, then send [task + summary + recent turns] instead of the full transcript.
			await this._maybeCompactThread(threadId, modelSelection, allThreadMessages)
			const chatMessages = this._buildCompactedChatMessages(threadId, this.state.allThreads[threadId]?.messages ?? allThreadMessages)
			const workspaceFolderPaths = this._getFolderUrisForThread(threadId).map(u => u.fsPath)
			const agentWorkspaceId = this.state.allThreads[threadId]?.agentWorkspaceId
			const { messages, separateSystemMessage } = await this._convertToLLMMessagesService.prepareLLMChatMessages({
				chatMessages,
				modelSelection,
				chatMode,
				toolPolicy: parentToolPolicy,
				workspaceFolderPaths,
				threadId,
				agentWorkspaceId,
			})
			const finalSystemMessage = [separateSystemMessage, additionalSystemContext].filter(Boolean).join('\n\n') || undefined

			if (interruptedWhenIdle) {
				this._setStreamState(threadId, undefined)
				return
			}

			let shouldRetryLLM = true
			let nAttempts = 0
			while (shouldRetryLLM) {
				shouldRetryLLM = false
				nAttempts += 1

				type ResTypes =
					| { type: 'llmDone', toolCall?: RawToolCallObj, toolCalls?: RawToolCallObj[], info: { fullText: string, fullReasoning: string, anthropicReasoning: AnthropicReasoning[] | null }, usage?: LLMUsage }
					| { type: 'llmError', error?: { message: string; fullError: Error | null; } }
					| { type: 'llmAborted' }

				let resMessageIsDonePromise: (res: ResTypes) => void // resolves when user approves this tool use (or if tool doesn't require approval)
				const messageIsDonePromise = new Promise<ResTypes>((res, rej) => { resMessageIsDonePromise = res })

				const mcpTools = this._mcpService.getMCPTools(agentWorkspaceId)
				const mcpToolNames = new Set<string>((mcpTools ?? []).map(tool => tool.name))
				const llmCancelToken = this._llmMessageService.sendLLMMessage({
					messagesType: 'chatMessages',
					chatMode,
					messages: messages,
					modelSelection,
					modelSelectionOptions,
					overridesOfModel,
					toolPolicy: parentToolPolicy,
					mcpToolsOverride: mcpTools,
					logging: { loggingName: `Chat - ${chatMode}`, loggingExtras: { threadId, nMessagesSent, chatMode } },
					separateSystemMessage: finalSystemMessage,
					onText: ({ fullText, fullReasoning, toolCall, toolCalls }) => {
						const normalizedToolCall = toolCall ? normalizeRawToolCallName(toolCall, mcpToolNames) : undefined
						const normalizedToolCalls = normalizeRawToolCalls(toolCalls, mcpToolNames)
						this._scheduleLlmStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: fullText, reasoningSoFar: fullReasoning, toolCallSoFar: normalizedToolCall ?? null, toolCallsSoFar: normalizedToolCalls ?? null }, interrupt: Promise.resolve(() => { if (llmCancelToken) this._llmMessageService.abort(llmCancelToken) }) })

						// NOTE: Removed the streaming placeholder tool logic that was here previously.
						// It was adding "Reading file" placeholders during streaming that would stick around.
						// These are now added only when tools are actually about to execute (see lines ~950-973)
					},
					onFinalMessage: async ({ fullText, fullReasoning, toolCall, toolCalls, anthropicReasoning, usage }) => {
						resMessageIsDonePromise({ type: 'llmDone', toolCall, toolCalls, info: { fullText, fullReasoning, anthropicReasoning }, usage }) // resolve with tool calls
					},
					onError: async (error) => {
						resMessageIsDonePromise({ type: 'llmError', error: error })
					},
					onAbort: () => {
						// stop the loop to free up the promise, but don't modify state (already handled by whatever stopped it)
						resMessageIsDonePromise({ type: 'llmAborted' })
						this._metricsService.capture('Agent Loop Done (Aborted)', { nMessagesSent, chatMode })
					},
				})

				// mark as streaming
				if (!llmCancelToken) {
					// Hard failure to even start the send — return so we don't fall through to the
					// "task complete" sound/notification on what is actually an error.
					this._setStreamState(threadId, { isRunning: undefined, error: { message: 'There was an unexpected error when sending your chat message.', fullError: null } })
					this._pauseQueue(threadId) // Q2: keep any queued messages; don't drain into a broken turn
					return
				}

				this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: '', reasoningSoFar: '', toolCallSoFar: null, toolCallsSoFar: null }, interrupt: Promise.resolve(() => this._llmMessageService.abort(llmCancelToken)) })
				const llmRes = await messageIsDonePromise // wait for message to complete
				this._flushLlmStreamState(threadId)

				// if something else started running in the meantime
				if (this.streamState[threadId]?.isRunning !== 'LLM') {
					// console.log('Chat thread interrupted by a newer chat thread', this.streamState[threadId]?.isRunning)
					return
				}

				// llm res aborted
				if (llmRes.type === 'llmAborted') {
					this._setStreamState(threadId, undefined)
					return
				}
				// llm res error
				else if (llmRes.type === 'llmError') {
					// error, should retry
					if (nAttempts < CHAT_RETRIES && this._isRetryableLLMError(llmRes.error)) {
						shouldRetryLLM = true
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
						// Exponential backoff, honoring a provider-supplied Retry-After when present.
						await timeout(this._retryAfterMsFromError(llmRes.error) ?? RETRY_DELAY * Math.pow(2, nAttempts - 1))
						if (interruptedWhenIdle) {
							this._setStreamState(threadId, undefined)
							return
						}
						else
							continue // retry
					}
					// error, but too many attempts
					else {
						const { error } = llmRes
						const { displayContentSoFar, reasoningSoFar, toolCallSoFar, toolCallsSoFar } = this.streamState[threadId].llmInfo
						this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, anthropicReasoning: null })

						if (toolCallsSoFar && toolCallsSoFar.length > 0) {
							for (const tc of toolCallsSoFar) {
								this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: tc.name, mcpServerName: this._computeMCPServerOfToolName(threadId, tc.name) })
							}
						}
						else if (toolCallSoFar) {
							this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(threadId, toolCallSoFar.name) })
						}

						this._setStreamState(threadId, { isRunning: undefined, error })
						this._pauseQueue(threadId) // Q2: keep any queued messages; don't drain into a broken turn
						return
					}
				}

				// llm res success
				const { toolCall, toolCalls, info, usage } = llmRes

					// Record real provider-reported token usage for this turn (context-window mgmt + UI).
					this._recordThreadUsage(threadId, usage)

				this._addMessageToThread(threadId, { role: 'assistant', displayContent: info.fullText, reasoning: info.fullReasoning, anthropicReasoning: info.anthropicReasoning })

				this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' }) // just decorative for clarity

				// reuse MCP tool list from this attempt to avoid re-querying
				const normalizedToolCall = toolCall ? normalizeRawToolCallName(toolCall, mcpToolNames) : undefined
				const normalizedToolCalls = normalizeRawToolCalls(toolCalls, mcpToolNames)

				// Process multiple tool calls if present, otherwise fall back to single toolCall
				const toolsToExecuteRaw = normalizedToolCalls && normalizedToolCalls.length > 0 ? normalizedToolCalls : (normalizedToolCall ? [normalizedToolCall] : [])

				// Filter out tools with empty names and handle unknown tools
				const validTools: RawToolCallObj[] = []
				const unknownTools: RawToolCallObj[] = []
				const hiddenBuiltinTools: RawToolCallObj[] = []
				for (const tool of toolsToExecuteRaw) {
					if (!tool.name || tool.name.trim() === '') {
						// Skip tools with empty names - log for debugging
						console.warn('[chatThreadService] Skipping tool call with empty name:', tool)
						continue
					}
					const isBuiltin = isABuiltinToolName(tool.name)
					const isMCP = mcpTools?.some(t => t.name === tool.name) ?? false
					if (isBuiltin && !isMCP && isLLMHiddenBuiltinToolName(tool.name)) {
						hiddenBuiltinTools.push(tool)
						continue
					}
					if (isBuiltin || isMCP) {
						validTools.push(tool)
					} else {
						unknownTools.push(tool)
					}
				}

				// Record unknown tools as errors in the chat (but don't crash)
				for (const unknownTool of unknownTools) {
					console.warn(`[chatThreadService] Unknown tool '${unknownTool.name}' - recording as error`)
					this._addMessageToThread(threadId, {
						role: 'tool',
						type: 'tool_error',
						name: unknownTool.name,
						params: {},
						result: `Tool '${unknownTool.name}' is not available. Available tools include built-in tools (${llmVisibleBuiltinToolNames.join(', ')})${mcpTools && mcpTools.length > 0 ? ' and configured MCP tools' : ''}.`,
						content: `Tool '${unknownTool.name}' is not available.`,
						id: unknownTool.id,
						rawParams: unknownTool.rawParams,
						mcpServerName: undefined
					})
				}
			for (const hiddenTool of hiddenBuiltinTools) {
				const errorMessage = HIDDEN_TOOL_REPLACEMENT_MESSAGE(hiddenTool.name)
					console.warn(`[chatThreadService] Hidden builtin tool '${hiddenTool.name}' requested - recording as error`)
					this._addMessageToThread(threadId, {
						role: 'tool',
						type: 'tool_error',
						name: hiddenTool.name,
						params: {},
						result: errorMessage,
						content: errorMessage,
						id: hiddenTool.id,
						rawParams: hiddenTool.rawParams,
						mcpServerName: undefined
					})
				}

				const toolsToExecute = validTools

				if (toolsToExecute.length > 0) {
					const thread = this.state.allThreads[threadId]
					const existingToolIds = new Set<string>(thread?.messages
						?.filter(m => m.role === 'tool')
						.map(m => m.id) ?? [])

					const mcpToolByName = new Map<string, InternalToolInfo>()
					for (const t of mcpTools ?? []) {
						mcpToolByName.set(t.name, t)
					}
					const isMCPToolReadOnly = (toolName: string): boolean => {
						const annotations = mcpToolByName.get(toolName)?.annotations as Record<string, unknown> | undefined
						if (!annotations) return false
						const readOnly =
							(annotations.readOnly as boolean | undefined)
							?? (annotations.readonly as boolean | undefined)
							?? (annotations.read_only as boolean | undefined)
						return readOnly === true
					}
					const isReadOnlyTaskTool = (tool: RawToolCallObj): boolean => {
						const builtinName = resolveBuiltinToolNameLoose(tool.name)
						if (builtinName !== 'task') return false
						const agentType = typeof tool.rawParams.subagent_type === 'string' ? tool.rawParams.subagent_type.trim() : ''
						if (!agentType) return false
						return getSubAgent(agentType)?.permissionMode === 'read_only'
					}

					// Group tools by whether they can be parallelized
					// A tool is read-only if:
					// 1. It's a builtin read-only tool (Read, Glob, etc.), OR
					// 2. It's an MCP tool explicitly annotated as read-only
					// 3. It's a read-only sub-agent task. This matches Claude Code's guidance that
					//    independent research agents should be launched in one parallel batch.
					const parallelTools = toolsToExecute.filter(tool => {
						const isBuiltinReadOnly = isABuiltinToolName(tool.name) && readOnlyToolNames.includes(tool.name)
						return isBuiltinReadOnly || isMCPToolReadOnly(tool.name) || isReadOnlyTaskTool(tool)
					})
					const mutatingTools = toolsToExecute.filter(tool => {
						const isBuiltinReadOnly = isABuiltinToolName(tool.name) && readOnlyToolNames.includes(tool.name)
						return !isBuiltinReadOnly && !isMCPToolReadOnly(tool.name) && !isReadOnlyTaskTool(tool)
					})

					// Execute read/search/sub-agent research tools in parallel
					if (parallelTools.length > 0) {
						// 🚀 PRE-ADD all tool placeholders to UI IMMEDIATELY for instant visual feedback
						// These placeholders show "Reading file" etc. while tools execute, then get replaced with results
						// Batch all additions into a single state update for better performance
						const placeholderTools: ChatMessage[] = []
						for (const tool of parallelTools) {
							// Check if it's an MCP tool first (by name match), then fall back to builtin
							const mcpTool = mcpToolByName.get(tool.name)
							if (existingToolIds.has(tool.id)) continue
							placeholderTools.push({
								role: 'tool' as const,
								type: 'running_now' as const,
								name: tool.name,
								params: {}, // Will be validated during actual execution
								content: '(Loading...)',
								result: null,
								id: tool.id,
								rawParams: tool.rawParams,
								mcpServerName: mcpTool?.mcpServerName
							})
							existingToolIds.add(tool.id)
						}
						// Add all placeholders in a single batch update (only if there are new ones to add)
						if (placeholderTools.length > 0) {
							this._addMessagesToThreadBatch(threadId, placeholderTools)
						}

						// Execute all tools in parallel. Buffer any vision image-messages so they're
						// appended once, after the whole batch settles (see below).
						const results = await mapWithConcurrency(parallelTools, MAX_PARALLEL_TOOL_CALLS, async (tool) => {
							// Check if it's an MCP tool first (by name match), then fall back to builtin
							const mcpTool = mcpToolByName.get(tool.name)
							return this._runToolCall(threadId, tool.name, tool.id, mcpTool?.mcpServerName, {
								preapproved: false,
								unvalidatedToolParams: tool.rawParams,
								executionContext: { modelSelection, modelSelectionOptions, turnSequence },
								deferImageMessages: true,
							})
						})

						// Check if any tool was interrupted or awaiting approval
						for (let idx = 0; idx < results.length; idx++) {
							const result = results[idx]
							if (result.interrupted) {
								this._setStreamState(threadId, undefined)
								return
							}
							if (result.awaitingUserApproval) {
								isRunningWhenEnd = 'awaiting_user'
								if (!pendingToolRequestId) pendingToolRequestId = parallelTools[idx]?.id
							}
						}

						// Append buffered vision image-messages after the batch settled, so they land
						// after every tool result instead of interleaving between sibling tools.
						const bufferedImageMessages = results.flatMap(r => r.imageMessages ?? [])
						if (bufferedImageMessages.length > 0) {
							this._addMessagesToThreadBatch(threadId, bufferedImageMessages)
						}
					}

					// Execute mutating/terminal tools sequentially (one at a time)
					if (isRunningWhenEnd !== 'awaiting_user') {
						for (const tool of mutatingTools) {
							// Check if it's an MCP tool first (by name match), then fall back to builtin
							const mcpTool = mcpToolByName.get(tool.name)
							const { awaitingUserApproval, interrupted } = await this._runToolCall(
								threadId,
								tool.name,
								tool.id,
								mcpTool?.mcpServerName,
								{
									preapproved: false,
									unvalidatedToolParams: tool.rawParams,
									executionContext: { modelSelection, modelSelectionOptions, turnSequence },
								}
							)
							if (interrupted) {
								this._setStreamState(threadId, undefined)
								return
							}
							if (awaitingUserApproval) {
								isRunningWhenEnd = 'awaiting_user'
								pendingToolRequestId = tool.id
								break
							}
						}
					}

					// If no tools are awaiting approval, send another message
					if (isRunningWhenEnd !== 'awaiting_user') {
						shouldSendAnotherMessage = true
					}

					if (isRunningWhenEnd !== 'awaiting_user') {
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' }) // just decorative, for clarity
					}
				} else if (unknownTools.length > 0 || hiddenBuiltinTools.length > 0) {
					// All tools were unknown - still need to send another message so LLM knows about the errors
					shouldSendAnotherMessage = true
				}

			} // end while (attempts)
		} // end while (send message)

		// if awaiting user approval, keep isRunning true, else end isRunning
		if (isRunningWhenEnd === 'awaiting_user') {
			this._setStreamState(threadId, { isRunning: 'awaiting_user', pendingToolRequestId })
		} else {
			this._setStreamState(threadId, { isRunning: isRunningWhenEnd })
			this._resumeParentAfterBackgroundCompletion(threadId)
		}

		// capture number of messages sent
		this._metricsService.capture('Agent Loop Done', { nMessagesSent, chatMode })

		// Only signal "completed" on a true terminal end — NOT when the loop paused to wait for
		// the user to approve a tool. Otherwise we'd tell the user the task finished while it's
		// actually blocked on their input.
		if (isRunningWhenEnd !== 'awaiting_user') {
			// Drain the next queued user message, if any — the turn isn't really "done" then,
			// so skip the completion sound/notification.
			if (this._drainNextQueuedUserMessage(threadId)) return

			// Play completion sound if enabled (fire and forget)
			this._playAgentCompletionSound();

			// Show completion notification if enabled
			this._showAgentCompletionNotification();
		}
	}


	private _addCheckpoint(threadId: string, checkpoint: CheckpointEntry) {
		this._addMessageToThread(threadId, checkpoint)
		// // update latest checkpoint idx to the one we just added
		// const newThread = this.state.allThreads[threadId]
		// if (!newThread) return // should never happen
		// const currCheckpointIdx = newThread.messages.length - 1
		// this._setThreadState(threadId, { currCheckpointIdx: currCheckpointIdx })
	}



	private _editMessageInThread(threadId: string, messageIdx: number, newMessage: ChatMessage,) {
		const { allThreads } = this.state
		const oldThread = allThreads[threadId]
		if (!oldThread) return // should never happen
		// update state and store it
		const newThreads = {
			...allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages: [
					...oldThread.messages.slice(0, messageIdx),
					newMessage,
					...oldThread.messages.slice(messageIdx + 1, Infinity),
				],
			}
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads }) // the current thread just changed (it had a message added to it)
	}


	private _getCheckpointInfo = (checkpointMessage: ChatMessage & { role: 'checkpoint' }, fsPath: string, opts: { includeUserModifiedChanges: boolean }) => {
		const voidFileSnapshot = checkpointMessage.voidFileSnapshotOfURI ? checkpointMessage.voidFileSnapshotOfURI[fsPath] ?? null : null
		if (!opts.includeUserModifiedChanges) { return { voidFileSnapshot, } }

		const userModifiedVoidFileSnapshot = fsPath in checkpointMessage.userModifications.voidFileSnapshotOfURI ? checkpointMessage.userModifications.voidFileSnapshotOfURI[fsPath] ?? null : null
		return { voidFileSnapshot: userModifiedVoidFileSnapshot ?? voidFileSnapshot, }
	}

	private _computeNewCheckpointInfo({ threadId }: { threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const lastCheckpointIdx = findLastIdx(thread.messages, (m) => m.role === 'checkpoint') ?? -1
		if (lastCheckpointIdx === -1) return

		const voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot | undefined } = {}

		// add a change for all the URIs in the checkpoint history
		const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: 0, hiIdx: lastCheckpointIdx, }) ?? {}
		for (const fsPath in lastIdxOfURI ?? {}) {
			const { model } = this._voidModelService.getModelFromFsPath(fsPath)
			if (!model) continue
			const checkpoint2 = thread.messages[lastIdxOfURI[fsPath]] || null
			if (!checkpoint2) continue
			if (checkpoint2.role !== 'checkpoint') continue
			const res = this._getCheckpointInfo(checkpoint2, fsPath, { includeUserModifiedChanges: false })
			if (!res) continue
			const { voidFileSnapshot: oldVoidFileSnapshot } = res

			// if there was any change to the str or diffAreaSnapshot, update. rough approximation of equality, oldDiffAreasSnapshot === diffAreasSnapshot is not perfect
			const voidFileSnapshot = this._editCodeService.getVoidFileSnapshot(URI.file(fsPath))
			if (oldVoidFileSnapshot === voidFileSnapshot) continue
			voidFileSnapshotOfURI[fsPath] = voidFileSnapshot
		}

		// // add a change for all user-edited files (that aren't in the history)
		// for (const fsPath of this._userModifiedFilesToCheckInCheckpoints.keys()) {
		// 	if (fsPath in lastIdxOfURI) continue // if already visisted, don't visit again
		// 	const { model } = this._voidModelService.getModelFromFsPath(fsPath)
		// 	if (!model) continue
		// 	currStrOfFsPath[fsPath] = model.getValue(EndOfLinePreference.LF)
		// }

		return { voidFileSnapshotOfURI }
	}


	private _addUserCheckpoint({ threadId }: { threadId: string }) {
		const { voidFileSnapshotOfURI } = this._computeNewCheckpointInfo({ threadId }) ?? {}
		this._addCheckpoint(threadId, {
			role: 'checkpoint',
			type: 'user_edit',
			voidFileSnapshotOfURI: voidFileSnapshotOfURI ?? {},
			userModifications: { voidFileSnapshotOfURI: {}, },
		})
	}
	private _getLatestCheckpointIdx(threadId: string): number | null {
		const thread = this.state.allThreads[threadId]
		if (!thread) return null
		const idx = findLastIdx(thread.messages, (m) => m.role === 'checkpoint')
		return idx === undefined ? null : idx
	}

	private _attachToolSnapshotToLatestCheckpoint({ threadId, uri }: { threadId: string, uri: URI }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const lastCheckpointIdx = this._getLatestCheckpointIdx(threadId)
		if (lastCheckpointIdx === null) return

		const checkpoint = thread.messages[lastCheckpointIdx]
		if (!checkpoint || checkpoint.role !== 'checkpoint') return

		// if we already recorded a snapshot for this file on this checkpoint, keep the earliest one
		if (checkpoint.voidFileSnapshotOfURI[uri.fsPath] !== undefined) return

		const snapshot = this._editCodeService.getVoidFileSnapshot(uri)
		const updatedCheckpoint: CheckpointEntry = {
			...checkpoint,
			voidFileSnapshotOfURI: {
				...checkpoint.voidFileSnapshotOfURI,
				[uri.fsPath]: snapshot,
			},
		}
		this._editMessageInThread(threadId, lastCheckpointIdx, updatedCheckpoint)
	}


	private _getCheckpointBeforeMessage = ({ threadId, messageIdx }: { threadId: string, messageIdx: number }): [CheckpointEntry, number] | undefined => {
		const thread = this.state.allThreads[threadId]
		if (!thread) return undefined
		for (let i = messageIdx; i >= 0; i--) {
			const message = thread.messages[i]
			if (message.role === 'checkpoint') {
				return [message, i]
			}
		}
		return undefined
	}

	private _getCheckpointsBetween({ threadId, loIdx, hiIdx }: { threadId: string, loIdx: number, hiIdx: number }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return { lastIdxOfURI: {} } // should never happen
		const lastIdxOfURI: { [fsPath: string]: number } = {}
		for (let i = loIdx; i <= hiIdx; i += 1) {
			const message = thread.messages[i]
			if (message?.role !== 'checkpoint') continue
			for (const fsPath in message.voidFileSnapshotOfURI) { // do not include userModified.beforeStrOfURI here, jumping should not include those changes
				lastIdxOfURI[fsPath] = i
			}
		}
		return { lastIdxOfURI }
	}

	private _readCurrentCheckpoint(threadId: string): [CheckpointEntry, number] | undefined {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const { currCheckpointIdx } = thread.state
		if (currCheckpointIdx === null) return

		const checkpoint = thread.messages[currCheckpointIdx]
		if (!checkpoint) return
		if (checkpoint.role !== 'checkpoint') return
		return [checkpoint, currCheckpointIdx]
	}
	private _addUserModificationsToCurrCheckpoint({ threadId }: { threadId: string }) {
		const { voidFileSnapshotOfURI } = this._computeNewCheckpointInfo({ threadId }) ?? {}
		const res = this._readCurrentCheckpoint(threadId)
		if (!res) return
		const [checkpoint, checkpointIdx] = res
		this._editMessageInThread(threadId, checkpointIdx, {
			...checkpoint,
			userModifications: { voidFileSnapshotOfURI: voidFileSnapshotOfURI ?? {}, },
		})
	}


	private _makeUsStandOnCheckpoint({ threadId }: { threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		if (thread.state.currCheckpointIdx !== null) return

		const lastCheckpointIdx = this._getLatestCheckpointIdx(threadId)
		if (lastCheckpointIdx === null) return

		this._setThreadState(threadId, { currCheckpointIdx: lastCheckpointIdx })
	}

	jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx, jumpToUserModified }: { threadId: string, messageIdx: number, jumpToUserModified: boolean }) {

		// if null, add a new temp checkpoint so user can jump forward again
		this._makeUsStandOnCheckpoint({ threadId })

		const thread = this.state.allThreads[threadId]
		if (!thread) return
		if (this.streamState[threadId]?.isRunning) return

		const c = this._getCheckpointBeforeMessage({ threadId, messageIdx })
		if (c === undefined) return // should never happen

		const fromIdx = thread.state.currCheckpointIdx
		if (fromIdx === null) return // should never happen

		const [_, toIdx] = c
		if (toIdx === fromIdx) return

		// console.log(`going from ${fromIdx} to ${toIdx}`)

		// update the user's checkpoint
		this._addUserModificationsToCurrCheckpoint({ threadId })

		/*
if undoing

A,B,C are all files.
x means a checkpoint where the file changed.

A B C D E F G H I
  x x x x x   x           <-- you can't always go up to find the "before" version; sometimes you need to go down
  | | | | |   | x
--x-|-|-|-x---x-|-----     <-- to
	| | | | x   x
	| | x x |
	| |   | |
----x-|---x-x-------     <-- from
	  x

We need to revert anything that happened between to+1 and from.
**We do this by finding the last x from 0...`to` for each file and applying those contents.**
We only need to do it for files that were edited since `to`, ie files between to+1...from.
*/
		if (toIdx < fromIdx) {
			const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: toIdx + 1, hiIdx: fromIdx })

			const idxes = function* () {
				for (let k = toIdx; k >= 0; k -= 1) { // first go up
					yield k
				}
				for (let k = toIdx + 1; k < thread.messages.length; k += 1) { // then go down
					yield k
				}
			}

			for (const fsPath in lastIdxOfURI) {
				// find the first instance of this file starting at toIdx (go up to latest file; if there is none, go down)
				for (const k of idxes()) {
					const message = thread.messages[k]
					if (message.role !== 'checkpoint') continue
					const res = this._getCheckpointInfo(message, fsPath, { includeUserModifiedChanges: jumpToUserModified })
					if (!res) continue
					const { voidFileSnapshot } = res
					if (!voidFileSnapshot) continue
					this._editCodeService.restoreVoidFileSnapshot(URI.file(fsPath), voidFileSnapshot)
					break
				}
			}
		}

		/*
if redoing

A B C D E F G H I J
  x x x x x   x     x
  | | | | |   | x x x
--x-|-|-|-x---x-|-|---     <-- from
	| | | | x   x
	| | x x |
	| |   | |
----x-|---x-x-----|---     <-- to
	  x           x


We need to apply latest change for anything that happened between from+1 and to.
We only need to do it for files that were edited since `from`, ie files between from+1...to.
*/
		if (toIdx > fromIdx) {
			const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: fromIdx + 1, hiIdx: toIdx })
			for (const fsPath in lastIdxOfURI) {
				// apply lowest down content for each uri
				for (let k = toIdx; k >= fromIdx + 1; k -= 1) {
					const message = thread.messages[k]
					if (message.role !== 'checkpoint') continue
					const res = this._getCheckpointInfo(message, fsPath, { includeUserModifiedChanges: jumpToUserModified })
					if (!res) continue
					const { voidFileSnapshot } = res
					if (!voidFileSnapshot) continue
					this._editCodeService.restoreVoidFileSnapshot(URI.file(fsPath), voidFileSnapshot)
					break
				}
			}
		}

		this._setThreadState(threadId, { currCheckpointIdx: toIdx })
	}


	private _wrapRunAgentToNotify(p: Promise<void>, threadId: string) {
		const notify = ({ error }: { error: string | null }) => {
			const thread = this.state.allThreads[threadId]
			if (!thread) return
			const userMsg = findLast(thread.messages, m => m.role === 'user')
			if (!userMsg) return
			if (userMsg.role !== 'user') return
			const messageContent = truncate(userMsg.displayContent, 50, '...')

			this._notificationService.notify({
				severity: error ? Severity.Warning : Severity.Info,
				message: error ? `Error: ${error} ` : `A new Chat result is ready.`,
				source: messageContent,
				sticky: true,
				actions: {
					primary: [{
						id: 'void.goToChat',
						enabled: true,
						label: `Jump to Chat`,
						tooltip: '',
						class: undefined,
						run: () => {
							this.switchToThread(threadId)
							// scroll to bottom
							this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
								m.scrollToBottom()
							})
						}
					}]
				},
			})
		}

		p.then(() => {
			if (threadId !== this.state.currentThreadId) notify({ error: null })
		}).catch((e) => {
			if (e instanceof StaleTurnError) {
				return
			}
			if (threadId !== this.state.currentThreadId) notify({ error: getErrorMessage(e) })
			console.error('[chatThreadService] agent run failed:', getErrorMessage(e))
		})
	}

	dismissStreamError(threadId: string): void {
		this._setStreamState(threadId, undefined)
	}


	private async _addUserMessageAndStreamResponse({ userMessage, llmInstructions, _chatSelections, _images, threadId }: { userMessage: string, llmInstructions?: string, _chatSelections?: StagingSelectionItem[], _images?: string[], threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		// interrupt existing stream
		if (this.streamState[threadId]?.isRunning) {
			await this.abortRunning(threadId)
		}

		// capture a checkpoint before every new user message (skip if we already have one, e.g. after edit/revert)
		const lastMsg = thread.messages[thread.messages.length - 1]
		if (lastMsg?.role !== 'checkpoint') {
			this._addUserCheckpoint({ threadId })
		}


		// add user's message to chat history
		// llmInstructions (when provided, e.g. by Plan Build) replaces what the LLM
		// sees while userMessage stays as the rendered bubble text. Default: both are
		// the same string.
		const instructions = llmInstructions ?? userMessage
		const currSelns: StagingSelectionItem[] = _chatSelections ?? thread.state.stagingSelections

		// Active slash tokens = ones explicitly inserted via the menu AND still present in the
		// text (so deleting a token, or typing one in prose, doesn't inject it).
		const stagedSlashTokens = thread.state.stagedSlashTokens ?? []
		const presentTokens = new Set(parseSlashTokenNames(instructions))
		const activeSlashTokens = stagedSlashTokens.filter(name => presentTokens.has(name))

		const userMessageContent = await chat_userMessageContent(instructions, currSelns, { directoryStrService: this._directoryStringService, fileService: this._fileService }, activeSlashTokens) // user message + names of files (NOT content)
		const mergedImages = mergeUniqueImages([
			...(_images ?? []),
			...imagesOfSelections(currSelns),
		])
		const userHistoryElt: ChatMessage = {
			role: 'user',
			content: userMessageContent,
			displayContent: userMessage,
			selections: currSelns,
			images: mergedImages,
			injectedSlashTokens: activeSlashTokens.length > 0 ? activeSlashTokens : undefined,
			state: defaultMessageState,
		}
		this._addMessageToThread(threadId, userHistoryElt)
		const turnSequence = this._nextTurnSequence(threadId)

		this._setThreadState(threadId, { currCheckpointIdx: null, stagedSlashTokens: [] }) // no longer at a checkpoint because started streaming; slash tokens consumed

		const agentPromise = this._runChatAgent({ threadId, ...this._currentModelSelectionProps(), turnSequence });
		this._trackAgentRun(threadId, agentPromise);
		this._wrapRunAgentToNotify(agentPromise, threadId);

	}

	private _trackAgentRun(threadId: string, agentPromise: Promise<void>): void {
		this._pendingAgentRunByThread.set(threadId, agentPromise);
		agentPromise.finally(() => {
			if (this._pendingAgentRunByThread.get(threadId) === agentPromise) {
				this._pendingAgentRunByThread.delete(threadId);
			}
		});
	}

	async waitForThreadAgentRunEnd(threadId: string): Promise<void> {
		const pending = this._pendingAgentRunByThread.get(threadId);
		if (pending) {
			await pending;
		}
		if (this.streamState[threadId]?.isRunning !== undefined) {
			await new Promise<void>((resolve) => {
				const disposable = this.onDidChangeStreamState(({ threadId: changedId }) => {
					if (changedId !== threadId) {
						return;
					}
					if (this.streamState[threadId]?.isRunning === undefined) {
						disposable.dispose();
						resolve();
					}
				});
			});
		}
	}


	getQueuedUserMessages(threadId: string): readonly QueuedUserMessage[] {
		return this._queuedUserMessagesByThread.get(threadId) ?? []
	}

	removeQueuedUserMessage(threadId: string, idx: number): void {
		const queue = this._queuedUserMessagesByThread.get(threadId)
		if (!queue || idx < 0 || idx >= queue.length) return
		queue.splice(idx, 1)
		if (queue.length === 0) { this._queuedUserMessagesByThread.delete(threadId); this._queuePausedByThread.delete(threadId) }
		this._onDidChangeQueuedMessages.fire({ threadId })
	}

	private _clearQueuedUserMessages(threadId: string): void {
		const had = this._queuedUserMessagesByThread.has(threadId) || this._queuePausedByThread.has(threadId)
		this._queuedUserMessagesByThread.delete(threadId)
		this._queuePausedByThread.delete(threadId)
		if (had) this._onDidChangeQueuedMessages.fire({ threadId })
	}

	/** Public: clear the queue WITHOUT aborting the current run (distinct from Stop, which aborts + clears). */
	clearQueuedUserMessages(threadId: string): void {
		this._clearQueuedUserMessages(threadId)
	}

	getIsQueuePaused(threadId: string): boolean {
		return this._queuePausedByThread.has(threadId) && (this._queuedUserMessagesByThread.get(threadId)?.length ?? 0) > 0
	}

	/** Pause the queue if it has messages (keep them, stop auto-draining). No-op on an empty queue. */
	private _pauseQueue(threadId: string): void {
		const queue = this._queuedUserMessagesByThread.get(threadId)
		if (!queue || queue.length === 0) return
		if (this._queuePausedByThread.has(threadId)) return
		this._queuePausedByThread.add(threadId)
		this._metricsService.capture('Message Queue Paused', { depth: queue.length }) // Q14
		this._onDidChangeQueuedMessages.fire({ threadId })
	}

	resumeQueuedUserMessages(threadId: string): void {
		if (!this._queuePausedByThread.has(threadId)) return
		this._queuePausedByThread.delete(threadId)
		this._onDidChangeQueuedMessages.fire({ threadId })
		// Only drain if the thread is idle; if a run is somehow active, the terminal-end drain will pick it up.
		const runningKind = this.streamState[threadId]?.isRunning
		if (runningKind === 'LLM' || runningKind === 'tool' || runningKind === 'awaiting_user') return
		this._drainNextQueuedUserMessage(threadId)
	}

	/** Called at a run's terminal end. Sends the next queued message, if any. Returns true if one was sent. */
	private _drainNextQueuedUserMessage(threadId: string): boolean {
		// Never auto-drain a paused queue — the user must explicitly resume.
		if (this._queuePausedByThread.has(threadId)) return false
		const queue = this._queuedUserMessagesByThread.get(threadId)
		if (!queue || queue.length === 0) return false
		const next = queue.shift()!
		if (queue.length === 0) this._queuedUserMessagesByThread.delete(threadId)
		this._metricsService.capture('Message Queue Drained', { remaining: queue.length }) // Q14
		this._onDidChangeQueuedMessages.fire({ threadId })
		// fire-and-forget: this starts a fresh run (streamState is no longer running at this point)
		this.addUserMessageAndStreamResponse({ ...next, threadId }).catch(e => {
			console.error('[chatThreadService] failed to send queued message:', getErrorMessage(e))
			// Q3: don't strand the rest of the queue or lose this message. Put it back at the front
			// and pause so the user can resume, rather than letting the drain chain die silently.
			const q = this._queuedUserMessagesByThread.get(threadId) ?? []
			q.unshift(next)
			this._queuedUserMessagesByThread.set(threadId, q)
			this._pauseQueue(threadId)
		})
		return true
	}

	async addUserMessageAndStreamResponse({ userMessage, llmInstructions, _chatSelections, _images, threadId }: { userMessage: string, llmInstructions?: string, _chatSelections?: StagingSelectionItem[], _images?: string[], threadId: string }) {
		const thread = this.state.allThreads[threadId];
		if (!thread) return

		// Cursor-style queueing: while the agent is actively working (LLM/tool/idle), a new user
		// message queues instead of aborting the run. 'awaiting_user' (blocked on tool approval /
		// question) keeps the legacy interrupt behavior — the run is paused, so queueing would
		// deadlock: nothing would ever drain the queue.
		// Also queue (rather than run ahead) when a PAUSED queue exists, so a new send can't jump the
		// FIFO order in front of messages waiting on a resume.
		const runningKind = this.streamState[threadId]?.isRunning
		const isActivelyRunning = runningKind === 'LLM' || runningKind === 'tool' || runningKind === 'idle'
		const hasPausedQueue = this.getIsQueuePaused(threadId)
		if (isActivelyRunning || hasPausedQueue) {
			// Q7: reject empty/whitespace-only sends that carry no attachments.
			const hasContent = userMessage.trim().length > 0 || (_chatSelections?.length ?? 0) > 0 || (_images?.length ?? 0) > 0
			if (!hasContent) return
			const queue = this._queuedUserMessagesByThread.get(threadId) ?? []
			// Q7: cap depth so runaway Enter presses can't grow the queue unbounded.
			if (queue.length >= MAX_QUEUED_USER_MESSAGES) {
				this._notificationService.info(`Message queue is full (max ${MAX_QUEUED_USER_MESSAGES}). Wait for the agent to catch up before queueing more.`)
				return
			}
			// Q7: collapse an immediate exact-duplicate of the tail (double-Enter).
			const queuedEntry: QueuedUserMessage = {
				userMessage,
				llmInstructions,
				_chatSelections: _chatSelections ? _chatSelections.map(cloneStagingSelection) : undefined,
				_images: _images ? [..._images] : undefined,
			}
			const tail = queue[queue.length - 1]
			if (tail && queuedUserMessagesEqual(tail, queuedEntry)) {
				return
			}
			// Deep-copy the attachment snapshots so later staging edits (which replace the array
			// reference on the thread) can never mutate an already-queued entry's context.
			queue.push(queuedEntry)
			this._queuedUserMessagesByThread.set(threadId, queue)
			this._metricsService.capture('Message Queued', { depth: queue.length, whileRunning: isActivelyRunning }) // Q14
			this._onDidChangeQueuedMessages.fire({ threadId })
			return
		}

		// if there's a current checkpoint, delete all messages after it
		if (thread.state.currCheckpointIdx !== null) {
			const checkpointIdx = thread.state.currCheckpointIdx;
			const newMessages = thread.messages.slice(0, checkpointIdx + 1);

			// Update the thread with truncated messages
			const newThreads = {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					lastModified: new Date().toISOString(),
					messages: newMessages,
				}
			};
			this._storeAllThreads(newThreads);
			this._setState({ allThreads: newThreads });
			this._pruneSubAgentConversationsForThread(threadId);
		}

		// Now call the original method to add the user message and stream the response
		await this._addUserMessageAndStreamResponse({ userMessage, llmInstructions, _chatSelections, _images, threadId });

	}

	editUserMessageAndStreamResponse: IChatThreadService['editUserMessageAndStreamResponse'] = async ({ userMessage, messageIdx, threadId }) => {

		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		if (thread.messages?.[messageIdx]?.role !== 'user') {
			throw new Error(`Error: editing a message with role !=='user'`)
		}

		// Editing rewrites history from messageIdx onward — any compaction summary built over the
		// old transcript is now stale. Drop it; it will be rebuilt on the next high-fill turn.
		this._setThreadCompaction(threadId, undefined)

		// get prev and curr selections before clearing the message
		const currSelns = thread.messages[messageIdx].state.stagingSelections || [] // staging selections for the edited message
		const currImages = thread.messages[messageIdx].images
		const prevInjected = thread.messages[messageIdx].role === 'user'
			? (thread.messages[messageIdx].injectedSlashTokens ?? [])
			: []

		// restore file state to the checkpoint before this user message
		this.jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx, jumpToUserModified: false })

		const threadAfterRestore = this.state.allThreads[threadId]
		if (!threadAfterRestore) return

		// clear the user message and everything after it
		const slicedMessages = threadAfterRestore.messages.slice(0, messageIdx)
		this._setState({
			allThreads: {
				...this.state.allThreads,
				[thread.id]: {
					...threadAfterRestore,
					messages: slicedMessages,
					state: {
						...threadAfterRestore.state,
						currCheckpointIdx: null,
					},
				}
			}
		})
		this._pruneSubAgentConversationsForThread(threadId);

		// Re-stage slash tokens still present in the edited text (prior injections + any new menu picks).
		const presentTokens = new Set(parseSlashTokenNames(userMessage))
		const stagedNow = threadAfterRestore.state.stagedSlashTokens ?? []
		const restoredSlash = [...new Set([
			...prevInjected.filter(n => presentTokens.has(n)),
			...stagedNow.filter(n => presentTokens.has(n)),
		])]
		this._setThreadState(threadId, { stagedSlashTokens: restoredSlash })

		// re-add the message and stream it
		await this._addUserMessageAndStreamResponse({ userMessage, _chatSelections: currSelns, _images: currImages, threadId })
	}

	// ---------- the rest ----------

	private _getAllSeenFileURIs(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return []

		const fsPathsSet = new Set<string>()
		const uris: URI[] = []
		const addURI = (uri: URI) => {
			if (fsPathsSet.has(uri.fsPath)) return
			fsPathsSet.add(uri.fsPath)
			uris.push(uri)
		}

		for (const m of thread.messages) {
			// URIs of user selections
			if (m.role === 'user') {
				for (const sel of m.selections ?? []) {
					if (sel.type === 'BrowserElement') continue
					addURI(sel.uri)
				}
			}
			// URIs of files that have been read
			else if (m.role === 'tool' && m.type === 'success' && (m.name === 'Read' || m.name === 'read_file')) {
				const params = m.params as BuiltinToolCallParams['Read']
				addURI(params.uri)
			}
		}
		return uris
	}



	getRelativeStr = (uri: URI) => {
		const threadId = this.state.currentThreadId
		const thread = threadId ? this.state.allThreads[threadId] : undefined
		const folders = threadId ? this._getFolderUrisForThread(threadId) : this._workspaceContextService.getWorkspace().folders.map(f => f.uri)
		if (folders.length === 0) {
			// Agent-window No Repo / empty workspace: fail closed — do not
			// expose IDE-relative paths (matches `_isUriInsideThreadWorkspace`).
			if (thread && thread.agentWorkspaceId !== undefined) {
				return undefined
			}
			const isInside = this._workspaceContextService.isInsideWorkspace(uri)
			if (!isInside) {
				return undefined
			}
			const f = this._workspaceContextService.getWorkspace().folders.find(f => uri.fsPath.startsWith(f.uri.fsPath))
			return f ? uri.fsPath.replace(f.uri.fsPath, '') : undefined
		}
		if (!isUriInsideFolders(uri, folders)) {
			return undefined
		}
		const f = folders.find(folder => uri.fsPath.startsWith(folder.fsPath))
		return f ? uri.fsPath.replace(f.fsPath, '') : undefined
	}


	// gets the location of codespan link so the user can click on it
	generateCodespanLink: IChatThreadService['generateCodespanLink'] = async ({ codespanStr: _codespanStr, threadId }) => {

		// process codespan to understand what we are searching for
		// TODO account for more complicated patterns eg `ITextEditorService.openEditor()`
		const functionOrMethodPattern = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/; // `fUnCt10n_name`
		const functionParensPattern = /^([^\s(]+)\([^)]*\)$/; // `functionName( args )`

		let target = _codespanStr // the string to search for
		let codespanType: 'file-or-folder' | 'function-or-class'
		if (target.includes('.') || target.includes('/')) {

			codespanType = 'file-or-folder'
			target = _codespanStr

		} else if (functionOrMethodPattern.test(target)) {

			codespanType = 'function-or-class'
			target = _codespanStr

		} else if (functionParensPattern.test(target)) {
			const match = target.match(functionParensPattern)
			if (match && match[1]) {

				codespanType = 'function-or-class'
				target = match[1]

			}
			else { return null }
		}
		else {
			return null
		}

		// get history of all AI and user added files in conversation + store in reverse order (MRU)
		const prevUris = this._getAllSeenFileURIs(threadId).reverse()

		if (codespanType === 'file-or-folder') {
			const doesUriMatchTarget = (uri: URI) => uri.path.includes(target)

			// check if any prevFiles are the `target`
			for (const [idx, uri] of prevUris.entries()) {
				if (doesUriMatchTarget(uri)) {

					// shorten it

					// TODO make this logic more general
					const prevUriStrs = prevUris.map(uri => uri.fsPath)
					const shortenedUriStrs = shorten(prevUriStrs)
					let displayText = shortenedUriStrs[idx]
					const ellipsisIdx = displayText.lastIndexOf('…/');
					if (ellipsisIdx >= 0) {
						displayText = displayText.slice(ellipsisIdx + 2)
					}

					return { uri, displayText }
				}
			}

			// else search codebase for `target`
			let uris: URI[] = []
			try {
				const { result } = await this._toolsService.callTool['Glob']({ globPattern: toFilenameSearchGlobPattern(target), targetDirectory: null })
				const { uris: uris_ } = await result
				uris = uris_
			} catch (e) {
				return null
			}

			for (const [idx, uri] of uris.entries()) {
				if (doesUriMatchTarget(uri)) {

					// TODO make this logic more general
					const uriStrs = uris.map(uri => uri.fsPath)
					const shortenedUriStrs = shorten(uriStrs)
					let displayText = shortenedUriStrs[idx]
					const ellipsisIdx = displayText.lastIndexOf('…/');
					if (ellipsisIdx >= 0) {
						displayText = displayText.slice(ellipsisIdx + 2)
					}


					return { uri, displayText }
				}
			}

		}


		if (codespanType === 'function-or-class') {


			// check all prevUris for the target
			for (const uri of prevUris) {

				const modelRef = await this._voidModelService.getModelSafe(uri)
				const { model } = modelRef
				if (!model) continue

				const matches = model.findMatches(
					target,
					false, // searchOnlyEditableRange
					false, // isRegex
					true,  // matchCase
					null, //' ',   // wordSeparators
					true   // captureMatches
				);

				const firstThree = matches.slice(0, 3);

				// take first 3 occurences, attempt to goto definition on them
				for (const match of firstThree) {
					const position = new Position(match.range.startLineNumber, match.range.startColumn);
					const definitionProviders = this._languageFeaturesService.definitionProvider.ordered(model);

					for (const provider of definitionProviders) {

						const _definitions = await provider.provideDefinition(model, position, CancellationToken.None);

						if (!_definitions) continue;

						const definitions = Array.isArray(_definitions) ? _definitions : [_definitions];

						for (const definition of definitions) {

							return {
								uri: definition.uri,
								selection: {
									startLineNumber: definition.range.startLineNumber,
									startColumn: definition.range.startColumn,
									endLineNumber: definition.range.endLineNumber,
									endColumn: definition.range.endColumn,
								},
								displayText: _codespanStr,
							};

							// const defModelRef = await this._textModelService.createModelReference(definition.uri);
							// const defModel = defModelRef.object.textEditorModel;

							// try {
							// 	const symbolProviders = this._languageFeaturesService.documentSymbolProvider.ordered(defModel);

							// 	for (const symbolProvider of symbolProviders) {
							// 		const symbols = await symbolProvider.provideDocumentSymbols(
							// 			defModel,
							// 			CancellationToken.None
							// 		);

							// 		if (symbols) {
							// 			const symbol = symbols.find(s => {
							// 				const symbolRange = s.range;
							// 				return symbolRange.startLineNumber <= definition.range.startLineNumber &&
							// 					symbolRange.endLineNumber >= definition.range.endLineNumber &&
							// 					(symbolRange.startLineNumber !== definition.range.startLineNumber || symbolRange.startColumn <= definition.range.startColumn) &&
							// 					(symbolRange.endLineNumber !== definition.range.endLineNumber || symbolRange.endColumn >= definition.range.endColumn);
							// 			});

							// 			// if we got to a class/function get the full range and return
							// 			if (symbol?.kind === SymbolKind.Function || symbol?.kind === SymbolKind.Method || symbol?.kind === SymbolKind.Class) {
							// 				return {
							// 					uri: definition.uri,
							// 					selection: {
							// 						startLineNumber: definition.range.startLineNumber,
							// 						startColumn: definition.range.startColumn,
							// 						endLineNumber: definition.range.endLineNumber,
							// 						endColumn: definition.range.endColumn,
							// 					}
							// 				};
							// 			}
							// 		}
							// 	}
							// } finally {
							// 	defModelRef.dispose();
							// }
						}
					}
				}
			}

			// unlike above do not search codebase (doesnt make sense)

		}

		return null

	}

	getCodespanLink({ codespanStr, messageIdx, threadId }: { codespanStr: string, messageIdx: number, threadId: string }): CodespanLocationLink | undefined {
		const thread = this.state.allThreads[threadId]
		if (!thread) return undefined;

		const links = thread.state.linksOfMessageIdx?.[messageIdx]
		if (!links) return undefined;

		const link = links[codespanStr]

		return link
	}

	async addCodespanLink({ newLinkText, newLinkLocation, messageIdx, threadId }: { newLinkText: string, newLinkLocation: CodespanLocationLink, messageIdx: number, threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({

			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					state: {
						...thread.state,
						linksOfMessageIdx: {
							...thread.state.linksOfMessageIdx,
							[messageIdx]: {
								...thread.state.linksOfMessageIdx?.[messageIdx],
								[newLinkText]: newLinkLocation
							}
						}
					}

				}
			}
		})
	}


	getCurrentThread(): ThreadType {
		const state = this.state
		const thread = state.allThreads[state.currentThreadId]
		if (!thread) throw new Error(`Current thread should never be undefined`)
		return thread
	}

	getThread(threadId: string): ThreadType | undefined {
		return this.state.allThreads[threadId]
	}

	getSelectedThreadId(inAgentWindow: boolean): string | null {
		return inAgentWindow ? this.state.agentWindowThreadId : this.state.currentThreadId
	}

	ensureAgentWindowThread(agentWorkspaceId: string | null): string {
		const selectedId = this.state.agentWindowThreadId
		const selected = selectedId ? this.state.allThreads[selectedId] : undefined
		if (selected?.agentWorkspaceId === agentWorkspaceId) {
			return selected.id
		}

		const nextId = findNewestThreadIdInExactScope(Object.values(this.state.allThreads), agentWorkspaceId)
		const next = nextId ? this.state.allThreads[nextId] : undefined
		if (next) {
			this._setState({ agentWindowThreadId: next.id }, true)
			return next.id
		}

		const newThread = newThreadObject({ agentWorkspaceId })
		const allThreads = { ...this.state.allThreads, [newThread.id]: newThread }
		this._turnSequenceOfThread[newThread.id] = 0
		this._storeAllThreads(allThreads)
		this._setState({ allThreads, agentWindowThreadId: newThread.id }, true)
		return newThread.id
	}

	getCurrentFocusedMessageIdx() {
		const thread = this.getCurrentThread()

		// get the focusedMessageIdx
		const focusedMessageIdx = thread.state.focusedMessageIdx
		if (focusedMessageIdx === undefined) return;

		// check that the message is actually being edited
		const focusedMessage = thread.messages[focusedMessageIdx]
		if (focusedMessage.role !== 'user') return;
		if (!focusedMessage.state) return;

		return focusedMessageIdx
	}

	isCurrentlyFocusingMessage() {
		return this.getCurrentFocusedMessageIdx() !== undefined
	}

	switchToThread(threadId: string, opts?: { inAgentWindow?: boolean }) {
		if (!this.state.allThreads[threadId]) {
			return
		}
		if (opts?.inAgentWindow) {
			this._setState({ agentWindowThreadId: threadId }, true)
			return
		}
		this._setState({ currentThreadId: threadId })
	}

	/**
	 * Resolve folder URIs for a thread. Agent-window threads (those with
	 * `agentWorkspaceId` set, including null = No Repo) use the independent
	 * agent project workspace; IDE threads use the main workbench folders.
	 */
	getFolderUrisForThread(threadId: string): URI[] {
		const thread = this.state.allThreads[threadId]
		if (thread && thread.agentWorkspaceId !== undefined) {
			return resolveFoldersForThread(thread.agentWorkspaceId, this._agentProjectWorkspaceService)
		}
		return this._workspaceContextService.getWorkspace().folders.map(f => f.uri)
	}

	private _getFolderUrisForThread(threadId: string): URI[] {
		return this.getFolderUrisForThread(threadId)
	}

	isUriInsideThreadWorkspace(threadId: string, uri: URI): boolean {
		return this._isUriInsideThreadWorkspace(threadId, uri)
	}

	private _isUriInsideThreadWorkspace(threadId: string, uri: URI): boolean {
		const folders = this._getFolderUrisForThread(threadId)
		if (folders.length === 0) {
			// No Repo / empty: fall back to IDE containment so IDE tools still work
			if (this.state.allThreads[threadId]?.agentWorkspaceId === undefined) {
				return this._workspaceContextService.isInsideWorkspace(uri)
			}
			return false
		}
		return isUriInsideFolders(uri, folders)
	}


	openNewThread(opts?: { agentWorkspaceId?: string | null }) {
		// if a thread with 0 messages already exists in the same workspace scope, switch to it
		const { allThreads: currentThreads } = this.state
		const wantsWorkspaceField = opts && 'agentWorkspaceId' in opts
		const targetWorkspaceId = wantsWorkspaceField ? (opts!.agentWorkspaceId ?? null) : undefined
		for (const threadId in currentThreads) {
			const existing = currentThreads[threadId]
			if (!existing || existing.messages.length !== 0) {
				continue
			}
			// Match workspace scope: agent-window callers only reuse empty threads
			// in the same agent workspace; IDE callers only reuse unscoped threads.
			if (wantsWorkspaceField) {
				// Strict: undefined (IDE) ≠ null (No Repo).
				if (existing.agentWorkspaceId !== targetWorkspaceId) {
					continue
				}
			} else if (existing.agentWorkspaceId !== undefined) {
				continue
			}
			if (!(threadId in this._turnSequenceOfThread)) {
				this._turnSequenceOfThread[threadId] = 0
			}
			this.switchToThread(threadId, { inAgentWindow: wantsWorkspaceField })
			return
		}
		// otherwise, start a new thread
		const newThread = newThreadObject(opts)

		// update state
		const newThreads: ChatThreads = {
			...currentThreads,
			[newThread.id]: newThread
		}
		this._turnSequenceOfThread[newThread.id] = 0
		this._storeAllThreads(newThreads)
		this._setState(wantsWorkspaceField
			? { allThreads: newThreads, agentWindowThreadId: newThread.id }
			: { allThreads: newThreads, currentThreadId: newThread.id }, wantsWorkspaceField)
	}

	hasRunningThreadInWorkspace(agentWorkspaceId: string | null): boolean {
		const { allThreads } = this.state
		for (const threadId in allThreads) {
			const thread = allThreads[threadId]
			if (!thread) {
				continue
			}
			const threadWs = thread.agentWorkspaceId ?? null
			// Legacy/IDE threads (undefined) only count when checking No Repo? No —
			// they are not agent-scoped, so only match when both are null AND thread
			// explicitly has agentWorkspaceId === null.
			if (thread.agentWorkspaceId === undefined) {
				continue
			}
			if (threadWs !== agentWorkspaceId) {
				continue
			}
			const running = this.streamState[threadId]?.isRunning
			if (running === 'LLM' || running === 'tool' || running === 'idle' || running === 'awaiting_user') {
				return true
			}
			// Parent loop may have finished (stream cleared) while background `task`
			// sub-agents are still running — those must still block/confirm switches.
			if ((this._pendingBackgroundTasks.get(threadId)?.size ?? 0) > 0) {
				return true
			}
		}
		return false
	}


	deleteThread(threadId: string): void {
		const { allThreads: currentThreads, currentThreadId } = this.state
		void this._terminalToolService.killShellsForThread(threadId);
		if (this._turnSequenceOfThread[threadId] !== undefined) {
			// nothing to cancel
		}
		this._subAgentService.cancelBackgroundRunsForThread(threadId);
		this._subAgentService.cancelForegroundRunsForThread(threadId);
		this._pendingBackgroundTasks.delete(threadId);
		this._completedBackgroundResults.delete(threadId);
		this._clearSubAgentConversationsForThread(threadId);
		this._clearToolProgressOverlay(threadId);
		this._clearLlmStreamThrottle(threadId);
		this._planBuildStateByThread.delete(threadId);
		this._latestUsageByThread.delete(threadId);
		this._clearQueuedUserMessages(threadId); // Q6: clear memory and the persisted queue entry

		// Clean up the compaction history file for this thread
		const folder = this._getFolderUrisForThread(threadId)[0];
		if (folder) {
			const historyFile = URI.joinPath(folder, '.orbit', 'history', `thread-${threadId}.md`);
			void this._fileService.del(historyFile).catch(() => { /* best-effort */ });
		}

		// delete the thread
		const newThreads = { ...currentThreads };
		delete newThreads[threadId];
		delete this._turnSequenceOfThread[threadId]

		const deletedThread = currentThreads[threadId]
		const newestInScope = (agentWorkspaceId: string | null | undefined): string | undefined =>
			findNewestThreadIdInExactScope(Object.values(newThreads), agentWorkspaceId)
		const createInScope = (agentWorkspaceId: string | null | undefined): string => {
			const replacement = newThreadObject(agentWorkspaceId === undefined ? undefined : { agentWorkspaceId })
			newThreads[replacement.id] = replacement
			this._turnSequenceOfThread[replacement.id] = 0
			return replacement.id
		}

		let newCurrentThreadId = currentThreadId;
		let newAgentWindowThreadId = this.state.agentWindowThreadId;
		if (threadId === currentThreadId) {
			// The IDE selection may only fall back to another unscoped IDE thread.
			newCurrentThreadId = newestInScope(undefined) ?? createInScope(undefined)
		}
		if (threadId === this.state.agentWindowThreadId) {
			// The Agents selection must remain in the deleted thread's exact scope;
			// undefined IDE threads and null No Repo threads are intentionally distinct.
			const scope = deletedThread?.agentWorkspaceId ?? null
			newAgentWindowThreadId = newestInScope(scope) ?? createInScope(scope)
		}

		// store the updated threads
		this._storeAllThreads(newThreads, { immediate: true });
		this._setState({ allThreads: newThreads, currentThreadId: newCurrentThreadId, agentWindowThreadId: newAgentWindowThreadId })
	}

	duplicateThread(threadId: string) {
		const { allThreads: currentThreads } = this.state
		const threadToDuplicate = currentThreads[threadId]
		if (!threadToDuplicate) return
		const newThread = {
			...deepClone(threadToDuplicate),
			id: generateUuid(),
		}
		this._turnSequenceOfThread[newThread.id] = 0
		const newThreads = {
			...currentThreads,
			[newThread.id]: newThread,
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads })
	}

	private _addMessagesToThreadBatch(threadId: string, messages: ChatMessage[]) {
		if (messages.length === 0) return
		const { allThreads } = this.state
		const oldThread = allThreads[threadId]
		if (!oldThread) return // should never happen

		const newThread = {
			...oldThread,
			lastModified: new Date().toISOString(),
			messages: [
				...oldThread.messages,
				...messages,
			],
		}

		const newThreads = {
			...allThreads,
			[oldThread.id]: newThread,
		}

		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads })
	}


	private _addMessageToThread(threadId: string, message: ChatMessage) {
		const { allThreads } = this.state
		const oldThread = allThreads[threadId]
		if (!oldThread) return // should never happen
		// update state and store it
		const newThreads = {
			...allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages: [
					...oldThread.messages,
					message
				],
			}
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads }) // the current thread just changed (it had a message added to it)
	}

	// sets the currently selected message (must be undefined if no message is selected)
	setCurrentlyFocusedMessageIdx(messageIdx: number | undefined) {

		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					state: {
						...thread.state,
						focusedMessageIdx: messageIdx,
					}
				}
			}
		})

		// // when change focused message idx, jump - do not jump back when click edit, too confusing.
		// if (messageIdx !== undefined)
		// 	this.jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx, jumpToUserModified: true })
	}


	// Record a /skill or /command token the user inserted via the slash menu (thread-level,
	// de-duped). Consumed and cleared when the next message is sent.
	addStagedSlashToken(name: string): void {
		const current = this.getCurrentThreadState().stagedSlashTokens ?? []
		if (current.includes(name)) return
		this.setCurrentThreadState({ stagedSlashTokens: [...current, name] })
	}

	addNewStagingSelection(newSelection: StagingSelectionItem): void {

		const focusedMessageIdx = this.getCurrentFocusedMessageIdx()

		// set the selections to the proper value
		let selections: StagingSelectionItem[] = []
		let setSelections = (s: StagingSelectionItem[]) => { }

		if (focusedMessageIdx === undefined) {
			selections = this.getCurrentThreadState().stagingSelections
			setSelections = (s: StagingSelectionItem[]) => this.setCurrentThreadState({ stagingSelections: s })
		} else {
			selections = this.getCurrentMessageState(focusedMessageIdx).stagingSelections
			setSelections = (s) => this.setCurrentMessageState(focusedMessageIdx, { stagingSelections: s })
		}

		// if matches with existing selection, overwrite (since text may change)
		const idx = findStagingSelectionIndex(selections, newSelection)
		if (idx !== null && idx !== -1) {
			setSelections([
				...selections!.slice(0, idx),
				newSelection,
				...selections!.slice(idx + 1, Infinity)
			])
		}
		// if no match, add it
		else {
			setSelections([...(selections ?? []), newSelection])
		}
	}


	// Pops the staging selections from the current thread's state
	popStagingSelections(numPops: number): void {

		numPops = numPops ?? 1;

		const focusedMessageIdx = this.getCurrentFocusedMessageIdx()

		// set the selections to the proper value
		let selections: StagingSelectionItem[] = []
		let setSelections = (s: StagingSelectionItem[]) => { }

		if (focusedMessageIdx === undefined) {
			selections = this.getCurrentThreadState().stagingSelections
			setSelections = (s: StagingSelectionItem[]) => this.setCurrentThreadState({ stagingSelections: s })
		} else {
			selections = this.getCurrentMessageState(focusedMessageIdx).stagingSelections
			setSelections = (s) => this.setCurrentMessageState(focusedMessageIdx, { stagingSelections: s })
		}

		setSelections([
			...selections.slice(0, selections.length - numPops)
		])

	}

	// set message.state
	private _setCurrentMessageState(state: Partial<UserMessageState>, messageIdx: number): void {

		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					messages: thread.messages.map((m, i) =>
						i === messageIdx && m.role === 'user' ? {
							...m,
							state: {
								...m.state,
								...state
							},
						} : m
					)
				}
			}
		})

	}

	// set thread.state
	private _setThreadState(threadId: string, state: Partial<ThreadType['state']>, doNotRefreshMountInfo?: boolean): void {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[thread.id]: {
					...thread,
					state: {
						...thread.state,
						...state
					}
				}
			}
		}, doNotRefreshMountInfo)

	}

	setThreadState(threadId: string, newState: Partial<ThreadType['state']>): void {
		this._setThreadState(threadId, newState)
	}

	getThreadMessageState(threadId: string, messageIdx: number): UserMessageState {
		const message = this.state.allThreads[threadId]?.messages?.[messageIdx]
		return message?.role === 'user' ? message.state : defaultMessageState
	}

	setThreadMessageState(threadId: string, messageIdx: number, newState: Partial<UserMessageState>): void {
		const thread = this.state.allThreads[threadId]
		const message = thread?.messages?.[messageIdx]
		if (!thread || message?.role !== 'user') {
			return
		}
		const messages = thread.messages.map((candidate, index) =>
			index === messageIdx && candidate.role === 'user'
				? { ...candidate, state: { ...candidate.state, ...newState } }
				: candidate,
		)
		this._setState({
			allThreads: {
				...this.state.allThreads,
				[threadId]: { ...thread, messages },
			},
		}, true)
	}

	setThreadFocusedMessageIdx(threadId: string, messageIdx: number | undefined): void {
		this._setThreadState(threadId, { focusedMessageIdx: messageIdx })
	}


	// closeCurrentStagingSelectionsInThread = () => {
	// 	const currThread = this.getCurrentThreadState()

	// 	// close all stagingSelections
	// 	const closedStagingSelections = currThread.stagingSelections.map(s => ({ ...s, state: { ...s.state, isOpened: false } }))

	// 	const newThread = currThread
	// 	newThread.stagingSelections = closedStagingSelections

	// 	this.setCurrentThreadState(newThread)

	// }

	// closeCurrentStagingSelectionsInMessage: IChatThreadService['closeCurrentStagingSelectionsInMessage'] = ({ messageIdx }) => {
	// 	const currMessage = this.getCurrentMessageState(messageIdx)

	// 	// close all stagingSelections
	// 	const closedStagingSelections = currMessage.stagingSelections.map(s => ({ ...s, state: { ...s.state, isOpened: false } }))

	// 	const newMessage = currMessage
	// 	newMessage.stagingSelections = closedStagingSelections

	// 	this.setCurrentMessageState(messageIdx, newMessage)

	// }



	getCurrentThreadState = () => {
		const currentThread = this.getCurrentThread()
		return currentThread.state
	}
	setCurrentThreadState = (newState: Partial<ThreadType['state']>) => {
		this._setThreadState(this.state.currentThreadId, newState)
	}

	// gets `staging` and `setStaging` of the currently focused element, given the index of the currently selected message (or undefined if no message is selected)

	getCurrentMessageState(messageIdx: number): UserMessageState {
		const currMessage = this.getCurrentThread()?.messages?.[messageIdx]
		if (!currMessage || currMessage.role !== 'user') return defaultMessageState
		return currMessage.state
	}
	setCurrentMessageState(messageIdx: number, newState: Partial<UserMessageState>) {
		const currMessage = this.getCurrentThread()?.messages?.[messageIdx]
		if (!currMessage || currMessage.role !== 'user') return
		this._setCurrentMessageState(newState, messageIdx)
	}

	// TODO list management

	getTodoList(threadId: string): TodoItem[] | undefined {
		return this.state.allThreads[threadId]?.todoList;
	}

	updateTodoStatus(threadId: string, todoId: string, status: TodoStatus): void {
		const thread = this.state.allThreads[threadId];
		if (!thread?.todoList) return;

		const todoIdx = thread.todoList.findIndex(t => t.id === todoId);
		if (todoIdx !== -1) {
			const newTodoList = applyTodoWrite(thread.todoList, [{ id: todoId, status }], true);
			if (todoListsEqual(normalizeTodoList(thread.todoList), newTodoList)) {
				return;
			}
			const newThreads = {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					todoList: newTodoList,
					lastModified: new Date().toISOString(),
				}
			};
			this._storeAllThreads(newThreads);
			this._setState({ allThreads: newThreads });
		}
	}

	// --- Plan draft + linked plan path ---

	getThreadPlanDraft(threadId: string): PlanDraft | undefined {
		return this.state.allThreads[threadId]?.planDraft;
	}

	setThreadPlanDraft(threadId: string, draft: PlanDraft | undefined): void {
		const thread = this.state.allThreads[threadId];
		if (!thread) return;
		// Reference equality — avoid spurious notifications / persistence.
		if (thread.planDraft === draft) return;
		const newThreads = {
			...this.state.allThreads,
			[threadId]: {
				...thread,
				planDraft: draft,
				lastModified: new Date().toISOString(),
			}
		};
		this._storeAllThreads(newThreads);
		this._setState({ allThreads: newThreads });
		this._onDidChangeThreadPlanDraft.fire({ threadId });
	}

	clearThreadPlanDraft(threadId: string): void {
		const thread = this.state.allThreads[threadId];
		if (!thread || thread.planDraft === undefined) return;
		const { planDraft: _drop, ...rest } = thread;
		const newThreads = {
			...this.state.allThreads,
			[threadId]: {
				...rest,
				lastModified: new Date().toISOString(),
			}
		};
		this._storeAllThreads(newThreads);
		this._setState({ allThreads: newThreads });
		this._onDidChangeThreadPlanDraft.fire({ threadId });
	}

	setLinkedPlanPath(threadId: string, path: string | null): void {
		const thread = this.state.allThreads[threadId];
		if (!thread) return;
		const current = thread.linkedPlanPath ?? null;
		if (current === path) return;
		const updated: ThreadType = path === null
			? (() => {
				const { linkedPlanPath: _drop, ...rest } = thread;
				return { ...rest, lastModified: new Date().toISOString() };
			})()
			: {
				...thread,
				linkedPlanPath: path,
				lastModified: new Date().toISOString(),
			};
		const newThreads = {
			...this.state.allThreads,
			[threadId]: updated,
		};
		this._storeAllThreads(newThreads);
		this._setState({ allThreads: newThreads });
		this._onDidChangeThreadLinkedPlanPath.fire({ threadId });
	}

	clearLinkedPlanPath(threadId: string): void {
		this.setLinkedPlanPath(threadId, null);
	}

	// --- Thread todo list (setter for plan sync) ---

	private readonly _onDidChangeThreadTodoList = new Emitter<{ threadId: string }>();
	onDidChangeThreadTodoList: Event<{ threadId: string }> = this._onDidChangeThreadTodoList.event;

	setThreadTodoList(threadId: string, todos: TodoItem[]): void {
		const thread = this.state.allThreads[threadId];
		if (!thread) return;
		const newThreads = {
			...this.state.allThreads,
			[threadId]: {
				...thread,
				todoList: todos,
				lastModified: new Date().toISOString(),
			}
		};
		this._storeAllThreads(newThreads);
		this._setState({ allThreads: newThreads });
		// Phase 1.3 fix: fire the dedicated todo-list event so subscribers (PlanTodoSyncService)
		// do not have to subscribe to onDidChangeCurrentThread and JSON-diff every state change.
		this._onDidChangeThreadTodoList.fire({ threadId });
	}

	getThreadTodoList(threadId: string): TodoItem[] | undefined {
		return this.state.allThreads[threadId]?.todoList;
	}

	setThreadTodoItemStatus(threadId: string, todoId: string, status: TodoStatus): void {
		const thread = this.state.allThreads[threadId];
		if (!thread?.todoList) return;
		const next = thread.todoList.map(t =>
			t.id === todoId ? { ...t, status } : t
		);
		// Reuse setThreadTodoList so the event fires exactly once and storage is updated.
		this.setThreadTodoList(threadId, next);
	}

	// --- Plan build state (in-memory, UI only) ---

	getPlanBuildState(threadId: string): PlanBuildState {
		return this._planBuildStateByThread.get(threadId) ?? 'idle';
	}

	setPlanBuildState(threadId: string, state: PlanBuildState): void {
		if (this._planBuildStateByThread.get(threadId) === state) return;
		this._planBuildStateByThread.set(threadId, state);
		this._onDidChangePlanBuildState.fire({ threadId });
	}



}

registerSingleton(IChatThreadService, ChatThreadService, InstantiationType.Eager);
