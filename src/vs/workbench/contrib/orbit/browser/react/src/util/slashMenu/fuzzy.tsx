/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

// Re-export from the leaf fuzzy module (NOT inputs.tsx) so the slash menu's module graph
// never pulls in the big input component — avoids an import cycle. The "@" menu uses the
// same leaf module, so filtering ranks identically.
export { isSubsequence, scoreSubsequence } from '../fuzzy.js';
