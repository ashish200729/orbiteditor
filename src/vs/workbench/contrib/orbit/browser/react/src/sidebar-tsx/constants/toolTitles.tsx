/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { BuiltinToolName } from '../../../../../common/toolsServiceTypes.js';
import { TextShimmer } from '../../util/TextShimmer.js';

// Perfect shimmer effect for streaming tool titles

const StreamingIndicator = ({ verb }: { verb: string }) => {
	return (
		<span style={{ color: 'var(--vscode-descriptionForeground)' }}>
			<TextShimmer>
				{verb}
			</TextShimmer>
		</span>
	);
};

export const loadingTitleWrapper = (verb: string): React.ReactNode => {
	return <StreamingIndicator verb={verb} />;
};

/** Titles for removed built-in tools (historical chat threads only). */
export const titleOfRemovedDirectoryListingToolName = {
	'ls_dir': { done: 'Listed', proposed: 'List', running: loadingTitleWrapper('Listing') },
	'get_dir_tree': { done: 'Listed tree', proposed: 'List tree', running: loadingTitleWrapper('Listing tree') },
} as const

export const titleOfRemovedBrowserToolName = {
	'browser_navigate': { done: 'Navigated', proposed: 'Navigate', running: loadingTitleWrapper('Navigating') },
	'browser_click': { done: 'Clicked', proposed: 'Click', running: loadingTitleWrapper('Clicking') },
	'browser_type': { done: 'Typed', proposed: 'Type', running: loadingTitleWrapper('Typing') },
	'browser_fill': { done: 'Filled', proposed: 'Fill', running: loadingTitleWrapper('Filling') },
	'browser_screenshot': { done: 'Captured', proposed: 'Capture', running: loadingTitleWrapper('Capturing') },
	'browser_get_content': { done: 'Got content', proposed: 'Get content', running: loadingTitleWrapper('Getting content') },
	'browser_extract_text': { done: 'Extracted text', proposed: 'Extract text', running: loadingTitleWrapper('Extracting text') },
	'browser_evaluate': { done: 'Evaluated', proposed: 'Evaluate', running: loadingTitleWrapper('Evaluating') },
	'browser_wait_for_selector': { done: 'Waited', proposed: 'Wait', running: loadingTitleWrapper('Waiting') },
	'browser_get_url': { done: 'Got URL', proposed: 'Get URL', running: loadingTitleWrapper('Getting URL') },
	'browser_snapshot': { done: 'Captured snapshot', proposed: 'Capture snapshot', running: loadingTitleWrapper('Capturing snapshot') },
} as const

export const titleOfBuiltinToolName = {
	'Read': { done: 'Read', proposed: 'Read', running: loadingTitleWrapper('Reading') },
	'Glob': { done: 'Globbed', proposed: 'Glob', running: loadingTitleWrapper('Globbing') },
	'Grep': { done: 'Grepped', proposed: 'Grep', running: loadingTitleWrapper('Grepping') },
	'StrReplace': { done: 'Edited', proposed: 'Edit', running: loadingTitleWrapper('Editing') },
	'Write': { done: 'Wrote', proposed: 'Write', running: loadingTitleWrapper('Writing') },
	'Shell': { done: 'Ran', proposed: 'Run', running: loadingTitleWrapper('Running') },
	'AwaitShell': { done: 'Polled', proposed: 'Await', running: loadingTitleWrapper('Awaiting') },

	'read_lint_errors': { done: 'Read errors', proposed: 'Read errors', running: loadingTitleWrapper('Reading errors') },
	'TodoWrite': { done: 'Updated to-dos', proposed: 'Update to-dos', running: loadingTitleWrapper('Updating to-dos') },
	'AskQuestion': { done: 'Asked questions', proposed: 'Ask questions', running: loadingTitleWrapper('Asking questions') },

	// Plan tools
	'create_plan': { done: 'Created plan', proposed: 'Create plan', running: loadingTitleWrapper('Creating plan') },
	'read_plan': { done: 'Read plan', proposed: 'Read plan', running: loadingTitleWrapper('Reading plan') },
	'update_plan_section': { done: 'Updated plan', proposed: 'Update plan', running: loadingTitleWrapper('Updating plan') },
	'add_plan_todo': { done: 'Added todo', proposed: 'Add todo', running: loadingTitleWrapper('Adding todo') },
	'mark_plan_item_complete': { done: 'Completed item', proposed: 'Complete item', running: loadingTitleWrapper('Completing item') },
	'task': { done: 'Agent done', proposed: 'Run agent', running: loadingTitleWrapper('Agent running') },
	'skill': { done: 'Loaded skill', proposed: 'Load skill', running: loadingTitleWrapper('Loading skill') },

} as const satisfies Record<BuiltinToolName, { done: any, proposed: any, running: any }>

export const TOOL_STATUS_ICON_SIZE = 14
