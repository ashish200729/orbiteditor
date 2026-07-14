/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Plan Template Infrastructure
 *
 * This module provides utilities for creating and manipulating implementation plan files
 * stored as Markdown with YAML frontmatter in .void/plans/
 */

import { PlanTodoItem as TodoItem } from './toolsServiceTypes.js';
import { generateUuid } from '../../../../base/common/uuid.js';

// Re-export TodoItem for convenience
export { TodoItem };

/** Completed checklist marker (U+2713). Escaped in source for production minify ASCII checks. */
const COMPLETED_TODO_MARKER = '\u2713';

// Plan status types
export type PlanStatus = 'planning' | 'approved' | 'in-progress' | 'completed';

// Plan metadata stored in YAML frontmatter
export interface PlanMetadata {
	title: string;
	created: string;
	updated: string;
	status: PlanStatus;
	model?: string;
}

// Valid section names in a plan file
export type PlanSection = 'overview' | 'files' | 'steps' | 'checklist' | 'testing' | 'notes';

// Section markers in the Markdown file
export const PLAN_SECTION_MARKERS: Record<PlanSection, string> = {
	overview: '## Overview',
	files: '## Files to Modify',
	steps: '## Implementation Steps',
	checklist: '## Implementation Checklist',
	testing: '## Testing Strategy',
	notes: '## Notes & Considerations',
};

// Order of sections in the plan file
const SECTION_ORDER: PlanSection[] = ['overview', 'files', 'steps', 'checklist', 'testing', 'notes'];

/**
 * Validation result interface
 */
export interface ValidationResult {
	valid: boolean;
	error?: string;
}

/**
 * Options for creating a new plan file (legacy)
 */
export interface CreatePlanOptions {
	planName: string;
	overview: string;
	initialFiles?: string[];
	metadata: PlanMetadata;
}

/**
 * Options for creating an atomic plan file (Cursor AI style)
 */
export interface CreateAtomicPlanOptions {
	name: string;
	overview?: string | null;
	plan: string;
	todos: TodoItem[];
	metadata: PlanMetadata;
}

/**
 * Parsed plan file structure
 */
export interface ParsedPlan {
	metadata: PlanMetadata;
	sections: Record<PlanSection, string>;
	rawContent: string;
}

/**
 * Creates the content for a new plan file
 */
export function createPlanContent(opts: CreatePlanOptions): string {
	const { planName, overview, initialFiles, metadata } = opts;

	const filesSection = initialFiles && initialFiles.length > 0
		? initialFiles.map(f => `- \`${f}\``).join('\n')
		: '_Files to be identified during planning..._';

	return `---
title: ${escapeYamlString(planName)}
created: ${metadata.created}
updated: ${metadata.updated}
status: ${metadata.status}
${metadata.model ? `model: ${metadata.model}` : ''}
---

# Implementation Plan: ${planName}

## Overview

${overview}

## Files to Modify

${filesSection}

## Implementation Steps

_Steps to be defined..._

## Implementation Checklist

- [ ] Initial planning complete

## Testing Strategy

_Testing approach to be defined..._

## Notes & Considerations

_Additional context and considerations..._
`;
}

/**
 * Escapes a string for safe YAML inclusion
 */
export function escapeYamlString(str: string): string {
	// If the string contains special characters, wrap in quotes
	if (/[:\{\}\[\],&*#?|\-<>=!%@`\\]/.test(str) || str.includes('\n')) {
		return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
	}
	return str;
}

/**
 * Reverses {@link escapeYamlString} for a quote-wrapped value.
 *
 * `escapeYamlString` only applies to values it wrapped in quotes (unquoted
 * values were never escaped), so this helper must only be called on values that
 * were quote-wrapped on disk. The replacement order is the reverse of the escape
 * order so multi-char escapes (\\n / \\r / \\\\") round-trip correctly.
 */
export function unescapeYamlString(value: string): string {
	return value
		.replace(/\\n/g, '\n')
		.replace(/\\r/g, '\r')
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, '\\');
}

/**
 * Returns the start/end indices of a section's content within the full plan file.
 */
function getSectionContentBounds(content: string, sectionName: PlanSection): { start: number; end: number } | null {
	const marker = PLAN_SECTION_MARKERS[sectionName];
	const markerIndex = content.indexOf(marker);
	if (markerIndex === -1) {
		return null;
	}

	const start = content.indexOf('\n', markerIndex) + 1;
	if (start === 0) {
		return null;
	}

	let end = content.length;
	for (const nextSectionName of SECTION_ORDER) {
		if (nextSectionName === sectionName) continue;
		const nextMarker = PLAN_SECTION_MARKERS[nextSectionName];
		const nextMarkerIndex = content.indexOf(nextMarker, start);
		if (nextMarkerIndex !== -1 && nextMarkerIndex < end) {
			end = nextMarkerIndex;
		}
	}

	return { start, end };
}

