/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { ChatMessage } from '../chatThreadServiceTypes.js';
import type { RawToolParamsObj } from '../sendLLMMessageTypes.js';
import { resolveBuiltinToolNameLoose } from '../prompt/prompts.js';
import { remoteAwaitShellResultFromOutput, remoteShellResultFromOutput } from '../shellToolHelpers.js';
import { StringSHA1 } from '../../../../../base/common/hash.js';
import {
	normalizeRemoteToolStartParams,
	remoteGlobResultFromOutput,
	remoteGrepResultFromOutput,
	remoteReadResultFromOutput,
} from './remoteToolResultHelpers.js';
import type { BuiltinToolCallParams, ToolCallParams, ToolName } from '../toolsServiceTypes.js';
import type { RunnerTaskEventPayload } from './runnerProtocol.js';
import type { RemoteTaskSummary } from './runnerTypes.js';
import { formatRemoteTaskTerminalMessage } from './remoteTaskUiStatus.js';

type EventData = Record<string, unknown>;

type RemoteSetupStep = {
	id: string;
	label: string;
	detail?: string;
};

type RemoteSetupParams = {
	steps: RemoteSetupStep[];
	progress?: string;
	/** High-level phase used for the collapsed header while setup is running. */
	phase?: 'queue' | 'environment' | 'workspace' | 'config';
};

const REMOTE_SETUP_TOOL = 'RemoteSetup' as ToolName;

const dataOf = (event: RunnerTaskEventPayload): EventData =>
	event.data && typeof event.data === 'object' && !Array.isArray(event.data)
		? event.data as EventData
		: {};

const textOf = (value: unknown): string => typeof value === 'string' ? value : '';

const isShellFamilyTool = (name: ToolName): boolean => name === 'Shell' || name === 'AwaitShell';

/** tool_error.result must be a string — never a structured shell object. */
const coerceToolErrorResult = (toolResult: unknown, output: string, error: string): string => {
	if (typeof toolResult === 'string' && toolResult) {
		return toolResult;
	}
	return error || output || 'Tool failed';
};

const resolveRemoteToolName = (raw: string): ToolName => {
	if (!raw) {
		return 'Shell' as ToolName;
	}
	return (resolveBuiltinToolNameLoose(raw) ?? raw) as ToolName;
};

const appendReasoningLine = (messages: ChatMessage[], line: string): void => {
	if (!line) { return; }
	const previous = messages[messages.length - 1];
	if (previous?.role === 'assistant' && !previous.displayContent) {
		messages[messages.length - 1] = assistantMessage('', [previous.reasoning, line].filter(Boolean).join('\n'));
	} else {
		messages.push(assistantMessage('', line));
	}
};

const assistantMessage = (displayContent = '', reasoning = ''): ChatMessage => ({
	role: 'assistant',
	displayContent,
	reasoning,
	anthropicReasoning: null,
});

const findRemoteSetupIndex = (messages: ChatMessage[]): number => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === 'tool' && message.name === REMOTE_SETUP_TOOL) {
			return i;
		}
	}
	return -1;
};

const getSetupParams = (message: Extract<ChatMessage, { role: 'tool' }>): RemoteSetupParams => {
	if (message.type === 'invalid_params') {
		return { steps: [] };
	}
	const fromParams = message.params as RemoteSetupParams | undefined;
	if (fromParams && Array.isArray(fromParams.steps)) {
		return {
			steps: fromParams.steps,
			progress: typeof fromParams.progress === 'string' ? fromParams.progress : undefined,
			phase: fromParams.phase,
		};
	}
	return { steps: [] };
};

const remoteSetupMessage = (
	id: string,
	params: RemoteSetupParams,
	type: 'running_now' | 'success',
): ChatMessage => ({
	role: 'tool',
	type,
	name: REMOTE_SETUP_TOOL,
	params: params as unknown as ToolCallParams<ToolName>,
	result: type === 'success' ? true : null,
	content: params.steps.map(step => step.label).join('\n'),
	id,
	rawParams: params as unknown as RawToolParamsObj,
	mcpServerName: undefined,
} as unknown as ChatMessage);

