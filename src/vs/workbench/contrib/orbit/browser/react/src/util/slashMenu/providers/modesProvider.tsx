/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { Bot, ListChecks, MessageCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ChatMode } from '../../../../../../common/orbitSettingsTypes.js';
import type { SlashCategoryProvider } from '../types.js';

const MODES: ChatMode[] = ['normal', 'plan', 'agent'];

const nameOfChatMode: Record<ChatMode, string> = {
	normal: 'Chat',
	plan: 'Plan',
	agent: 'Agent',
};

const detailOfChatMode: Record<ChatMode, string> = {
	normal: 'Normal chat mode',
	plan: 'Creates implementation plans',
	agent: 'Edits files and uses tools',
};

const iconOfChatMode: Record<ChatMode, LucideIcon> = {
	normal: MessageCircle,
	plan: ListChecks,
	agent: Bot,
};

/** Modes category: selecting sets the chat mode (shown by the existing toolbar pill). */
export const modesProvider: SlashCategoryProvider = {
	id: 'modes',
	title: 'Modes',
	order: 2,
	getItems: (ctx) =>
		MODES.map(mode => ({
			id: `modes:${mode}`,
			categoryId: 'modes' as const,
			name: nameOfChatMode[mode],
			detail: detailOfChatMode[mode],
			icon: iconOfChatMode[mode],
			isActive: ctx.settingsState.globalSettings.chatMode === mode,
			searchKeys: [mode],
			onSelect: (sctx) => {
				sctx.accessor.get('IVoidSettingsService').setGlobalSetting('chatMode', mode);
			},
		})),
};
