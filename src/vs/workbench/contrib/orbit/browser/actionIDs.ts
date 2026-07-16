// Normally you'd want to put these exports in the files that register them, but if you do that you'll get an import order error if you import them in certain cases.
// (importing them runs the whole file to get the ID, causing an import error). I guess it's best practice to separate out IDs, pretty annoying...

export const VOID_CTRL_L_ACTION_ID = 'void.ctrlLAction'

export const VOID_CTRL_K_ACTION_ID = 'void.ctrlKAction'

export const VOID_ACCEPT_DIFF_ACTION_ID = 'void.acceptDiff'

export const VOID_REJECT_DIFF_ACTION_ID = 'void.rejectDiff'

export const VOID_GOTO_NEXT_DIFF_ACTION_ID = 'void.goToNextDiff'

export const VOID_GOTO_PREV_DIFF_ACTION_ID = 'void.goToPrevDiff'

export const VOID_GOTO_NEXT_URI_ACTION_ID = 'void.goToNextUri'

export const VOID_GOTO_PREV_URI_ACTION_ID = 'void.goToPrevUri'

export const VOID_ACCEPT_FILE_ACTION_ID = 'void.acceptFile'

export const VOID_REJECT_FILE_ACTION_ID = 'void.rejectFile'

export const VOID_ACCEPT_ALL_DIFFS_ACTION_ID = 'void.acceptAllDiffs'

export const VOID_REJECT_ALL_DIFFS_ACTION_ID = 'void.rejectAllDiffs'

export const VOID_OPENAI_CODEX_SIGN_IN_ACTION_ID = 'void.openAiCodexSignIn'

export const VOID_OPENAI_CODEX_SIGN_OUT_ACTION_ID = 'void.openAiCodexSignOut'

export const VOID_XAI_GROK_SIGN_IN_ACTION_ID = 'void.xAiGrokSignIn'

export const VOID_XAI_GROK_DEVICE_SIGN_IN_ACTION_ID = 'void.xAiGrokDeviceSignIn'

export const VOID_XAI_GROK_SIGN_OUT_ACTION_ID = 'void.xAiGrokSignOut'

export const VOID_GITHUB_SIGN_IN_ACTION_ID = 'void.githubSignIn'

export const VOID_GITHUB_SIGN_OUT_ACTION_ID = 'void.githubSignOut'

export const VOID_ORBIT_PROVIDER_SIGN_IN_ACTION_ID = 'void.orbitProviderSignIn'

export const VOID_ORBIT_PROVIDER_SIGN_OUT_ACTION_ID = 'void.orbitProviderSignOut'

export const VOID_REFRESH_ORBIT_PROVIDER_ACTION_ID = 'void.refreshOrbitProvider'

export const VOID_OPEN_ACCOUNT_SETTINGS_ACTION_ID = 'void.openAccountSettings'