function getChecklistSectionContent(content: string): string {
	const bounds = getSectionContentBounds(content, 'checklist');
	if (!bounds) {
		return '';
	}
	return content.substring(bounds.start, bounds.end);
}

/**
 * Removes the "## Implementation Checklist" heading and its content from a plan
 * body. Used by the Plan Editor preview so the checklist renders exactly once,
 * as the interactive `PlanChecklist` component, instead of also appearing as
 * inert markdown prose.
 */
export function stripChecklistSection(content: string): string {
	const marker = PLAN_SECTION_MARKERS.checklist;
	const markerIndex = content.indexOf(marker);
	if (markerIndex === -1) {
		return content;
	}
	const bounds = getSectionContentBounds(content, 'checklist');
	const end = bounds ? bounds.end : content.length;
	return (content.slice(0, markerIndex) + content.slice(end)).trim();
}

/**
 * Parses a plan file and extracts metadata and sections
 */
export function parsePlanFile(content: string): ParsedPlan {
	// Normalize line endings first: the frontmatter/section regexes are written against `\n`, so a
	// plan hand-saved with CRLF would otherwise fail to parse (→ "Untitled Plan" / empty sections).
	const normalized = content.replace(/\r\n?/g, '\n');
	const metadata = parseYamlFrontmatter(normalized);
	const sections = parseSections(normalized);

	return {
		metadata,
		sections,
		rawContent: content,
	};
}

/**
 * Parses YAML frontmatter from the plan content
 */
function parseYamlFrontmatter(content: string): PlanMetadata {
	const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
	if (!frontmatterMatch) {
		return {
			title: 'Untitled Plan',
			created: new Date().toISOString(),
			updated: new Date().toISOString(),
			status: 'planning',
		};
	}

	const frontmatter = frontmatterMatch[1];
	const metadata: PlanMetadata = {
		title: 'Untitled Plan',
		created: new Date().toISOString(),
		updated: new Date().toISOString(),
		status: 'planning',
	};

	// Parse each line of YAML
	const lines = frontmatter.split('\n');
	for (const line of lines) {
		const colonIndex = line.indexOf(':');
		if (colonIndex === -1) continue;

		const key = line.substring(0, colonIndex).trim();
		let value = line.substring(colonIndex + 1).trim();

		// Remove quotes if present. Only quote-wrapped values were run through
		// escapeYamlString on write, so only those need unescaping on read.
		const wasQuoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
		if (wasQuoted) {
			value = value.slice(1, -1);
			if (key === 'title' || key === 'model') {
				value = unescapeYamlString(value);
			}
		}

		switch (key) {
			case 'title':
				metadata.title = value;
				break;
			case 'created':
				metadata.created = value;
				break;
			case 'updated':
				metadata.updated = value;
				break;
			case 'status':
				if (['planning', 'approved', 'in-progress', 'completed'].includes(value)) {
					metadata.status = value as PlanStatus;
				}
				break;
			case 'model':
				metadata.model = value;
				break;
		}
	}

	return metadata;
}

/**
 * Parses sections from the plan content
 */
function parseSections(content: string): Record<PlanSection, string> {
	const sections: Record<PlanSection, string> = {
		overview: '',
		files: '',
		steps: '',
		checklist: '',
		testing: '',
		notes: '',
	};

	// Remove frontmatter for section parsing
	const contentWithoutFrontmatter = content.replace(/^---\n[\s\S]*?\n---\n?/, '');

	for (const sectionName of SECTION_ORDER) {
		const marker = PLAN_SECTION_MARKERS[sectionName];
		const markerIndex = contentWithoutFrontmatter.indexOf(marker);

		if (markerIndex === -1) continue;

		// Find the start of section content (after the marker line)
		const contentStart = contentWithoutFrontmatter.indexOf('\n', markerIndex) + 1;
		if (contentStart === 0) continue;

		// Find the end of section (next section marker or end of file)
		let contentEnd = contentWithoutFrontmatter.length;
		for (const nextSectionName of SECTION_ORDER) {
			if (nextSectionName === sectionName) continue;
			const nextMarker = PLAN_SECTION_MARKERS[nextSectionName];
			const nextMarkerIndex = contentWithoutFrontmatter.indexOf(nextMarker, contentStart);
			if (nextMarkerIndex !== -1 && nextMarkerIndex < contentEnd) {
				contentEnd = nextMarkerIndex;
			}
		}

		sections[sectionName] = contentWithoutFrontmatter.substring(contentStart, contentEnd).trim();
	}

	return sections;
}

