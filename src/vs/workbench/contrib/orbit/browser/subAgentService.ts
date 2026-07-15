/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { approvalTypeOfBuiltinToolName, IToolsService } from '../common/toolsServiceTypes.js';
import { IVoidSettingsService } from '../common/orbitSettingsService.js';
import { IMCPService } from '../common/mcpService.js';
import { SubAgentDefinition, getEffectiveDisallowedTools } from '../common/subAgentRegistry.js';
import { AnthropicReasoning, RawToolCallObj } from '../common/sendLLMMessageTypes.js';
import { ChatMessage } from '../common/chatThreadServiceTypes.js';
import { isMCPToolReadOnly, resolveBuiltinToolName } from '../common/prompt/prompts.js';
import { RawMCPToolCall } from '../common/mcpServiceTypes.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
import { IVoidNativeNotificationService } from './nativeNotificationService.js';
import { withTimeout } from '../common/asyncUtils.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { getPathAccessApprovalReason } from '../common/agentToolSecurity.js';

export interface ISubAgentService {
	readonly _serviceBrand: undefined;
	/** Fires when a sub-agent executes a tool: { toolId: parent task tool id, activity: tool name } */
	readonly onProgress: Event<{ toolId: string; activity: string }>;
	/** Fires when a background agent completes: { toolId, threadId, description, result } */
	readonly onBackgroundComplete: Event<{ toolId: string; threadId: string; description: string; result: SubAgentRunResult }>;
	/** Fires as the sub-agent's internal conversation grows (for live popup UI). */
	readonly onSubAgentConversationUpdate: Event<{ toolId: string; threadId: string; messages: ChatMessage[] }>;
	cancelBackgroundRun(toolId: string): boolean;
	cancelBackgroundRunsForThread(threadId: string): number;
	/** Cancel a single in-flight foreground sub-agent without stopping the parent agent. */
	cancelForegroundRun(toolId: string): boolean;
	cancelForegroundRunsForThread(threadId: string): number;
	runSubAgent(opts: {
		agent: SubAgentDefinition;
		prompt: string;
		description: string;
		toolId: string;
		threadId: string;
		modelOverride?: string;
		runInBackground?: boolean;
		abortRef?: { current: (() => void) | null };
	}): Promise<SubAgentRunResult>;
}

export const ISubAgentService = createDecorator<ISubAgentService>('SubAgentService');

// Safety net for custom agents that omit `maxTurns` in their .orbit/agents/*.md frontmatter.
// Not used by any built-in agent (explore=40, plan=35, general=50 — see subAgentRegistry.ts).
const DEFAULT_MAX_TURNS = 40;

const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60_000;

export type SubAgentTerminalStatus = 'completed' | 'failed' | 'cancelled';

export type SubAgentRunResult = {
	output: string;
	agentType: string;
	durationMs: number;
	toolUseCount: number;
	status: SubAgentTerminalStatus | 'background_launched';
};

type ActiveSubAgentRun = {
	toolId: string;
	threadId: string;
	description: string;
	cancelRequested: boolean;
	cancelCurrent?: () => void;
	toolUseCount: number;
};

class SubAgentCancelledError extends Error {
	constructor() {
		super('Sub-agent run was cancelled.');
		this.name = 'SubAgentCancelledError';
	}
}

class SubAgentFailedError extends Error {
	constructor(
		readonly output: string,
		readonly durationMs: number,
		readonly toolUseCount: number,
	) {
		super(output);
		this.name = 'SubAgentFailedError';
	}
}

export class SubAgentService extends Disposable implements ISubAgentService {
	_serviceBrand: undefined;

	private _toolsService: IToolsService | undefined;
	private readonly _backgroundRuns = new Map<string, ActiveSubAgentRun>();
	private readonly _foregroundRuns = new Map<string, ActiveSubAgentRun>();

	private readonly _onProgress = this._register(new Emitter<{ toolId: string; activity: string }>());
	readonly onProgress: Event<{ toolId: string; activity: string }> = this._onProgress.event;

