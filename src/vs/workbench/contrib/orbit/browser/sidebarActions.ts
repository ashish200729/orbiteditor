/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';


import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';

import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';

import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { IRange } from '../../../../editor/common/core/range.js';
import { VOID_VIEW_CONTAINER_ID, VOID_VIEW_ID } from './sidebarPane.js';
import { IMetricsService } from '../common/metricsService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { VOID_TOGGLE_SETTINGS_ACTION_ID } from './orbitSettingsPane.js';
import { VOID_CTRL_L_ACTION_ID } from './actionIDs.js';
import { localize2 } from '../../../../nls.js';
import { IChatThreadService } from './chatThreadService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { StagingSelectionItem } from '../common/chatThreadServiceTypes.js';
import { HISTORY_DROPDOWN_TOGGLE_EVENT } from './historyDropdownService.js';
import { IAgentWindowService } from './agentWindowService.js';
import { IAgentProjectWorkspaceService } from './agentProjectWorkspaceService.js';
import { isAuxiliaryWindow } from '../../../../base/browser/window.js';
import { getActiveWindow as getActiveDomWindow } from '../../../../base/browser/dom.js';

// ---------- Register commands and keybindings ----------


export const roundRangeToLines = (range: IRange | null | undefined, options: { emptySelectionBehavior: 'null' | 'line' }) => {
	if (!range)
		return null

	// treat as no selection if selection is empty
	if (range.endColumn === range.startColumn && range.endLineNumber === range.startLineNumber) {
		if (options.emptySelectionBehavior === 'null')
			return null
		else if (options.emptySelectionBehavior === 'line')
			return { startLineNumber: range.startLineNumber, startColumn: 1, endLineNumber: range.startLineNumber, endColumn: 1 }
	}

	// IRange is 1-indexed
	const endLine = range.endColumn === 1 ? range.endLineNumber - 1 : range.endLineNumber // e.g. if the user triple clicks, it selects column=0, line=line -> column=0, line=line+1
	const newRange: IRange = {
		startLineNumber: range.startLineNumber,
		startColumn: 1,
		endLineNumber: endLine,
		endColumn: Number.MAX_SAFE_INTEGER
	}
	return newRange
}

// const getContentInRange = (model: ITextModel, range: IRange | null) => {
// 	if (!range)
// 		return null
// 	const content = model.getValueInRange(range)
// 	const trimmedContent = content
// 		.replace(/^\s*\n/g, '') // trim pure whitespace lines from start
// 		.replace(/\n\s*$/g, '') // trim pure whitespace lines from end
// 	return trimmedContent
// }



