/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Slash-menu barrel. Importing this module registers the four built-in category providers.
 * To add a category later: write a provider in ./providers and add one registerSlashCategory
 * call below.
 */

import { registerSlashCategory } from './registry.js';
import { skillsProvider } from './providers/skillsProvider.js';
import { commandsProvider } from './providers/commandsProvider.js';
import { modesProvider } from './providers/modesProvider.js';
import { modelsProvider } from './providers/modelsProvider.js';

registerSlashCategory(skillsProvider);
registerSlashCategory(commandsProvider);
registerSlashCategory(modesProvider);
registerSlashCategory(modelsProvider);

export { listSlashCategories, registerSlashCategory } from './registry.js';
export type {
	SlashMenuItem,
	SlashCategoryId,
	SlashCategoryProvider,
	SlashProviderContext,
	SlashSelectContext,
} from './types.js';