/**
 * Updates a specific section in the plan content
 */
export function updatePlanSection(currentContent: string, sectionName: PlanSection, newContent: string): string {
	const marker = PLAN_SECTION_MARKERS[sectionName];
	if (currentContent.indexOf(marker) === -1) {
		// Section doesn't exist, append it at the end
		return updateFrontmatterTimestamp(currentContent.trimEnd() + `\n\n${marker}\n${newContent}\n`);
	}

	const updatedContent = updateFrontmatterTimestamp(currentContent);
	const bounds = getSectionContentBounds(updatedContent, sectionName);
	if (!bounds) {
		return currentContent;
	}

	return updatedContent.substring(0, bounds.start) + newContent + '\n\n' + updatedContent.substring(bounds.end);
}

/**
 * Updates the 'updated' timestamp in the frontmatter
 */
function updateFrontmatterTimestamp(content: string): string {
	const newTimestamp = new Date().toISOString();
	const re = /^(---\n[\s\S]*?)updated:\s*[^\n]*(\n[\s\S]*?---)/;
	if (re.test(content)) {
		return content.replace(re, `$1updated: ${newTimestamp}$2`);
	}
	// No `updated:` field present — insert one after the opening fence so the timestamp actually
	// updates instead of silently no-op'ing on a hand-edited plan that dropped the field.
	if (/^---\n/.test(content)) {
		return content.replace(/^---\n/, `---\nupdated: ${newTimestamp}\n`);
	}
	return content; // no frontmatter at all
}

/**
 * Detects if checklist uses numbered format (1. [STATUS]) or checkbox format (- [ ])
 */
function detectChecklistFormat(checklistContent: string): 'numbered' | 'checkbox' {
	const numberedRegex = /^\d+\.\s+\[(PENDING|IN_PROGRESS|\u2713|CANCELLED)\]/m;
	const checkboxRegex = /^- \[[\sxX]\]/m;

	if (numberedRegex.test(checklistContent)) return 'numbered';
	if (checkboxRegex.test(checklistContent)) return 'checkbox';

	// Default to numbered for new checklists
	return 'numbered';
}

/**
 * Adds a TODO item to the plan's checklist section
 * Supports both checkbox and numbered formats
 */
export function addTodoToChecklist(currentContent: string, todoText: string, category?: string): { content: string; todoCount: number } {
	const marker = PLAN_SECTION_MARKERS.checklist;
	const markerIndex = currentContent.indexOf(marker);

	if (markerIndex === -1) {
		// No checklist section, create one with numbered format
		const newChecklist = `\n\n${marker}\n1. [PENDING] ${todoText}\n`;
		return {
			content: updateFrontmatterTimestamp(currentContent.trimEnd() + newChecklist),
			todoCount: 1,
		};
	}

	const bounds = getSectionContentBounds(currentContent, 'checklist');
	if (!bounds) {
		const newChecklist = `\n\n${marker}\n1. [PENDING] ${todoText}\n`;
		return {
			content: updateFrontmatterTimestamp(currentContent.trimEnd() + newChecklist),
			todoCount: 1,
		};
	}

	// Get current checklist content
	const checklistContent = currentContent.substring(bounds.start, bounds.end).trim();

	// Detect format
	const format = detectChecklistFormat(checklistContent);

	let existingTodos = 0;
	let newTodo = '';

	if (format === 'numbered') {
		// Count existing numbered todos
		const numberedMatches = checklistContent.match(/^\d+\.\s+\[(PENDING|IN_PROGRESS|\u2713|CANCELLED)\]/gm);
		existingTodos = numberedMatches ? numberedMatches.length : 0;
		newTodo = `${existingTodos + 1}. [PENDING] ${todoText}`;
	} else {
		// Count existing checkbox todos
		const checkboxMatches = checklistContent.match(/^- \[[\sxX]\]/gm);
		existingTodos = checkboxMatches ? checkboxMatches.length : 0;
		newTodo = `- [ ] ${todoText}`;
	}

	// Add category header if provided and not already present
	if (category) {
		const categoryHeader = `### ${category}`;
		if (!checklistContent.includes(categoryHeader)) {
			newTodo = `\n${categoryHeader}\n${newTodo}`;
		}
	}

	// Append the new todo
	const newChecklistContent = checklistContent + '\n' + newTodo;

	// Update the content (compute bounds from timestamp-updated content)
	const updatedContent = updateFrontmatterTimestamp(currentContent);
	const updatedBounds = getSectionContentBounds(updatedContent, 'checklist');
	if (!updatedBounds) {
		return {
			content: updatedContent,
			todoCount: existingTodos + 1,
		};
	}
	return {
		content: updatedContent.substring(0, updatedBounds.start) + newChecklistContent + '\n\n' + updatedContent.substring(updatedBounds.end),
		todoCount: existingTodos + 1,
	};
}

