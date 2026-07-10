/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { ToolApprovalType } from '../../../../../../common/toolsServiceTypes.js';

/**
 * Friendly, human-readable labels for the tool approval surface.
 *
 * The backend approval types are lowercase technical strings (`edits`,
 * `terminal`, `MCP tools`). These helpers map them to the copy shown in the
 * UI so we keep the technical identifiers out of the rendered card.
 */

/** Friendly noun phrase for an approval category, e.g. "Terminal commands". */
export const getApprovalTypeLabel = (type: ToolApprovalType): string => {
	switch (type) {
		case 'edits': return 'Code edits';
		case 'terminal': return 'Terminal commands';
		case 'MCP tools': return 'MCP tools';
		default: return type;
	}
};

/**
 * Label for the "always allow" toggle in the footer.
 * e.g. "Always allow terminal commands" — matches the Settings page phrasing.
 */
export const getAutoApproveLabel = (type: ToolApprovalType): string => {
	switch (type) {
		case 'edits': return 'Always allow code edits';
		case 'terminal': return 'Always allow terminal commands';
		case 'MCP tools': return 'Always allow MCP tools';
		default: return `Always allow ${type}`;
	}
};

/** Short verb for the primary action, customized per category. */
export const getApproveActionLabel = (type: ToolApprovalType | undefined): string => {
	switch (type) {
		case 'edits': return 'Approve';
		case 'terminal': return 'Approve';
		case 'MCP tools': return 'Approve';
		default: return 'Approve';
	}
};

/** aria-label for the approve button, including the category for screen readers. */
export const getApproveAriaLabel = (type: ToolApprovalType | undefined): string => {
	const label = getApprovalTypeLabel(type ?? 'MCP tools');
	return `Approve ${label.toLowerCase()}`;
};

/** aria-label for the deny button, including the category for screen readers. */
export const getDenyAriaLabel = (type: ToolApprovalType | undefined): string => {
	const label = getApprovalTypeLabel(type ?? 'MCP tools');
	return `Deny ${label.toLowerCase()}`;
};

/* -------------------------------------------------------------------------- */
/* Compact premium button labels                                            */
/*                                                                            */
/* These back the lean footer (Skip · Always Run · Run ↵). The legacy helpers  */
/* above (`getApprovalTypeLabel`, `getAutoApproveLabel`) are untouched — they  */
/* still back the Settings page's full-sentence copy.                          */
/* -------------------------------------------------------------------------- */

/**
 * Visible label for the ghost "Skip" button. Same for every approval type.
 * (aria-labels still use the descriptive `Skip {type}` form via `getDenyAriaLabel`.)
 */
export const getSkipLabel = (): string => 'Skip';

/**
 * Visible label for the primary pill action. Terminal commands use "Run";
 * edits, MCP tools, and the default case use "Approve". Browser-open keeps
 * its own override ("Open browser") and never goes through here.
 */
export const getRunActionLabel = (type: ToolApprovalType | undefined): string => {
	switch (type) {
		case 'terminal': return 'Run';
		case 'edits':
		case 'MCP tools':
		default: return 'Approve';
	}
};

/**
 * Visible label for the bordered secondary "always allow" pill. Terminal
 * commands read "Always Run"; edits and MCP tools read "Always Allow"
 * (matching the Settings-page verb for non-terminal categories).
 */
export const getAlwaysRunLabel = (type: ToolApprovalType | undefined): string => {
	switch (type) {
		case 'terminal': return 'Always Run';
		case 'edits': return 'Always Allow';
		case 'MCP tools': return 'Always Allow';
		default: return 'Always Allow';
	}
};

/**
 * aria-label for the Skip button — descriptive form for screen readers.
 */
export const getSkipAriaLabel = (type: ToolApprovalType | undefined): string => {
	const label = getApprovalTypeLabel(type ?? 'MCP tools');
	return `Skip ${label.toLowerCase()}`;
};

/**
 * aria-label for the Always Run / Always Allow button — descriptive form.
 */
export const getAlwaysRunAriaLabel = (type: ToolApprovalType | undefined): string => {
	const label = getApprovalTypeLabel(type ?? 'MCP tools');
	return `Always allow ${label.toLowerCase()}`;
};