/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import type { LucideIcon } from 'lucide-react';
import type { useAccessor, useSettingsState } from '../services.js';
import type { SkillDefinition } from '../../../../../common/orbitSkillTypes.js';

export type SlashCategoryId = 'skills' | 'commands' | 'modes' | 'models';

/** Context passed to a selection side-effect (set mode/model, etc.). */
export type SlashSelectContext = {
	accessor: ReturnType<typeof useAccessor>;
};

/** A single selectable row in the slash menu. */
export type SlashMenuItem = {
	/** Globally-unique id, e.g. `skills:review`. Used as the React key. */
	id: string;
	categoryId: SlashCategoryId;
	/** Display + search label, e.g. `review`, `Agent`, `gpt-5`. */
	name: string;
	/** Secondary dimmed text (description / provider). */
	detail?: string;
	icon: LucideIcon;
	/**
	 * If set, selecting the item inserts this inline token (e.g. `/review`) into the input
	 * and performs no other side effect. Used by skills + commands.
	 */
	insertsToken?: { token: string };
	/**
	 * Side effect run on selection (e.g. set chat mode / model). Used by modes + models.
	 * Items with `insertsToken` typically omit this.
	 */
	onSelect?: (ctx: SlashSelectContext) => void;
	/** When true, a checkmark is shown (current mode / model). */
	isActive?: boolean;
	/** Extra strings used for fuzzy filtering (e.g. mode id `plan` for display name `Plan`). */
	searchKeys?: string[];
};

/** Context a provider reads to build its current items. */
export type SlashProviderContext = {
	accessor: ReturnType<typeof useAccessor>;
	settingsState: ReturnType<typeof useSettingsState>;
	/** Current enabled-aware skills snapshot (so providers don't each re-list). */
	skills: SkillDefinition[];
};

/** Owns one category of the slash menu. New categories register one of these. */
export type SlashCategoryProvider = {
	id: SlashCategoryId;
	/** Group header shown in the empty-query view, e.g. `Skills`. */
	title: string;
	/** Group ordering in the empty-query view (ascending). */
	order: number;
	/** Returns the category's current items from live state. */
	getItems: (ctx: SlashProviderContext) => SlashMenuItem[];
};
