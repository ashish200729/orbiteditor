/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useEffect, useState } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { ToolMessage } from '../../../../../../common/chatThreadServiceTypes.js';
import { CollapsibleSection } from '../wrappers/CollapsibleSection.js';
import { TextShimmer } from '../../../util/TextShimmer.js';
import { OrbitProgressIndicator } from '../../../util/OrbitProgressIndicator.js';

export type RemoteSetupStep = {
	id: string;
	label: string;
	detail?: string;
};

export type RemoteSetupParams = {
	steps: RemoteSetupStep[];
	progress?: string;
	phase?: 'queue' | 'environment' | 'workspace' | 'config';
};

const isRemoteSetupParams = (value: unknown): value is RemoteSetupParams =>
	!!value && typeof value === 'object' && Array.isArray((value as RemoteSetupParams).steps);

/** Dedicated setup / provisioning card for self-hosted runner lifecycle (not Thought). */
export const isRemoteSetupTool = (toolMessage: { name?: string; mcpServerName?: string }): boolean =>
	!toolMessage.mcpServerName && toolMessage.name === 'RemoteSetup';

const headerForPhase = (phase: RemoteSetupParams['phase'] | undefined, isRunning: boolean): string => {
	if (!isRunning) {
		return 'Workspace ready';
	}
	switch (phase) {
		case 'queue':
			return 'Waiting for a runner…';
		case 'environment':
			return 'Preparing environment…';
		case 'config':
			return 'Configuring environment…';
		case 'workspace':
		default:
			return 'Setting up workspace…';
	}
};

/** Fixed icon column shared by header + step rows for optical alignment. */
const IconSlot = ({ children }: { children: React.ReactNode }) => (
	<span className="flex-shrink-0 w-3.5 h-3.5 flex items-center justify-center" aria-hidden="true">
		{children}
	</span>
);

export const RemoteSetupCard = ({
	toolMessage,
}: {
	toolMessage: Exclude<ToolMessage<string>, { type: 'invalid_params' }>;
	messageIdx?: number;
	threadId?: string;
	compact?: boolean;
}) => {
	const params = isRemoteSetupParams(toolMessage.params)
		? toolMessage.params
		: isRemoteSetupParams(toolMessage.rawParams)
			? toolMessage.rawParams
			: { steps: [] as RemoteSetupStep[] };
	const steps = params.steps ?? [];
	const progress = typeof params.progress === 'string' ? params.progress : undefined;
	const isRunning = toolMessage.type === 'running_now';
	const [isOpen, setIsOpen] = useState(false);

	useEffect(() => {
		// Keep collapsed by default — header shimmer carries the status; expand for details.
		if (!isRunning) {
			setIsOpen(false);
		}
	}, [isRunning]);

	if (steps.length === 0 && !progress) {
		return null;
	}

	const headerLabel = headerForPhase(params.phase, isRunning);

	return (
		<div className="orbit-card-enter my-1 w-full">
			<button
				type="button"
				onClick={() => setIsOpen(prev => !prev)}
				aria-expanded={isOpen}
				className="
					group flex items-center gap-1.5 w-full
					bg-transparent border-none p-0 py-0.5
					cursor-pointer select-none
					text-void-fg-3 text-[12px]
					opacity-80 hover:opacity-100
					transition-opacity duration-150 ease-out
				"
			>
				<IconSlot>
					<ChevronRight
						size={11}
						strokeWidth={2.5}
						className={`
							text-void-fg-4/50
							transition-transform duration-200 ease-out
							${isOpen ? 'rotate-90' : 'rotate-0'}
						`}
					/>
				</IconSlot>
				{isRunning ? (
					<span className="font-medium min-w-0 truncate" style={{ color: 'var(--vscode-descriptionForeground)' }}>
						{/* Shimmer alone while collapsed — expanded steps show OrbitProgressIndicator. */}
						<TextShimmer duration={1.5} spread={2}>{headerLabel}</TextShimmer>
					</span>
				) : (
					<span className="font-medium truncate flex items-center gap-1.5 min-w-0">
						<IconSlot>
							<Check size={12} className="text-void-fg-3" strokeWidth={2.5} />
						</IconSlot>
						<span className="truncate">{headerLabel}</span>
					</span>
				)}
			</button>

			<CollapsibleSection isOpen={isOpen} contentClassName="mt-1.5">
				<div
					className="
						rounded-lg border border-void-border-3/40 bg-void-bg-2/40
						px-2.5 py-2 flex flex-col gap-1.5
					"
					role="status"
					aria-label="Workspace setup"
				>
					{steps.map((step, index) => {
						const isLatest = index === steps.length - 1;
						const showSpinner = isRunning && isLatest;
						return (
							<div key={step.id} className="flex items-start gap-2 min-w-0">
								<span className="mt-0.5 flex-shrink-0">
									<IconSlot>
										{showSpinner ? (
											<OrbitProgressIndicator size="xs" variant="muted" label={step.label} />
										) : (
											<Check size={12} className="text-void-fg-3" strokeWidth={2.5} />
										)}
									</IconSlot>
								</span>
								<div className="min-w-0 flex-1">
									<div className="text-[12px] text-void-fg-2 leading-snug truncate">{step.label}</div>
									{step.detail ? (
										<div className="text-[11px] text-void-fg-4 leading-snug whitespace-pre-wrap break-words mt-0.5 max-h-24 overflow-y-auto void-custom-scrollable">
											{step.detail}
										</div>
									) : null}
								</div>
							</div>
						);
					})}
					{progress ? (
						<div className="text-[11px] text-void-fg-4 pl-5 pt-0.5 truncate">{progress}</div>
					) : null}
				</div>
			</CollapsibleSection>
		</div>
	);
};
