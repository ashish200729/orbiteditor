/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities, IUntypedEditorInput, ISaveOptions, GroupIdentifier } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IFileService, FileChangeType } from '../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IFilesConfigurationService } from '../../../services/filesConfiguration/common/filesConfigurationService.js';
import { ParsedPlan, parsePlanFile } from '../common/planTemplate.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { isEqual } from '../../../../base/common/resources.js';
import { Emitter } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { VOID_PLAN_EDITOR_ID } from './planEditorConstants.js';
import { planFileLock } from '../common/planFileLock.js';

/**
 * Formats an arbitrary error from a plan-file load into a display string.
 * Extracted as a pure helper so the error-shaping is unit-testable without
 * instantiating a PlanEditorInput.
 */
export function formatPlanLoadError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

export class PlanEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.void.planEditor';

	private _resource: URI;
	private _parsedPlan: ParsedPlan | undefined;
	private _isDirty: boolean = false;
	private _currentContent: string = '';
	private _fileWatcher: IDisposable | undefined;
	// Phase 1.5 (C4) fix: distinguish self-writes (our save(), the planTodoSyncService
	// writing the latest todoList back, etc.) from genuine external writes. Two layers:
	//   1. A short ignore window after a known self-write (works for the sync service
	//      that does not live inside this input).
	//   2. A content-hash check on our own save() so we never reload our own content.
	private _selfWriteSerial: number = 0;
	private _lastSelfWriteHash: string = '';
	private _lastSelfWriteAt: number = 0;
	/** Whether the most recent self-write recorded a content hash. When it did, the hash is
	 * authoritative and the timestamp window is NOT used — otherwise a genuine external edit
	 * landing within the window would be silently dropped. */
	private _lastSelfWriteHadContent: boolean = false;
	private static readonly SELF_WRITE_IGNORE_MS = 1500;

	// Public for PlanTodoSyncService to call when it writes the plan file.
	// When the caller knows the written content (e.g. the sync service), it passes
	// it in so we can record a content hash for certainty-based self-write
	// detection. When the caller is our own save() path, it sets the hash
	// directly; callers without the content can omit it and fall back to the
	// timestamp-based ignore window.
	notifySelfWrite(content?: string): void {
		this._selfWriteSerial += 1;
		this._lastSelfWriteAt = Date.now();
		this._lastSelfWriteHadContent = content !== undefined;
		if (content !== undefined) {
			this._lastSelfWriteHash = this._hash(content);
		}
	}

	// Event for external file changes
	private readonly _onDidChangeExternalContent = new Emitter<void>();
	readonly onDidChangeExternalContent = this._onDidChangeExternalContent.event;

	// Phase 2.6 (H6) fix: emit when the file on disk changed while we have dirty
	// in-memory edits. The pane subscribes and prompts the user.
	private readonly _onDidDetectExternalConflict = new Emitter<void>();
	readonly onDidDetectExternalConflict = this._onDidDetectExternalConflict.event;
	hasExternalConflict(): boolean { return this._hasExternalConflict; }
	private _hasExternalConflict: boolean = false;

	constructor(
		resource: URI,
		@IFileService private readonly fileService: IFileService,
		@ILabelService private readonly labelService: ILabelService,
		@IFilesConfigurationService private readonly filesConfigurationService: IFilesConfigurationService
	) {
		super();
		this._resource = resource;
		this._setupFileWatcher();
	}

	// Setup file watcher to detect external changes
	private _setupFileWatcher(): void {
		this._fileWatcher = this.fileService.watch(this._resource);

		// Listen for file changes
		this._register(this.fileService.onDidFilesChange(async (event) => {
			// Check if our file was updated
			const wasUpdated = event.contains(this._resource, FileChangeType.UPDATED);

			if (!wasUpdated) {
				return;
			}

			// Phase 1.5 (C4) fix: ignore self-writes. The content hash is authoritative:
			// when the last self-write recorded its content, only a hash match counts as
			// a self-write — the timestamp window is just a fallback for callers that
			// couldn't provide the written content. (Checking the window first would drop
			// genuine external edits that land within it.)
			let onDiskContent: string | undefined;
			try {
				const content = await this.fileService.readFile(this._resource);
				onDiskContent = content.value.toString();
			} catch {
				// File deleted or unreadable - leave handling to existing logic
				return;
			}
			if (this._lastSelfWriteHash && this._hash(onDiskContent) === this._lastSelfWriteHash) {
				// This is our own written content; nothing to do.
				return;
			}
			if (!this._lastSelfWriteHadContent && Date.now() - this._lastSelfWriteAt < PlanEditorInput.SELF_WRITE_IGNORE_MS) {
				// Hashless self-write (caller couldn't provide content) — fall back to the window.
				return;
			}

			if (this._isDirty) {
				// Phase 2.6 (H6) fix: don't silently drop the user's in-memory edits.
				// Mark an external conflict; the pane will surface a notification.
				this._hasExternalConflict = true;
				this._onDidDetectExternalConflict.fire();
				return;
			}

			// File was changed externally (not by us) and we have no in-memory edits.
			// Reload it.
			console.log('[PlanEditorInput] External file change detected, reloading...');
			this._currentContent = onDiskContent;
			try {
				this._parsedPlan = parsePlanFile(onDiskContent);
			} catch {
				// Ignore parse errors; UI will show the raw text.
			}
			this._onDidChangeExternalContent.fire();
		}));
	}

	// Cheap content hash for self-write detection. Not cryptographic; we just need
	// a quick equality check.
	private _hash(s: string): string {
		// Use the string's length + a simple rolling hash. This is O(n) but n is small.
		// Real implementations could use a digest; we avoid pulling in crypto here.
		let h = 0;
		for (let i = 0; i < s.length; i++) {
			h = (h * 31 + s.charCodeAt(i)) | 0;
		}
		return `${s.length}:${h}`;
	}

	// Core EditorInput overrides
	override get typeId(): string {
		return PlanEditorInput.ID;
	}

	override get editorId(): string {
		return VOID_PLAN_EDITOR_ID;
	}

	override get resource(): URI {
		return this._resource;
	}

	override get capabilities(): EditorInputCapabilities {
		let capabilities = EditorInputCapabilities.CanSplitInGroup;

		if (this.filesConfigurationService.isReadonly(this._resource)) {
			capabilities |= EditorInputCapabilities.Readonly;
		}

		return capabilities;
	}

	// Display name
	override getName(): string {
		return this.labelService.getUriBasenameLabel(this._resource);
	}

	// Dirty state
	override isDirty(): boolean {
		return this._isDirty;
	}

	// Get current parsed plan
	getParsedPlan(): ParsedPlan | undefined {
		return this._parsedPlan;
	}

	// Get current content
	getCurrentContent(): string {
		return this._currentContent;
	}

	// Load plan from file system
	async loadPlan(): Promise<ParsedPlan> {
		try {
			const content = await this.fileService.readFile(this._resource);
			const contentStr = content.value.toString();
			this._currentContent = contentStr;
			this._parsedPlan = parsePlanFile(contentStr);
			return this._parsedPlan;
		} catch (error) {
			// Return fallback plan with error message
			return this.createErrorPlan(error);
		}
	}

	// Update content (from React component)
	updateContent(content: string): void {
		if (this._currentContent !== content) {
			this._currentContent = content;
			try {
				this._parsedPlan = parsePlanFile(content);
			} catch {
				// Ignore parse errors during editing
			}
			this._isDirty = true;
			// Any pending external conflict is superseded by the user's in-memory edit.
			this._hasExternalConflict = false;
			this._onDidChangeDirty.fire();
		}
	}

	// Save to file system
	override async save(group: GroupIdentifier, options?: ISaveOptions): Promise<EditorInput | IUntypedEditorInput | undefined> {
		try {
			const content = this._currentContent;
			// Serialize with plan tool/sync writes (they all take planFileLock) so a manual editor save
			// can't interleave with and clobber a concurrent tool write. Atomic write = no truncation
			// on crash mid-write.
			await planFileLock.withLock(this._resource.fsPath, () => this.fileService.writeFile(
				this._resource,
				VSBuffer.fromString(content),
				{ atomic: { postfix: '.orbittmp' } }
			));
			// Phase 1.5 (C4) fix: record the self-write hash + timestamp so the
			// file-watcher's follow-up event for our own write is recognized and
			// ignored.
			this._selfWriteSerial += 1;
			this._lastSelfWriteHash = this._hash(content);
			this._lastSelfWriteAt = Date.now();
			this._lastSelfWriteHadContent = true;
			this._isDirty = false;
			this._hasExternalConflict = false;
			this._onDidChangeDirty.fire();
			return this;
		} catch (error) {
			console.error('Failed to save plan:', error);
			return undefined;
		}
	}

	// Revert unsaved changes
	override async revert(group: GroupIdentifier, options?: any): Promise<void> {
		await this.loadPlan();
		this._isDirty = false;
		this._hasExternalConflict = false;
		this._onDidChangeDirty.fire();
	}

	// Helper: Create fallback plan for errors
	private createErrorPlan(error: any): ParsedPlan {
		return {
			metadata: {
				title: 'Parse Error',
				created: new Date().toISOString(),
				updated: new Date().toISOString(),
				status: 'planning'
			},
			sections: {
				overview: `**Error loading plan file:**\n\n${formatPlanLoadError(error)}`,
				files: '',
				steps: '',
				checklist: '',
				testing: '',
				notes: ''
			},
			rawContent: this._currentContent
		};
	}

	// Match other editor inputs
	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (other instanceof PlanEditorInput) {
			return isEqual(other.resource, this._resource);
		}
		return false;
	}

	// Serialization
	override toUntyped(): IUntypedEditorInput | undefined {
		return {
			resource: this._resource,
			options: {
				override: this.editorId
			}
		};
	}

	override dispose(): void {
		this._fileWatcher?.dispose();
		this._onDidChangeExternalContent.dispose();
		this._onDidDetectExternalConflict.dispose();
		super.dispose();
	}
}
