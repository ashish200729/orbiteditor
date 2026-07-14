/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// past values:
// 'void.settingsServiceStorage'
// 'void.settingsServiceStorageI' // 1.0.2

// 1.0.3
export const VOID_SETTINGS_STORAGE_KEY = 'void.settingsServiceStorageII'


// past values:
// 'void.chatThreadStorage'
// 'void.chatThreadStorageI' // 1.0.2

// 1.0.3
export const THREAD_STORAGE_KEY = 'void.chatThreadStorageII'


export const OPT_OUT_KEY = 'void.app.optOutAll'

// Persisted per-thread message queue (Cursor-style send-while-running queue). Survives reload/restart;
// rehydrated as PAUSED so a cold thread never auto-fires. Stored as { [threadId]: QueuedUserMessage[] }.
export const QUEUED_MESSAGES_STORAGE_KEY = 'orbit.chatQueuedMessagesI'

export const GITHUB_AUTH_STORAGE_KEY = 'orbit.githubAuth.credentials'

/**
 * Persists the pty-host ids of agent-window terminal tabs so they can be
 * reattached after an IDE reload. Stores a JSON array of
 * `{ id, title, cwd, workspaceFolderUri }` entries.
 */
export const AGENT_WINDOW_TERMINAL_STORAGE_KEY = 'orbit.agentWindow.terminals'
