/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { VoidFileSnapshot } from './editCodeServiceTypes.js';
import { AnthropicReasoning, RawToolParamsObj } from './sendLLMMessageTypes.js';
import { ToolCallParams, ToolName, ToolResult } from './toolsServiceTypes.js';

// TODO types
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type TodoPriority = 'high' | 'medium' | 'low';

export type TodoItem = {
	id: string;
	content: string;
	status: TodoStatus;
	priority?: TodoPriority;
	activeForm?: string; // Optional gerund form for display during execution (e.g., "Running tests")
};

export type TodoWriteItem = {
	id: string;
	content?: string;
	status?: TodoStatus;
	priority?: TodoPriority;
	activeForm?: string;
};

export type AskQuestionOption = {
	id: string;
	label: string;
};

export type AskQuestionItem = {
	id: string;
	prompt: string;
	options: AskQuestionOption[];
	allow_multiple: boolean;
};

export type AskQuestionUserAnswer = {
	questionId: string;
	selectedOptionIds: string[];
	otherText?: string;
};

export type AskQuestionResult = {
	answers: AskQuestionUserAnswer[];
	wasSkipped: boolean;
};

export type PlanBuildState = 'idle' | 'building' | 'built' | 'failed';

export interface PlanDraft {
	name: string;
	overview: string | null;
	planMarkdown: string;
	todos: { id: string; content: string }[];
	createdAt: string;
	updatedAt: string;
	savedPlanPath?: string;
}

export type ToolMessage<T extends ToolName> = {
	role: 'tool';
	content: string; // give this result to LLM (string of value)
	id: string;
	rawParams: RawToolParamsObj;
	mcpServerName: string | undefined; // the server name at the time of the call
} & (
		// in order of events:
		| { type: 'invalid_params', result: null, name: T, }

		| { type: 'tool_request', result: null, name: T, params: ToolCallParams<T>, }  // params were validated, awaiting user

		| { type: 'running_now', result: null, name: T, params: ToolCallParams<T>, }

		| { type: 'tool_error', result: string, name: T, params: ToolCallParams<T>, } // error when tool was running
		| { type: 'success', result: Awaited<ToolResult<T>>, name: T, params: ToolCallParams<T>, }
		| { type: 'rejected', result: null, name: T, params: ToolCallParams<T> }
	) // user rejected

export type DecorativeCanceledTool = {
	role: 'interrupted_streaming_tool';
	name: ToolName;
	mcpServerName: string | undefined; // the server name at the time of the call
}


// checkpoints
export type CheckpointEntry = {
	role: 'checkpoint';
	type: 'user_edit' | 'tool_edit';
	voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot | undefined };

	userModifications: {
		voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot | undefined };
	};
}


// WARNING: changing this format is a big deal!!!!!! need to migrate old format to new format on users' computers so people don't get errors.
export type ChatMessage =
	| {
		role: 'user';
		content: string; // content displayed to the LLM on future calls - allowed to be '', will be replaced with (empty)
		displayContent: string; // content displayed to user  - allowed to be '', will be ignored
		selections: StagingSelectionItem[] | null; // the user's selection
		images?: string[]; // Array of image URLs (data URIs or URLs) to send to AI
		/** Slash tokens injected via the menu on send (optional for back-compat). */
		injectedSlashTokens?: string[];
		state: {
			stagingSelections: StagingSelectionItem[];
			isBeingEdited: boolean;
		}
	} | {
		role: 'assistant';
		displayContent: string; // content received from LLM  - allowed to be '', will be replaced with (empty)
		reasoning: string; // reasoning from the LLM, used for step-by-step thinking

		anthropicReasoning: AnthropicReasoning[] | null; // anthropic reasoning
	}
	| ToolMessage<ToolName>
	| DecorativeCanceledTool
	| CheckpointEntry


// one of the square items that indicates a selection in a chat bubble
export type StagingSelectionItem = {
	type: 'File';
	uri: URI;
	language: string;
	state: { wasAddedAsCurrentFile: boolean; };
} | {
	type: 'CodeSelection';
	range: [number, number];
	uri: URI;
	language: string;
	state: { wasAddedAsCurrentFile: boolean; };
} | {
	type: 'Folder';
	uri: URI;
	language?: undefined;
	state?: undefined;
} | {
	type: 'BrowserElement';
	/**
	 * Best-effort selector for the element. For Shadow DOM, this may be a "deep" selector
	 * (e.g. segments joined by `>>>`) and `selectorChain` provides the segments.
	 */
	selector: string;
	selectorChain?: string[];
	pageUrl: string;
	elementData: {
		tagName: string;
		id: string | null;
		classes: string[];
		attributes: Record<string, string>;
		text: string;
		html: string;
	};
	/** Base64-encoded PNG (no `data:` prefix) */
	screenshot: string | null;
	timestamp: number;
}


// a link to a symbol (an underlined link to a piece of code)
export type CodespanLocationLink = {
	uri: URI, // we handle serialization for this
	displayText: string,
	selection?: { // store as JSON so dont have to worry about serialization
		startLineNumber: number
		startColumn: number,
		endLineNumber: number
		endColumn: number,
	} | undefined
} | null

// Shared utility functions for TODO list parsing and validation
// Keep for backward compatibility and markdown parsing
export function parseMarkdownChecklist(md: string): TodoItem[] {
	const lines = md.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
	const todos: TodoItem[] = [];

	for (const line of lines) {
		const match = line.match(/^(?:-\s*)?\[\s*([ xX\-~cC])\s*\]\s+(.+)$/);
		if (!match) continue;

		let status: TodoStatus = 'pending';
		if (match[1] === 'x' || match[1] === 'X') status = 'completed';
		else if (match[1] === '-' || match[1] === '~') status = 'in_progress';
		else if (match[1] === 'c' || match[1] === 'C') status = 'cancelled';

		const id = generateUuid();
		todos.push({ id, content: match[2], status });
	}

	return todos;
}

export function validateTodoItems(todos: TodoItem[]): { valid: boolean; error?: string } {
	if (!Array.isArray(todos)) return { valid: false, error: 'todos must be an array' };

	let inProgressCount = 0;

	for (const [i, t] of todos.entries()) {
		if (!t?.id || typeof t.id !== 'string')
			return { valid: false, error: `Item ${i + 1} missing id` };
		if (!t?.content || typeof t.content !== 'string')
			return { valid: false, error: `Item ${i + 1} missing content` };
		if (t.status && !['pending', 'in_progress', 'completed', 'cancelled'].includes(t.status))
			return { valid: false, error: `Item ${i + 1} has invalid status: ${t.status}` };
		if (t.priority !== undefined && !['high', 'medium', 'low'].includes(t.priority))
			return { valid: false, error: `Item ${i + 1} has invalid priority: ${t.priority}` };

		// Validate activeForm if provided (optional field)
		if (t.activeForm !== undefined && typeof t.activeForm !== 'string')
			return { valid: false, error: `Item ${i + 1} has invalid activeForm: must be string or undefined` };

		if (t.status === 'in_progress') inProgressCount++;
	}

	if (inProgressCount > 1) {
		return { valid: false, error: `Only ONE task can be in_progress (found ${inProgressCount})` };
	}

	return { valid: true };
}