/**
 * Marks a TODO item as complete in the checklist section
 * @param currentContent The current plan file content
 * @param itemIndex 1-based index of the item to mark complete
 */
export function markTodoComplete(currentContent: string, itemIndex: number): { content: string; completedItem: string } {
	const marker = PLAN_SECTION_MARKERS.checklist;
	const markerIndex = currentContent.indexOf(marker);

	if (markerIndex === -1) {
		throw new Error('No checklist section found in plan');
	}

	const lines = currentContent.split('\n');

	// `itemIndex` is the position shown to the model in the rendered checklist, which numbers ALL
	// items 1..N regardless of state. Count EVERY checklist item (not just incomplete ones) so the
	// index lines up — otherwise, once earlier items are completed, the count skips them and the
	// wrong row gets marked. Match any state; the mark-replace below is a no-op on already-done rows.
	// NOTE: completed rows use the `✓` (✓) marker (numbered) or `[x]` (checkbox), NOT the word
	// "COMPLETED" — they must be counted too so the rendered index stays aligned.
	const checkboxRegex = /^- \[( |x|X|-|~|c|C)\] (.*)$/;
	const numberedRegex = /^(\d+)\.\s+\[(PENDING|IN_PROGRESS|COMPLETED|CANCELLED|✓)\]\s+(.+)$/;

	let renderedIndex = 0;
	let targetLineIndex = -1;
	let completedItem = '';
	let isNumberedFormat = false;

	// Find target line and detect format
	for (let i = 0; i < lines.length; i++) {
		const checkboxMatch = lines[i].match(checkboxRegex);
		const numberedMatch = lines[i].match(numberedRegex);

		if (checkboxMatch) {
			renderedIndex++;
			if (renderedIndex === itemIndex) {
				targetLineIndex = i;
				completedItem = checkboxMatch[2];
				isNumberedFormat = false;
				break;
			}
		} else if (numberedMatch) {
			renderedIndex++;
			if (renderedIndex === itemIndex) {
				targetLineIndex = i;
				completedItem = numberedMatch[3];
				isNumberedFormat = true;
				break;
			}
		}
	}

	if (targetLineIndex === -1) {
		throw new Error(`TODO item #${itemIndex} not found. There are ${renderedIndex} items in the checklist.`);
	}

	// Mark the item as complete based on format
	if (isNumberedFormat) {
		lines[targetLineIndex] = lines[targetLineIndex].replace(
			/^(\d+)\.\s+\[(PENDING|IN_PROGRESS)\]\s+/,
			`$1. [${COMPLETED_TODO_MARKER}] `
		);
	} else {
		lines[targetLineIndex] = lines[targetLineIndex].replace(/^- \[\s\] /, '- [x] ');
	}

	const updatedContent = updateFrontmatterTimestamp(lines.join('\n'));
	return {
		content: updatedContent,
		completedItem,
	};
}

/**
 * Updates the plan status in the frontmatter
 */
export function updatePlanStatus(currentContent: string, newStatus: PlanStatus): string {
	const re = /^(---\n[\s\S]*?)status:\s*[^\n]*(\n[\s\S]*?---)/;
	let updatedContent: string;
	if (re.test(currentContent)) {
		updatedContent = currentContent.replace(re, `$1status: ${newStatus}$2`);
	} else if (/^---\n/.test(currentContent)) {
		// Insert a `status:` field if the frontmatter lacks one (else status silently desyncs).
		updatedContent = currentContent.replace(/^---\n/, `---\nstatus: ${newStatus}\n`);
	} else {
		updatedContent = currentContent;
	}
	return updateFrontmatterTimestamp(updatedContent);
}

/**
 * Generates a slug from a plan name for use in filenames
 */
export function generatePlanSlug(planName: string): string {
	return planName
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.substring(0, 50)
		.replace(/^-|-$/g, '');
}

