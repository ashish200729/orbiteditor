/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { Zap } from 'lucide-react';
import type { SlashCategoryProvider } from '../types.js';
import { BUILTIN_COMMANDS } from '../../../../../../common/slashCommands/builtinCommands.js';

/** Commands category: built-in prompt templates, inserted as `/command` tokens. */
export const commandsProvider: SlashCategoryProvider = {
	id: 'commands',
	title: 'Commands',
	order: 1,
	getItems: () =>
		BUILTIN_COMMANDS.map(c => ({
			id: `commands:${c.name}`,
			categoryId: 'commands' as const,
			name: c.name,
			detail: c.description,
			icon: Zap,
			insertsToken: { token: `/${c.name}` },
		})),
};
