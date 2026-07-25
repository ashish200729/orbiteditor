/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useState } from 'react';
import { TextShimmer } from '../../../util/TextShimmer.js';

type AgentStatusLineProps = {
	label: string;
	className?: string;
};

/** Single-line agent activity indicator with visible shimmer + animated dots. */
export const AgentStatusLine = ({ label, className = '' }: AgentStatusLineProps) => {
	const [dotCount, setDotCount] = useState(1);

	useEffect(() => {
		const intervalId = setInterval(() => {
			setDotCount((prev) => (prev >= 3 ? 1 : prev + 1));
		}, 400);
		return () => clearInterval(intervalId);
	}, []);

	return (
		<div className={`py-0.5 ${className}`} role="status" aria-live="polite">
			<span
				className="inline-flex items-center font-medium tracking-wide text-void-fg-3"
				style={{ fontSize: '0.8rem' }}
			>
				<TextShimmer duration={2.5} spread={2}>
					{`${label}${'.'.repeat(dotCount)}`}
				</TextShimmer>
			</span>
		</div>
	);
};