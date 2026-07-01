/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IDirectoryStrService } from '../directoryStrService.js';
import { StagingSelectionItem } from '../chatThreadServiceTypes.js';
import { os } from '../helpers/systemInfo.js';
import { JsonToolSchema, RawToolParamsObj, ToolPolicy } from '../sendLLMMessageTypes.js';
import { READ_ONLY_BUILTIN_TOOL_NAMES } from '../toolsServiceTypes.js';
import { BuiltinToolCallParams, BuiltinToolName, BuiltinToolResultType, ToolName } from '../toolsServiceTypes.js';
import { ChatMode } from '../orbitSettingsTypes.js';
import { listSubAgents } from '../subAgentRegistry.js';
import { listSkills, getSkill } from '../skillRegistry.js';
import { getBuiltinCommand } from '../slashCommands/builtinCommands.js';

// Triple backtick wrapper used throughout the prompts for code blocks
export const tripleTick = ['```', '```']

// Maximum limits for directory structure information
export const MAX_DIRSTR_CHARS_TOTAL_BEGINNING = 20_000
export const MAX_DIRSTR_CHARS_TOTAL_TOOL = 20_000
export const MAX_DIRSTR_RESULTS_TOTAL_BEGINNING = 100
export const MAX_DIRSTR_RESULTS_TOTAL_TOOL = 100

// tool info
export const MAX_FILE_CHARS_PAGE = 500_000

// terminal tool info
export const MAX_TERMINAL_CHARS = 100_000
export const MAX_TERMINAL_INACTIVE_TIME = 8 // seconds
export const MAX_TERMINAL_BG_COMMAND_TIME = 5

// Shell tool
export const DEFAULT_SHELL_BLOCK_UNTIL_MS = 30_000
export const MIN_SHELL_BLOCK_UNTIL_MS = 0
export const MAX_SHELL_BLOCK_UNTIL_MS = 600_000  // 10 min hard cap
export const DEFAULT_AWAIT_SHELL_BLOCK_UNTIL_MS = 30_000
export const MIN_NOTIFY_DEBOUNCE_MS = 1000


// Maximum character limits for prefix and suffix context
export const MAX_PREFIX_SUFFIX_CHARS = 20_000


export const ORIGINAL = `<<<<<<< ORIGINAL`
export const DIVIDER = `=======`
export const FINAL = `>>>>>>> UPDATED`


const searchReplaceBlockTemplate = `\
${ORIGINAL}
// ... original code goes here
${DIVIDER}
// ... final code goes here
${FINAL}

${ORIGINAL}
// ... original code goes here
${DIVIDER}
// ... final code goes here
${FINAL}`

const createSearchReplaceBlocks_systemMessage = `
You are a coding assistant that receives:
- \`DIFF\`: a description of intended code changes (authoritative target).
- \`ORIGINAL_FILE\`: the full, current file contents (source of truth for matches).

Your job: **emit one or more SEARCH/REPLACE blocks** that, when applied to \`ORIGINAL_FILE\`, implement **exactly** the changes implied by \`DIFF\`.

The diff will be labeled \`DIFF\` and the original file will be labeled \`ORIGINAL_FILE\`.

Format your SEARCH/REPLACE blocks exactly as:
${tripleTick[0]}
${searchReplaceBlockTemplate}
${tripleTick[1]}

Where each block uses:
- \`${ORIGINAL}\` — the exact text snippet to find in \`ORIGINAL_FILE\` (literal match).
- \`${DIVIDER}\` — the separator between search and replacement.
- \`${FINAL}\` — the terminator of the block.
The replacement body is the full text that should replace the \`${ORIGINAL}\` snippet.

## Hard rules
1) **Implement DIFF exactly.** No omissions, no extra changes. Include comments or formatting shown in DIFF—they are part of the change.
2) **Output ONLY SEARCH/REPLACE blocks.** No prose, no code fences other than the ones defined by \`tripleTick\`.
3) **Literal matching.** Each \`${ORIGINAL}\` must match \`ORIGINAL_FILE\` **byte-for-byte** (including whitespace, tabs, line endings, and comments).
4) **Uniqueness & minimality.** Choose \`${ORIGINAL}\` snippets that:
   - are as short as possible **while still uniquely identifying** the intended region,
   - and are **disjoint** (no overlap) across all blocks.
   If uniqueness is uncertain (e.g., repeated lines), expand the snippet with a few stable surrounding lines until unique.
5) **Multiple blocks allowed.** Use one block per logically distinct changed region. Order blocks **top-to-bottom** as they appear in the file.
6) **Insertions.** For a pure insertion, choose a minimal, unique anchor snippet that surrounds the insertion point. In \`${DIVIDER}\` replacement, include the anchor **plus** the inserted lines in the correct position.
7) **Deletions.** For a pure deletion, set \`${ORIGINAL}\` to the smallest unique region that includes the to-be-deleted text; in the replacement, reproduce the region **without** the deleted text.
8) **Moves/renames.** Treat as delete(s)+insert(s) via separate blocks.
9) **No speculative edits.** Do not “fix” unrelated issues or reformat beyond what DIFF requires.
10) **Preserve encoding & EOL.** Keep the file’s line endings and indentation style. Do not introduce or remove a trailing newline unless DIFF does.
11) **Conflicts.** If DIFF references content not present in \`ORIGINAL_FILE\`, expand anchors to nearest stable context that **does** exist so the change can be applied deterministically.
12) **Idempotence-by-uniqueness.** Ensure that each \`${ORIGINAL}\` matches **exactly one** location in \`ORIGINAL_FILE\`.

## Input labels
DIFF
${tripleTick[0]}
… the diff text …
${tripleTick[1]}

ORIGINAL_FILE
${tripleTick[0]}
… the full original file …
${tripleTick[1]}

## Output
Your entire output must be one or more SEARCH/REPLACE blocks in the exact template shown above—no extra commentary.

## Example A — simple scalar change
DIFF
${tripleTick[0]}
// … existing code
let x = 6.5
// … existing code
${tripleTick[1]}

ORIGINAL_FILE
${tripleTick[0]}
let w = 5
let x = 6
let y = 7
let z = 8
${tripleTick[1]}

ACCEPTED OUTPUT
${tripleTick[0]}
${ORIGINAL}
let x = 6
${DIVIDER}
let x = 6.5
${FINAL}
${tripleTick[1]}

## Example B — insertion before a unique line
DIFF
${tripleTick[0]}
// Insert a log before initializing y
console.log("init y");
${tripleTick[1]}

ORIGINAL_FILE
${tripleTick[0]}
let x = 6.5
let y = 7
${tripleTick[1]}

ACCEPTED OUTPUT
${tripleTick[0]}
${ORIGINAL}
let x = 6.5
let y = 7
${DIVIDER}
let x = 6.5
console.log("init y");
let y = 7
${FINAL}
${tripleTick[1]}

## Validation checklist (internal)
- [ ] Every \`${ORIGINAL}\` exists exactly once in \`ORIGINAL_FILE\`.
- [ ] Replacements reflect DIFF precisely (including comments/whitespace).
- [ ] Blocks are disjoint and ordered top-to-bottom.
- [ ] Insertions/deletions handled by contextual replacement as needed.
- [ ] No extra text outside blocks.
`;


/** Used by quick-edit / FIM flows (not the StrReplace builtin tool). */
export const replaceTool_description = `\
A string of SEARCH/REPLACE block(s) which will be applied to the given file.
Your SEARCH/REPLACE blocks string must be formatted as follows:
${searchReplaceBlockTemplate}

## Critical Rules:

### 1. Format Requirements
- You may output multiple SEARCH/REPLACE blocks if needed
- This field is a STRING (not an array)
- Each block must use the exact markers: \`${ORIGINAL}\`, \`${DIVIDER}\`, and \`${FINAL}\`

### 2. ORIGINAL Section Rules (What to Match)
- The ORIGINAL code must EXACTLY match the existing code in the file
- Do NOT add, remove, or modify ANY whitespace, newlines, or comments
- Copy the existing code character-by-character, including all formatting
- Each ORIGINAL section must be large enough to uniquely identify the location in the file
- Prefer minimal ORIGINAL sections - only include enough code to uniquely identify the location
- Each ORIGINAL section must be DISJOINT (non-overlapping) from all other ORIGINAL sections

### 3. UPDATED Section Rules (What to Change To)
- Write the complete replacement code as it should appear in the final file
- Include ALL code that should exist at that location, not just the changed lines
- Preserve the same indentation style as the surrounding code

### 4. Multiple Changes
- Combine multiple changes to the SAME file into multiple \`StrReplace\` calls (one per distinct edit).
- Ensure ORIGINAL sections do not overlap, and order blocks top-to-bottom when possible.

## IMPORTANT - Conflict Markers Context:
The conflict markers (\`${ORIGINAL}\`, \`${DIVIDER}\`, \`${FINAL}\`) are ONLY used inside SEARCH/REPLACE blocks for quick-edit / FIM flows (not for the \`StrReplace\` tool).

**NEVER include these markers in regular code blocks or as literal text in your code output.** When outputting regular code blocks (for display, suggestions, or explanations), output ONLY the code content. Do NOT include conflict markers unless you are specifically creating a SEARCH/REPLACE block for quick-edit.

## Example:
If the file contains:
\`\`\`
function greet() {
  console.log("Hello")
}
\`\`\`

To change "Hello" to "Hi there":
\`\`\`
${ORIGINAL}
  console.log("Hello")
${DIVIDER}
  console.log("Hi there")
${FINAL}
\`\`\`
`
// const chatSuggestionDiffExample = `\
// ${tripleTick[0]}typescript
// /Users/username/Dekstop/my_project/app.ts
// // ... existing code ...
// // {{change 1}}
// // ... existing code ...
// // {{change 2}}
// // ... existing code ...
// // {{change 3}}
// // ... existing code ...
// ${tripleTick[1]}`


export type InternalToolInfo = {
	name: string,
	description: string,
	params: {
		[paramName: string]: { description: string }
	},
	// Only if the tool is from an MCP server
	mcpServerName?: string,
	annotations?: Record<string, unknown>,
	inputSchema?: JsonToolSchema,
	example?: string,
}

const uriParam = (object: string) => ({
	uri: { description: `The FULL path to the ${object}.` }
})

const terminalDescHelper = `You can use this tool to run any command: sed, grep, mkdir, rm, etc. Do not edit file contents with this tool; use StrReplace instead. When working with git and other tools that open an editor (e.g. git diff), you should pipe to cat to get all results and not get stuck in vim.`

const cwdHelper = 'Optional. The directory in which to run the command. Defaults to the first workspace folder.'

export type SnakeCase<S extends string> =
	// exact acronym URI
	S extends 'URI' ? 'uri'
	// suffix URI: e.g. 'rootURI' -> snakeCase('root') + '_uri'
	: S extends `${infer Prefix}URI` ? `${SnakeCase<Prefix>}_uri`
	// default: for each char, prefix '_' on uppercase letters
	: S extends `${infer C}${infer Rest}`
	? `${C extends Lowercase<C> ? C : `_${Lowercase<C>}`}${SnakeCase<Rest>}`
	: S;

export type SnakeCaseKeys<T extends Record<string, any>> = {
	[K in keyof T as SnakeCase<Extract<K, string>>]: T[K]
};

/** Enabled skills the model may load via the `skill` tool. */
const enabledSkillsForPrompt = () => listSkills().filter(s => s.enabled)

