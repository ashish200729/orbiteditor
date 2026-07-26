/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo } from 'react';
import { Laptop, Server } from 'lucide-react';
import { isMacintosh, isWindows } from '../../../../../../../../../base/common/platform.js';
import { useAccessor, useRunnerList, useSettingsState } from '../../../util/services.js';
import { VoidCustomDropdownBox } from '../../../util/inputs.js';
import {
	makeRunnerExecutionTarget,
	parseExecutionTargetId,
	type ExecutionTargetId,
} from '../../../../../../common/runner/runnerTypes.js';
import { runnerChromeTriggerClassName } from './runnerChromeStyles.js';

const LOCAL_LABEL = isWindows ? 'This PC' : isMacintosh ? 'This Mac' : 'This Machine';

export type ExecutionTargetPickerProps = {
	className?: string;
};

/**
 * Compact "Run on" picker above the empty-thread composer:
 * Local | Self-hosted Runner(s). Hidden after the first message.
 */
export const ExecutionTargetPicker = ({
	className,
}: ExecutionTargetPickerProps) => {
	const accessor = useAccessor();
	const voidSettingsService = accessor.get('IVoidSettingsService');
	const settingsState = useSettingsState();
	const runners = useRunnerList();

	const selected = parseExecutionTargetId(settingsState.globalSettings.executionTarget);

	const options: ExecutionTargetId[] = useMemo(() => {
		const opts: ExecutionTargetId[] = ['local'];
		for (const r of runners) {
			opts.push(makeRunnerExecutionTarget(r.id));
		}
		return opts;
	}, [runners]);

	const isRunnerOnline = useCallback((id: ExecutionTargetId) => {
		if (id === 'local') {
			return true;
		}
		const runnerId = id.slice('runner:'.length);
		const runner = runners.find(r => r.id === runnerId);
		return runner?.status === 'online' || runner?.status === 'busy';
	}, [runners]);

	const safeSelected: ExecutionTargetId = options.includes(selected) ? selected : 'local';

	useEffect(() => {
		if (safeSelected !== selected) {
			void voidSettingsService.setGlobalSetting('executionTarget', safeSelected);
		}
	}, [safeSelected, selected, voidSettingsService]);

	const onChangeOption = useCallback((newVal: ExecutionTargetId) => {
		if (!isRunnerOnline(newVal) && newVal !== 'local') {
			return; // E27: offline runners are not selectable
		}
		void voidSettingsService.setGlobalSetting('executionTarget', newVal);
	}, [voidSettingsService, isRunnerOnline]);

	const getOptionDisplayName = useCallback((val: ExecutionTargetId) => {
		if (val === 'local') {
			return LOCAL_LABEL;
		}
		const id = val.slice('runner:'.length);
		const runner = runners.find(r => r.id === id);
		return runner?.name ?? 'Self-hosted Runner';
	}, [runners]);

	const getOptionDropdownName = useCallback((val: ExecutionTargetId) => {
		if (val === 'local') {
			return LOCAL_LABEL;
		}
		const id = val.slice('runner:'.length);
		const runner = runners.find(r => r.id === id);
		const offline = runner && runner.status !== 'online' && runner.status !== 'busy';
		return runner
			? `Runner: ${runner.name}${offline ? ' (offline)' : ''}`
			: 'Self-hosted Runner';
	}, [runners]);

	const getOptionDropdownDetail = useCallback((val: ExecutionTargetId) => {
		if (val === 'local') {
			return 'Run the agent on this machine';
		}
		const id = val.slice('runner:'.length);
		const runner = runners.find(r => r.id === id);
		if (!runner) {
			return 'Self-hosted Runner';
		}
		const status = runner.status === 'online' || runner.status === 'busy'
			? runner.status
			: 'offline — select after reconnect';
		return `${runner.hostUrl} · ${status}`;
	}, [runners]);

	const getOptionIcon = useCallback((val: ExecutionTargetId) => {
		return val === 'local' ? Laptop : Server;
	}, []);

	const isOptionDisabled = useCallback((val: ExecutionTargetId) => {
		return val !== 'local' && !isRunnerOnline(val);
	}, [isRunnerOnline]);

	return (
		<div className={`min-w-0 ${className ?? ''}`}>
			<VoidCustomDropdownBox
				className={runnerChromeTriggerClassName}
				options={options}
				selectedOption={safeSelected}
				onChangeOption={onChangeOption}
				getOptionDisplayName={getOptionDisplayName}
				getOptionDropdownName={getOptionDropdownName}
				getOptionDropdownDetail={getOptionDropdownDetail}
				getOptionsEqual={(a, b) => a === b}
				getOptionIcon={getOptionIcon}
				isOptionDisabled={isOptionDisabled}
				showCheckmarkOnSelected
				matchInputWidth={false}
				arrowTouchesText
				offsetPx={-3}
				opacity={100}
			/>
		</div>
	);
};
