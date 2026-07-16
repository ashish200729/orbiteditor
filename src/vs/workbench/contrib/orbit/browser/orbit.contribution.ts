/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/


// register inline diffs
import './editCodeService.js'

// register Sidebar pane, state, actions (keybinds, menus) (Ctrl+L)
import './sidebarActions.js'
import './sidebarPane.js'

// register quick edit (Ctrl+K)
import './quickEditActions.js'

// register standalone Agents window (Cursor-style pop-out)
import './agentWindowService.js'
import './agentWindowActions.js'
import './agentWindowTerminalStore.js'
import './media/agentWindow.css'


// register Autocomplete
import './autocomplete/index.js'

// register Context services
// import './contextGatheringService.js'
// import './contextUserChangesService.js'

// settings pane
import './orbitSettingsPane.js'
import './orbitCustomizePane.js'

// marketplace catalog (Customize > Marketplace)
import './marketplaceCatalogService.js'

// register css
import './media/void.css'

// update (frontend part, also see platform/)
import './orbitUpdateActions.js'
import './openAiCodexActions.js'
import './xAiGrokActions.js'
import './orbitProviderAuthActions.js'

import './convertToLLMMessageWorkbenchContrib.js'

// tools
import './toolsService.js'
import './semanticRetrievalService.js'
import './terminalToolService.js'
import './subAgentService.js'
import './projectAgentLoader.js'
import './subAgentImportService.js'

// skills (registry loader + import service)
import './skillLoader.js'
import './skillImportService.js'

// register Thread History
import './chatThreadService.js'

// ping
import './metricsPollService.js'

// helper services
import './helperServices/consistentItemService.js'

// register selection helper
import './orbitSelectionHelperWidget.js'

// register tooltip service
import './tooltipService.js'

// register history dropdown service
import './historyDropdownService.js'

// register onboarding service
import './orbitOnboardingService.js'

// register misc service
import './miscWokrbenchContrib.js'

// register file service (for explorer context menu)
import './fileService.js'

// register source control management
import './orbitSCMService.js'
import './agentGitService.js'

// register native notifications
import './nativeNotificationService.js'

// register Plan Editor custom editor
import './planEditorInput.js'
import './planEditorPane.js'
import './planEditorCommands.js'
import './planEditorRegistration.js'

// ---------- common (unclear if these actually need to be imported, because they're already imported wherever they're used) ----------

// llmMessage
import '../common/sendLLMMessageService.js'

// voidSettings
import '../common/orbitSettingsService.js'

// refreshModel
import '../common/refreshModelService.js'

// metrics
import '../common/metricsService.js'

// updates
import '../common/orbitUpdateService.js'
import '../common/openAiCodexAuthService.js'
import '../common/xAiGrokAuthService.js'
import '../common/githubAuthService.js'
import '../common/orbitProviderAuthService.js'

// model service
import '../common/orbitModelService.js'