/**
 * Skills the model may load on its own initiative: enabled AND not flagged
 * `disableModelInvocation`. The latter are surfaced separately under <explicit_skills> and
 * must NOT be advertised in the tool's auto-load list.
 */
const autoInvokeSkillsForPrompt = () => enabledSkillsForPrompt().filter(s => !s.disableModelInvocation)

/** Builds the `skill` tool description, including the current set of loadable skills. */
const buildSkillToolDescription = (): string => {
	const skills = enabledSkillsForPrompt()
	const loadable = skills.filter(s => !s.disableModelInvocation)
	const list = loadable.length > 0
		? loadable.map(s => `- ${s.name}: ${s.description}`).join('\n')
		: '(none currently installed)'
	return `Load a specialized skill when the task matches its description. Skills provide domain-specific instructions, workflows, and best practices that are not loaded until you request them.

Available skills:
${list}

Usage notes:
- Call this tool with the skill's exact name to load its full instructions, then follow them.
- Only load a skill when the current task matches its description — skills are lazily loaded to keep context focused.
- The tool returns the skill's instructions as text; act on them, do not just relay them to the user.`
}

export const builtinTools: {
	[T in keyof BuiltinToolCallParams]: {
		name: string;
		description: string;
		// more params can be generated than exist here, but these params must be a subset of them
		params: Partial<{ [paramName in keyof SnakeCaseKeys<BuiltinToolCallParams[T]>]: { description: string } }> & Record<string, { description: string }>
		inputSchema?: JsonToolSchema;
		example?: string;
	}
} = {


	Read: {
		name: 'Read',
		description: `Reads a file from the local filesystem. You can access any file directly by using this tool.
If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters
- Lines in the output are numbered starting at 1, using following format: LINE_NUMBER|LINE_CONTENT
- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful.
- If you read a file that exists but has empty contents you will receive 'File is empty.'

Image Support:
- This tool can also read image files when called with the appropriate path.
- Supported image formats: jpeg/jpg, png, gif, webp.

PDF Support:
- PDF files are converted into text content automatically (subject to the same character limits as other files).`,
		params: {
			path: { description: 'The absolute path to the file.' },
			offset: { description: 'Optional. The line number to start reading from. Positive values are 1-indexed from the start of the file. Negative values count backwards from the end (e.g. -1 is the last line). Only provide if the file is too large to read at once.' },
			limit: { description: 'Optional. The number of lines to read. Only provide if the file is too large to read at once.' },
		},
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'The absolute path to the file.' },
				offset: { type: 'integer', description: 'Optional. The line number to start reading from. Positive values are 1-indexed from the start of the file. Negative values count backwards from the end (e.g. -1 is the last line). Only provide if the file is too large to read at once.' },
				limit: { type: 'integer', description: 'Optional. The number of lines to read. Only provide if the file is too large to read at once.' },
			},
			required: ['path'],
		},
		example: `Read entire file:
<Read>
<path>/path/to/file.ts</path>
</Read>

Read specific range:
<Read>
<path>/path/to/largeFile.ts</path>
<offset>35</offset>
<limit>50</limit>
</Read>

Read tail of file (last 20 lines):
<Read>
<path>/path/to/log.txt</path>
<offset>-20</offset>
</Read>

Read image:
<Read>
<path>/path/to/screenshot.png</path>
</Read>`,
	},

	Glob: {
		name: 'Glob',
		description: `Tool to search for files matching a glob pattern

- Works fast with codebases of any size
- Returns matching file paths sorted by modification time
- Use this tool to discover and explore files by name or path patterns (replaces directory listing tools)
- Combine with Grep when you need to search file contents
- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches that are potentially useful as a batch.`,
		params: {
			globPattern: {
				description: `The glob pattern to match files against.
Patterns not starting with "**/" are automatically prepended with "**/" to enable recursive searching.

Examples:
	- "*.js" (becomes "**/*.js") - find all .js files
	- "**/node_modules/**" - find all node_modules directories
	- "**/test/**/test_*.ts" - find all test_*.ts files in any test directory`,
			},
			targetDirectory: { description: 'Absolute path to directory to search for files in. If not provided, defaults to the workspace root.' },
		},
		inputSchema: {
			type: 'object',
			properties: {
				glob_pattern: {
					type: 'string',
					description: `The glob pattern to match files against.
Patterns not starting with "**/" are automatically prepended with "**/" to enable recursive searching.

Examples:
	- "*.js" (becomes "**/*.js") - find all .js files
	- "**/node_modules/**" - find all node_modules directories
	- "**/test/**/test_*.ts" - find all test_*.ts files in any test directory`,
				},
				target_directory: {
					type: 'string',
					description: 'Absolute path to directory to search for files in. If not provided, defaults to the workspace root.',
				},
			},
			required: ['glob_pattern'],
		},
		example: `Find every JavaScript file in the workspace:
	<Glob>
	<glob_pattern>*.js</glob_pattern>
	</Glob>

Find every React component under src/:
	<Glob>
	<glob_pattern>src/**/*.tsx</glob_pattern>
	</Glob>

Find files in a specific directory:
	<Glob>
	<glob_pattern>*.css</glob_pattern>
	<target_directory>/Users/me/project/src/styles</target_directory>
	</Glob>

Explore what lives under a folder (set target_directory; simple patterns become recursive, e.g. * → **/*):
	<Glob>
	<glob_pattern>*</glob_pattern>
	<target_directory>/Users/me/project/src/components</target_directory>
	</Glob>`,
	},

	Grep: {
		name: 'Grep',
		description: `A powerful search tool built on ripgrep
Usage:
- Prefer using Grep for search tasks when you know the exact symbols or strings to search for. Whenever possible, use this tool instead of invoking grep or rg as a terminal command. The Grep tool has been optimized for speed and file restrictions inside Orbit.
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
- Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
- Output modes: "content" shows matching lines (default), "files_with_matches" shows only file paths, "count" shows match counts
- Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use interface\\{\\} to find interface{} in Go code)
- Multiline matching: By default patterns match within single lines only. For cross-line patterns like struct \\{[\\s\\S]*?field, use multiline: true
- Results are capped to several thousand output lines for responsiveness; when truncation occurs, the results report "at least" counts, but are otherwise accurate.
- Content output formatting closely follows ripgrep output format: '-' for context lines, ':' for match lines, and all context/match lines below each file group.`,
		params: {
			pattern: { description: 'The regular expression pattern to search for in file contents' },
			path: { description: 'File or directory to search in (rg pattern -- PATH). Defaults to workspace root.' },
			glob: { description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob' },
			output_mode: { description: 'Output mode: "content" shows matching lines (supports -A/-B/-C context, line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "content".' },
			'-B': { description: 'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.' },
			'-A': { description: 'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.' },
			'-C': { description: 'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.' },
			'-i': { description: 'Case insensitive search (rg -i). Defaults to false.' },
			type: { description: 'File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.' },
			head_limit: { description: 'head_limit: For \'content\' mode: total matches shown (default 500). For \'files_with_matches\' and \'count\' modes: number of files listed (default 500). Hard cap: 5000.' },
			offset: { description: 'Skip first N entries. For "content" mode: skips first N matches. For "files_with_matches" and "count" modes: skips first N files. Use with head_limit for pagination.' },
			multiline: { description: 'Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.' },
		},
		inputSchema: {
			type: 'object',
			properties: {
				pattern: {
					type: 'string',
					description: 'The regular expression pattern to search for in file contents'
				},
				path: {
					type: 'string',
					description: 'File or directory to search in (rg pattern -- PATH). Defaults to workspace root.'
				},
				glob: {
					type: 'string',
					description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob'
				},
				output_mode: {
					type: 'string',
					enum: ['content', 'files_with_matches', 'count'],
					description: 'Output mode: "content" shows matching lines (supports -A/-B/-C context, line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "content".'
				},
				'-B': {
					type: 'integer',
					minimum: 0,
					maximum: 5000,
					description: 'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.'
				},
				'-A': {
					type: 'integer',
					minimum: 0,
					maximum: 5000,
					description: 'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.'
				},
				'-C': {
					type: 'integer',
					minimum: 0,
					maximum: 5000,
					description: 'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.'
				},
				'-i': {
					type: 'boolean',
					description: 'Case insensitive search (rg -i). Defaults to false.'
				},
				type: {
					type: 'string',
					description: 'File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.'
				},
				head_limit: {
					type: 'integer',
					minimum: 0,
					maximum: 5000,
					description: 'head_limit: For \'content\' mode: total matches shown (default 500). For \'files_with_matches\' and \'count\' modes: number of files listed (default 500). Hard cap: 5000.'
				},
				offset: {
					type: 'integer',
					minimum: 0,
					description: 'Skip first N entries. For "content" mode: skips first N matches. For "files_with_matches" and "count" modes: skips first N files. Use with head_limit for pagination.'
				},
				multiline: {
					type: 'boolean',
					description: 'Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.'
				}
			},
			required: ['pattern']
		},
		example: `Find matching lines for "function initApp" in TypeScript files:
<Grep>
<pattern>function\\s+initApp</pattern>
<glob>*.{ts,tsx}</glob>
<output_mode>content</output_mode>
</Grep>

Find usages of "useState" with 2 lines of context:
<Grep>
<pattern>useState</pattern>
<output_mode>content</output_mode>
<-C>2</-C>
</Grep>`,
	},

	read_lint_errors: {
		name: 'read_lint_errors',
		description: `Read and display linter errors from the current workspace. You can provide paths to specific files or directories, or omit the argument to get diagnostics for all files.

- If a file path is provided, returns diagnostics for that file only
- If a directory path is provided, returns diagnostics for all files within that directory
- If no path is provided, returns diagnostics for all files in the workspace
- This tool can return linter errors that were already present before your edits, so avoid calling it with a very wide scope of files
- NEVER call this tool on a file unless you've edited it or are about to edit it`,
		params: {
			...uriParam('file'),
		},
		example: `Displays all linting errors found in src/utils/helpers.ts
<read_lint_errors>
<uri>src/utils/helpers.ts</uri>
</read_lint_errors>`,
	},

	StrReplace: {
		name: 'StrReplace',
		description: `Performs exact string replacements in files.

Usage:
- When editing text, ensure you preserve the exact indentation (tabs/spaces) as it appears before.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string.
- Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
- Optional parameter: replace_all (boolean, default false) — if true, replaces all occurrences of old_string in the file.

If you want to create a new file, use the Write tool instead.`,
		params: {
			path: { description: 'The absolute path to the file to modify' },
			old_string: { description: 'The text to replace' },
			new_string: { description: 'The text to replace it with (must be different from old_string)' },
			replace_all: { description: 'Replace all occurrences of old_string (default false)' },
		},
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'The absolute path to the file to modify' },
				old_string: { type: 'string', description: 'The text to replace' },
				new_string: { type: 'string', description: 'The text to replace it with (must be different from old_string)' },
				replace_all: { type: 'boolean', description: 'Replace all occurrences of old_string (default false)' },
			},
			required: ['path', 'old_string', 'new_string'],
		},
		example: `Renames a function in src/utils/helpers.ts:
<StrReplace>
<path>src/utils/helpers.ts</path>
<old_string>function getData() {
	return fetchData();
}</old_string>
<new_string>async function fetchDataFromServer() {
	const response = await fetch("/api/data");
	return response.json();
}</new_string>
</StrReplace>`,
	},

	Write: {
		name: 'Write',
		description: `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
- Does NOT auto-create parent folders — use Shell with mkdir -p first if needed.`,
		params: {
			path: { description: 'The absolute path to the file to modify' },
			contents: { description: 'The contents to write to the file' },
		},
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'The absolute path to the file to modify' },
				contents: { type: 'string', description: 'The contents to write to the file' },
			},
			required: ['path', 'contents'],
		},
		example: `Creates or overwrites src/utils/helpers.ts:
<Write>
<path>src/utils/helpers.ts</path>
<contents>export function sum(a, b) {
	return a + b;
}
</contents>
</Write>`,
	},

	Shell: {
		name: 'Shell',
		description: `Executes a command in a long-lived shell session with a configurable foreground wall-clock timeout.

<managing-long-running-commands>
Shell runs commands in a long-lived shell session. block_until_ms sets a wall-clock deadline (default 30000ms). Set block_until_ms: 0 to run in the background — the tool returns immediately with shell_id for use with AwaitShell. For long-running processes (dev servers, watch modes), use block_until_ms: 0 and poll with AwaitShell or set notify_on_output to wake when output matches a regex.
</managing-long-running-commands>

<scheduling-notifications>
Use notify_on_output when you need to wake on specific output (e.g. test failure, server ready). Pass a JSON object with pattern (regex), debounce_ms (minimum 1000), and reason (short label). When the pattern matches, a synthetic tool result is injected to re-engage the agent.
</scheduling-notifications>

<other-common-operations>
- block_until_ms: 0 — background immediately and receive shell_id
- AwaitShell — poll output or wait for a regex pattern on a prior shell
- working_directory — optional cwd override
</other-common-operations>

${terminalDescHelper}`,
		params: {
			command: { description: 'The command to execute.' },
			working_directory: { description: cwdHelper },
			block_until_ms: { description: 'Max time to block before returning (milliseconds). Defaults to 30000. Set to 0 to run in the background and return immediately with shell_id.' },
			description: { description: 'Clear, concise description of what this command does in 5-10 words.' },
			notify_on_output: { description: 'Optional. JSON object: { "pattern": "<regex>", "debounce_ms": 1000, "reason": "<short label>" }. Wakes the LLM when output matches the pattern.' },
			request_smart_mode_approval: { description: 'Set to true only after Auto-review blocks this exact command and you decide the user should approve it through the native approval card.' },
		},
		example: `<Shell>
<command>npm run test</command>
<working_directory>./</working_directory>
<block_until_ms>30000</block_until_ms>
<description>Run unit tests</description>
</Shell>

<Shell>
<command>npm run dev</command>
<working_directory>./</working_directory>
<block_until_ms>0</block_until_ms>
<description>Start dev server in background</description>
<notify_on_output>{"pattern": "ready on", "debounce_ms": 5000, "reason": "dev server ready"}</notify_on_output>
</Shell>`,
	},

	AwaitShell: {
		name: 'AwaitShell',
		description: `Poll a background shell. block_until_ms: 0 returns the current output immediately; with a pattern, blocks until the pattern matches or the timeout elapses.`,
		params: {
			shell_id: { description: 'Optional shell id to poll. If omitted, this tool sleeps for the full block_until_ms duration and then returns.' },
			block_until_ms: { description: 'Max sleep time to block before returning (in milliseconds). Defaults to 30000. Set to 0 for a non-blocking status check.' },
			pattern: { description: 'Optional. Block until the regex matches stdout/stderr stream (or task completes). Matches anywhere in the shell output, not just new output.' },
		},
		example: `<AwaitShell>
<shell_id>abc-123</shell_id>
<block_until_ms>30000</block_until_ms>
</AwaitShell>

<AwaitShell>
<shell_id>abc-123</shell_id>
<block_until_ms>60000</block_until_ms>
<pattern>All tests passed</pattern>
</AwaitShell>`,
	},

	TodoWrite: {
		name: 'TodoWrite',
		description: `Use this tool to create and manage a structured task list for your current coding session. This helps track progress, organize complex tasks, and demonstrate thoroughness.

Note: Other than when first creating todos, don't tell the user you're updating todos, just do it.

**IMPORTANT FORMAT REQUIREMENT:** The \`todos\` parameter must be a JSON array string, NOT XML. Do NOT use <todo> or <todos> XML tags inside the todos parameter. Use the exact JSON format shown in the example below.

### When to Use This Tool

Use proactively for:
1. Complex multi-step tasks (3+ distinct steps)
2. Non-trivial tasks requiring careful planning
3. User explicitly requests todo list
4. User provides multiple tasks (numbered/comma-separated)
5. After receiving new instructions - capture requirements as todos (use merge=true to add new ones without dropping existing todos)
6. After completing tasks - mark complete with merge=true and add follow-ups
7. When starting new tasks - mark as in_progress (ideally only one at a time)

### When NOT to Use

Skip for:
1. Single, straightforward tasks
2. Trivial tasks with no organizational benefit
3. Tasks completable in < 3 trivial steps
4. Purely conversational/informational requests
5. Don't add a task to test the change unless asked, or you'll overfocus on testing

### Examples

<example>
  User: Add dark mode toggle to settings
  Assistant:
    - *Creates todo list:*
      1. Add state management [in_progress]
      2. Implement styles
      3. Create toggle component
      4. Update components
    - [Immediately begins working on todo 1 in the same tool call batch]
<reasoning>
  Multi-step feature with dependencies.
</reasoning>
</example>

<example>
  User: Rename getCwd to getCurrentWorkingDirectory across my project
  Assistant: *Searches codebase, finds 15 instances across 8 files*
  *Creates todo list with specific items for each file that needs updating*

<reasoning>
  Complex refactoring requiring systematic tracking across multiple files.
</reasoning>
</example>

<example>
  User: Implement user registration, product catalog, shopping cart, checkout flow.
  Assistant: *Creates todo list breaking down each feature into specific tasks*

<reasoning>
  Multiple complex features provided as list requiring organized task management.
</reasoning>
</example>

<example>
  User: Optimize my React app - it's rendering slowly.
  Assistant: *Analyzes codebase, identifies issues*
  *Creates todo list: 1) Memoization, 2) Virtualization, 3) Image optimization, 4) Fix state loops, 5) Code splitting*

<reasoning>
  Performance optimization requires multiple steps across different components.
</reasoning>
</example>

### Examples of When NOT to Use the Todo List

<example>
  User: What does git status do?
  Assistant: Shows current state of working directory and staging area...

<reasoning>
  Informational request with no coding task to complete.
</reasoning>
</example>

<example>
  User: Add comment to calculateTotal function.
  Assistant: *Uses edit tool to add comment*

<reasoning>
  Single straightforward task in one location.
</reasoning>
</example>

<example>
  User: Run npm install for me.
  Assistant: *Executes npm install* Command completed successfully...

<reasoning>
  Single command execution with immediate results.
</reasoning>
</example>

### Task States and Management

1. **Task States:**
  - pending: Not yet started
  - in_progress: Currently working on
  - completed: Finished successfully
  - cancelled: No longer needed

2. **Task Management:**
  - Update status in real-time
  - Mark complete IMMEDIATELY after finishing
  - Only ONE task in_progress at a time
  - Complete current tasks before starting new ones

3. **Task Breakdown:**
  - Create specific, actionable items
  - Break complex tasks into manageable steps
  - Use clear, descriptive names

4. **Parallel Todo Writes:**
  - Prefer creating the first todo as in_progress
  - Start working on todos by using tool calls in the same tool call batch as the todo write
  - Batch todo updates with other tool calls for better latency and lower costs to the user

Use this tool when tracking improves progress clarity. Avoid creating todos just to look busy or for work that is already obvious from a single action.`,
		params: {
			todos: {
				description: 'JSON array of todo objects. Each object must have "id" (unique string like "setup-auth"). New todos and replace-mode todos must include "content" (description string). Merge-mode updates may omit unchanged fields and patch by id. Optionally include "status" (pending/in_progress/completed/cancelled), "priority" (high/medium/low), and "activeForm" (present continuous display text for in_progress items). MUST be a JSON array string, NOT XML. Example: [{"id": "setup-auth", "content": "Setup JWT authentication", "status": "in_progress", "priority": "high", "activeForm": "Setting up JWT authentication"}, {"id": "add-login", "content": "Add login endpoint", "status": "pending", "priority": "medium"}]'
			},
			merge: {
				description: 'Whether to merge the todos with the existing todos. If true, todos are patched by id and unchanged properties can be omitted. If false, the new todos replace the entire existing todo list and each item must include content.'
			}
		},
		example: `Creates a task list with two items
<TodoWrite>
<todos>[{"id": "setup-auth", "content": "Setup JWT authentication", "status": "in_progress", "priority": "high"}, {"id": "add-login", "content": "Add login endpoint", "status": "pending", "priority": "medium"}]</todos>
<merge>false</merge>
</TodoWrite>`
	},

	AskQuestion: {
		name: 'AskQuestion',
		description: `Collect structured multiple-choice answers from the user.
Provide one or more questions with options, and set allow_multiple when multi-select is appropriate.

Use this tool when you need to gather specific information from the user through a structured question format.
Each question should have:
- A unique id (used to match answers)
- A clear prompt/question text
- At least 2 options for the user to choose from (do not use id \`__other__\` — reserved for the UI "Other…" option)
- An optional allow_multiple flag (defaults to false for single-select)
By default, the tool will present the questions to the user and wait for their responses before continuing.

Prefer this tool over listing options in your response text (as letters, numbers, bullet points, etc.). Also use it when you are blocked and need the user to choose a path forward.`,
		params: {
			title: { description: 'Optional title for the questions form' },
			questions: { description: 'JSON array of question objects. Each question: { id, prompt, options: [{id,label}], allow_multiple? }. minItems: 1, each question has minItems: 2 options.' },
		},
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'Optional title for the questions form' },
				questions: {
					type: 'array',
					minItems: 1,
					items: {
						type: 'object',
						properties: {
							id: { type: 'string' },
							prompt: { type: 'string' },
							options: {
								type: 'array',
								minItems: 2,
								items: {
									type: 'object',
									properties: {
										id: { type: 'string' },
										label: { type: 'string' },
									},
									required: ['id', 'label'],
								},
							},
							allow_multiple: { type: 'boolean', default: false },
						},
						required: ['id', 'prompt', 'options'],
					},
				},
			},
			required: ['questions'],
		},
		example: `<AskQuestion>
<title>Quick setup questions</title>
<questions>[{"id":"q1","prompt":"Which keyboard shortcut do you use most?","options":[{"id":"a","label":"Save (Cmd/Ctrl+S)"},{"id":"b","label":"Command palette (Cmd/Ctrl+Shift+P)"},{"id":"c","label":"Other..."}],"allow_multiple":false},{"id":"q2","prompt":"When does a build fail, what's your first move?","options":[{"id":"retry","label":"Retry immediately"},{"id":"step","label":"Step away for 5 min, then retry"}]}]</questions>
</AskQuestion>`,
	},

	// --- Plan Mode Tools ---

	create_plan: {
		name: 'create_plan',
		description: `Use this tool to create a concise plan for accomplishing the user's request. This tool should be called at the end of the planning phase to finalize and store the plan.

The plan you create should be properly formatted in markdown, using appropriate sections and headers. The plan should be very concise and actionable, providing the minimum amount of detail for the user to understand and action the plan. It may be helpful to identify the most important couple files you will change, and existing code you will leverage. Cite specific file paths and essential snippets of code. IMPORTANT: Do NOT use markdown tables in plan content (they cannot be rendered for the user); use bullet lists instead. The first line MUST BE A TITLE for the plan formatted as a level 1 markdown heading.

TASK ORGANIZATION:

Use 'todos' for organizing implementation tasks:
- Each todo should be a clear, specific, and actionable task
- Each todo needs a unique ID (e.g., "setup-auth") and descriptive content
- If the plan is simple, provide just a few high-level todos or none at all

UPDATING THE PLAN:
- This tool creates a NEW plan file each time it is called
- The plan file URI will be returned in the tool result
- To update an existing plan, read and edit the plan file directly using your file editing tools
- Do NOT call this tool again to update an existing plan

Additional guidelines:
- Avoid asking clarifying questions in the plan itself. Ask them before calling this tool. Present these to the user using the AskQuestion tool.
- Todos help break down complex plans into manageable, trackable tasks
- Focus on high-level meaningful decisions rather than low-level implementation details
- A good plan is glanceable, not a wall of text.`,
		params: {
			name: { description: 'Short 3-4 word name for the plan (e.g., "User Authentication", "API Refactor"). Optional - defaults to "Implementation Plan" if not provided.' },
			overview: { description: '1-2 sentence high-level summary of what will be accomplished.' },
			plan: { description: 'Complete markdown plan content. Must start with # heading. Be concise - provide minimum detail for understanding. NO TABLES - use bullet lists.' },
			todos: { description: 'JSON array of todo objects with unique id (e.g., "setup-auth") and content. MUST be a JSON array string, NOT XML. Example: [{"id": "setup-auth", "content": "Setup JWT authentication system"}]' },
		},
		example: `Creates a complete implementation plan in one call:
<create_plan>
<name>User Authentication</name>
<overview>Implement JWT-based authentication with login/logout endpoints and session management to secure API access.</overview>
<plan>
# User Authentication Implementation

## Approach

Implement JWT token-based authentication using existing middleware patterns in \`src/middleware/\`. Will leverage the \`express-jwt\` library already in package.json.

## Key Files

- **\`src/auth/authService.ts\`** - Create new service with token generation
- **\`src/middleware/authMiddleware.ts\`** - Add JWT verification middleware
- **\`src/routes/authRoutes.ts\`** - New login/logout endpoints
- **\`src/models/user.ts\`** - Extend with password hashing

## Implementation Details

1. **Token Generation**
   - Use \`jsonwebtoken\` library (already installed)
   - 24hr expiry, refresh token support
   - Store secret in environment variable

2. **Middleware Integration**
   - Add to existing middleware chain in \`src/app.ts\`
   - Protect routes with \`authenticate\` wrapper
   - Return 401 for invalid/missing tokens

3. **Password Security**
   - Use bcrypt for hashing (add to dependencies)
   - Salt rounds: 10
   - Store hashed passwords only

## Testing

- Unit tests for token generation/verification
- Integration tests for login/logout flows
- Test expired token handling
</plan>
<todos>[
  {"id": "create-auth-service", "content": "Create authService.ts with JWT token generation"},
  {"id": "add-middleware", "content": "Implement authentication middleware with token verification"},
  {"id": "create-endpoints", "content": "Add POST /login and POST /logout endpoints"},
  {"id": "password-hashing", "content": "Add bcrypt password hashing to user model"},
  {"id": "write-tests", "content": "Write unit and integration tests for auth flow"}
]</todos>
</create_plan>`,
	},

	read_plan: {
		name: 'read_plan',
		description: `Read the current active plan file. Returns the full Markdown content of the plan including all sections.

**When to Use:**
- To check the current state of the plan
- Before making updates to ensure you have the latest content
- To reference the plan when answering user questions

**Note:** If no plan exists, creates a placeholder indicating no active plan.`,
		params: {},
		example: `Reads the current active plan
<read_plan>
</read_plan>`,
	},

	update_plan_section: {
		name: 'update_plan_section',
		description: `⚠️ LEGACY TOOL: Prefer editing plan files directly with StrReplace. This tool exists for backward compatibility only.

Update a specific section of the current plan file. The entire section content will be replaced.

**Available Sections:**
- \`overview\` - High-level description of the plan
- \`files\` - List of files to modify (use Markdown list format)
- \`steps\` - Numbered implementation steps
- \`checklist\` - Implementation checklist with checkboxes
- \`testing\` - Testing strategy and approach
- \`notes\` - Additional considerations and trade-offs

**Best Practices:**
- Read the plan first to understand current state
- Use appropriate Markdown formatting for each section
- For steps, use numbered lists
- For files, use bullet points with backtick-wrapped paths`,
		params: {
			section_name: { description: 'The section to update. One of: overview, files, steps, checklist, testing, notes' },
			content: { description: 'The new content for the section (Markdown formatted)' },
		},
		example: `Updates the implementation steps section
<update_plan_section>
<section_name>steps</section_name>
<content>1. Create AuthService class with JWT token generation
2. Implement login endpoint in authRoutes.ts
3. Add authentication middleware for protected routes
4. Create logout endpoint with token invalidation
5. Add session refresh mechanism</content>
</update_plan_section>`,
	},

	add_plan_todo: {
		name: 'add_plan_todo',
		description: `⚠️ LEGACY TOOL: Use create_plan with todos array instead. For existing plans, edit the file directly with StrReplace.

Add a single TODO item to the plan's implementation checklist. Items are added as unchecked checkboxes.

**When to Use:**
- To add specific, actionable tasks to the plan
- When breaking down implementation steps into granular items
- To track individual tasks that need completion

**Best Practices:**
- Keep items specific and actionable
- Start with a verb (Create, Add, Update, Fix, etc.)
- Use categories to group related items`,
		params: {
			todo_text: { description: 'The TODO item text (without the checkbox prefix)' },
			category: { description: 'Optional. A category header to group this item under (e.g., "Backend", "Frontend", "Testing")' },
		},
		example: `Adds a TODO item to the checklist
<add_plan_todo>
<todo_text>Create JWT token generation utility</todo_text>
<category>Backend</category>
</add_plan_todo>`,
	},

	mark_plan_item_complete: {
		name: 'mark_plan_item_complete',
		description: `⚠️ LEGACY TOOL: For existing plans, edit the file directly with StrReplace to update todo status.

Mark a TODO item as complete in the plan's checklist. Items are identified by their 1-based index among unchecked items.

**When to Use:**
- When a specific task has been completed
- To track progress through the plan
- During Agent mode execution when following a plan

**Note:** The index refers to the position among unchecked items only, not all items.`,
		params: {
			item_index: { description: 'The 1-based index of the unchecked TODO item to mark complete' },
		},
		example: `Marks the first unchecked item as complete
<mark_plan_item_complete>
<item_index>1</item_index>
</mark_plan_item_complete>`,
	},

	// --- sub-agent delegation
	task: {
		name: 'task',
		description: `Launch a specialized sub-agent to handle a focused task autonomously. The sub-agent runs in complete isolation — it has NO access to this conversation history.

Available agents:
${listSubAgents().map(a => `- ${a.agentType} [${a.permissionMode ?? 'custom'}]: ${a.whenToUse}`).join('\n')}

## Writing a good prompt
The agent starts with zero context. Brief it like a smart colleague who just walked in:
- Explain what you're trying to accomplish and why
- Include exact file paths, function names, and line numbers when you know them
- Describe what you've already tried or ruled out
- State the expected output format clearly

**Never delegate understanding.** Don't write "based on your findings, fix the bug" — that pushes synthesis onto the agent. Write prompts that prove you understood: include specifics.

Terse command-style prompts produce shallow, generic work.

## Usage notes
- Always include a short description (3-5 words) of what the agent will do
- Use sub-agents for complex, multi-step, or open-ended work. Do not use a sub-agent when a specific file read, filename search, or 2-3 known-file inspection will answer faster with direct tools.
- Launch multiple agents concurrently when tasks are independent. If the user asks for parallel agents, you MUST send a single assistant message containing multiple task tool calls.
- Use foreground (default) when you need the agent's result before continuing. Use run_in_background=true only when the work is genuinely independent; do not poll or guess background results.
- The agent returns a single text result — relay the key findings to the user yourself
- Treat task results as authoritative, but if a task result says failed, cancelled, or hit a turn limit, clearly report that state instead of summarizing it as a successful finding.
- Clearly tell the agent whether it should only research or may modify code
- Optionally specify a model override to use a different model for this agent`,
		params: {
			subagent_type: { description: `The type of agent to use. Available: ${listSubAgents().map(a => a.agentType).join(', ')}` },
			description: { description: 'Short 3-5 word description of what the agent will do (shown in UI)' },
			prompt: { description: 'Complete, self-contained task instructions. Include all context, file paths, and goals — the agent has no access to this conversation.' },
			model: { description: 'Optional model name override (e.g. "claude-opus-4-5"). Uses the same provider as the current model.' },
			run_in_background: { description: 'Optional. Set to true to run the agent in the background. You will be notified when it completes. Use for long-running tasks when you have other work to do.' },
		},
		example: `task({ subagent_type: "explore", description: "Find auth files", prompt: "Find all files related to authentication in this codebase. Search for: login, auth, token, session, JWT, OAuth patterns. For each file found, note its role and how it connects to others. Report exact file paths and key functions." })`,
	},

	// --- skills
	skill: {
		name: 'skill',
		description: buildSkillToolDescription(),
		params: {
			name: { description: `The exact name of the skill to load. Available: ${autoInvokeSkillsForPrompt().map(s => s.name).join(', ') || '(none)'}` },
		},
		example: `skill({ name: "code-review" })`,
	},

} satisfies { [T in keyof BuiltinToolResultType]: InternalToolInfo }