/**
 * Generates a plan filename with timestamp and slug
 * Format: YYYY-MM-DD-HHMMSS-slug.md
 */
export function generatePlanFileName(planName?: string): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

	const slug = planName ? generatePlanSlug(planName) : 'plan';
	return `${dateStr}-${timeStr}-${slug}.md`;
}

/**
 * Validates that a section name is valid
 */
export function isValidSectionName(name: string): name is PlanSection {
	return ['overview', 'files', 'steps', 'checklist', 'testing', 'notes'].includes(name);
}

/**
 * Gets the display name for a section
 */
export function getSectionDisplayName(section: PlanSection): string {
	const displayNames: Record<PlanSection, string> = {
		overview: 'Overview',
		files: 'Files to Modify',
		steps: 'Implementation Steps',
		checklist: 'Implementation Checklist',
		testing: 'Testing Strategy',
		notes: 'Notes & Considerations',
	};
	return displayNames[section];
}

/**
 * Calculates the appropriate plan status based on todo completion
 * @param content The plan file content
 * @returns The calculated status: planning, in-progress, or completed
 */
export function calculatePlanStatus(content: string): PlanStatus {
	const { total, completed } = countTodoItems(content);

	// No todos yet - still in planning phase
	if (total === 0) return 'planning';

	// All todos completed
	if (completed === total) return 'completed';

	// Some todos done or in progress - actively working
	if (completed > 0) return 'in-progress';

	// Has todos but none started - could be planning or in-progress
	// If it was already approved/in-progress, keep that status
	const currentMetadata = parseYamlFrontmatter(content);
	if (currentMetadata.status === 'in-progress' || currentMetadata.status === 'approved') {
		return currentMetadata.status;
	}

	return 'planning';
}

/**
 * Synchronizes plan status based on todo completion
 * Auto-updates status if it should change based on progress
 * @param content The current plan file content
 * @returns Updated content with synced status, or original if no change needed
 */
export function syncPlanStatus(content: string): string {
	const currentMetadata = parseYamlFrontmatter(content);
	const calculatedStatus = calculatePlanStatus(content);

	// No change needed
	if (currentMetadata.status === calculatedStatus) {
		return content;
	}

	// Update status to match current progress
	return updatePlanStatus(content, calculatedStatus);
}

/**
 * Counts the total and completed TODO items in the checklist
 * Supports both checkbox format (- [ ]) and numbered format (1. [PENDING])
 */
export function countTodoItems(content: string): { total: number; completed: number; pending: number } {
	// Checkbox format - Case-insensitive matching for [x] or [X]
	const checkboxCompleted = /^- \[[xX]\]/gm;
	// Match any single whitespace character for unchecked
	const checkboxPending = /^- \[\s\]/gm;

	// Numbered format - Match completed/cancelled todos
	const numberedCompleted = /^\d+\.\s+\[(?:\u2713|CANCELLED)\]/gm;
	// Match pending/in-progress todos
	const numberedPending = /^\d+\.\s+\[(?:PENDING|IN_PROGRESS)\]/gm;

	const checklistContent = getChecklistSectionContent(content);
	if (!checklistContent.trim()) {
		return { total: 0, completed: 0, pending: 0 };
	}

	// Combine matches from both formats (scoped to checklist section only)
	const completedMatches = [
		...(checklistContent.match(checkboxCompleted) || []),
		...(checklistContent.match(numberedCompleted) || [])
	];

	const pendingMatches = [
		...(checklistContent.match(checkboxPending) || []),
		...(checklistContent.match(numberedPending) || [])
	];

	return {
		total: completedMatches.length + pendingMatches.length,
		completed: completedMatches.length,
		pending: pendingMatches.length,
	};
}

// ========================================
// Atomic Plan Creation (Cursor AI Style)
// ========================================

/**
 * Extracts the level-1 heading title from plan markdown (Cursor requires # Title first line).
 */