/** Lifecycle / provisioning as a dedicated card — never mixed into Thought/reasoning. */
const upsertLifecycleStep = (
	messages: ChatMessage[],
	taskId: string,
	step: RemoteSetupStep,
	phase?: RemoteSetupParams['phase'],
): void => {
	const index = findRemoteSetupIndex(messages);
	const id = `${taskId}:remote-setup`;
	if (index < 0) {
		messages.push(remoteSetupMessage(id, { steps: [step], phase }, 'running_now'));
		return;
	}

	const existing = messages[index];
	if (existing.role !== 'tool') {
		return;
	}
	const current = getSetupParams(existing);
	const steps = [...current.steps];
	const existingIdx = steps.findIndex(candidate => candidate.id === step.id);
	if (existingIdx >= 0) {
		steps[existingIdx] = { ...steps[existingIdx], ...step };
	} else {
		steps.push(step);
	}
	messages[index] = remoteSetupMessage(existing.id, {
		steps,
		progress: current.progress,
		phase: phase ?? current.phase,
	}, 'running_now');
};

const setLifecycleProgress = (messages: ChatMessage[], taskId: string, progress: string): void => {
	if (!progress) {
		return;
	}
	const index = findRemoteSetupIndex(messages);
	if (index < 0) {
		upsertLifecycleStep(messages, taskId, { id: 'progress', label: progress });
		return;
	}
	const existing = messages[index];
	if (existing.role !== 'tool') {
		return;
	}
	const current = getSetupParams(existing);
	const type = existing.type === 'success' ? 'success' : 'running_now';
	messages[index] = remoteSetupMessage(existing.id, { ...current, progress }, type);
};

const completeLifecycle = (messages: ChatMessage[]): void => {
	const index = findRemoteSetupIndex(messages);
	if (index < 0) {
		return;
	}
	const existing = messages[index];
	if (existing.role !== 'tool' || existing.type === 'success') {
		return;
	}
	messages[index] = remoteSetupMessage(existing.id, getSetupParams(existing), 'success');
};

const findToolMessageIndex = (
	messages: ChatMessage[],
	toolMessageIndex: Map<string, number>,
	id: string,
	name?: string,
): number | undefined => {
	if (id && toolMessageIndex.has(id)) {
		return toolMessageIndex.get(id);
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const candidate = messages[i];
		if (candidate.role !== 'tool') {
			continue;
		}
		if (id && candidate.id === id) {
			return i;
		}
		if (
			!id
			&& (candidate.type === 'running_now' || candidate.type === 'tool_request')
			&& (!name || candidate.name === name)
		) {
			return i;
		}
	}
	return undefined;
};

/**
 * Stable identity for the local transcript prefix anchoring a remote turn.
 * Uses SHA-1 truncated to 16 hex chars via StringSHA1 (sync; stronger than the
 * previous FNV-1a `v1:` anchors). Prefix `v2:` so old anchors never false-match.
 */
export function remoteTaskHistoryAnchor(messages: readonly ChatMessage[], count = messages.length): string {
	const stable = messages.slice(0, count).map(message => {
		if (message.role === 'user') return ['user', message.displayContent];
		if (message.role === 'assistant') return ['assistant', message.displayContent];
		if (message.role === 'checkpoint') return ['checkpoint', message.type];
		if (message.role === 'tool') return ['tool', message.id, message.name, message.content];
		return ['interrupted_tool', message.name];
	});
	const value = JSON.stringify(stable);
	const sha = new StringSHA1();
	sha.update(value);
	return `v2:${count}:${sha.digest().slice(0, 16)}`;
}

export type RemoteTaskChatMessagesOptions = {
	/** When the editor already persisted the user turn at editorMessageIndex, omit the synthetic bubble. */
	skipUserMessage?: boolean;
};

const shortSha = (commit: string): string => commit.length > 7 ? commit.slice(0, 7) : commit;

/** True when a persisted local user message at the anchor already represents this remote prompt. */
export function shouldSkipRemoteUserMessage(
	summary: RemoteTaskSummary,
	localMessages: readonly ChatMessage[],
	editorMessageIndex?: number,
): boolean {
	const injectIndex = editorMessageIndex ?? localMessages.length;
	const userIndex = injectIndex - 1;
	if (userIndex < 0 || userIndex >= localMessages.length) {
		return false;
	}
	const local = localMessages[userIndex];
	if (local.role !== 'user') {
		return false;
	}
	const prompt = summary.prompt.trim();
	const content = (local.displayContent || local.content || '').trim();
	return content === prompt || content.startsWith(prompt) || prompt.startsWith(content);
}