export const builtinToolNames = Object.keys(builtinTools) as BuiltinToolName[]
const toolNamesSet = new Set<string>(builtinToolNames)
const normalizeToolName = (toolName: string) => toolName.trim().replace(/[\s-]+/g, '_')
export const resolveBuiltinToolName = (toolName: string): BuiltinToolName | undefined => {
	const normalized = normalizeToolName(toolName)
	const lower = normalized.toLowerCase()
	if (lower === 'read_file') {
		return 'Read'
	}
	if (toolNamesSet.has(lower)) return lower as BuiltinToolName
	if (toolNamesSet.has(normalized)) return normalized as BuiltinToolName
	return undefined
}
export const isABuiltinToolName = (toolName: string): toolName is BuiltinToolName => {
	return !!resolveBuiltinToolName(toolName)
}

const builtinToolNameSet = new Set<string>(builtinToolNames)
const compactBuiltinToolNameMap = (() => {
	const map = new Map<string, BuiltinToolName | null>()
	for (const name of builtinToolNames) {
		const compact = name.replace(/[^a-z0-9]/gi, '').toLowerCase()
		const existing = map.get(compact)
		if (existing && existing !== name) {
			map.set(compact, null)
		} else if (!existing) {
			map.set(compact, name)
		}
	}
	return map
})()

