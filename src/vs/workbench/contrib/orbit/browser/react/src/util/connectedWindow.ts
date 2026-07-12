/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Re-export shared DOM helpers from the workbench layer (single source of truth).
export {
	getConnectedDocument,
	getConnectedWindow,
	findThreadComposerInWindow,
	focusInConnectedWindow,
} from '../../../connectedWindowDom.js';
