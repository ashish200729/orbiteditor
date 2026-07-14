/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export type ThreadStructuralFields = {
	messages: readonly unknown[];
	lastModified: string;
	state: unknown;
	todoList?: unknown;
	linkedPlanPath?: string;
	planDraft?: unknown;
	filesWithUserChanges: Set<string>;
};

/** Thread state uses reference equality — updaters must assign a new object when mutating. */
const threadStateStructurallyEqual = (a: unknown, b: unknown): boolean => {
	return a === b;
};

/** Shallow structural compare for thread update bail-out. */
export const threadStructurallyEqual = (a: ThreadStructuralFields, b: ThreadStructuralFields): boolean => {
	return a.messages === b.messages
		&& a.lastModified === b.lastModified
		&& threadStateStructurallyEqual(a.state, b.state)
		&& a.todoList === b.todoList
		&& a.linkedPlanPath === b.linkedPlanPath
		&& a.planDraft === b.planDraft
		&& a.filesWithUserChanges === b.filesWithUserChanges;
};

/** Returns true when the global current-thread emitter should fire. */
export const shouldNotifyGlobalThreadChange = (threadId: string, currentThreadId: string): boolean => {
	return threadId === currentThreadId;
};

/** Immutable message append (mirrors _addMessageToThread). */
export const appendMessageImmutable = <T>(messages: readonly T[], message: T): { messages: T[]; idx: number } => {
	const idx = messages.length;
	return { messages: [...messages, message], idx };
};

/** Immutable single-message replace (mirrors _setCurrentMessageState). */
export const replaceMessageImmutable = <T>(messages: readonly T[], messageIdx: number, message: T): T[] => {
	return [
		...messages.slice(0, messageIdx),
		message,
		...messages.slice(messageIdx + 1),
	];
};

export type ThreadStorePolicy = 'immediate' | 'debounced';

/** Decide whether thread persistence should flush immediately or be debounced. */
export const resolveThreadStorePolicy = (opts: { immediate?: boolean }): ThreadStorePolicy =>
	opts.immediate ? 'immediate' : 'debounced';