const VOID_OPEN_SIDEBAR_ACTION_ID = 'void.sidebar.open'
registerAction2(class extends Action2 {
	constructor() {
		super({ id: VOID_OPEN_SIDEBAR_ACTION_ID, title: localize2('voidOpenSidebar', 'Orbit: Open Sidebar'), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService)
		const chatThreadsService = accessor.get(IChatThreadService)
		viewsService.openViewContainer(VOID_VIEW_CONTAINER_ID)
		await chatThreadsService.focusCurrentChat()
	}
})


const VOID_ADD_BROWSER_ELEMENT_SELECTION_ACTION_ID = 'void.addBrowserElementSelection'
registerAction2(class extends Action2 {
	constructor() {
		super({ id: VOID_ADD_BROWSER_ELEMENT_SELECTION_ACTION_ID, title: 'Orbit: Add Browser Element Selection', f1: false });
	}
	async run(accessor: ServicesAccessor, payload: any): Promise<void> {
		const chatThreadService = accessor.get(IChatThreadService)

		if (!payload || typeof payload !== 'object') {
			throw new Error('Invalid BrowserElement payload')
		}
		if (payload.type !== 'BrowserElement') {
			throw new Error('Invalid BrowserElement payload type')
		}
		if (typeof payload.pageUrl !== 'string' || typeof payload.selector !== 'string') {
			throw new Error('Invalid BrowserElement payload')
		}
		if (!payload.elementData || typeof payload.elementData !== 'object') {
			throw new Error('Invalid BrowserElement payload')
		}

		let screenshot: string | null = typeof payload.screenshot === 'string' ? payload.screenshot : null
		if (screenshot && screenshot.startsWith('data:')) {
			const match = screenshot.match(/^data:image\/[^;]+;base64,(.+)$/)
			screenshot = match?.[1] || null
		}

		const elementData = payload.elementData as any
		const selection: StagingSelectionItem = {
			type: 'BrowserElement',
			selector: payload.selector,
			selectorChain: Array.isArray(payload.selectorChain) ? payload.selectorChain.filter((s: any) => typeof s === 'string') : undefined,
			pageUrl: payload.pageUrl,
			elementData: {
				tagName: typeof elementData.tagName === 'string' ? elementData.tagName : '',
				id: typeof elementData.id === 'string' ? elementData.id : null,
				classes: Array.isArray(elementData.classes) ? elementData.classes.filter((s: any) => typeof s === 'string') : [],
				attributes: elementData.attributes && typeof elementData.attributes === 'object' ? elementData.attributes : {},
				text: typeof elementData.text === 'string' ? elementData.text : '',
				html: typeof elementData.html === 'string' ? elementData.html : '',
			},
			screenshot,
			timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Date.now(),
		}

		chatThreadService.addNewStagingSelection(selection)
	}
})


// cmd L
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VOID_CTRL_L_ACTION_ID,
			f1: true,
			title: localize2('voidCmdL', 'Orbit: Add Selection to Chat'),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyL,
				weight: KeybindingWeight.VoidExtension
			}
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		// Get services
		const commandService = accessor.get(ICommandService)
		const viewsService = accessor.get(IViewsService)
		const metricsService = accessor.get(IMetricsService)
		const editorService = accessor.get(ICodeEditorService)
		const chatThreadService = accessor.get(IChatThreadService)

		metricsService.capture('Ctrl+L', {})

		// capture selection and model before opening the chat panel
		const editor = editorService.getActiveCodeEditor()
		const model = editor?.getModel()
		if (!model) return

		const selectionRange = roundRangeToLines(editor?.getSelection(), { emptySelectionBehavior: 'null' })

		// open panel
		const wasAlreadyOpen = viewsService.isViewContainerVisible(VOID_VIEW_CONTAINER_ID)
		if (!wasAlreadyOpen) {
			await commandService.executeCommand(VOID_OPEN_SIDEBAR_ACTION_ID)
		}

		// Add selection to chat
		// add line selection
		if (selectionRange) {
			editor?.setSelection({
				startLineNumber: selectionRange.startLineNumber,
				endLineNumber: selectionRange.endLineNumber,
				startColumn: 1,
				endColumn: Number.MAX_SAFE_INTEGER
			})
			chatThreadService.addNewStagingSelection({
				type: 'CodeSelection',
				uri: model.uri,
				language: model.getLanguageId(),
				range: [selectionRange.startLineNumber, selectionRange.endLineNumber],
				state: { wasAddedAsCurrentFile: false },
			})
		}
		// add file
		else {
			chatThreadService.addNewStagingSelection({
				type: 'File',
				uri: model.uri,
				language: model.getLanguageId(),
				state: { wasAddedAsCurrentFile: false },
			})
		}

		await chatThreadService.focusCurrentChat()
	}
})


