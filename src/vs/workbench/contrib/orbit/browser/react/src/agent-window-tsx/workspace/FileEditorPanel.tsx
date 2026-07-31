/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as React from 'react';
import {
	FileCode,
	ChevronRight,
	ChevronLeft,
	MoreHorizontal,
	Search,
	PanelRight,
	ListTree,
	Lock,
} from 'lucide-react';
import { CodeEditorWidget } from '../../../../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { ITextModel } from '../../../../../../../../editor/common/model.js';
import type { ICodeEditorViewState } from '../../../../../../../../editor/common/editorCommon.js';
import { URI } from '../../../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../../../base/common/buffer.js';
import { DisposableStore, IReference } from '../../../../../../../../base/common/lifecycle.js';
import { isLinux, isMacintosh } from '../../../../../../../../base/common/platform.js';
import { Schemas } from '../../../../../../../../base/common/network.js';
import { mainWindow } from '../../../../../../../../base/browser/window.js';
import { relativePath as resourceRelativePath, basename as resourceBasename, joinPath } from '../../../../../../../../base/common/resources.js';
import { ServiceCollection } from '../../../../../../../../platform/instantiation/common/serviceCollection.js';
import { IEditorProgressService } from '../../../../../../../../platform/progress/common/progress.js';
import { IResolvedTextEditorModel } from '../../../../../../../../editor/common/services/resolverService.js';
import { TextFileOperationError, TextFileOperationResult } from '../../../../../../../services/textfile/common/textfiles.js';
import { FileOperationError, FileOperationResult } from '../../../../../../../../platform/files/common/files.js';
import { IWorkbenchThemeService } from '../../../../../../../services/themes/common/workbenchThemeService.js';
import { useAccessor, useAgentWorkspaceState } from '../../util/services.js';
import { getConnectedDocument, getConnectedWindow, focusInConnectedWindow } from '../../util/connectedWindow.js';
import type { WorkspacePanelProps } from './workspaceTypes.js';
import { PanelPlaceholder } from './PanelPlaceholder.js';

const basename = (p: string | undefined | null): string => {
	if (!p) {
		return '';
	}
	const cleaned = p.replace(/[\\/]+$/, '');
	const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
	return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
};

/** No-op progress service for Monaco widgets hosted outside an editor group (Agents window). */
const NULL_PROGRESS_RUNNER = { done: () => { }, total: () => { }, worked: () => { } };
const noopEditorProgressService: IEditorProgressService = {
	_serviceBrand: undefined,
	show() { return NULL_PROGRESS_RUNNER; },
	async showWhile(promise) { await promise; },
};

const parseResource = (resource: string): URI => {
	if (resource.includes('://')) {
		return URI.parse(resource);
	}
	return URI.file(resource);
};

const SAVE_SHORTCUT = isMacintosh ? '⌘S' : 'Ctrl+S';

/** Fail the resolve rather than spin "Loading…" forever on a wedged remote/IPC fs. */
const RESOLVE_TIMEOUT_MS = 15_000;

const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> => {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				reject(new Error(`${label} timed out.`));
			}
		}, ms);
		p.then(
			v => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
			e => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } },
		);
	});
};

const readEditorOption = <T,>(configurationService: { getValue: (key: string) => unknown }, key: string, fallback: T): T => {
	const value = configurationService.getValue(key);
	return (value === undefined || value === null) ? fallback : value as T;
};

export interface FileEditorPanelProps extends WorkspacePanelProps {
	explorerVisible?: boolean;
	onToggleExplorer?: () => void;
	onNavigateFile?: (uri: URI) => void;
	openFileResources?: string[];
}

/**
 * Cursor-style agent file editor.
 *
 * Opens files via ITextModelService.createModelReference (same path as the main
 * workbench) so content, language, dirty, and save share the IDE model pipeline.
 *
 * Lifecycle contract (this is what keeps the panel from blinking/jumping):
 *   1. The Monaco CodeEditorWidget is created EXACTLY ONCE (on the first resolved
 *      model) and disposed only when the panel unmounts. It is never rebuilt on
 *      model / uri / isActive / config changes — those are applied imperatively
 *      (setModel, updateOptions, layout). Rebuilding Monaco is what produced the
 *      content flash + cursor/scroll reset.
 *   2. The model-resolve effect keys on `uri` ONLY. Every other input it needs
 *      (setTitle, etc.) is read through a ref so an unrelated parent re-render
 *      can never re-trigger a full teardown + refetch.
 *   3. View state (scroll / cursor / folding) is saved per-resource and restored
 *      on model swap and tab re-activation, matching the main editor.
 */