export function extractPlanTitleFromMarkdown(plan: string): string | null {
	const match = plan.match(/^#\s+(.+?)\s*$/m);
	return match?.[1]?.trim() || null;
}

/**
 * Injects a short overview section when the model provides `overview` separately from `plan`.
 * Skips injection if the plan already has an Overview section or overview is empty.
 */
export function injectOverviewIntoPlan(plan: string, overview: string | null | undefined): string {
	const trimmedOverview = overview?.trim();
	if (!trimmedOverview) {
		return plan;
	}
	if (/^##\s+overview\b/im.test(plan)) {
		return plan;
	}

	const lines = plan.split('\n');
	const titleLineIdx = lines.findIndex(line => line.trim().startsWith('# '));
	if (titleLineIdx === -1) {
		return `${plan.trimEnd()}\n\n## Overview\n\n${trimmedOverview}\n`;
	}

	const before = lines.slice(0, titleLineIdx + 1);
	const after = lines.slice(titleLineIdx + 1);
	return [...before, '', '## Overview', '', trimmedOverview, ...after].join('\n');
}

/**
 * Resolves the display/file title for create_plan (Cursor: short name on first call only).
 */
export function resolveCreatePlanTitle(
	name: string | null | undefined,
	plan: string,
	existingTitle?: string | null,
	reusingExistingPlan = false,
): string {
	if (reusingExistingPlan && existingTitle?.trim()) {
		return existingTitle.trim();
	}
	if (name?.trim()) {
		return name.trim();
	}
	return extractPlanTitleFromMarkdown(plan) || 'Implementation Plan';
}

/**
 * Validates todo ID format (lowercase, hyphens, alphanumeric only)
 */
export function validateTodoId(id: string): boolean {
	return /^[a-z0-9-]+$/.test(id);
}

/**
 * Validates plan content according to Cursor AI rules
 */
export function validatePlanContent(content: string): ValidationResult {
	const lines = content.split('\n');
	const firstLine = lines[0].trim();

	// Rule 1: First line must be # heading
	if (!firstLine.startsWith('# ')) {
		return {
			valid: false,
			error: 'Plan must start with level 1 heading (# Title)',
		};
	}

	// Rule 2: No markdown tables (ignore table-like patterns inside fenced code blocks)
	let inCodeBlock = false;
	let hasTable = false;
	for (const line of lines) {
		if (line.trim().startsWith('```')) {
			inCodeBlock = !inCodeBlock;
			continue;
		}
		if (!inCodeBlock && (line.includes('|---') || line.includes('| ---'))) {
			hasTable = true;
			break;
		}
	}
	if (hasTable) {
		return {
			valid: false,
			error: 'Markdown tables not allowed. Use bullet lists instead.',
		};
	}

	return { valid: true };
}

/**
 * Validates todos array structure and IDs
 */
export function validateTodos(todos: TodoItem[]): ValidationResult {
	// Check unique IDs
	const ids = todos.map(t => t.id);
	const uniqueIds = new Set(ids);
	if (uniqueIds.size !== ids.length) {
		return {
			valid: false,
			error: 'Todo IDs must be unique',
		};
	}

	// Check ID format (lowercase, hyphens, alphanumeric)
	for (const todo of todos) {
		if (!validateTodoId(todo.id)) {
			return {
				valid: false,
				error: `Invalid todo ID "${todo.id}". Use lowercase, hyphens, and alphanumeric only.`,
			};
		}
	}

	// Check content not empty
	for (const todo of todos) {
		if (!todo.content?.trim()) {
			return {
				valid: false,
				error: `Todo "${todo.id}" has empty content`,
			};
		}
	}

	return { valid: true };
}

/**
 * Converts todos array to markdown checklist with ID comments (legacy format)
 */
export function todosToMarkdown(todos: TodoItem[]): string {
	if (todos.length === 0) {
		return '';
	}
	return todos.map(todo =>
		`- [ ] ${todo.content} <!-- id:${todo.id} -->`
	).join('\n');
}

/**
 * Converts todos with status to numbered markdown format
 * Format: 1. [STATUS] Content <!-- id:xxx -->
 * Includes ID comments for persistence across sync cycles
 */
export function todosToNumberedMarkdown(todos: { id: string; content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled' }[]): string {
	if (todos.length === 0) {
		return '';
	}
	return todos.map((todo, idx) => {
		const statusMarker =
			todo.status === 'completed' ? COMPLETED_TODO_MARKER :
				todo.status === 'in_progress' ? 'IN_PROGRESS' :
					todo.status === 'cancelled' ? 'CANCELLED' : 'PENDING';
		return `${idx + 1}. [${statusMarker}] ${todo.content} <!-- id:${todo.id} -->`;
	}).join('\n');
}

type PlanChecklistTodo = { id: string; content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled' };

function parseChecklistTodosFromContent(content: string): PlanChecklistTodo[] {
	const parsed = parsePlanFile(content);
	const checklistContent = parsed.sections.checklist;
	let todos = parseNumberedTodoMarkdown(checklistContent);
	if (todos.length === 0) {
		todos = parseTodosFromMarkdown(checklistContent || content).map(t => ({
			id: t.id,
			content: t.content,
			status: 'pending' as const,
		}));
	}
	return todos;
}

/** Replaces the checklist section with an updated numbered todo list. */
export function updatePlanChecklistInContent(
	content: string,
	todos: PlanChecklistTodo[],
): string {
	const todosMarkdown = todosToNumberedMarkdown(todos);
	return updatePlanSection(content, 'checklist', todosMarkdown);
}

/** Toggles a checklist item between pending and completed. */
export function togglePlanChecklistTodoStatus(content: string, todoId: string): string {
	const todos = parseChecklistTodosFromContent(content);
	const idx = todos.findIndex(t => t.id === todoId);
	if (idx === -1) {
		return content;
	}
	const current = todos[idx];
	todos[idx] = {
		...current,
		status: current.status === 'completed' ? 'pending' : 'completed',
	};
	return updatePlanChecklistInContent(content, todos);
}

/** Appends a new pending todo to the checklist. */
export function addPlanChecklistTodo(content: string, todoContent: string, id?: string): string {
	const todos = parseChecklistTodosFromContent(content);
	todos.push({
		id: id || generateUuid(),
		content: todoContent.trim(),
		status: 'pending',
	});
	return updatePlanChecklistInContent(content, todos);
}

/**
 * Builds a stable, content-derived todo id for checklist entries that lack an
 * explicit `<!-- id: -->` comment. The id is `todo-` + a slug of the content +
 * a short hash, so reordering checklist lines (or re-parsing the same file)
 * yields the same ids instead of reshuffling positional `todo-N` ids.
 *
 * Duplicate contents are disambiguated with a `-{n}` suffix so each todo still
 * gets a unique id (validated downstream by {@link validateTodos}).
 */
function deriveStableTodoId(content: string, usedIds: Set<string>): string {
	const slug = content
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 24);
	// Cheap stable hash of the full content so two distinct todos that happen to
	// share a 24-char prefix still get different ids.
	let h = 0;
	for (let i = 0; i < content.length; i++) {
		h = (h * 31 + content.charCodeAt(i)) | 0;
	}
	const hash = (h >>> 0).toString(36);
	let base = `todo-${slug || 'item'}-${hash}`;
	let id = base;
	let n = 2;
	while (usedIds.has(id)) {
		id = `${base}-${n}`;
		n += 1;
	}
	usedIds.add(id);
	return id;
}

/**
 * Parses numbered todo markdown format
 * Format: 1. [STATUS] Content (optionally with <!-- id:xxx --> comment)
 * Preserves existing IDs from comments, generates new UUIDs only if needed
 */
export function parseNumberedTodoMarkdown(content: string): { id: string; content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled' }[] {
	const todos: { id: string; content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled' }[] = [];
	const usedIds = new Set<string>();
	const lines = content.split('\n');

	// Regex to match: 1. [STATUS] Content with optional ID comment
	const todoRegex = /^\d+\.\s+\[(PENDING|IN_PROGRESS|\u2713|CANCELLED)\]\s+(.+?)(?:\s*<!--\s*id:([A-Za-z0-9_-]+)\s*-->)?$/;

	for (const line of lines) {
		const trimmed = line.trim();
		const match = trimmed.match(todoRegex);
		if (match) {
			const [, statusMarker, todoContent, existingId] = match;
			let status: 'pending' | 'in_progress' | 'completed' | 'cancelled' = 'pending';

			if (statusMarker === COMPLETED_TODO_MARKER) status = 'completed';
			else if (statusMarker === 'IN_PROGRESS') status = 'in_progress';
			else if (statusMarker === 'CANCELLED') status = 'cancelled';

			const trimmedContent = todoContent.trim();
			const id = existingId && !usedIds.has(existingId)
				? (usedIds.add(existingId), existingId)
				: deriveStableTodoId(trimmedContent, usedIds);

			todos.push({
				id,
				content: trimmedContent,
				status
			});
		}
	}

	return todos;
}

/**
 * Derives active form (gerund) from content
 * Simple heuristic: if starts with verb, add "ing"
 */
export function deriveActiveForm(content: string): string | undefined {
	const trimmed = content.trim();
	if (!trimmed) return undefined;

	// Extract first word
	const firstWord = trimmed.split(/\s+/)[0].toLowerCase();

	// Common verbs that should get "ing" form
	const verbTransforms: Record<string, string> = {
		'add': 'Adding',
		'create': 'Creating',
		'update': 'Updating',
		'delete': 'Deleting',
		'implement': 'Implementing',
		'fix': 'Fixing',
		'refactor': 'Refactoring',
		'test': 'Testing',
		'write': 'Writing',
		'read': 'Reading',
		'parse': 'Parsing',
		'validate': 'Validating',
		'build': 'Building',
		'compile': 'Compiling',
		'run': 'Running',
		'execute': 'Executing',
		'install': 'Installing',
		'configure': 'Configuring',
		'setup': 'Setting up',
		'deploy': 'Deploying',
		'migrate': 'Migrating',
		'sync': 'Syncing',
		'merge': 'Merging',
		'integrate': 'Integrating',
		'debug': 'Debugging',
		'optimize': 'Optimizing',
		'improve': 'Improving',
		'enhance': 'Enhancing',
		'modify': 'Modifying',
		'remove': 'Removing',
		'check': 'Checking',
		'verify': 'Verifying',
		'ensure': 'Ensuring',
	};

	if (verbTransforms[firstWord]) {
		return verbTransforms[firstWord] + trimmed.substring(firstWord.length);
	}

	// Default: return undefined and use content as-is
	return undefined;
}

/**
 * Converts plan todo (from plan file) to execution todo (for thread)
 */
export function convertPlanTodoToExecutionTodo(
	planTodo: { id: string; content: string; status?: 'pending' | 'in_progress' | 'completed' | 'cancelled' },
): { id: string; content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled'; activeForm?: string } {
	return {
		id: planTodo.id,
		content: planTodo.content,
		status: planTodo.status || 'pending',
		activeForm: deriveActiveForm(planTodo.content)
	};
}

/**
 * Parses todos with IDs from markdown content
 */
export function parseTodosFromMarkdown(content: string): TodoItem[] {
	const todos: TodoItem[] = [];
	const lines = content.split('\n');

	// Checkbox format: - [ ] Text <!-- id:todo-id -->
	const checkboxRegex = /^- \[[\s\-xX]\] (.+?) <!-- id:([a-z0-9-]+) -->$/;
	// Numbered format: 1. [PENDING] Text <!-- id:todo-id -->
	const numberedRegex = /^\d+\.\s+\[(PENDING|IN_PROGRESS|\u2713|CANCELLED)\]\s+(.+?) <!-- id:([a-z0-9-]+) -->$/;

	for (const line of lines) {
		const trimmed = line.trim();
		const checkboxMatch = trimmed.match(checkboxRegex);
		if (checkboxMatch) {
			const [, todoContent, id] = checkboxMatch;
			todos.push({ id, content: todoContent });
			continue;
		}
		const numberedMatch = trimmed.match(numberedRegex);
		if (numberedMatch) {
			const [, , todoContent, id] = numberedMatch;
			todos.push({ id, content: todoContent });
		}
	}

	return todos;
}

/**
 * Creates complete atomic plan content (Cursor AI style)
 * Accepts full plan markdown + todos, validates, and generates final content
 */
export function createAtomicPlanContent(opts: CreateAtomicPlanOptions): string {
	const { name, plan, todos, metadata } = opts;

	// Validate plan content
	const contentValidation = validatePlanContent(plan);
	if (!contentValidation.valid) {
		throw new Error(`Plan content validation failed: ${contentValidation.error}`);
	}

	// Validate todos if provided
	if (todos.length > 0) {
		const todosValidation = validateTodos(todos);
		if (!todosValidation.valid) {
			throw new Error(`Todos validation failed: ${todosValidation.error}`);
		}
	}

	// Build YAML frontmatter
	const frontmatter = `---
title: ${escapeYamlString(name)}
created: ${metadata.created}
updated: ${metadata.updated}
status: ${metadata.status}
${metadata.model ? `model: ${metadata.model}` : ''}
---

`;

	// If todos provided, always write them to the checklist (replace or append)
	let finalContent = plan;
	if (todos.length > 0) {
		const todosWithStatus = todos.map(todo => ({
			id: todo.id,
			content: todo.content,
			status: 'pending' as const
		}));
		const todosMarkdown = todosToNumberedMarkdown(todosWithStatus);
		const hasChecklistSection = /^##\s+implementation\s+checklist\s*$/im.test(plan);
		if (hasChecklistSection) {
			finalContent = updatePlanSection(plan, 'checklist', todosMarkdown);
		} else {
			finalContent = `${plan.trimEnd()}

## Implementation Checklist

${todosMarkdown}
`;
		}
	}

	// Combine frontmatter + plan content
	return frontmatter + finalContent;
}