const normalizeToolNameLoose = (toolName: string) => {
	const trimmed = toolName.trim()
	if (!trimmed) return ''
	const withUnderscores = trimmed.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
	return withUnderscores.replace(/[\s-]+/g, '_')
}

const stripKnownPrefixes = (toolName: string) => {
	const trimmed = toolName.trim()
	const lower = trimmed.toLowerCase()
	const prefixes = ['mcp_', 'mcp-', 'mcp ', 'call_', 'tool_', 'builtin_']
	for (const prefix of prefixes) {
		if (lower.startsWith(prefix)) {
			return trimmed.substring(prefix.length).trim()
		}
	}
	if (lower.startsWith('mcp')) {
		const remainder = trimmed.substring(3).replace(/^[_\-\s]+/, '').trim()
		if (remainder) return remainder
	}
	return trimmed
}

const hasMcpToolName = (toolNames: Iterable<string> | undefined, toolName: string) => {
	if (!toolNames) return false
	if (toolNames instanceof Set) return toolNames.has(toolName)
	for (const name of toolNames) {
		if (name === toolName) return true
	}
	return false
}

export const resolveBuiltinToolNameLoose = (toolName: string, opts?: { mcpToolNames?: Iterable<string> }): BuiltinToolName | undefined => {
	if (hasMcpToolName(opts?.mcpToolNames, toolName)) return undefined

	const resolved = resolveBuiltinToolName(toolName)
	if (resolved) return resolved

	const normalized = normalizeToolNameLoose(toolName)
	const lower = normalized.toLowerCase()
	if (builtinToolNameSet.has(lower)) return lower as BuiltinToolName
	if (builtinToolNameSet.has(normalized)) return normalized as BuiltinToolName

	const stripped = stripKnownPrefixes(toolName)
	if (stripped !== toolName) {
		const strippedResolved = resolveBuiltinToolName(stripped)
		if (strippedResolved) return strippedResolved
		const strippedNormalized = normalizeToolNameLoose(stripped)
		const strippedLower = strippedNormalized.toLowerCase()
		if (builtinToolNameSet.has(strippedLower)) return strippedLower as BuiltinToolName
		if (builtinToolNameSet.has(strippedNormalized)) return strippedNormalized as BuiltinToolName
	}

	const compact = toolName.replace(/[^a-z0-9]/gi, '').toLowerCase()
	const compactMatch = compactBuiltinToolNameMap.get(compact)
	return compactMatch ?? undefined
}

