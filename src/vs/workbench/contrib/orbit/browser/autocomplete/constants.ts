/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { isWindows } from '../../../../../base/common/platform.js';

export const allLinebreakSymbols = ['\r\n', '\n']
export const _ln = isWindows ? allLinebreakSymbols[0] : allLinebreakSymbols[1]

export const DEBOUNCE_TIME = 200 // Reduced from 500ms for faster response
export const DEBOUNCE_TIME_FAST = 100 // Even faster when cache hit is likely
export const TIMEOUT_TIME = 8000 // Autocomplete is interactive — a completion that takes >8s is useless and its pending entry blocks the cache
export const MAX_CACHE_SIZE = 20
export const MAX_PENDING_REQUESTS = 2
export const MAX_TRIM_CACHE_SIZE = 100
export const MAX_GLOBAL_CACHE_ITEMS = 1000 // Global limit across all documents
export const AUTOCOMPLETE_ACCEPTANCE_WINDOW_MS = 500 // Time window to detect recent acceptance
export const MAX_NEWLINES_IN_COMPLETION = 10 // Maximum newlines before truncating
export const CONTEXT_LINES_BEFORE = 30 // Lines of context before cursor
export const CONTEXT_LINES_AFTER = 30 // Lines of context after cursor