/**
 * Converts the runner's durable append-only event stream into the exact message model used by
 * local agents. The normal ChatBubble renderers can therefore display remote reasoning, tool
 * calls/results, and assistant responses without a second reduced-function conversation UI.
 */
export function remoteTaskChatMessages(
	summary: RemoteTaskSummary,
	events: readonly RunnerTaskEventPayload[],
	options?: RemoteTaskChatMessagesOptions,
): ChatMessage[] {
const messages: ChatMessage[] = options?.skipUserMessage ? [] : [{
	role: 'user',
	content: summary.prompt,
	displayContent: summary.prompt,
	selections: [],
	state: { stagingSelections: [], isBeingEdited: false },
}];
const toolMessageIndex = new Map<string, number>();
let fallbackToolOrdinal = 0;
/** Tracks the last assistant bubble's iteration so a full `agent.message`
 * can reattach to the correct bubble even when a tool call separates the
 * streamed deltas from the final full-text event (reconnect replay edge). */
let lastAssistantIteration: number | undefined;
/** Index of the assistant bubble for each iteration — findAssistant must not
 * blindly return the most recent assistant after a same-iteration post-tool delta
 * created a duplicate bubble. */
const assistantIndexByIteration = new Map<number, number>();
/** Find the assistant message for a given iteration (or the latest if unknown). */
const findAssistantForIteration = (iteration: number | undefined): number => {
	if (iteration !== undefined) {
		const tracked = assistantIndexByIteration.get(iteration);
		if (tracked !== undefined && messages[tracked]?.role === 'assistant') {
			return tracked;
		}
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== 'assistant') { continue; }
		return i;
	}
	return -1;
};
const rememberAssistantIndex = (iteration: number | undefined, index: number): void => {
	if (iteration !== undefined) {
		assistantIndexByIteration.set(iteration, index);
	}
};

	for (const event of events) {
		const data = dataOf(event);
		if (event.kind === 'queue.wait') {
			upsertLifecycleStep(messages, summary.taskId, {
				id: 'queue',
				label: 'Waiting for a runner…',
				detail: textOf(data.reason) || undefined,
			}, 'queue');
			continue;
		}

		if (event.kind === 'state') {
			const to = textOf(data.to);
			if (to === 'PROVISIONING') {
				upsertLifecycleStep(messages, summary.taskId, {
					id: 'provision',
					label: 'Preparing environment…',
				}, 'environment');
				continue;
			}
			if (to === 'PREPARING_WORKSPACE') {
				const branch = textOf(data.branch) || summary.git?.branch || '';
				const commit = textOf(data.commit) || summary.git?.commit || '';
				const short = commit ? shortSha(commit) : '';
				const detailParts = [branch, short].filter(Boolean);
				upsertLifecycleStep(messages, summary.taskId, {
					id: 'clone',
					label: 'Setting up workspace…',
					detail: detailParts.length > 0 ? detailParts.join(' · ') : undefined,
				}, 'workspace');
				continue;
			}
			if (to === 'RUNNING') {
				completeLifecycle(messages);
			}
			continue;
		}

		if (event.kind === 'model.resolved') {
			// Keep model resolution out of the setup card — not user-facing setup copy.
			continue;
		}

		if (event.kind === 'environment.config.ignored') {
			upsertLifecycleStep(messages, summary.taskId, {
				id: 'config-ignored',
				label: 'Using default environment settings',
				detail: textOf(data.reason) || undefined,
			}, 'config');
			continue;
		}
		if (event.kind === 'task.continued') {
			upsertLifecycleStep(messages, summary.taskId, {
				id: 'continued',
				label: 'Continuing previous workspace…',
			}, 'workspace');
			continue;
		}

		if (event.kind === 'environment.setup.start') {
			upsertLifecycleStep(messages, summary.taskId, {
				id: 'setup',
				label: 'Configuring environment…',
			}, 'config');
			continue;
		}

		if (event.kind === 'environment.setup.output' || event.kind === 'environment.setup.end') {
			const detail = event.kind === 'environment.setup.end'
				? undefined
				: [textOf(data.stdout), textOf(data.stderr)].filter(Boolean).join('\n') || undefined;
			const label = event.kind === 'environment.setup.end'
				? 'Environment ready'
				: 'Configuring environment…';
			upsertLifecycleStep(messages, summary.taskId, {
				id: event.kind === 'environment.setup.end' ? 'setup-end' : 'setup',
				label,
				detail,
			}, 'config');
			continue;
		}

		if (event.kind === 'task.error' || event.kind === 'agent.error') {
			completeLifecycle(messages);
			const errorText = textOf(data.message);
			if (errorText) messages.push(assistantMessage(`Remote task failed: ${errorText}`));
			continue;
		}

		if (event.kind === 'artifact.branch' || event.kind === 'artifact.pr') {
			// Handoff metadata is consumed by RemoteTaskInlineCard — do not dump into chat.
			completeLifecycle(messages);
			continue;
		}

		if (event.kind === 'artifact.patch') {
			completeLifecycle(messages);
			const patch = textOf(data.patch);
			if (patch) {
				const params = { baseCommit: textOf(data.baseCommit), truncated: data.truncated === true } as unknown as ToolCallParams<ToolName>;
				messages.push({
					role: 'tool', type: data.exitCode === 0 ? 'success' : 'tool_error', name: 'RemotePatch' as ToolName,
					params, result: patch, content: patch, id: `${summary.taskId}:artifact-patch`,
					rawParams: params as RawToolParamsObj, mcpServerName: undefined,
				} as ChatMessage);
			}
			continue;
		}
		if (event.kind === 'agent.reasoning') {
			completeLifecycle(messages);
			appendReasoningLine(messages, textOf(data.content));
			continue;
		}
		if (event.kind === 'agent.progress') {
			const message = textOf(data.message);
			if (!message) continue;
			// Soft status only while the setup card is still running — never reopen it after complete.
			const setupIndex = findRemoteSetupIndex(messages);
			if (setupIndex >= 0) {
				const setup = messages[setupIndex];
				if (setup?.role === 'tool' && setup.type === 'running_now') {
					setLifecycleProgress(messages, summary.taskId, message);
				}
			}
			continue;
		}

	if (event.kind === 'agent.message.delta') {
		completeLifecycle(messages);
		const content = textOf(data.content);
		if (!content) continue;
		const iteration = typeof data.iteration === 'number' ? data.iteration : undefined;
		// A new iteration starts a fresh assistant bubble — never concatenate
		// streamed text across iterations (the model may restate/revise).
		if (iteration !== undefined && iteration !== lastAssistantIteration) {
			messages.push(assistantMessage(content));
			lastAssistantIteration = iteration;
			rememberAssistantIndex(iteration, messages.length - 1);
			continue;
		}
		// Same iteration: reattach even when a tool message sits between deltas
		// (reconnect / mid-turn tools) instead of spawning a duplicate bubble.
		const reattachIdx = findAssistantForIteration(iteration);
		if (reattachIdx >= 0) {
			const existing = messages[reattachIdx];
			if (existing?.role === 'assistant') {
				messages[reattachIdx] = assistantMessage(existing.displayContent + content, existing.reasoning);
				lastAssistantIteration = iteration;
				rememberAssistantIndex(iteration, reattachIdx);
				continue;
			}
		}
		messages.push(assistantMessage(content));
		lastAssistantIteration = iteration;
		rememberAssistantIndex(iteration, messages.length - 1);
		continue;
	}

	if (event.kind === 'agent.message') {
		completeLifecycle(messages);
		const content = textOf(data.content);
		if (!content) continue;
		const iteration = typeof data.iteration === 'number' ? data.iteration : undefined;
		// Reattach to the matching-iteration assistant bubble even when a tool
		// message separates the streamed deltas from this final full-text event
		// (happens on reconnect replay). Falls back to a new bubble only when no
		// matching bubble exists or the full text isn't a superset of the partial.
		if (iteration !== undefined) {
			const idx = findAssistantForIteration(iteration);
			if (idx >= 0) {
				const existing = messages[idx];
				if (existing?.role === 'assistant'
					&& (!existing.displayContent || content.startsWith(existing.displayContent))) {
					messages[idx] = assistantMessage(content, existing.reasoning);
					lastAssistantIteration = iteration;
					rememberAssistantIndex(iteration, idx);
					continue;
				}
			}
		}
		const previous = messages[messages.length - 1];
		if (previous?.role === 'assistant'
			&& (!previous.displayContent || content.startsWith(previous.displayContent))) {
			messages[messages.length - 1] = assistantMessage(content, previous.reasoning);
			rememberAssistantIndex(iteration, messages.length - 1);
		} else {
			messages.push(assistantMessage(content));
			rememberAssistantIndex(iteration, messages.length - 1);
		}
		lastAssistantIteration = iteration;
		continue;
	}

		if (event.kind === 'tool.start') {
			completeLifecycle(messages);
			const name = resolveRemoteToolName(textOf(data.name));
			if (!name) continue;
			const id = textOf(data.toolCallId) || `${summary.taskId}:tool:${fallbackToolOrdinal++}`;
			const rawArgs = (data.args && typeof data.args === 'object' ? data.args : {}) as Record<string, unknown>;
			const params = normalizeRemoteToolStartParams(name, rawArgs);
			const existingIndex = findToolMessageIndex(messages, toolMessageIndex, id, name);
			const message = {
				role: 'tool',
				type: 'running_now',
				name,
				params,
				result: null,
				content: '',
				id,
				rawParams: rawArgs as RawToolParamsObj,
				mcpServerName: undefined,
			} as ChatMessage;
			if (existingIndex === undefined) {
				toolMessageIndex.set(id, messages.length);
				messages.push(message);
			} else {
				toolMessageIndex.set(id, existingIndex);
				messages[existingIndex] = message;
			}
			continue;
		}

		if (event.kind === 'approval.requested') {
			completeLifecycle(messages);
			const id = textOf(data.toolCallId) || `${summary.taskId}:approval:${textOf(data.approvalId) || event.seq}`;
			const name = resolveRemoteToolName(textOf(data.toolName));
			const rawArgs = (data.toolArgs && typeof data.toolArgs === 'object' && !Array.isArray(data.toolArgs)
				? data.toolArgs
				: {}) as Record<string, unknown>;
			const params = normalizeRemoteToolStartParams(name, rawArgs);
			const existingIndex = findToolMessageIndex(messages, toolMessageIndex, id, name);
			const message = {
				role: 'tool',
				type: 'tool_request',
				name,
				params,
				result: null,
				content: textOf(data.reason) || 'Awaiting approval',
				id,
				rawParams: rawArgs as RawToolParamsObj,
				mcpServerName: undefined,
			} as ChatMessage;
			if (existingIndex === undefined) {
				toolMessageIndex.set(id, messages.length);
				messages.push(message);
			} else {
				toolMessageIndex.set(id, existingIndex);
				messages[existingIndex] = message;
			}
			continue;
		}

		if (event.kind === 'approval.resolved') {
			const id = textOf(data.toolCallId);
			const decision = textOf(data.decision);
			const index = findToolMessageIndex(messages, toolMessageIndex, id);
			if (index === undefined) {
				continue;
			}
			const existing = messages[index];
			if (existing?.role !== 'tool' || existing.type === 'invalid_params') {
				continue;
			}
			if (decision === 'deny') {
				messages[index] = {
					...existing,
					type: 'rejected',
					result: null,
					content: existing.content || 'Skipped',
				} as ChatMessage;
			} else if (existing.type === 'tool_request') {
				// Stay as tool_request until tool.start flips to running_now — avoids a flash.
				// If allow arrives without a later start (edge), leave request; start will replace.
			}
			continue;
		}

		if (event.kind === 'tool.result') {
			completeLifecycle(messages);
			const name = resolveRemoteToolName(textOf(data.name));
			const id = textOf(data.toolCallId);
			const output = textOf(data.output) || textOf(data.preview);
			let index = findToolMessageIndex(messages, toolMessageIndex, id, name);
			const running = index === undefined ? undefined : messages[index];
			const rawArgsFromEvent = (data.args && typeof data.args === 'object' && !Array.isArray(data.args)
				? data.args
				: undefined) as Record<string, unknown> | undefined;
			const rawArgs = running?.role === 'tool' && running.type !== 'invalid_params'
				? running.rawParams as Record<string, unknown>
				: (rawArgsFromEvent ?? {});
			const params = running?.role === 'tool' && running.type !== 'invalid_params'
				? running.params
				: normalizeRemoteToolStartParams((name || 'Shell') as ToolName, rawArgs);
			const resolvedId = id || (running?.role === 'tool' ? running.id : `${summary.taskId}:tool-result:${event.seq}`);
			const succeeded = data.ok !== false;
			const rejected = data.rejected === true || textOf(data.error).startsWith('User denied:');
			const resolvedName = name || (running?.role === 'tool' ? running.name : 'Shell');
			let toolResult: unknown = output;
			if (resolvedName === 'Shell') {
				toolResult = remoteShellResultFromOutput(
					output,
					succeeded,
					params as BuiltinToolCallParams['Shell'],
					textOf(data.error),
					data.result,
				);
			} else if (resolvedName === 'AwaitShell') {
				toolResult = remoteAwaitShellResultFromOutput(
					output,
					params as BuiltinToolCallParams['AwaitShell'],
					data.result,
				);
			} else if (resolvedName === 'Glob') {
				toolResult = remoteGlobResultFromOutput(output, data.result);
			} else if (resolvedName === 'Grep') {
				toolResult = remoteGrepResultFromOutput(output, data.result);
			} else if (resolvedName === 'Read') {
				toolResult = remoteReadResultFromOutput(
					output,
					params as BuiltinToolCallParams['Read'],
					succeeded,
					textOf(data.error),
				);
			}
			// Shell/AwaitShell mirror the local agent: structured results (exit codes, timeouts)
			// are stored as success, not tool_error. tool_error is reserved for string errors.
			let messageType: 'success' | 'tool_error' | 'rejected';
			let messageResult: unknown;
			if (rejected) {
				messageType = 'rejected';
				messageResult = null;
			} else if (isShellFamilyTool(resolvedName)) {
				messageType = 'success';
				messageResult = toolResult;
			} else if (succeeded) {
				messageType = 'success';
				messageResult = toolResult;
			} else {
				messageType = 'tool_error';
				messageResult = coerceToolErrorResult(toolResult, output, textOf(data.error));
			}
			const result = {
				role: 'tool',
				type: messageType,
				name: resolvedName,
				params,
				result: messageResult,
				content: output || textOf(data.error),
				id: resolvedId,
				rawParams: (running?.role === 'tool' ? running.rawParams : params) as RawToolParamsObj,
				mcpServerName: undefined,
			} as ChatMessage;
			if (index === undefined) {
				toolMessageIndex.set(resolvedId, messages.length);
				messages.push(result);
			} else {
				toolMessageIndex.set(resolvedId, index);
				messages[index] = result;
			}
			continue;
		}

		if (event.kind === 'agent.done') {
			completeLifecycle(messages);
			const finalText = textOf(data.finalText);
			const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant');
			if (finalText && (lastAssistant?.role !== 'assistant' || lastAssistant.displayContent !== finalText)) {
				messages.push(assistantMessage(finalText));
			}
		}
	}

	// Fail-closed / cancel / timeout often set summary.lastError without a task.error event.
	// Surface that into the durable transcript so materialize does not drop to an empty stub.
	const terminalBad = summary.state === 'FAILED'
		|| summary.state === 'CANCELLED'
		|| summary.state === 'TIMED_OUT'
		|| summary.state === 'LOST';
	if (terminalBad) {
		completeLifecycle(messages);
		const err = (summary.lastError ?? '').trim();
		const alreadyHasError = err
			? messages.some(message => message.role === 'assistant' && message.displayContent.includes(err))
			: messages.some(message => message.role === 'assistant');
		if (!alreadyHasError) {
			messages.push(assistantMessage(formatRemoteTaskTerminalMessage(summary.state, summary.lastError)));
		}
	}

	return messages;
}