// Read/search tools that can be parallelized safely. `skill` is read-only (it returns
// the text of an in-memory skill definition) so it is safe in every mode.
export const readOnlyToolNames: BuiltinToolName[] = [...READ_ONLY_BUILTIN_TOOL_NAMES, 'skill']

const llmHiddenBuiltinToolNames = new Set<BuiltinToolName>([
	'update_plan_section',
	'add_plan_todo',
	'mark_plan_item_complete',
])

export const isLLMHiddenBuiltinToolName = (toolName: string): boolean => {
	const resolved = resolveBuiltinToolNameLoose(toolName)
	return !!resolved && llmHiddenBuiltinToolNames.has(resolved)
}

export const llmVisibleBuiltinToolNames = builtinToolNames.filter(toolName => !llmHiddenBuiltinToolNames.has(toolName))

export const isMCPToolReadOnly = (tool: InternalToolInfo): boolean => {
	const annotations = tool.annotations as Record<string, unknown> | undefined
	if (!annotations) return false
	const readOnly =
		(annotations.readOnly as boolean | undefined)
		?? (annotations.readonly as boolean | undefined)
		?? (annotations.read_only as boolean | undefined)
	return readOnly === true
}

export const availableTools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined, toolPolicy?: ToolPolicy) => {

	// Plan mode gets read-only tools plus plan management tools
	const planModeToolNames: BuiltinToolName[] = [
		...readOnlyToolNames,
		'TodoWrite',
		'AskQuestion',
		'task',
		'StrReplace',
		'Write',
		'create_plan',
		'read_plan',
	]

	const builtinToolNames: BuiltinToolName[] | undefined = chatMode === 'normal' ? readOnlyToolNames
		: chatMode === 'plan' ? planModeToolNames
			: chatMode === 'agent' ? Object.keys(builtinTools) as BuiltinToolName[]
				: undefined

	const allowedBuiltinNameSet = toolPolicy?.allowedBuiltinTools
		? new Set(
			toolPolicy.allowedBuiltinTools
				.map(toolName => resolveBuiltinToolNameLoose(toolName))
				.filter((toolName): toolName is BuiltinToolName => !!toolName)
		)
		: undefined
	const disallowedBuiltinNameSet = toolPolicy?.disallowedBuiltinTools
		? new Set(
			toolPolicy.disallowedBuiltinTools
				.map(toolName => resolveBuiltinToolNameLoose(toolName))
				.filter((toolName): toolName is BuiltinToolName => !!toolName)
		)
		: undefined

	const effectiveBuiltinTools = builtinToolNames
		?.filter(toolName => {
			if (llmHiddenBuiltinToolNames.has(toolName)) return false
			if (toolPolicy?.denyDelegation && toolName === 'task') return false
			if (disallowedBuiltinNameSet?.has(toolName)) return false
			if (allowedBuiltinNameSet && !allowedBuiltinNameSet.has(toolName)) return false
			return true
		})
		.map(toolName => {
			if (toolName === 'task') {
				// Rebuild task tool description dynamically so it includes user/project-defined agents
				const agents = listSubAgents();
				return {
					...builtinTools.task,
					description: `Launch a specialized sub-agent to handle a focused task autonomously. The sub-agent runs in complete isolation — it has NO access to this conversation history.

Available agents:
${agents.map(a => `- ${a.agentType} [${a.permissionMode ?? 'custom'}]: ${a.whenToUse}`).join('\n')}

## Writing a good prompt
The agent starts with zero context. Brief it like a smart colleague who just walked in:
- Explain what you're trying to accomplish and why
- Include exact file paths, function names, and line numbers when you know them
- Describe what you've already tried or ruled out
- State the expected output format clearly

**Never delegate understanding.** Don't write "based on your findings, fix the bug" — that pushes synthesis onto the agent. Write prompts that prove you understood: include specifics.

Terse command-style prompts produce shallow, generic work.

## Usage notes
- Always include a short description (3-5 words) of what the agent will do
- Use sub-agents for complex, multi-step, or open-ended work. Do not use a sub-agent when a specific file read, filename search, or 2-3 known-file inspection will answer faster with direct tools.
- Launch multiple agents concurrently when tasks are independent. If the user asks for parallel agents, you MUST send a single assistant message containing multiple task tool calls.
- Use foreground (default) when you need the agent's result before continuing. Use run_in_background=true only when the work is genuinely independent; do not poll or guess background results.
- The agent returns a single text result — relay the key findings to the user yourself
- Treat task results as authoritative, but if a task result says failed, cancelled, or hit a turn limit, clearly report that state instead of summarizing it as a successful finding.
- Clearly tell the agent whether it should only research or may modify code
- Optionally specify a model override to use a different model for this agent`,
					params: {
						...builtinTools.task.params,
						subagent_type: { description: `The type of agent to use. Available: ${agents.map(a => a.agentType).join(', ')}` },
					},
				};
			}
			if (toolName === 'skill') {
				// Rebuild the skill tool description dynamically so it includes the current
				// set of enabled user/project/built-in skills.
				return {
					...builtinTools.skill,
					description: buildSkillToolDescription(),
					params: {
						...builtinTools.skill.params,
						name: { description: `The exact name of the skill to load. Available: ${autoInvokeSkillsForPrompt().map(s => s.name).join(', ') || '(none)'}` },
					},
				};
			}
			return builtinTools[toolName];
		}) ?? undefined

	const effectiveMCPTools = chatMode === 'agent'
		? (mcpTools ?? []).filter(tool => {
			if (toolPolicy?.allowReadOnlyMcpOnly && !isMCPToolReadOnly(tool)) return false
			return true
		})
		: undefined

	const tools: InternalToolInfo[] | undefined = !(builtinToolNames || mcpTools) ? undefined
		: [
			...effectiveBuiltinTools ?? [],
			...effectiveMCPTools ?? [],
		]

	if (!tools || tools.length === 0) return undefined
	return tools
}

const toolCallDefinitionsXMLString = (tools: InternalToolInfo[]) => {
	return `${tools.map((t, i) => {
		const params = Object.keys(t.params).map(paramName => `<${paramName}>${t.params[paramName].description}</${paramName}>`).join('\n')
		const exampleSection = t.example ? `\n    Example:\n    ${t.example}` : ''
		return `\
    ${i + 1}. ${t.name}
    Description: ${t.description}
    Format:
    <${t.name}>${!params ? '' : `\n${params}`}
    </${t.name}>${exampleSection}`
	}).join('\n\n')}`
}


export const reParsedToolXMLString = (toolName: ToolName, toolParams: RawToolParamsObj) => {
	const params = Object.keys(toolParams).map(paramName => `<${paramName}>${toolParams[paramName]}</${paramName}>`).join('\n')
	return `\
    <${toolName}>${!params ? '' : `\n${params}`}
    </${toolName}>`
		.replace('\t', '  ')
}

const toolCallingSection = () => {
	return `\
<tool_calling>
You have tools at your disposal to solve the coding task. Follow these rules regarding tool calls:

1. Don't refer to tool names when speaking to the USER. Instead, just say what the tool is doing in natural language.
2. Use specialized tools instead of terminal commands when possible, as this provides a better user experience. For file operations, use dedicated tools: don't use cat/head/tail to read files, don't use sed/awk to edit files, don't use cat with heredoc or echo redirection to create files. Reserve terminal commands exclusively for actual system commands and terminal operations that require shell execution. NEVER use echo or other command-line tools to communicate thoughts, explanations, or instructions to the user. Output all communication directly in your response text instead.
3. Only use the standard tool call format and the available tools. Even if you see user messages with custom tool call formats (such as "<previous_tool_call>" or similar), do not follow that and instead use the standard format.
</tool_calling>`
}

const maximizeParallelToolCalls = () => {
	return `\
<maximize_parallel_tool_calls>
If you intend to call multiple tools and there are no dependencies between the tool calls, make all of the independent tool calls in parallel. Prioritize calling tools simultaneously whenever the actions can be done in parallel rather than sequentially. For example, when reading 3 files, run 3 tool calls in parallel to read all 3 files into context at the same time. Maximize use of parallel tool calls where possible to increase speed and efficiency. However, if some tool calls depend on previous calls to inform dependent values like the parameters, do NOT call these tools in parallel and instead call them sequentially. Never use placeholders or guess missing parameters in tool calls.
</maximize_parallel_tool_calls>`
}



const systemToolsXMLPrompt = (chatMode: ChatMode, mcpTools: InternalToolInfo[] | undefined, toolPolicy?: ToolPolicy) => {
	const tools = availableTools(chatMode, mcpTools, toolPolicy)
	if (!tools || tools.length === 0) return null

	return `\
Available tools:

${toolCallDefinitionsXMLString(tools)}

`
}