export const FileEditorPanel = ({
	tab,
	isActive,
	setTitle,
	openInWorkspace,
	registerFileHandle,
	explorerVisible = true,
	onToggleExplorer,
	onNavigateFile,
	openFileResources = [],
}: FileEditorPanelProps) => {
	const accessor = useAccessor();
	const instantiationService = accessor.get('IInstantiationService');
	const textModelService = accessor.get('ITextModelService');
	const textFileService = accessor.get('ITextFileService');
	const modelService = accessor.get('IModelService');
	const fileDialogService = accessor.get('IFileDialogService');
	const configurationService = accessor.get('IConfigurationService');
	const fileService = accessor.get('IFileService');
	const agentProjectWorkspaceService = accessor.get('IAgentProjectWorkspaceService');
	const clipboardService = accessor.get('IClipboardService');
	const nativeHostService = accessor.get('INativeHostService');
	const notificationService = accessor.get('INotificationService');
	const languageService = accessor.get('ILanguageService');

	// Subscribe to workspace state so memoized values keyed on the active workspace
	// (breadcrumbs) recompute when the active workspace switches even if `uri` is
	// unchanged. Without this, breadcrumbs keep showing the old workspace's folder
	// prefix after a switch. M5/#16.
	const agentWorkspaceState = useAgentWorkspaceState();

	const [uri, setUri] = React.useState<URI | null>(() => (tab.resource ? parseResource(tab.resource) : null));
	const [model, setModel] = React.useState<ITextModel | null>(null);
	const [dirty, setDirty] = React.useState(false);
	const [readOnly, setReadOnly] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const [loading, setLoading] = React.useState(false);
	const [menuOpen, setMenuOpen] = React.useState(false);
	const [lineNumbers, setLineNumbers] = React.useState(() => {
		const v = configurationService.getValue<string | boolean>('editor.lineNumbers');
		return v !== 'off' && v !== false;
	});
	const [wordWrap, setWordWrap] = React.useState(() => {
		const v = configurationService.getValue<string>('editor.wordWrap');
		return v === 'on' || v === 'wordWrapColumn' || v === 'bounded';
	});
	const [autoSave, setAutoSave] = React.useState(() => {
		const v = configurationService.getValue('files.autoSave');
		return !!(v && v !== 'off');
	});

	// Host for Monaco ONLY — React never puts children inside this node.
	const hostRef = React.useRef<HTMLDivElement | null>(null);
	const editorRef = React.useRef<CodeEditorWidget | null>(null);
	const monacoHostRef = React.useRef<HTMLElement | null>(null);
	const editorStoreRef = React.useRef<DisposableStore | null>(null);
	const menuRef = React.useRef<HTMLDivElement | null>(null);
	const menuBtnRef = React.useRef<HTMLButtonElement | null>(null);
	const modelRefHandle = React.useRef<IReference<IResolvedTextEditorModel> | null>(null);
	const ephemeralModelRef = React.useRef<ITextModel | null>(null);
	// Disk state (etag/mtime) captured when the ephemeral fallback model was
	// read, so saving it can detect an external modification instead of
	// silently overwriting it (tracked models get this from ITextFileService).
	const ephemeralStatRef = React.useRef<{ etag: string; mtime: number } | null>(null);
	const loadGenRef = React.useRef(0);
	const prevUriKeyRef = React.useRef<string | null>(null);
	// Per-resource view state so back/forward and tab switches restore scroll+cursor.
	const viewStatesRef = React.useRef<Map<string, ICodeEditorViewState | null>>(new Map());
	const currentModelUriRef = React.useRef<string | null>(null);

	// Refs for values the resolve/mount effects must read WITHOUT depending on
	// them (depending on an unstable prop would re-run the effect on every parent
	// render — the root cause of the reload loop).
	const setTitleRef = React.useRef(setTitle);
	setTitleRef.current = setTitle;
	const isActiveRef = React.useRef(isActive);
	isActiveRef.current = isActive;
	const readOnlyRef = React.useRef(readOnly);
	readOnlyRef.current = readOnly;

	const releaseModel = React.useCallback(() => {
		if (modelRefHandle.current) {
			try { modelRefHandle.current.dispose(); } catch { /* ignore */ }
			modelRefHandle.current = null;
		}
		if (ephemeralModelRef.current) {
			try { ephemeralModelRef.current.dispose(); } catch { /* ignore */ }
			ephemeralModelRef.current = null;
		}
		ephemeralStatRef.current = null;
	}, []);

	// Point the live editor at `m`, preserving/restoring per-resource view state.
	// Called synchronously on resolve (before the old model reference is disposed,
	// so Monaco is never attached to a disposed model) and again from the create
	// effect for the first-ever model (a no-op the second time via the identity
	// guard). Safe to call before the editor exists — it simply no-ops.
	const applyModelToEditor = React.useCallback((m: ITextModel) => {
		const editor = editorRef.current;
		if (!editor || editor.getModel() === m) {
			return;
		}
		const outgoing = editor.getModel();
		if (outgoing && currentModelUriRef.current) {
			try {
				const states = viewStatesRef.current;
				// Re-insert to refresh Map insertion order, then evict the oldest
				// beyond a small cap — view states are large and were otherwise
				// retained for every file ever opened (and forever for renamed ones).
				states.delete(currentModelUriRef.current);
				states.set(currentModelUriRef.current, editor.saveViewState());
				const MAX_VIEW_STATES = 50;
				while (states.size > MAX_VIEW_STATES) {
					const oldest = states.keys().next().value as string | undefined;
					if (oldest === undefined) { break; }
					states.delete(oldest);
				}
			} catch { /* ignore */ }
		}
		editor.setModel(m);
		currentModelUriRef.current = m.uri.toString();
		const saved = viewStatesRef.current.get(m.uri.toString());
		if (saved) {
			try { editor.restoreViewState(saved); } catch { /* ignore */ }
		}
		editor.updateOptions({ readOnly: readOnlyRef.current, domReadOnly: readOnlyRef.current });
	}, []);

	React.useEffect(() => {
		if (!tab.resource) {
			setUri(prev => (prev === null ? prev : null));
			return;
		}
		try {
			const next = parseResource(tab.resource);
			setUri(prev => (prev && prev.toString() === next.toString() ? prev : next));
		} catch (e) {
			setError(`Invalid file path: ${String((e as Error)?.message ?? e)}`);
			setUri(null);
		}
	}, [tab.resource]);

	React.useEffect(() => {
		const sub = configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('files.autoSave')) {
				const v = configurationService.getValue('files.autoSave');
				setAutoSave(!!(v && v !== 'off'));
			}
			if (e.affectsConfiguration('editor.lineNumbers')) {
				const v = configurationService.getValue<string | boolean>('editor.lineNumbers');
				setLineNumbers(v !== 'off' && v !== false);
			}
			if (e.affectsConfiguration('editor.wordWrap')) {
				const v = configurationService.getValue<string>('editor.wordWrap');
				setWordWrap(v === 'on' || v === 'wordWrapColumn' || v === 'bounded');
			}
		});
		return () => sub.dispose();
	}, [configurationService]);

	// Resolve the text model for `uri` using the same pipeline as the main editor.
	// KEYED ON `uri` ONLY — see lifecycle contract above.
	React.useEffect(() => {
		// Guard against effect re-runs that don't actually change the resource.
		if (prevUriKeyRef.current === (uri ? uri.toString() : null)) {
			return;
		}
		prevUriKeyRef.current = uri ? uri.toString() : null;

		if (!uri) {
			// Detach Monaco BEFORE disposing the reference (same invariant as
			// finishError below) — otherwise the editor keeps a disposed model
			// bound and the next layout()/saveViewState() runs against it.
			editorRef.current?.setModel(null);
			currentModelUriRef.current = null;
			releaseModel();
			setModel(null);
			setDirty(false);
			setReadOnly(false);
			setLoading(false);
			setError(null);
			return;
		}

		const gen = ++loadGenRef.current;
		setLoading(true);
		setError(null);
		// NOTE: we do NOT clear `model` here. Keeping the previous model mounted
		// until the new one is ready avoids a blank/torn-down frame; setModel below
		// swaps atomically once resolved.
		const stale = () => loadGenRef.current !== gen;

		const finishError = (message: string) => {
			if (stale()) { return; }
			// Detach Monaco from the outgoing model BEFORE disposing it — otherwise
			// `releaseModel()` disposes the model the editor still has bound (from a
			// previously successful resolve), and the next `editor.layout()` /
			// `saveViewState()` on tab switch runs against a disposed model.
			editorRef.current?.setModel(null);
			currentModelUriRef.current = null;
			releaseModel();
			setModel(null);
			setDirty(false);
			setReadOnly(false);
			setLoading(false);
			setError(message);
		};

		(async () => {
			try {
				const exists = await withTimeout(fileService.exists(uri), RESOLVE_TIMEOUT_MS, 'Opening file');
				if (stale()) { return; }
				if (!exists) {
					finishError('This file no longer exists on disk.');
					return;
				}

				// Primary path: workbench text model reference (language, dirty, save).
				let ref: IReference<IResolvedTextEditorModel>;
				try {
					ref = await withTimeout(textModelService.createModelReference(uri), RESOLVE_TIMEOUT_MS, 'Opening file');
				} catch (primaryErr: unknown) {
					// Typed guards first (main-editor parity), then a message fallback.
					if (TextFileOperationError.isTextFileOperationError(primaryErr)
						&& (primaryErr as TextFileOperationError).textFileOperationResult === TextFileOperationResult.FILE_IS_BINARY) {
						finishError('This file appears to be binary and cannot be opened as text.');
						return;
					}
					if (primaryErr instanceof FileOperationError
						&& primaryErr.fileOperationResult === FileOperationResult.FILE_TOO_LARGE) {
						finishError('This file is too large to open in the editor.');
						return;
					}
					const msg = String((primaryErr as Error)?.message ?? primaryErr);
					if (/binary/i.test(msg)) {
						finishError('This file appears to be binary and cannot be opened as text.');
						return;
					}
					// Fallback: read raw bytes into an ephemeral model so the user can
					// still view content when the resolver rejects for a soft reason.
					try {
						const content = await withTimeout(fileService.readFile(uri), RESOLVE_TIMEOUT_MS, 'Opening file');
						if (stale()) { return; }
						const text = content.value.toString();
						if (text.includes('\u0000')) {
							finishError('This file appears to be binary and cannot be opened as text.');
							return;
						}
						const lang = languageService.createByFilepathOrFirstLine(uri, text.split(/\r?\n/, 1)[0] ?? '');
						const ephemeral = modelService.createModel(text, lang, uri, false);
						// Attach the new model to the live editor BEFORE disposing the
						// previous reference, so Monaco is never pointed at a disposed model.
						readOnlyRef.current = false;
						applyModelToEditor(ephemeral);
						releaseModel();
						ephemeralModelRef.current = ephemeral;
						ephemeralStatRef.current = { etag: content.etag, mtime: content.mtime };
						setModel(ephemeral);
						setDirty(false);
						setReadOnly(false);
						setTitleRef.current(basename(uri.fsPath || uri.path));
						setLoading(false);
						setError(null);
						return;
					} catch (fallbackErr: unknown) {
						finishError(String((fallbackErr as Error)?.message ?? fallbackErr ?? msg));
						return;
					}
				}

				if (stale()) {
					ref.dispose();
					return;
				}
				const textModel = ref.object.textEditorModel;
				if (!textModel || textModel.isDisposed()) {
					ref.dispose();
					finishError('No text model available for this resource.');
					return;
				}
				let ro = false;
				try {
					const roState = ref.object.isReadonly();
					ro = roState !== false && roState !== undefined && roState !== null;
				} catch { /* ignore */ }
				// Attach the new model to the live editor BEFORE disposing the previous
				// reference, so Monaco is never pointed at a disposed model. Then swap
				// the live reference we hold.
				readOnlyRef.current = ro;
				applyModelToEditor(textModel);
				releaseModel();
				modelRefHandle.current = ref;
				setModel(textModel);
				setDirty(textFileService.isDirty(uri));
				setReadOnly(ro);
				setTitleRef.current(basename(uri.fsPath || uri.path));
				setLoading(false);
				setError(null);
			} catch (e: unknown) {
				finishError(String((e as Error)?.message ?? e));
			}
		})();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [uri]);

	// Release model refs when the panel unmounts entirely.
	React.useEffect(() => {
		return () => {
			loadGenRef.current += 1;
			releaseModel();
		};
	}, [releaseModel]);

	// Dirty tracking
	React.useEffect(() => {
		if (!uri || !model) {
			return;
		}
		if (ephemeralModelRef.current === model) {
			const sub = model.onDidChangeContent(() => setDirty(true));
			return () => sub.dispose();
		}
		const sync = () => {
			try { setDirty(textFileService.isDirty(uri)); } catch { /* ignore */ }
		};
		sync();
		const sub = textFileService.files.onDidChangeDirty(m => {
			if (m.resource.toString() === uri.toString()) {
				sync();
			}
		});
		return () => sub.dispose();
	}, [uri, model, textFileService]);

	const doSave = React.useCallback(async () => {
		if (!uri || !model || readOnlyRef.current) {
			return;
		}
		try {
			if (ephemeralModelRef.current === model) {
				// Pass the etag/mtime captured at read time so an external rewrite
				// since then fails with FILE_MODIFIED_SINCE instead of being
				// silently clobbered.
				const stat = await fileService.writeFile(
					uri,
					VSBuffer.fromString(model.getValue()),
					ephemeralStatRef.current ?? undefined,
				);
				ephemeralStatRef.current = { etag: stat.etag, mtime: stat.mtime };
				setDirty(false);
				setError(null);
				return;
			}
			const saved = await textFileService.save(uri);
			setDirty(textFileService.isDirty(uri));
			if (!saved) {
				setError('Save was cancelled or failed.');
			} else {
				setError(null);
			}
		} catch (e: unknown) {
			if (e instanceof FileOperationError && e.fileOperationResult === FileOperationResult.FILE_MODIFIED_SINCE) {
				setError('Save failed: the file changed on disk since it was opened. Use "Discard Changes" to reload it, or save again to overwrite.');
				// Let a deliberate second ⌘S overwrite (user has seen the warning).
				ephemeralStatRef.current = null;
				return;
			}
			setError(String((e as Error)?.message ?? e));
		}
	}, [uri, model, textFileService, fileService]);
	const doSaveRef = React.useRef(doSave);
	doSaveRef.current = doSave;
	const dirtyRef = React.useRef(dirty);
	dirtyRef.current = dirty;
	const registerFileHandleRef = React.useRef(registerFileHandle);
	registerFileHandleRef.current = registerFileHandle;

	const doDiscard = React.useCallback(async () => {
		if (!uri || !model) {
			return;
		}
		try {
			if (ephemeralModelRef.current === model) {
				const content = await fileService.readFile(uri);
				model.setValue(content.value.toString());
				ephemeralStatRef.current = { etag: content.etag, mtime: content.mtime };
				setDirty(false);
				setError(null);
				return;
			}
			await textFileService.revert(uri, { force: true });
			setDirty(textFileService.isDirty(uri));
			setError(null);
		} catch (e: unknown) {
			notificationService.error(String((e as Error)?.message ?? e));
		}
	}, [uri, model, textFileService, fileService, notificationService]);
	const doDiscardRef = React.useRef(doDiscard);
	doDiscardRef.current = doDiscard;

	// Report dirty/save/discard up to AgentWorkspace so the tab dot and the
	// close-tab save-prompt work for an ephemeral (fallback) model too — its
	// edits live only in this panel's `dirty` state, not `ITextFileService`.
	// Re-registers (with a fresh handle) on every dirty transition so the
	// parent's tick-based re-render picks up the change; on true unmount the
	// final cleanup unregisters.
	React.useEffect(() => {
		registerFileHandleRef.current?.({
			isDirty: () => dirtyRef.current,
			save: () => doSaveRef.current(),
			discard: () => doDiscardRef.current(),
		});
		return () => { registerFileHandleRef.current?.(null); };
	}, [dirty]);

	// ── Monaco: created ONCE, model swapped imperatively thereafter ────────────
	//
	// Cross-window fix (see connectedWindow.ts): the agent window is a VS Code
	// auxiliary window whose `createElement` is delegated to the MAIN document, so
	// a React node's `ownerDocument` is the main document even though it paints in
	// the aux window. Monaco resolves its window via `node.ownerDocument.defaultView`,
	// so we build the Monaco host element with the CONNECTED (aux) document and take
	// ResizeObserver / requestAnimationFrame off the connected window.
	const layoutEditor = React.useCallback((focus: boolean) => {
		const editor = editorRef.current;
		const host = monacoHostRef.current;
		if (!editor || !host || !host.isConnected) {
			return;
		}
		try {
			editor.layout();
			if (focus) {
				const dom = editor.getDomNode();
				const textarea = dom?.querySelector('textarea');
				focusInConnectedWindow((textarea as HTMLTextAreaElement | null) ?? dom);
			}
		} catch { /* ignore */ }
	}, []);

	// Create the widget the first time a model is available; swap the model on
	// every subsequent change. Disposal happens only in the unmount effect below.
	React.useEffect(() => {
		const shell = hostRef.current;
		if (!shell || !model) {
			return;
		}

		if (!editorRef.current) {
			const connectedDoc = getConnectedDocument(shell);
			// Bypass `delegateNodeFactories` (which rebinds aux `createElement` to the
			// main document). Monaco resolves its window via `ownerDocument.defaultView`,
			// and after adoption into the aux tree token CSS must come from the aux
			// document — so the host must be an aux-owned element from birth.
			// Cast through Function: Electron's Document.createElement overloads reject
			// normal tag names when calling Document.prototype.createElement directly.
			const createInConnectedDoc = Document.prototype.createElement.bind(connectedDoc) as (tagName: string) => HTMLElement;
			const host = createInConnectedDoc('div');
			host.className = 'void-agent-workspace-file-editor-host';
			host.style.position = 'absolute';
			host.style.inset = '0';
			host.style.width = '100%';
			host.style.height = '100%';
			host.style.minHeight = '0';
			shell.appendChild(host);
			monacoHostRef.current = host;

			// Belt-and-suspenders: inject TextMate token colors into the aux document
			// head (and keep them live). Missing `.mtkN` rules is what makes this
			// editor render monochrome while the main IDE editor highlights fine.
			const syncTokenStyles = (): void => {
				try {
					const mainTokens = mainWindow.document.head.querySelector('style.vscode-tokens-styles');
					const css = mainTokens?.textContent;
					if (!css) {
						return;
					}
					const auxDoc = getConnectedDocument(host);
					let local = auxDoc.getElementById('orbit-agent-file-editor-tokens') as HTMLStyleElement | null;
					if (!local) {
						local = createInConnectedDoc('style') as HTMLStyleElement;
						local.id = 'orbit-agent-file-editor-tokens';
						local.className = 'vscode-tokens-styles';
						local.type = 'text/css';
						auxDoc.head.appendChild(local);
					}
					if (local.textContent !== css) {
						local.textContent = css;
					}
				} catch { /* ignore */ }
			};

			const store = new DisposableStore();
			editorStoreRef.current = store;

			const attachMainTokenStyleObserver = (el: Element): void => {
				const mo = new MutationObserver(() => syncTokenStyles());
				mo.observe(el, { childList: true, characterData: true, subtree: true });
				store.add({ dispose: () => mo.disconnect() });
			};

			syncTokenStyles();

			const mainTokensEl = mainWindow.document.head.querySelector('style.vscode-tokens-styles');
			if (mainTokensEl) {
				attachMainTokenStyleObserver(mainTokensEl);
			}

			// TextMate may emit vscode-tokens-styles after the editor mounts.
			const headObserver = new MutationObserver(mutations => {
				for (const mutation of mutations) {
					for (const node of mutation.addedNodes) {
						if (node instanceof HTMLStyleElement && node.classList.contains('vscode-tokens-styles')) {
							syncTokenStyles();
							attachMainTokenStyleObserver(node);
						}
					}
				}
			});
			headObserver.observe(mainWindow.document.head, { childList: true });
			store.add({ dispose: () => headObserver.disconnect() });

			const workbenchThemeService = accessor.get('IWorkbenchThemeService') as IWorkbenchThemeService;
			store.add(workbenchThemeService.onDidColorThemeChange(() => syncTokenStyles()));

			// Retry briefly when token CSS is not ready yet (cold start / theme load).
			let tokenSyncAttempts = 0;
			const retryTokenSync = (): void => {
				syncTokenStyles();
				const hasCss = !!mainWindow.document.head.querySelector('style.vscode-tokens-styles')?.textContent;
				if (!hasCss && tokenSyncAttempts++ < 50) {
					mainWindow.setTimeout(retryTokenSync, 100);
				}
			};
			retryTokenSync();

			const scopedInstantiation = instantiationService.createChild(
				new ServiceCollection([IEditorProgressService, noopEditorProgressService]),
			);
			store.add(scopedInstantiation);
			let editor: CodeEditorWidget;
			try {
				editor = scopedInstantiation.createInstance(
					CodeEditorWidget,
					host,
					{
						automaticLayout: true,
						readOnly: readOnlyRef.current,
						domReadOnly: readOnlyRef.current,
						lineNumbers: lineNumbers ? 'on' : 'off',
						minimap: { enabled: false },
						scrollBeyondLastLine: false,
						renderWhitespace: readEditorOption(configurationService, 'editor.renderWhitespace', 'selection' as const),
						fontSize: readEditorOption(configurationService, 'editor.fontSize', 13),
						fontFamily: readEditorOption<string | undefined>(configurationService, 'editor.fontFamily', undefined),
						fontLigatures: readEditorOption(configurationService, 'editor.fontLigatures', false),
						wordWrap: wordWrap ? 'on' : 'off',
						cursorBlinking: readEditorOption(configurationService, 'editor.cursorBlinking', 'blink' as const),
						cursorStyle: readEditorOption(configurationService, 'editor.cursorStyle', 'line' as const),
						renderLineHighlight: readEditorOption(configurationService, 'editor.renderLineHighlight', 'line' as const),
						smoothScrolling: readEditorOption(configurationService, 'editor.smoothScrolling', false),
						mouseWheelZoom: readEditorOption(configurationService, 'editor.mouseWheelZoom', false),
						padding: { top: 8, bottom: 8 },
						scrollbar: {
							verticalScrollbarSize: 10,
							horizontalScrollbarSize: 10,
							useShadows: false,
						},
						ariaLabel: `Editing ${basename(uri?.fsPath || uri?.path || 'file')}`,
					},
					{ isSimpleWidget: false },
				);
			} catch (e: unknown) {
				setError(`Failed to create editor: ${String((e as Error)?.message ?? e)}`);
				host.remove();
				monacoHostRef.current = null;
				// Dispose the store so the scoped child instantiation service (added
				// above) doesn't leak when widget creation throws.
				try { store.dispose(); } catch { /* ignore */ }
				editorStoreRef.current = null;
				return;
			}

			store.add(editor);
			editorRef.current = editor;

			const onKeyDown = (e: KeyboardEvent) => {
				if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
					e.preventDefault();
					e.stopPropagation();
					void doSaveRef.current();
				}
			};
			host.addEventListener('keydown', onKeyDown, true);
			store.add({ dispose: () => host.removeEventListener('keydown', onKeyDown, true) });

			const win = getConnectedWindow(host) as Window & typeof globalThis;
			if (typeof win.ResizeObserver === 'function') {
				const ro = new win.ResizeObserver(() => {
					try {
						if (editor.getContainerDomNode()?.isConnected) {
							editor.layout();
						}
					} catch { /* ignore */ }
				});
				ro.observe(host);
				ro.observe(shell);
				store.add({ dispose: () => ro.disconnect() });
			}
		}

		if (!editorRef.current) {
			return;
		}

		// Attach the model (no-op if the resolve path already did it for an existing
		// editor; the meaningful call is the first-ever creation above).
		applyModelToEditor(model);

		// Double rAF so layout runs after a display:none → flex transition settles.
		const win = getConnectedWindow(hostRef.current) as Window & typeof globalThis;
		const id1 = win.requestAnimationFrame(() => {
			win.requestAnimationFrame(() => layoutEditor(isActiveRef.current));
		});
		return () => win.cancelAnimationFrame(id1);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [model]);

	// Dispose the widget ONLY on unmount.
	React.useEffect(() => {
		return () => {
			try { editorStoreRef.current?.dispose(); } catch { /* ignore */ }
			editorStoreRef.current = null;
			editorRef.current = null;
			if (monacoHostRef.current) {
				try { monacoHostRef.current.remove(); } catch { /* ignore */ }
				monacoHostRef.current = null;
			}
		};
	}, []);

	// Apply option toggles without rebuilding the editor.
	React.useEffect(() => {
		editorRef.current?.updateOptions({
			lineNumbers: lineNumbers ? 'on' : 'off',
			wordWrap: wordWrap ? 'on' : 'off',
		});
	}, [lineNumbers, wordWrap]);

	React.useEffect(() => {
		editorRef.current?.updateOptions({ readOnly, domReadOnly: readOnly });
	}, [readOnly]);

	// Relayout + focus when this tab becomes active.
	React.useEffect(() => {
		if (!isActive || !editorRef.current) {
			return;
		}
		const win = hostRef.current ? getConnectedWindow(hostRef.current) : window;
		const id = win.requestAnimationFrame(() => layoutEditor(true));
		return () => win.cancelAnimationFrame(id);
	}, [isActive, layoutEditor]);

	// Relayout (no focus steal) when the explorer toggles.
	React.useEffect(() => {
		if (!isActive || !editorRef.current) {
			return;
		}
		const win = hostRef.current ? getConnectedWindow(hostRef.current) : window;
		const id = win.requestAnimationFrame(() => layoutEditor(false));
		return () => win.cancelAnimationFrame(id);
	}, [explorerVisible, isActive, layoutEditor]);

	React.useEffect(() => {
		if (!menuOpen) {
			return;
		}
		const doc = menuBtnRef.current ? getConnectedWindow(menuBtnRef.current).document : document;
		const onDown = (e: MouseEvent) => {
			const t = e.target as Node;
			if (menuRef.current?.contains(t) || menuBtnRef.current?.contains(t)) {
				return;
			}
			setMenuOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				setMenuOpen(false);
			}
		};
		doc.addEventListener('mousedown', onDown, true);
		doc.addEventListener('keydown', onKey, true);
		return () => {
			doc.removeEventListener('mousedown', onDown, true);
			doc.removeEventListener('keydown', onKey, true);
		};
	}, [menuOpen]);

	const crumbs = React.useMemo(() => {
		if (!uri) {
			return [] as { label: string; uri?: URI }[];
		}
		const agentFolders = agentProjectWorkspaceService.getActiveFolders();
		const agentFolder = agentFolders.find(f => {
			const fs = f.fsPath;
			return uri.fsPath === fs || uri.fsPath.startsWith(fs.endsWith('/') || fs.endsWith('\\') ? fs : fs + (uri.fsPath.includes('\\') ? '\\' : '/'));
		});
		if (!agentFolder) {
			return [{ label: resourceBasename(uri) || basename(uri.fsPath || uri.path) }];
		}
		const folder = { uri: agentFolder };
		const rel = resourceRelativePath(folder.uri, uri);
		if (!rel) {
			return [{ label: resourceBasename(uri) || basename(uri.fsPath || uri.path) }];
		}
		const parts = rel.replace(/\\/g, '/').split('/').filter(Boolean);
		const out: { label: string; uri?: URI }[] = [];
		let acc = folder.uri;
		for (let i = 0; i < parts.length; i++) {
			acc = joinPath(acc, parts[i]);
			out.push({ label: parts[i], uri: i < parts.length - 1 ? acc : undefined });
		}
		return out;
		// `agentProjectWorkspaceService` is a stable service ref and never changes
		// identity, so it alone can't bust this memo when the active workspace
		// switches (same `uri`, different folder set). Include `activeWorkspaceId`
		// and a stringified folder list from `agentWorkspaceState` (which IS backed
		// by `onDidChangeState`) so the breadcrumbs recompute on switch. M5/#16.
	}, [uri, agentProjectWorkspaceService, agentWorkspaceState.activeWorkspaceId, agentWorkspaceState.workspaces]);

	const fileIndex = uri ? openFileResources.indexOf(uri.toString()) : -1;
	const canBack = fileIndex > 0;
	const canForward = fileIndex >= 0 && fileIndex < openFileResources.length - 1;

	const goBack = () => {
		if (canBack && onNavigateFile) {
			try { onNavigateFile(parseResource(openFileResources[fileIndex - 1])); } catch { /* malformed entry — ignore */ }
		}
	};
	const goForward = () => {
		if (canForward && onNavigateFile) {
			try { onNavigateFile(parseResource(openFileResources[fileIndex + 1])); } catch { /* malformed entry — ignore */ }
		}
	};

	const openFileDialog = React.useCallback(async () => {
		const picked = await fileDialogService.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			title: 'Open File',
			openLabel: 'Open',
		});
		if (picked?.[0]) {
			openInWorkspace('files', picked[0].toString());
		}
	}, [fileDialogService, openInWorkspace]);

	const toggleAutoSave = React.useCallback(async () => {
		const next = !autoSave;
		const previous = autoSave;
		setAutoSave(next);
		try {
			await configurationService.updateValue('files.autoSave', next ? 'afterDelay' : 'off');
		} catch {
			setAutoSave(previous);
		}
	}, [autoSave, configurationService]);

	const explorerToggle = onToggleExplorer && (
		<button
			type="button"
			className={`agent-workspace-file-iconbtn${explorerVisible ? ' active' : ''}`}
			title={explorerVisible ? 'Hide Explorer' : 'Show Explorer'}
			onClick={onToggleExplorer}
		>
			<PanelRight size={14} strokeWidth={1.75} />
		</button>
	);

	// Single tree with a persistent Monaco host. Empty / error / loading render as
	// overlays so the editor widget is never unmounted underneath them.
	return (
		<div className="agent-workspace-file">
			<div className="agent-workspace-file-chrome">
				<div className="agent-workspace-file-chrome-left">
					{uri ? (
						<>
							<button type="button" className="agent-workspace-file-navbtn" disabled={!canBack} onClick={goBack} title="Previous open file" aria-label="Previous open file">
								<ChevronLeft size={14} strokeWidth={1.75} />
							</button>
							<button type="button" className="agent-workspace-file-navbtn" disabled={!canForward} onClick={goForward} title="Next open file" aria-label="Next open file">
								<ChevronRight size={14} strokeWidth={1.75} />
							</button>
							<nav className="agent-workspace-file-crumbs" aria-label="Breadcrumb">
								{crumbs.map((c, i) => (
									<React.Fragment key={`${c.label}-${i}`}>
										{i > 0 && <span className="agent-workspace-file-crumb-sep">›</span>}
										{c.uri ? (
											<span className="agent-workspace-file-crumb" title={c.uri.fsPath || c.uri.path}>{c.label}</span>
										) : (
											<span className="agent-workspace-file-crumb-current" title={uri.fsPath || uri.path}>
												{c.label}{dirty ? ' •' : ''}
											</span>
										)}
									</React.Fragment>
								))}
								{readOnly && (
									<span className="agent-workspace-file-readonly" title="This file is read-only">
										<Lock size={11} strokeWidth={2} /> Read-only
									</span>
								)}
							</nav>
						</>
					) : (
						<span className="agent-workspace-file-crumb-current">No file open</span>
					)}
				</div>
				<div className="agent-workspace-file-chrome-right">
					{uri && (
						<>
							<button type="button" className="agent-workspace-file-iconbtn" title="Find" onClick={() => void editorRef.current?.getAction('actions.find')?.run()}>
								<Search size={13} strokeWidth={1.75} />
							</button>
							<button type="button" className="agent-workspace-file-iconbtn" title="Go to Symbol" onClick={() => void editorRef.current?.getAction('editor.action.quickOutline')?.run()}>
								<ListTree size={13} strokeWidth={1.75} />
							</button>
							<div className="agent-workspace-file-menu-wrap">
								<button
									ref={menuBtnRef}
									type="button"
									className="agent-workspace-file-iconbtn"
									title="More actions"
									aria-haspopup="menu"
									aria-expanded={menuOpen}
									onClick={() => setMenuOpen(v => !v)}
								>
									<MoreHorizontal size={14} strokeWidth={1.75} />
								</button>
								{menuOpen && (
									<div ref={menuRef} role="menu" className="agent-workspace-file-menu">
										<button type="button" role="menuitem" className="agent-workspace-file-menu-item" onClick={() => { setMenuOpen(false); void doSave(); }} disabled={!dirty || readOnly}>
											Save File<span className="agent-workspace-file-menu-kbd">{SAVE_SHORTCUT}</span>
										</button>
										<button type="button" role="menuitem" className="agent-workspace-file-menu-item" onClick={() => { setMenuOpen(false); void doDiscard(); }} disabled={!dirty}>
											Discard Changes
										</button>
										<div className="agent-workspace-file-menu-sep" />
										<button type="button" role="menuitem" className="agent-workspace-file-menu-item" onClick={() => {
											setMenuOpen(false);
											if (uri.scheme !== Schemas.file) {
												notificationService.error('Reveal is only available for local files.');
												return;
											}
											nativeHostService.showItemInFolder(uri.fsPath);
										}}>
											{isLinux ? 'Open Containing Folder' : isMacintosh ? 'Reveal in Finder' : 'Reveal in File Explorer'}
										</button>
										<button type="button" role="menuitem" className="agent-workspace-file-menu-item" onClick={() => { setMenuOpen(false); void clipboardService.writeText(uri.fsPath || uri.path); }}>
											Copy Path
										</button>
										<button type="button" role="menuitem" className="agent-workspace-file-menu-item" onClick={() => {
											setMenuOpen(false);
											const agentFolders = agentProjectWorkspaceService.getActiveFolders();
											const agentFolder = agentFolders.find(f => {
												const fs = f.fsPath;
												return uri.fsPath === fs || uri.fsPath.startsWith(fs.endsWith('/') || fs.endsWith('\\') ? fs : fs + (uri.fsPath.includes('\\') ? '\\' : '/'));
											});
											const rel = agentFolder ? resourceRelativePath(agentFolder, uri) : undefined;
											void clipboardService.writeText(rel?.replace(/\\/g, '/') || uri.fsPath || uri.path);
										}}>
											Copy Relative Path
										</button>
										<div className="agent-workspace-file-menu-sep" />
										<button type="button" role="menuitem" className="agent-workspace-file-menu-item" onClick={() => setLineNumbers(v => !v)}>
											Line Numbers<span className={`agent-workspace-file-menu-toggle${lineNumbers ? ' on' : ''}`} />
										</button>
										<button type="button" role="menuitem" className="agent-workspace-file-menu-item" onClick={() => setWordWrap(v => !v)}>
											Word Wrap<span className={`agent-workspace-file-menu-toggle${wordWrap ? ' on' : ''}`} />
										</button>
										<button type="button" role="menuitem" className="agent-workspace-file-menu-item" onClick={() => void toggleAutoSave()}>
											Auto Save<span className={`agent-workspace-file-menu-toggle${autoSave ? ' on' : ''}`} />
										</button>
										<div className="agent-workspace-file-menu-sep" />
										<button type="button" role="menuitem" className="agent-workspace-file-menu-item" onClick={() => { setMenuOpen(false); openFileDialog(); }}>
											Open File…
										</button>
									</div>
								)}
							</div>
						</>
					)}
					{explorerToggle}
				</div>
			</div>

			{error && model && <div className="agent-workspace-file-banner" role="alert">{error}</div>}

			{/*
				`.agent-workspace-file-editor` is the relative-positioned stage. The
				Monaco host (created imperatively in the aux document by the mount
				effect) is appended into `.agent-workspace-file-editor-surface`, which
				React keeps empty. Loading / error / empty states render as sibling
				overlays so the editor widget is never unmounted beneath them.
			*/}
			<div className="agent-workspace-file-editor">
				<div className="agent-workspace-file-editor-surface" ref={hostRef} />
				{loading && (
					<div className="agent-workspace-file-loading">Loading…</div>
				)}
				{!uri && (
					<div className="agent-workspace-file-overlay">
						<FileCode size={22} strokeWidth={1.5} className="agent-workspace-placeholder-icon" />
						<div className="agent-workspace-placeholder-label">No file open</div>
						<div className="agent-workspace-placeholder-detail">Select a file from the explorer, or open one from disk.</div>
						<button type="button" className="agent-workspace-file-openbtn" onClick={openFileDialog}>
							Open File…
						</button>
					</div>
				)}
				{uri && error && !model && !loading && (
					<div className="agent-workspace-file-overlay">
						<PanelPlaceholder icon={FileCode} label="Can't open file" detail={error} />
					</div>
				)}
			</div>
		</div>
	);
};
