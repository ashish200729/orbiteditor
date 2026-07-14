/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import * as nls from '../../../../nls.js';
import { EditorExtensions } from '../../../common/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { URI } from '../../../../base/common/uri.js';

import { mountVoidCustomize } from './react/out/customize-tsx/index.js'
import { Codicon } from '../../../../base/common/codicons.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { setPendingOrbitCustomize } from './orbitCustomizeNavigation.js';


class VoidCustomizeInput extends EditorInput {

	static readonly ID: string = 'workbench.input.void.customize';

	static readonly RESOURCE = URI.from({
		scheme: 'void',
		path: 'customize'
	})
	readonly resource = VoidCustomizeInput.RESOURCE;

	constructor() {
		super();
	}

	override get typeId(): string {
		return VoidCustomizeInput.ID;
	}

	override getName(): string {
		return nls.localize('voidCustomizeInputsName', 'Customize');
	}

	override getIcon() {
		return Codicon.settingsGear
	}

}


class VoidCustomizePane extends EditorPane {
	static readonly ID = 'workbench.editor.voidCustomize';

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super(VoidCustomizePane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		parent.style.height = '100%';
		parent.style.width = '100%';

		const customizeElt = document.createElement('div');
		customizeElt.style.height = '100%';
		customizeElt.style.width = '100%';

		parent.appendChild(customizeElt);

		this.instantiationService.invokeFunction(accessor => {
			const disposeFn = mountVoidCustomize(customizeElt, accessor)?.dispose;
			this._register(toDisposable(() => disposeFn?.()))
		});
	}

	layout(dimension: Dimension): void {
	}

	override get minimumWidth() { return 640 }

}

// register Customize pane
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(VoidCustomizePane, VoidCustomizePane.ID, nls.localize('VoidCustomizePane', "Orbit Customize Pane")),
	[new SyncDescriptor(VoidCustomizeInput)]
);


// Open (or focus) the Customize editor. Dedupe like Settings: close stale
// instances first so we always keep a single editor tab.
const openCustomizeEditor = async (accessor: ServicesAccessor) => {
	const editorService = accessor.get(IEditorService);
	const instantiationService = accessor.get(IInstantiationService);

	const openEditors = editorService.findEditors(VoidCustomizeInput.RESOURCE);
	if (openEditors.length > 0) {
		await editorService.closeEditors(openEditors);
	}

	const input = instantiationService.createInstance(VoidCustomizeInput);
	await editorService.openEditor(input);
}


export const VOID_OPEN_CUSTOMIZE_ACTION_ID = 'workbench.action.openVoidCustomize'
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VOID_OPEN_CUSTOMIZE_ACTION_ID,
			title: nls.localize2('voidCustomizeAction', "Orbit: Open Customize"),
			f1: true,
			icon: Codicon.settingsGear,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await openCustomizeEditor(accessor);
	}
})


export const VOID_OPEN_MARKETPLACE_ACTION_ID = 'workbench.action.openVoidMarketplace'
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VOID_OPEN_MARKETPLACE_ACTION_ID,
			title: nls.localize2('voidMarketplaceAction', "Orbit: Open Marketplace"),
			f1: true,
			icon: Codicon.extensions,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		setPendingOrbitCustomize({ view: 'marketplace' });
		await openCustomizeEditor(accessor);
	}
})


// Discoverability: add "Customize" to the settings-gear (bottom-left) menu, next to Settings.
MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
	group: '0_command',
	command: {
		id: VOID_OPEN_CUSTOMIZE_ACTION_ID,
		title: nls.localize('voidCustomizeActionGear', "Customize")
	},
	order: 2
});