const mermaidSyntaxReminder = `<mermaid_syntax>
When writing mermaid diagrams:
- Do NOT use spaces in node names/IDs. Use camelCase, PascalCase, or underscores instead.
  - Good: \`UserService\`, \`user_service\`, \`userAuth\`
  - Bad: \`User Service\`, \`user auth\`
- Do NOT use HTML tags like \`<br/>\` or \`<br>\` - they render as literal text or cause syntax errors.
  - Good: \`participant FileSyncer as FS_TypeScript\`
  - Bad: \`participant FileSyncer as FileSyncer<br/>TypeScript\`
- When edge labels contain parentheses, brackets, or other special characters, wrap the label in quotes:
  - Good: \`A -->|"O(1) lookup"| B\`
  - Bad: \`A -->|O(1) lookup| B\` (parentheses parsed as node syntax)
- Use double quotes for node labels containing special characters (parentheses, commas, colons):
  - Good: \`A["Process (main)"]\`, \`B["Step 1: Init"]\`
  - Bad: \`A[Process (main)]\` (parentheses parsed as shape syntax)
- Avoid reserved keywords as node IDs: \`end\`, \`subgraph\`, \`graph\`, \`flowchart\`
  - Good: \`endNode[End]\`, \`processEnd[End]\`
  - Bad: \`end[End]\` (conflicts with subgraph syntax)
- For subgraphs, use explicit IDs with labels in brackets: \`subgraph id [Label]\`
  - Good: \`subgraph auth [Authentication Flow]\`
  - Bad: \`subgraph Authentication Flow\` (spaces cause parsing issues)
- Avoid angle brackets and HTML entities in labels - they render as literal text:
  - Good: \`Files[Files Vec]\` or \`Files[FilesTuple]\`
  - Bad: \`Files["Vec&lt;T&gt;"]\`
- Do NOT use explicit colors or styling - the renderer applies theme colors automatically:
  - Bad: \`style A fill:#fff\`, \`classDef myClass fill:white\`, \`A:::someStyle\`
  - These break in dark mode. Let the default theme handle colors.
- Click events are disabled for security - don't use \`click\` syntax
</mermaid_syntax>`

/** Cursor-style per-turn mode instructions injected as <system_reminder> on the latest user message (not in the system prompt). */
export const chat_modeSystemReminder = (chatMode: ChatMode): string | null => {
	if (chatMode === 'plan') {
		return `Plan mode is active. The user indicated that they do not want you to execute yet — you MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received (for example, to make edits). Instead, you should:

1. Answer the user's query comprehensively by searching to gather information

2. If you do not have enough information to create an accurate plan, you MUST ask the user for more information. If any of the user instructions are ambiguous, you MUST ask for clarification.

3. If the user's request is too broad, you MUST ask the user questions that narrow down the scope of the plan. ONLY ask 1-2 critical questions at a time.

4. If there are multiple valid implementations, each changing the plan significantly, you MUST ask the user to clarify which implementation they want you to use.

5. If you have determined that you will need to ask questions, you should ask them IMMEDIATELY at the start of the conversation. Prefer a small pre-read beforehand only if ≤5 files (~20s) will likely answer them.

6. When you're done researching, present your plan by calling the \`create_plan\` tool, which will prompt the user to confirm the plan. Do NOT make any file changes or run any tools that modify the system state in any way until the user has confirmed the plan.

7. The plan should be concise, specific and actionable. Cite specific file paths and essential snippets of code. When mentioning files, use markdown links with the full file path (for example, \`[backend/src/foo.ts](backend/src/foo.ts)\`).

8. Keep plans proportional to the request complexity — don't over-engineer simple tasks.

9. Do NOT use emojis in the plan.

10. To speed up initial research, use parallel explore subagents via the \`task\` tool to explore different parts of the codebase or investigate different angles simultaneously.

11. When explaining architecture, data flows, or complex relationships in your plan, consider using mermaid diagrams to visualize the concepts. Diagrams can make plans clearer and easier to understand.

12. All questions to the user should be asked using the \`AskQuestion\` tool.

${mermaidSyntaxReminder}`
	}

	if (chatMode === 'normal') {
		return `Chat mode is active. You are in read-only mode for exploring code and answering questions.

You MUST NOT edit files, run shell commands, or use any tools that modify the system state. Use read and search tools to gather context and provide concrete answers with file paths and code references.

If the user wants you to implement changes, ask them to switch to Agent mode using the mode selector in the chat UI.`
	}

	// Agent mode: no per-turn reminder (default harness behavior, same as Cursor)
	return null
}

export const formatHarnessTimestamp = (date: Date = new Date()): string => {
	return date.toLocaleString('en-US', {
		weekday: 'long',
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		timeZoneName: 'shortOffset',
	})
}

type HarnessAugmentableMessage = {
	role: string
	content?: string
	images?: string[]
}

/** Inject Cursor-style harness context on the latest user message at LLM prepare time (not stored in chat history). */
export const augmentChatMessagesWithHarnessContext = <T extends HarnessAugmentableMessage>(messages: T[], chatMode: ChatMode): T[] => {
	let lastUserIdx = -1
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (messages[i].role === 'user') {
			lastUserIdx = i
			break
		}
	}
	if (lastUserIdx === -1) {
		return messages
	}

	const userMsg = messages[lastUserIdx]
	const content = userMsg.content ?? ''
	if (content.includes('<user_query>')) {
		return messages
	}

	const reminder = chat_modeSystemReminder(chatMode)
	const timestamp = formatHarnessTimestamp()
	const wrappedContent = reminder
		? `<system_reminder>\n${reminder}\n</system_reminder>\n\n<timestamp>${timestamp}</timestamp>\n<user_query>\n${content}\n</user_query>`
		: `<timestamp>${timestamp}</timestamp>\n<user_query>\n${content}\n</user_query>`

	const newMessages = messages.slice()
	newMessages[lastUserIdx] = { ...userMsg, content: wrappedContent }
	return newMessages
}

/**
 * Builds the <available_skills> system-prompt section advertising loadable skills. Returns
 * an empty string when no skills are enabled. Skills flagged `disableModelInvocation` are
 * listed separately so the model knows they exist but are only used on explicit request.
 */
const buildAvailableSkillsSection = (): string => {
	const skills = listSkills().filter(s => s.enabled)
	if (skills.length === 0) return ''

	const autoInvoke = skills.filter(s => !s.disableModelInvocation)
	const explicit = skills.filter(s => s.disableModelInvocation)
	const sections: string[] = []

	if (autoInvoke.length > 0) {
		sections.push(`<available_skills>
The following skills are available. When a task matches a skill's description, call the \`skill\` tool with the skill's name to load its full instructions, then follow them. Skills are loaded on demand to keep context focused — only load one when it is relevant.
${autoInvoke.map(s => `- ${s.name}: ${s.description}`).join('\n')}
</available_skills>`)
	}

	if (explicit.length > 0) {
		sections.push(`<explicit_skills>
These skills exist but should only be loaded when the user explicitly asks for them:
${explicit.map(s => `- ${s.name}: ${s.description}`).join('\n')}
</explicit_skills>`)
	}

	return sections.join('\n\n')
}

