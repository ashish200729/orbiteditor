/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useMemo } from 'react';
import { ChatMode } from '../../../../../../common/orbitSettingsTypes.js';
import { useAccessor, useSettingsState } from '../../../util/services.js';
import { VoidCustomDropdownBox } from '../../../util/inputs.js';
import { iconOfChatMode } from '../../../util/slashMenu/providers/modesProvider.js';

const nameOfChatMode = {
	'normal': 'Chat',
	'plan': 'Plan',
	'agent': 'Agent',
}

const detailOfChatMode = {
	'normal': 'Normal chat mode',
	'plan': 'Creates implementation plans',
	'agent': 'Edits files and uses tools',
}

export const ChatModeDropdown = ({ className }: { className: string }) => {
	const accessor = useAccessor()

	const voidSettingsService = accessor.get('IVoidSettingsService')
	const settingsState = useSettingsState()

	const options: ChatMode[] = useMemo(() => ['normal', 'plan', 'agent'], [])

	const onChangeOption = useCallback((newVal: ChatMode) => {
		voidSettingsService.setGlobalSetting('chatMode', newVal)
	}, [voidSettingsService])

	return (
		<VoidCustomDropdownBox
			className={`${className} hover:text-void-fg-2 transition-colors`}
			options={options}
			selectedOption={settingsState.globalSettings.chatMode}
			onChangeOption={onChangeOption}

			// MUST return string (not JSX)
			getOptionDisplayName={(val) => nameOfChatMode[val]}

			// MUST return string (not JSX)
			getOptionDropdownName={(val) => nameOfChatMode[val]}

			// description also remains a string
			getOptionDropdownDetail={(val) => detailOfChatMode[val]}

			getOptionsEqual={(a, b) => a === b}
			getOptionIcon={(val) => iconOfChatMode[val]}
			showCheckmarkOnSelected
			matchInputWidth={false}
			offsetPx={-3}
			opacity={60}
		/>
	)
}
