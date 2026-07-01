/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import type { SlashCategoryId, SlashCategoryProvider } from './types.js';

/**
 * Registry of slash-menu category providers. Adding a new category is a one-liner:
 * write a provider and call `registerSlashCategory(provider)` (see ./index.ts).
 */
const _providers = new Map<SlashCategoryId, SlashCategoryProvider>();

export const registerSlashCategory = (provider: SlashCategoryProvider): void => {
	_providers.set(provider.id, provider);
};

/** All registered providers, sorted by their display order. */
export const listSlashCategories = (): SlashCategoryProvider[] =>
	[..._providers.values()].sort((a, b) => a.order - b.order);