// New chat keybind + menu button
const VOID_CMD_SHIFT_L_ACTION_ID = 'void.cmdShiftL'
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VOID_CMD_SHIFT_L_ACTION_ID,
			title: 'New Chat',
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyL,
				weight: KeybindingWeight.VoidExtension,
			},
			icon: { id: 'add' },
			menu: [{ id: MenuId.ViewTitle, group: 'navigation', order: 1, when: ContextKeyExpr.equals('view', VOID_VIEW_ID), }],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {

		const metricsService = accessor.get(IMetricsService)
		const chatThreadsService = accessor.get(IChatThreadService)
		const editorService = accessor.get(ICodeEditorService)
		const agentWindowService = accessor.get(IAgentWindowService)
		const agentProjectWorkspaceService = accessor.get(IAgentProjectWorkspaceService)
		metricsService.capture('Chat Navigation', { type: 'Start New Chat' })

		// get current selections and value to transfer
		const oldThreadId = chatThreadsService.state.currentThreadId
		const oldThread = chatThreadsService.state.allThreads[oldThreadId]

		const oldUI = await oldThread?.state.mountedInfo?.whenMounted

		const oldSelns = oldThread?.state.stagingSelections
		const oldVal = oldUI?.textAreaRef?.current?.value

	// open and focus new thread — scope to the agent workspace ONLY when the
	// command was invoked from the Agents window itself. Gating on
	// `isOpen()` would mis-scope main-IDE chats whenever the pop-out is
	// merely open in the background (worst case: No Repo mode gives IDE
	// chats zero workspace folders, breaking Glob/Grep/Shell).
	const invokedFromAgentWindow = agentWindowService.isOpen() && isAuxiliaryWindow(getActiveDomWindow())
		if (invokedFromAgentWindow) {
			chatThreadsService.openNewThread({
				agentWorkspaceId: agentProjectWorkspaceService.getState().activeWorkspaceId,
				forceNew: true,
			})
		} else {
			chatThreadsService.openNewThread({ forceNew: true })
		}
		await chatThreadsService.focusSelectedChat(invokedFromAgentWindow)


		// set new thread values
		const newThreadId = invokedFromAgentWindow
			? chatThreadsService.state.agentWindowThreadId
			: chatThreadsService.state.currentThreadId
		if (!newThreadId) {
			return
		}
		const newThread = chatThreadsService.state.allThreads[newThreadId]

		const newUI = await newThread?.state.mountedInfo?.whenMounted
		if (invokedFromAgentWindow) {
			chatThreadsService.setThreadState(newThreadId, { stagingSelections: oldSelns })
		} else {
			chatThreadsService.setCurrentThreadState({ stagingSelections: oldSelns })
		}
		if (newUI?.textAreaRef?.current && oldVal) newUI.textAreaRef.current.value = oldVal


		// if has selection, add it
		const editor = editorService.getActiveCodeEditor()
		const model = editor?.getModel()
		if (!model) return
		const selectionRange = roundRangeToLines(editor?.getSelection(), { emptySelectionBehavior: 'null' })
		if (!selectionRange) return
		editor?.setSelection({ startLineNumber: selectionRange.startLineNumber, endLineNumber: selectionRange.endLineNumber, startColumn: 1, endColumn: Number.MAX_SAFE_INTEGER })
		chatThreadsService.addNewStagingSelection({
			type: 'CodeSelection',
			uri: model.uri,
			language: model.getLanguageId(),
			range: [selectionRange.startLineNumber, selectionRange.endLineNumber],
			state: { wasAddedAsCurrentFile: false },
		})
	}
})

// History menu button - toggles thread history dropdown (hidden when ChatHistory panel is open)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'void.historyAction',
			title: 'View Past Chats',
			icon: { id: 'history' },
			menu: [{
				id: MenuId.ViewTitle,
				group: 'navigation',
				order: 2,
				when: ContextKeyExpr.and(
					ContextKeyExpr.equals('view', VOID_VIEW_ID),
					ContextKeyExpr.not('chatHistoryVisible'),
				),
			}]
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const metricsService = accessor.get(IMetricsService)
		metricsService.capture('Chat Navigation', { type: 'History' })

		// Dispatch DOM event to toggle the history dropdown
		const event = new CustomEvent(HISTORY_DROPDOWN_TOGGLE_EVENT);
		document.dispatchEvent(event);
	}
})


// Toggle Thread Panel (ChatHistory side panel)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'void.toggleThreadPanel',
			title: 'Toggle Thread Panel',
			icon: { id: 'panel-right' },
			menu: [{
				id: MenuId.ViewTitle,
				group: 'navigation',
				order: 5,
				when: ContextKeyExpr.and(
					ContextKeyExpr.equals('view', VOID_VIEW_ID),
					ContextKeyExpr.not('chatHistoryVisible'),
				),
			}]
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService)
		commandService.executeCommand('workbench.action.toggleChatHistory')
	}
})


// Settings gear
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'void.settingsAction',
			title: `Orbit's Settings`,
			icon: { id: 'settings-gear' },
			menu: [{ id: MenuId.ViewTitle, group: 'navigation', order: 4, when: ContextKeyExpr.equals('view', VOID_VIEW_ID), }]
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService)
		commandService.executeCommand(VOID_TOGGLE_SETTINGS_ACTION_ID)
	}
})




// export class TabSwitchListener extends Disposable {

// 	constructor(
// 		onSwitchTab: () => void,
// 		@ICodeEditorService private readonly _editorService: ICodeEditorService,
// 	) {
// 		super()

// 		// when editor switches tabs (models)
// 		const addTabSwitchListeners = (editor: ICodeEditor) => {
// 			this._register(editor.onDidChangeModel(e => {
// 				if (e.newModelUrl?.scheme !== 'file') return
// 				onSwitchTab()
// 			}))
// 		}

// 		const initializeEditor = (editor: ICodeEditor) => {
// 			addTabSwitchListeners(editor)
// 		}

// 		// initialize current editors + any new editors
// 		for (let editor of this._editorService.listCodeEditors()) initializeEditor(editor)
// 		this._register(this._editorService.onCodeEditorAdd(editor => { initializeEditor(editor) }))
// 	}
// }