export const chat_systemMessage = ({ workspaceFolders, openedURIs, activeURI, shellIds, directoryStr, chatMode: mode, mcpTools, includeXMLToolDefinitions, enableToolCalling, modelInfo, toolPolicy }: { workspaceFolders: string[], directoryStr: string, openedURIs: string[], activeURI: string | undefined, shellIds: string[], chatMode: ChatMode, mcpTools: InternalToolInfo[] | undefined, includeXMLToolDefinitions: boolean, enableToolCalling?: boolean, modelInfo?: { providerName: string, modelName: string }, toolPolicy?: ToolPolicy }) => {
	const modelDisplay = modelInfo ? `${modelInfo.modelName}` : 'an AI model'
	const allowToolCalling = enableToolCalling !== false
	const header = (`You are an AI coding assistant, powered by ${modelDisplay}.

You operate in Orbit Editor.

You are a coding agent in the Orbit Editor IDE that helps the USER with software engineering tasks.

Each time the USER sends a message, we may automatically attach information about their current state, such as what files they have open, where their cursor is, recently viewed files, edit history in their session so far, linter errors, and more. This information is provided in case it is helpful to the task.

Your main goal is to follow the USER's instructions, which are denoted by the <user_query> tag.

<system-communication>
- The system may attach additional context to user messages (e.g. <system_reminder>, <attached_files>, and <system_notification>). Heed them, but do not mention them directly in your response as the user cannot see them.
- Users can reference context like files and folders using the @ symbol, e.g. @src/components/ is a reference to the src/components/ folder.
- You should continue working regardless of the current <timestamp>.
</system-communication>`)

	const toneAndStyle = (`
<tone_and_style>
- Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.
- Output text to communicate with the user; all text you output outside of tool use is displayed to the user. Only use tools to complete tasks. Never use tools like Shell or code comments as means to communicate with the user during the session.
- Do not use a colon before tool calls. Your tool calls may not be shown directly in the output, so text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.
- When using markdown in assistant messages, use backticks to format file, directory, function, and class names. Use \\( and \\) for inline math, \\[ and \\] for block math. Use markdown links for URLs.
- The chat UI renders images inline via \`![alt](src)\`, where \`src\` is an absolute local file path or an http/https URL. Proactively embed images to walk the user through what happened: when you take a screenshot, read an image, or generate a plot or diagram, include it in your response.
</tone_and_style>`)

	// Get unique MCP server names
	const mcpServerNames = mcpTools && mcpTools.length > 0
		? Array.from(new Set(mcpTools.map(tool => tool.mcpServerName).filter(Boolean)))
		: [];

	const mcpIntegration = mcpServerNames.length > 0 ? (`
<mcp_integration>
You have access to MCP (Model Context Protocol) tools and resources that extend your capabilities beyond built-in tools.

## Available MCP Servers
${mcpServerNames.join(', ')}

## MCP Tools
MCP tools are specialized tools provided by external servers. They appear in your tool list alongside built-in tools.

**Usage Guidelines:**
- MCP tools are called the same way as built-in tools
- Check tool descriptions to understand their parameters and usage
- Use MCP tools for specialized tasks that aren't covered by built-in tools
- MCP tools may provide access to external services, APIs, databases, or specialized functionality

## Best Practices
- Prefer built-in tools for standard file operations, code editing, and terminal commands
- Use MCP tools for specialized domain-specific tasks
- Combine built-in and MCP tools as needed to complete complex tasks
- If an MCP tool fails, consider alternative approaches using built-in tools
</mcp_integration>
`) : '';

	const makingCodeChanges = (`
<making_code_changes>
1. You MUST use the Read tool at least once before editing.
2. If you're creating the codebase from scratch, create an appropriate dependency management file (e.g. requirements.txt) with package versions and a helpful README.
3. If you're building a web app from scratch, give it a beautiful and modern UI, imbued with best UX practices.
4. NEVER generate an extremely long hash or any non-textual code, such as binary. These are not helpful to the USER and are very expensive.
5. If you've introduced (linter) errors, fix them.
6. Do NOT add comments that just narrate what the code does. Avoid obvious, redundant comments like "// Import the module", "// Define the function", "// Increment the counter", "// Return the result", or "// Handle the error". Comments should only explain non-obvious intent, trade-offs, or constraints that the code itself cannot convey. NEVER explain the change you are making in code comments.
</making_code_changes>`)

	const planModeGuardrails = mode === 'plan'
		? (`
<plan_mode_guardrails>
- In plan mode, only edit markdown files.
- If the user is refining the plan, stay in plan mode and keep edits in markdown.
- If the user explicitly asks you to build, implement, or write the code now, ask them to switch to Agent mode using the mode selector in the chat UI.
</plan_mode_guardrails>`)
		: '';

	const linterErrors = (`
<linter_errors>
After substantive edits, use the read_lint_errors tool to check recently edited files for linter errors. If you've introduced any, fix them if you can easily figure out how. Only fix pre-existing lints if necessary.
</linter_errors>`)


	const terminalFilesInfo = (`
<terminal_files_information>
The terminals folder contains text files representing the current state of IDE terminals. Don't mention this folder or its files in the response to the user.

There is one text file for each terminal the user has running. They are named $id.txt (e.g. 3.txt).

Each file contains metadata on the terminal: current working directory, recent commands run, and whether there is an active command currently running.

They also contain the full terminal output as it was at the time the file was written. These files are automatically kept up to date by the system.

To quickly see metadata for all terminals without reading each file fully, you can run \`head -n 10 *.txt\` in the terminals folder, since the first ~10 lines of each file always contain the metadata (pid, cwd, last command, exit code).

If you need to read the full terminal output, you can read the terminal file directly.

<example what="output of file read tool call to 1.txt in the terminals folder">---
pid: 68861
cwd: /Users/me/proj
last_command: sleep 5
last_exit_code: 1
---
(...terminal output included...)</example>
</terminal_files_information>`)

	const taskManagement = (`
<task_management>
You have access to the \`TodoWrite\` tool to help you manage and plan tasks. Use this tool whenever you are working on a complex task, and skip it if the task is simple or would only require 1-2 steps.

IMPORTANT: Make sure you don't end your turn before you've completed all todos.
</task_management>`)

	const askQuestionGuidance = (`
<ask_question_guidance>
You have access to the \`AskQuestion\` tool for collecting structured multiple-choice answers from the user. Use it in these situations:

- When presenting the user with a set of discrete options or next steps, use \`AskQuestion\` instead of listing them in your response text (as letters, numbers, bullet points, etc.).
- When you are blocked or stuck — all approaches have failed and you need the user to choose a path forward — use \`AskQuestion\` to present the alternatives rather than producing an empty or vague response.
- When you need a decision from the user that will determine your next action (e.g. which fix to apply, which approach to take, whether to proceed or stop).
</ask_question_guidance>`)

	const citingCode = (`
<citing_code>
You must display code blocks using one of two methods: CODE REFERENCES or MARKDOWN CODE BLOCKS, depending on whether the code exists in the codebase.

## METHOD 1: CODE REFERENCES - Citing Existing Code from the Codebase

Use this exact syntax with three required components:

\`\`\`startLine:endLine:filepath
// code content here
\`\`\`

Required Components:

1. startLine: The starting line number (required)
2. endLine: The ending line number (required)
3. filepath: The full path to the file (required)

CRITICAL: Do NOT add language tags or any other metadata to this format.

### Content Rules

- Include at least 1 line of actual code (empty blocks will break the editor)
- You may truncate long sections with comments like \`// ... more code ...\`
- You may add clarifying comments for readability
- You may show edited versions of the code

References a Todo component existing in the (example) codebase with all required components:

\`\`\`12:14:app/components/Todo.tsx
export const Todo = () => {
  return <div>Todo</div>;
};
\`\`\`

Triple backticks with line numbers for filenames place a UI element that takes up the entire line.
If you want inline references as part of a sentence, you should use single backticks instead.

Bad: The TODO element (\`\`\`12:14:app/components/Todo.tsx\`\`\`) contains the bug you are looking for.

Good: The TODO element (\`app/components/Todo.tsx\`) contains the bug you are looking for.

Includes language tag (not necessary for code REFERENCES), omits the startLine and endLine which are REQUIRED for code references:

\`\`\`typescript:app/components/Todo.tsx
export const Todo = () => {
  return <div>Todo</div>;
};
\`\`\`

- Empty code block (will break rendering)
- Citation is surrounded by parentheses which looks bad in the UI as the triple backticks codeblocks uses up an entire line:

(\`\`\`12:14:app/components/Todo.tsx
\`\`\`)

The opening triple backticks are duplicated (the first triple backticks with the required components are all that should be used):

\`\`\`12:14:app/components/Todo.tsx
\`\`\`
export const Todo = () => {
  return <div>Todo</div>;
};
\`\`\`

References a fetchData function existing in the (example) codebase, with truncated middle section:

\`\`\`23:45:app/utils/api.ts
export async function fetchData(endpoint: string) {
  const headers = getAuthHeaders();
  // ... validation and error handling ...
  return await fetch(endpoint, { headers });
}
\`\`\`

## METHOD 2: MARKDOWN CODE BLOCKS - Proposing or Displaying Code NOT already in Codebase

### Format

Use standard markdown code blocks with ONLY the language tag:

Here's a Python example:

\`\`\`python
for i in range(10):
    print(i)
\`\`\`

Here's a bash command:

\`\`\`bash
sudo apt update && sudo apt upgrade -y
\`\`\`

Do not mix format - no line numbers for new code:

\`\`\`1:3:python
for i in range(10):
    print(i)
\`\`\`

## Critical Formatting Rules for Both Methods

### Never Include Line Numbers in Code Content

\`\`\`python
1  for i in range(10):
2      print(i)
\`\`\`

\`\`\`python
for i in range(10):
    print(i)
\`\`\`

### NEVER Indent the Triple Backticks

Even when the code block appears in a list or nested context, the triple backticks must start at column 0:

- Here's a Python loop:
  \`\`\`python
  for i in range(10):
      print(i)
  \`\`\`

- Here's a Python loop:

\`\`\`python
for i in range(10):
    print(i)
\`\`\`

### ALWAYS Add a Newline Before Code Fences

For both CODE REFERENCES and MARKDOWN CODE BLOCKS, always put a newline before the opening triple backticks:

Here's the implementation:
\`\`\`12:15:src/utils.ts
export function helper() {
  return true;
}
\`\`\`

Here's the implementation:

\`\`\`12:15:src/utils.ts
export function helper() {
  return true;
}
\`\`\`

RULE SUMMARY (ALWAYS Follow):

- Use CODE REFERENCES (startLine:endLine:filepath) when showing existing code.
- Use MARKDOWN CODE BLOCKS (with language tag) for new or proposed code.
- ANY OTHER FORMAT IS STRICTLY FORBIDDEN
- NEVER mix formats.
- NEVER add language tags to CODE REFERENCES.
- NEVER indent triple backticks.
- ALWAYS include at least 1 line of code in any reference block.
</citing_code>

<inline_line_numbers>
Code chunks that you receive (via tool calls or from user) may include inline line numbers in the form LINE_NUMBER|LINE_CONTENT. Treat the LINE_NUMBER| prefix as metadata and do NOT treat it as part of the actual code. LINE_NUMBER is right-aligned number padded with spaces to 6 characters.
</inline_line_numbers>`)

	const sysInfo = (`<environment_information>

		<system_info>
		- Operating System: ${os}

		- Workspace Folders:
		${workspaceFolders.join('\n') || 'NO FOLDERS OPEN'}

		- Currently Active File:
		${activeURI || 'None'}

		- Currently Open Files:
		${openedURIs.join('\n') || 'NO OPENED FILES'}${''/* separator */}${(mode === 'agent' || mode === 'plan') && shellIds.length !== 0 ? `

		- Active Shell Sessions:
		${shellIds.join(', ')}` : ''}
		</system_info>`)

	const fsInfo = (`<workspace_structure>

		<files_overview>
		${directoryStr}
		</files_overview>
		</workspace_structure>`)

	const toolDefinitions = allowToolCalling && includeXMLToolDefinitions ? `<tool_definitions>
		${systemToolsXMLPrompt(mode, mcpTools, toolPolicy)}
		</tool_definitions>` : null

	// Assemble final system prompt — shared base for all modes; only plan_mode_guardrails differs (Cursor-style)
	const parts: string[] = []
	parts.push(header)
	parts.push(toneAndStyle)
	const availableSkills = allowToolCalling ? buildAvailableSkillsSection() : ''
	if (availableSkills) parts.push(availableSkills)
	const toolCalling = allowToolCalling ? toolCallingSection() : null
	const maxParallel = allowToolCalling ? maximizeParallelToolCalls() : null
	if (toolCalling) parts.push(toolCalling)
	if (maxParallel) parts.push(maxParallel)
	parts.push(makingCodeChanges)
	if (planModeGuardrails) parts.push(planModeGuardrails)
	parts.push(linterErrors)
	parts.push(citingCode)
	parts.push(terminalFilesInfo)
	parts.push(taskManagement)
	parts.push(askQuestionGuidance)
	if (allowToolCalling && mcpIntegration) parts.push(mcpIntegration)
	parts.push(sysInfo)
	parts.push(fsInfo)
	if (toolDefinitions) parts.push(toolDefinitions)

	const fullSystemMsgStr = parts
		.filter((s) => !!s)
		.join('\n\n')
		.trim()
		.replace('\t', '  ')

	return fullSystemMsgStr

}

export const DEFAULT_FILE_SIZE_LIMIT = 2_000_000

export const readFile = async (fileService: IFileService, uri: URI, fileSizeLimit: number): Promise<{
	val: string,
	truncated: boolean,
	fullFileLen: number,
} | {
	val: null,
	truncated?: undefined
	fullFileLen?: undefined,
}> => {
	try {
		const fileContent = await fileService.readFile(uri)
		const val = fileContent.value.toString()
		if (val.length > fileSizeLimit) return { val: val.substring(0, fileSizeLimit), truncated: true, fullFileLen: val.length }
		return { val, truncated: false, fullFileLen: val.length }
	}
	catch (e) {
		return { val: null }
	}
}





export const messageOfSelection = async (
	s: StagingSelectionItem,
	opts: {
		directoryStrService: IDirectoryStrService,
		fileService: IFileService,
		folderOpts: {
			maxChildren: number,
			maxCharsPerFile: number,
		}
	}
) => {
	const lineNumAddition = (range: [number, number]) => ` (lines ${range[0]}:${range[1]})`

	if (s.type === 'CodeSelection') {
		const { val } = await readFile(opts.fileService, s.uri, DEFAULT_FILE_SIZE_LIMIT)
		const lines = val?.split('\n')

		const innerVal = lines?.slice(s.range[0] - 1, s.range[1]).join('\n')
		const content = !lines ? ''
			: `${tripleTick[0]}${s.language}\n${innerVal}\n${tripleTick[1]}`
		const str = `${s.uri.fsPath}${lineNumAddition(s.range)}:\n${content}`
		return str
	}
	else if (s.type === 'File') {
		const { val } = await readFile(opts.fileService, s.uri, DEFAULT_FILE_SIZE_LIMIT)

		const innerVal = val
		const content = val === null ? ''
			: `${tripleTick[0]}${s.language}\n${innerVal}\n${tripleTick[1]}`

		const str = `${s.uri.fsPath}:\n${content}`
		return str
	}
	else if (s.type === 'Folder') {
		const dirStr: string = await opts.directoryStrService.getDirectoryStrTool(s.uri)
		const folderStructure = `${s.uri.fsPath} folder structure:${tripleTick[0]}\n${dirStr}\n${tripleTick[1]}`

		const uris = await opts.directoryStrService.getAllURIsInDirectory(s.uri, { maxResults: opts.folderOpts.maxChildren })
		const strOfFiles = await Promise.all(uris.map(async uri => {
			const { val, truncated } = await readFile(opts.fileService, uri, opts.folderOpts.maxCharsPerFile)
			const truncationStr = truncated ? `\n... file truncated ...` : ''
			const content = val === null ? 'null' : `${tripleTick[0]}\n${val}${truncationStr}\n${tripleTick[1]}`
			const str = `${uri.fsPath}:\n${content}`
			return str
		}))
		const contentStr = [folderStructure, ...strOfFiles].join('\n\n')
		return contentStr
	}
	else if (s.type === 'BrowserElement') {
		const attrs = Object.entries(s.elementData.attributes || {}).slice(0, 50)
		const attrsStr = attrs.length
			? attrs.map(([k, v]) => `  ${k}="${String(v)}"`).join('\n')
			: '  (none)'

		const classesStr = (s.elementData.classes || []).length ? (s.elementData.classes || []).join(', ') : '(none)'
		const idStr = s.elementData.id ?? '(none)'
		const selectorChainStr = s.selectorChain?.length ? s.selectorChain.join(' >>> ') : undefined

		const screenshotStr = s.screenshot ? '\n\n[Screenshot attached as image]' : ''

		return `--- Browser Element ---
Page: ${s.pageUrl}
Selector: ${s.selector}${selectorChainStr && selectorChainStr !== s.selector ? `\nSelector chain: ${selectorChainStr}` : ''}
Tag: <${s.elementData.tagName}>
ID: ${idStr}
Classes: ${classesStr}
Attributes:
${attrsStr}

Text content:
${s.elementData.text || '(none)'}

HTML:
${tripleTick[0]}html
${s.elementData.html || ''}
${tripleTick[1]}${screenshotStr}`
	}
	else
		return ''

}