	private readonly _onBackgroundComplete = this._register(new Emitter<{ toolId: string; threadId: string; description: string; result: SubAgentRunResult }>());
	readonly onBackgroundComplete: Event<{ toolId: string; threadId: string; description: string; result: SubAgentRunResult }> = this._onBackgroundComplete.event;

	private readonly _onSubAgentConversationUpdate = this._register(new Emitter<{ toolId: string; threadId: string; messages: ChatMessage[] }>());
	readonly onSubAgentConversationUpdate: Event<{ toolId: string; threadId: string; messages: ChatMessage[] }> = this._onSubAgentConversationUpdate.event;

	constructor(
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
		@IMCPService private readonly _mcpService: IMCPService,
		@IConvertToLLMMessageService private readonly _convertService: IConvertToLLMMessageService,
		@IVoidNativeNotificationService private readonly _notificationService: IVoidNativeNotificationService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	private _getToolsService(): IToolsService {
		if (!this._toolsService) {
			this._toolsService = this._instantiationService.invokeFunction(accessor => accessor.get(IToolsService));
		}
		return this._toolsService;
	}

	cancelBackgroundRun(toolId: string): boolean {
		const run = this._backgroundRuns.get(toolId);
		if (!run) return false;
		run.cancelRequested = true;
		run.cancelCurrent?.();
		this._onProgress.fire({ toolId, activity: 'Stopping…' });
		return true;
	}

	cancelBackgroundRunsForThread(threadId: string): number {
		let count = 0;
		for (const run of this._backgroundRuns.values()) {
			if (run.threadId === threadId) {
				run.cancelRequested = true;
				run.cancelCurrent?.();
				count++;
			}
		}
		return count;
	}

	cancelForegroundRun(toolId: string): boolean {
		const run = this._foregroundRuns.get(toolId);
		if (!run) return false;
		run.cancelRequested = true;
		run.cancelCurrent?.();
		this._onProgress.fire({ toolId, activity: 'Stopping…' });
		return true;
	}

	cancelForegroundRunsForThread(threadId: string): number {
		let count = 0;
		for (const run of this._foregroundRuns.values()) {
			if (run.threadId === threadId) {
				run.cancelRequested = true;
				run.cancelCurrent?.();
				count++;
			}
		}
		return count;
	}

	private _throwIfCancelled(activeRun: ActiveSubAgentRun | undefined): void {
		if (activeRun?.cancelRequested) {
			throw new SubAgentCancelledError();
		}
	}

	private _setCancelable(activeRun: ActiveSubAgentRun | undefined, abortRef: { current: (() => void) | null } | undefined, cancel: (() => void) | null): void {
		if (activeRun) {
			activeRun.cancelCurrent = cancel ?? undefined;
		}
		if (abortRef) {
			abortRef.current = cancel;
		}
	}

	private _terminalResult(agentType: string, status: SubAgentTerminalStatus, output: string, durationMs: number, toolUseCount: number): SubAgentRunResult {
		return { output, agentType, durationMs, toolUseCount, status };
	}

	async runSubAgent(opts: {
		agent: SubAgentDefinition;
		prompt: string;
		description: string;
		toolId: string;
		threadId: string;
		modelOverride?: string;
		runInBackground?: boolean;
		abortRef?: { current: (() => void) | null };
	}): Promise<SubAgentRunResult> {
		const { agent, prompt, description, toolId, threadId, modelOverride, runInBackground, abortRef } = opts;

		if (runInBackground) {
			const activeRun: ActiveSubAgentRun = { toolId, threadId, description, cancelRequested: false, toolUseCount: 0 };
			const backgroundStartTime = Date.now();
			this._backgroundRuns.set(toolId, activeRun);
			// Launch in background — return immediately, notify when done
			void this._runLoop({ agent, prompt, description, toolId, threadId, modelOverride, abortRef, activeRun, isBackground: true }).then(result => {
				const completedResult = { ...result, status: 'completed' as const };
				this._onBackgroundComplete.fire({ toolId, threadId, description, result: completedResult });
				this._notificationService.showNotification(
					`Agent done: ${description}`,
					`${agent.agentType} completed in ${result.durationMs < 1000 ? `${result.durationMs}ms` : `${(result.durationMs / 1000).toFixed(1)}s`} · ${result.toolUseCount} tools used`,
				);
			}).catch((err: unknown) => {
				const status: SubAgentTerminalStatus = err instanceof SubAgentCancelledError ? 'cancelled' : 'failed';
				const output = status === 'cancelled'
					? 'Background sub-agent was stopped before it completed.'
					: err instanceof SubAgentFailedError ? err.output : `Sub-agent error: ${err instanceof Error ? err.message : String(err)}`;
				const result = this._terminalResult(
					agent.agentType,
					status,
					output,
					err instanceof SubAgentFailedError ? err.durationMs : Date.now() - backgroundStartTime,
					err instanceof SubAgentFailedError ? err.toolUseCount : activeRun.toolUseCount,
				);
				this._onBackgroundComplete.fire({ toolId, threadId, description, result });
				this._notificationService.showNotification(
					status === 'cancelled' ? `Agent stopped: ${description}` : `Agent failed: ${description}`,
					output,
				);
			}).finally(() => {
				this._backgroundRuns.delete(toolId);
			});

			return {
				output: `Agent '${agent.agentType}' launched in background. You will be notified when it completes. Continue with other work.`,
				agentType: agent.agentType,
				durationMs: 0,
				toolUseCount: 0,
				status: 'background_launched',
			};
		}

		const foregroundStartTime = Date.now();
		const activeRun: ActiveSubAgentRun = { toolId, threadId, description, cancelRequested: false, toolUseCount: 0 };
		this._foregroundRuns.set(toolId, activeRun);
		try {
			const result = await this._runLoop({ agent, prompt, description, toolId, threadId, modelOverride, abortRef, activeRun, isBackground: false });
			return { ...result, status: 'completed' };
		} catch (err: unknown) {
			if (err instanceof SubAgentCancelledError) {
				return this._terminalResult(
					agent.agentType,
					'cancelled',
					'Sub-agent was stopped before it completed.',
					Date.now() - foregroundStartTime,
					activeRun.toolUseCount,
				);
			}
			if (err instanceof SubAgentFailedError) {
				return this._terminalResult(agent.agentType, 'failed', err.output, err.durationMs, err.toolUseCount);
			}
			return this._terminalResult(agent.agentType, 'failed', `Sub-agent error: ${err instanceof Error ? err.message : String(err)}`, Date.now() - foregroundStartTime, activeRun.toolUseCount);
		} finally {
			this._foregroundRuns.delete(toolId);
			this._setCancelable(undefined, abortRef, null);
		}
	}

	private async _runLoop(opts: {
		agent: SubAgentDefinition;
		prompt: string;
		description: string;
		toolId: string;
		threadId: string;
		modelOverride?: string;
		abortRef?: { current: (() => void) | null };
		activeRun?: ActiveSubAgentRun;
		isBackground: boolean;
	}): Promise<{ output: string; agentType: string; durationMs: number; toolUseCount: number }> {
		const { agent, prompt, description, toolId, threadId, modelOverride, abortRef, activeRun, isBackground } = opts;
		const startTime = Date.now();

		const featureName = 'Chat' as const;
		const parentModelSelection = this._settingsService.state.modelSelectionOfFeature[featureName];
		const modelSelection = (modelOverride && parentModelSelection)
			? { ...parentModelSelection, modelName: modelOverride }
			: parentModelSelection;
		const modelSelectionOptions = modelSelection
			? this._settingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]
			: undefined;
		const overridesOfModel = this._settingsService.state.overridesOfModel;

		// Resolve effective disallowed tools from permissionMode or explicit list
		const disallowedTools = getEffectiveDisallowedTools(agent);

		const toolPolicy = {
			disallowedBuiltinTools: disallowedTools,
			allowReadOnlyMcpOnly: agent.permissionMode === 'read_only',
			denyDelegation: true as const,
		};

		const chatMessages: ChatMessage[] = [{
			role: 'user',
			content: prompt,
			displayContent: prompt,
			selections: null,
			state: { stagingSelections: [], isBeingEdited: false },
		}];

		const emitConversation = () => {
			this._onSubAgentConversationUpdate.fire({
				toolId,
				threadId,
				messages: [...chatMessages],
			});
		};
		const appendChatMessage = (message: ChatMessage) => {
			chatMessages.push(message);
			emitConversation();
		};

		emitConversation();

		let lastText = '';
		let toolUseCount = 0;
		let turns = 0;
		let completedNormally = false;
		const maxTurns = agent.maxTurns ?? DEFAULT_MAX_TURNS;

		while (turns < maxTurns) {
			this._throwIfCancelled(activeRun);
			turns++;

			const { messages, separateSystemMessage } = await this._convertService.prepareLLMChatMessages({
				chatMessages,
				chatMode: 'agent',
				modelSelection,
				toolPolicy,
			});

			const agentSystemPrompt = agent.getSystemPrompt();
			const finalSystemMessage = separateSystemMessage
				? `${agentSystemPrompt}\n\n${separateSystemMessage}`
				: agentSystemPrompt;

			const result = await new Promise<
				| { type: 'done'; fullText: string; fullReasoning: string; anthropicReasoning: AnthropicReasoning[] | null; toolCalls: RawToolCallObj[] }
				| { type: 'error'; message: string }
				| { type: 'aborted' }
			>((resolve) => {
				const cancelToken = this._llmMessageService.sendLLMMessage({
					messagesType: 'chatMessages',
					chatMode: 'agent',
					messages,
					modelSelection,
					modelSelectionOptions,
					overridesOfModel,
					toolPolicy,
					separateSystemMessage: finalSystemMessage,
					suppressStreamingEvents: true,
					logging: { loggingName: `SubAgent:${agent.agentType}`, loggingExtras: { agentType: agent.agentType, description } },
					onText: () => { /* streaming not needed */ },
					onFinalMessage: ({ fullText, fullReasoning, anthropicReasoning, toolCall, toolCalls }) => {
						const all = toolCalls && toolCalls.length > 0 ? toolCalls : (toolCall ? [toolCall] : []);
						resolve({ type: 'done', fullText, fullReasoning, anthropicReasoning, toolCalls: all });
					},
					onError: ({ message }) => resolve({ type: 'error', message }),
					onAbort: () => resolve({ type: 'aborted' }),
				});

				if (cancelToken) {
					this._setCancelable(activeRun, abortRef, () => this._llmMessageService.abort(cancelToken));
				}
			});
			this._setCancelable(activeRun, abortRef, null);

			if (result.type === 'aborted') {
				throw new SubAgentCancelledError();
			}
			if (result.type === 'error') {
				throw new SubAgentFailedError(`Sub-agent error: ${result.message}`, Date.now() - startTime, toolUseCount);
			}

			lastText = result.fullText;

			// Store reasoning so providers (DeepSeek, Anthropic) receive it back on the next turn
			appendChatMessage({
				role: 'assistant',
				displayContent: result.fullText,
				reasoning: result.fullReasoning || '',
				anthropicReasoning: result.anthropicReasoning,
			});

			if (result.toolCalls.length === 0) {
				completedNormally = true;
				break;
			}

			for (const toolCall of result.toolCalls) {
				this._throwIfCancelled(activeRun);
				const toolName = toolCall.name;
				const callId = toolCall.id || generateUuid();
				const builtinName = resolveBuiltinToolName(toolName);

				if (builtinName === 'AskQuestion') {
					const message = 'AskQuestion cannot run inside a sub-agent — it requires user interaction.';
					this._onProgress.fire({ toolId, activity: `Blocked: ${toolName}` });
					appendChatMessage({ role: 'tool', type: 'tool_error', name: toolName, params: {} as any, result: message, content: message, id: callId, rawParams: toolCall.rawParams, mcpServerName: undefined });
					continue;
				}

				// Hard recursion guard
				if (builtinName === 'task') {
					appendChatMessage({ role: 'tool', type: 'tool_error', name: toolName, params: {} as any, result: 'Sub-agents cannot spawn further sub-agents.', content: 'Sub-agents cannot spawn further sub-agents.', id: callId, rawParams: toolCall.rawParams, mcpServerName: undefined });
					continue;
				}

				// Permission check
				if (builtinName && (disallowedTools as string[]).includes(builtinName)) {
					this._onProgress.fire({ toolId, activity: `Blocked: ${toolName}` });
					appendChatMessage({ role: 'tool', type: 'tool_error', name: toolName, params: {} as any, result: `Tool '${toolName}' is not allowed for the ${agent.agentType} agent (${agent.permissionMode ?? 'custom'} mode).`, content: `Tool '${toolName}' is not allowed for the ${agent.agentType} agent.`, id: callId, rawParams: toolCall.rawParams, mcpServerName: undefined });
					continue;
				}

				if (isBackground && builtinName && approvalTypeOfBuiltinToolName[builtinName]) {
					const message = `Tool '${toolName}' requires user approval and cannot run inside a background sub-agent.`;
					this._onProgress.fire({ toolId, activity: `Blocked: ${toolName}` });
					appendChatMessage({ role: 'tool', type: 'tool_error', name: toolName, params: {} as any, result: message, content: message, id: callId, rawParams: toolCall.rawParams, mcpServerName: undefined });
					continue;
				}

				this._onProgress.fire({ toolId, activity: toolName });
				toolUseCount++;
				if (activeRun) {
					activeRun.toolUseCount = toolUseCount;
				}

				let resultStr: string;
				try {
					if (builtinName) {
						const toolsService = this._getToolsService();
						const params = toolsService.validateParams[builtinName](toolCall.rawParams as any);
						const pathReason = getPathAccessApprovalReason(
							builtinName,
							params,
							uri => this._workspaceContextService.isInsideWorkspace(uri),
						);
						if (pathReason) {
							resultStr = `Tool '${toolName}' requires user approval for ${pathReason} and cannot run inside a sub-agent.`;
							this._onProgress.fire({ toolId, activity: `Blocked: ${toolName}` });
							appendChatMessage({ role: 'tool', type: 'tool_error', name: builtinName, params: params as any, result: resultStr, content: resultStr, id: callId, rawParams: toolCall.rawParams, mcpServerName: undefined });
							continue;
						}

						const approvalType = approvalTypeOfBuiltinToolName[builtinName];
						const forceApproval = builtinName === 'Shell'
							&& (params as any).requestSmartModeApproval === true;
						if (approvalType && (!this._settingsService.state.globalSettings.autoApprove[approvalType] || forceApproval)) {
							resultStr = `Tool '${toolName}' requires ${approvalType} approval and cannot run inside a sub-agent. Enable auto-approval for ${approvalType} or run the operation in the parent agent.`;
							this._onProgress.fire({ toolId, activity: `Blocked: ${toolName}` });
							appendChatMessage({ role: 'tool', type: 'tool_error', name: builtinName, params: params as any, result: resultStr, content: resultStr, id: callId, rawParams: toolCall.rawParams, mcpServerName: undefined });
							continue;
						}

						const { result: toolResult, interruptTool } = await toolsService.callTool[builtinName](params as any);
						this._setCancelable(activeRun, abortRef, interruptTool ?? null);
						const resolved = await toolResult;
						this._throwIfCancelled(activeRun);
						this._setCancelable(activeRun, abortRef, null);
						resultStr = toolsService.stringOfResult[builtinName](params as any, resolved as any);
						appendChatMessage({ role: 'tool', type: 'success', name: builtinName, params: params as any, result: resolved as any, content: resultStr, id: callId, rawParams: toolCall.rawParams, mcpServerName: undefined });
					} else {
						const mcpTool = this._mcpService.getMCPTools()?.find(t => t.name === toolName);
						if (mcpTool) {
							if (agent.permissionMode === 'read_only' && !isMCPToolReadOnly(mcpTool)) {
								resultStr = `MCP tool '${toolName}' is not marked read-only and is blocked for the ${agent.agentType} agent.`;
								this._onProgress.fire({ toolId, activity: `Blocked: ${toolName}` });
								appendChatMessage({ role: 'tool', type: 'tool_error', name: toolName, params: toolCall.rawParams as any, result: resultStr, content: resultStr, id: callId, rawParams: toolCall.rawParams, mcpServerName: mcpTool.mcpServerName });
								continue;
							}
							if (isBackground && !isMCPToolReadOnly(mcpTool)) {
								resultStr = `MCP tool '${toolName}' may require approval and cannot run inside a background sub-agent.`;
								this._onProgress.fire({ toolId, activity: `Blocked: ${toolName}` });
								appendChatMessage({ role: 'tool', type: 'tool_error', name: toolName, params: toolCall.rawParams as any, result: resultStr, content: resultStr, id: callId, rawParams: toolCall.rawParams, mcpServerName: mcpTool.mcpServerName });
								continue;
							}
							// Cancel the underlying MCP call on timeout (or if the run is cancelled) so it
							// doesn't keep running server-side. The token is bridged to an AbortSignal in
							// the MCP channel.
							const mcpTimeoutMs = this._settingsService.state.globalSettings.mcpToolTimeoutMs ?? DEFAULT_MCP_TOOL_TIMEOUT_MS;
							const mcpCts = new CancellationTokenSource();
							const mcpTimer = setTimeout(() => mcpCts.cancel(), mcpTimeoutMs);
							this._setCancelable(activeRun, abortRef, () => mcpCts.cancel());
							let mcpResult;
							try {
								mcpResult = await withTimeout(
									this._mcpService.callMCPTool({ serverName: mcpTool.mcpServerName ?? 'unknown', toolName, params: toolCall.rawParams }, mcpCts.token),
									mcpTimeoutMs,
									toolName,
								);
							} finally {
								clearTimeout(mcpTimer);
								mcpCts.dispose(true);
								this._setCancelable(activeRun, abortRef, null);
							}
							this._throwIfCancelled(activeRun);
							resultStr = this._mcpService.stringifyResult(mcpResult.result as RawMCPToolCall);
						} else {
							resultStr = `Tool '${toolName}' is not available.`;
						}
						appendChatMessage({ role: 'tool', type: 'success', name: toolName, params: toolCall.rawParams as any, result: resultStr as any, content: resultStr, id: callId, rawParams: toolCall.rawParams, mcpServerName: mcpTool?.mcpServerName });
					}
				} catch (e: unknown) {
					this._setCancelable(activeRun, abortRef, null);
					this._throwIfCancelled(activeRun);
					resultStr = `Tool error: ${e instanceof Error ? e.message : String(e)}`;
					appendChatMessage({ role: 'tool', type: 'tool_error', name: toolName, params: toolCall.rawParams as any, result: resultStr, content: resultStr, id: callId, rawParams: toolCall.rawParams, mcpServerName: undefined });
				}
			}
		}

		if (!completedNormally && turns >= maxTurns) {
			throw new SubAgentFailedError(
				`Sub-agent stopped after reaching the ${maxTurns}-turn limit before producing a final answer.${lastText ? `\n\nPartial output:\n${lastText}` : ''}`,
				Date.now() - startTime,
				toolUseCount,
			);
		}

		return { output: lastText || '(no output)', agentType: agent.agentType, durationMs: Date.now() - startTime, toolUseCount };
	}
}

registerSingleton(ISubAgentService, SubAgentService, InstantiationType.Delayed);
