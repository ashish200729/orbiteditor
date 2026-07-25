/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/** Typed payloads for Self-hosted Runner handoff artifacts (task.event kinds). */

export type ArtifactBranchData = {
	name: string;
	baseCommit: string;
	headCommit?: string | null;
	baseBranch?: string | null;
	pushed: boolean;
	reason?: string;
	hasChanges?: boolean;
};

export type ArtifactPrData = {
	url: string;
	kind: 'compare' | 'pull_request';
	baseBranch: string;
	headBranch: string;
};

export type ArtifactPatchData = {
	baseCommit?: string;
	patch?: string;
	truncated?: boolean;
	exitCode?: number;
};

export function parseArtifactBranch(data: unknown): ArtifactBranchData | undefined {
	if (!data || typeof data !== 'object') return undefined;
	const d = data as Record<string, unknown>;
	if (typeof d.name !== 'string' || !d.name) return undefined;
	if (typeof d.baseCommit !== 'string' || !d.baseCommit) return undefined;
	return {
		name: d.name,
		baseCommit: d.baseCommit,
		headCommit: typeof d.headCommit === 'string' ? d.headCommit : null,
		baseBranch: typeof d.baseBranch === 'string' ? d.baseBranch : null,
		pushed: d.pushed === true,
		reason: typeof d.reason === 'string' ? d.reason : undefined,
		hasChanges: d.hasChanges === true ? true : d.hasChanges === false ? false : undefined,
	};
}

export function parseArtifactPr(data: unknown): ArtifactPrData | undefined {
	if (!data || typeof data !== 'object') return undefined;
	const d = data as Record<string, unknown>;
	if (typeof d.url !== 'string' || !d.url) return undefined;
	if (typeof d.headBranch !== 'string' || !d.headBranch) return undefined;
	const kind = d.kind === 'pull_request' ? 'pull_request' : 'compare';
	return {
		url: d.url,
		kind,
		baseBranch: typeof d.baseBranch === 'string' ? d.baseBranch : 'main',
		headBranch: d.headBranch,
	};
}

export function parseArtifactPatch(data: unknown): ArtifactPatchData | undefined {
	if (!data || typeof data !== 'object') return undefined;
	const d = data as Record<string, unknown>;
	return {
		baseCommit: typeof d.baseCommit === 'string' ? d.baseCommit : undefined,
		patch: typeof d.patch === 'string' ? d.patch : undefined,
		truncated: d.truncated === true,
		exitCode: typeof d.exitCode === 'number' ? d.exitCode : undefined,
	};
}