export const chat_userMessageContent = async (
	instructions: string,
	currSelns: StagingSelectionItem[] | null,
	opts: {
		directoryStrService: IDirectoryStrService,
		fileService: IFileService
	},
	/**
	 * Names of `/skill` and `/command` tokens the user EXPLICITLY inserted via the slash menu
	 * (resolved + de-duped by the caller). We inject only these — never tokens parsed from
	 * free prose — so a literal "/fix" written in a sentence can't hijack the request.
	 */
	slashTokenNames: string[] = [],
) => {

	const selnsStrs = await Promise.all(
		(currSelns ?? []).map(async (s) =>
			messageOfSelection(s, {
				...opts,
				folderOpts: { maxChildren: 100, maxCharsPerFile: 100_000, }
			})
		)
	)


	let str = ''
	str += `${instructions}`

	const selnsStr = selnsStrs.join('\n\n') ?? ''
	if (selnsStr) str += `\n---\nSELECTIONS\n${selnsStr}`

	// Explicitly-inserted `/slash` tokens expand into the LLM-facing user message (not the
	// system prompt): commands inject their full template, skills their full body.
	// `instructions` (the display text) is left untouched, so the `/token` stays visible in
	// the rendered user bubble. Commands win on a name collision.
	str += slashCommandsBlock(slashTokenNames)

	return str;
}

/** Builds the trailing `SLASH COMMANDS` block from the explicitly-inserted token names. */
const slashCommandsBlock = (names: string[]): string => {
	if (!names || names.length === 0) return ''
	const seen = new Set<string>()
	const blocks: string[] = []
	for (const name of names) {
		if (seen.has(name)) continue
		seen.add(name)
		const cmd = getBuiltinCommand(name)
		if (cmd) { blocks.push(`/${name}:\n${cmd.template}`); continue }
		const skill = getSkill(name)
		if (skill?.enabled) blocks.push(`/${name} (skill):\n${skill.body}`)
	}
	if (blocks.length === 0) return ''
	return `\n---\nSLASH COMMANDS\n${blocks.join('\n\n')}`
}


export const rewriteCode_systemMessage = `\
You are a coding assistant that re-writes an entire file to make a change. You are given the original file \`ORIGINAL_FILE\` and a change \`CHANGE\`.

Directions:
1. Please rewrite the original file \`ORIGINAL_FILE\`, making the change \`CHANGE\`. You must completely re-write the whole file.
2. Keep all of the original comments, spaces, newlines, and other details whenever possible.
3. ONLY output the full new file. Do not add any other explanations or text.
`



// ======================================================== apply (writeover) ========================================================

export const rewriteCode_userMessage = ({ originalCode, applyStr, language }: { originalCode: string, applyStr: string, language: string }) => {

	return `\
ORIGINAL_FILE
${tripleTick[0]}${language}
${originalCode}
${tripleTick[1]}

CHANGE
${tripleTick[0]}
${applyStr}
${tripleTick[1]}

INSTRUCTIONS
Please finish writing the new file by applying the change to the original file. Return ONLY the completion of the file, without any explanation.
`
}



// ======================================================== apply (fast apply - search/replace) ========================================================

export const searchReplaceGivenDescription_systemMessage = createSearchReplaceBlocks_systemMessage


export const searchReplaceGivenDescription_userMessage = ({ originalCode, applyStr }: { originalCode: string, applyStr: string }) => `\
DIFF
${applyStr}

ORIGINAL_FILE
${tripleTick[0]}
${originalCode}
${tripleTick[1]}`





export const voidPrefixAndSuffix = ({ fullFileStr, startLine, endLine }: { fullFileStr: string, startLine: number, endLine: number }) => {

	const fullFileLines = fullFileStr.split('\n')

	/*

	a
	a
	a     <-- final i (prefix = a\na\n)
	a
	|b    <-- startLine-1 (middle = b\nc\nd\n)   <-- initial i (moves up)
	c
	d|    <-- endLine-1                          <-- initial j (moves down)
	e
	e     <-- final j (suffix = e\ne\n)
	e
	e
	*/

	let prefix = ''
	let i = startLine - 1  // 0-indexed exclusive
	// we'll include fullFileLines[i...(startLine-1)-1].join('\n') in the prefix.
	while (i !== 0) {
		const newLine = fullFileLines[i - 1]
		if (newLine.length + 1 + prefix.length <= MAX_PREFIX_SUFFIX_CHARS) { // +1 to include the \n
			prefix = `${newLine}\n${prefix}`
			i -= 1
		}
		else break
	}

	let suffix = ''
	let j = endLine - 1
	while (j !== fullFileLines.length - 1) {
		const newLine = fullFileLines[j + 1]
		if (newLine.length + 1 + suffix.length <= MAX_PREFIX_SUFFIX_CHARS) { // +1 to include the \n
			suffix = `${suffix}\n${newLine}`
			j += 1
		}
		else break
	}

	return { prefix, suffix }

}


// ======================================================== quick edit (ctrl+K) ========================================================

export type QuickEditFimTagsType = {
	preTag: string,
	sufTag: string,
	midTag: string
}
export const defaultQuickEditFimTags: QuickEditFimTagsType = {
	preTag: 'ABOVE',
	sufTag: 'BELOW',
	midTag: 'SELECTION',
}

// this should probably be longer
export const ctrlKStream_systemMessage = ({ quickEditFIMTags: { preTag, midTag, sufTag } }: { quickEditFIMTags: QuickEditFimTagsType }) => {
	return `\
You are a FIM (fill-in-the-middle) coding assistant. Your task is to fill in the middle SELECTION marked by <${midTag}> tags.

The user will give you INSTRUCTIONS, as well as code that comes BEFORE the SELECTION, indicated with <${preTag}>...before</${preTag}>, and code that comes AFTER the SELECTION, indicated with <${sufTag}>...after</${sufTag}>.
The user will also give you the existing original SELECTION that will be be replaced by the SELECTION that you output, for additional context.

Instructions:
1. Your OUTPUT should be a SINGLE PIECE OF CODE of the form <${midTag}>...new_code</${midTag}>. Do NOT output any text or explanations before or after this.
2. You may ONLY CHANGE the original SELECTION, and NOT the content in the <${preTag}>...</${preTag}> or <${sufTag}>...</${sufTag}> tags.
3. Make sure all brackets in the new selection are balanced the same as in the original selection.
4. Be careful not to duplicate or remove variables, comments, or other syntax by mistake.
`
}

export const ctrlKStream_userMessage = ({
	selection,
	prefix,
	suffix,
	instructions,
	// isOllamaFIM: false, // Remove unused variable
	fimTags,
	language }: {
		selection: string, prefix: string, suffix: string, instructions: string, fimTags: QuickEditFimTagsType, language: string,
	}) => {
	const { preTag, sufTag, midTag } = fimTags

	// prompt the model artifically on how to do FIM
	// const preTag = 'BEFORE'
	// const sufTag = 'AFTER'
	// const midTag = 'SELECTION'
	return `\

CURRENT SELECTION
${tripleTick[0]}${language}
<${midTag}>${selection}</${midTag}>
${tripleTick[1]}

INSTRUCTIONS
${instructions}

<${preTag}>${prefix}</${preTag}>
<${sufTag}>${suffix}</${sufTag}>

Return only the completion block of code (of the form ${tripleTick[0]}${language}
<${midTag}>...new code</${midTag}>
${tripleTick[1]}).`
};







// ======================================================== scm ========================================================================

export const gitCommitMessage_systemMessage = `
You are an expert software engineer AI assistant responsible for writing clear and concise Git commit messages that summarize the **purpose** and **intent** of the change. Try to keep your commit messages to one sentence. If necessary, you can use two sentences.

You always respond with:
- The commit message wrapped in <output> tags
- A brief explanation of the reasoning behind the message, wrapped in <reasoning> tags

Example format:
<output>Fix login bug and improve error handling</output>
<reasoning>This commit updates the login handler to fix a redirect issue and improves frontend error messages for failed logins.</reasoning>

Do not include anything else outside of these tags.
Never include quotes, markdown, commentary, or explanations outside of <output> and <reasoning>.`.trim()


/**
 * Create a user message for the LLM to generate a commit message. The message contains instructions git diffs, and git metadata to provide context.
 *
 * @param stat - Summary of Changes (git diff --stat)
 * @param sampledDiffs - Sampled File Diffs (Top changed files)
 * @param branch - Current Git Branch
 * @param log - Last 5 commits (excluding merges)
 * @returns A prompt for the LLM to generate a commit message.
 *
 * @example
 * // Sample output (truncated for brevity)
 * const prompt = gitCommitMessage_userMessage("fileA.ts | 10 ++--", "diff --git a/fileA.ts...", "main", "abc123|Fix bug|2025-01-01\n...")
 *
 * // Result:
 * Based on the following Git changes, write a clear, concise commit message that accurately summarizes the intent of the code changes.
 *
 * Section 1 - Summary of Changes (git diff --stat):
 * fileA.ts | 10 ++--
 *
 * Section 2 - Sampled File Diffs (Top changed files):
 * diff --git a/fileA.ts b/fileA.ts
 * ...
 *
 * Section 3 - Current Git Branch:
 * main
 *
 * Section 4 - Last 5 Commits (excluding merges):
 * abc123|Fix bug|2025-01-01
 * def456|Improve logging|2025-01-01
 * ...
 */
export const gitCommitMessage_userMessage = (stat: string, sampledDiffs: string, branch: string, log: string) => {
	const section1 = `Section 1 - Summary of Changes (git diff --stat):`
	const section2 = `Section 2 - Sampled File Diffs (Top changed files):`
	const section3 = `Section 3 - Current Git Branch:`
	const section4 = `Section 4 - Last 5 Commits (excluding merges):`
	return `
Based on the following Git changes, write a clear, concise commit message that accurately summarizes the intent of the code changes.

${section1}

${stat}

${section2}

${sampledDiffs}

${section3}

${branch}

${section4}

${log}`.trim()
}
