/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { Box } from 'lucide-react';
import type { SlashCategoryProvider } from '../types.js';
import { modelFilterOfFeatureName } from '../../../../../../common/orbitSettingsService.js';

const FEATURE = 'Chat' as const;

/**
 * Models category: selecting sets the Chat model (shown by the existing model dropdown).
 * Uses the same capability filter the model dropdown applies so only usable models appear.
 */
export const modelsProvider: SlashCategoryProvider = {
	id: 'models',
	title: 'Models',
	order: 3,
	getItems: (ctx) => {
		const { filter } = modelFilterOfFeatureName[FEATURE];
		const current = ctx.settingsState.modelSelectionOfFeature[FEATURE];
		return ctx.settingsState._modelOptions
			.filter(o => filter(o.selection, {
				chatMode: ctx.settingsState.globalSettings.chatMode,
				overridesOfModel: ctx.settingsState.overridesOfModel,
			}))
			.map(o => ({
				id: `models:${o.selection.providerName}:${o.selection.modelName}`,
				categoryId: 'models' as const,
				name: o.name,
				detail: o.selection.providerName,
				icon: Box,
				isActive: !!current
					&& current.providerName === o.selection.providerName
					&& current.modelName === o.selection.modelName,
				onSelect: (sctx) => {
					sctx.accessor.get('IVoidSettingsService').setModelSelectionOfFeature(FEATURE, o.selection);
				},
			}));
	},
};
