/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { Sparkles } from 'lucide-react';
import type { SlashCategoryProvider } from '../types.js';

/** Skills category: enabled skills, inserted as `/skill-name` tokens. */
export const skillsProvider: SlashCategoryProvider = {
	id: 'skills',
	title: 'Skills',
	order: 0,
	getItems: (ctx) =>
		ctx.skills
			.filter(s => s.enabled)
			.map(s => ({
				id: `skills:${s.name}`,
				categoryId: 'skills' as const,
				name: s.name,
				detail: s.description,
				icon: Sparkles,
				insertsToken: { token: `/${s.name}` },
			})),
};
