/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

/**
 * VS Code–aligned design tokens for the tool approval consent card.
 * Modeled on `askQuestionTheme` so the two consent surfaces share a visual
 * language. Every value resolves to a VS Code CSS variable so the card
 * adapts to light/dark themes automatically.
 */
export const toolApprovalTheme = {
	// surfaces
	panelBg: 'var(--vscode-editor-background)',
	panelBorder: 'rgba(var(--vscode-void-border-3-rgb, 64, 64, 64), 0.3)',
	panelBorderActive: 'rgba(var(--vscode-void-border-2-rgb, 96, 96, 96), 0.5)',
	hoverBg: 'var(--vscode-list-hoverBackground)',
	toolbarHover: 'var(--vscode-toolbar-hoverBackground)',

	// text
	fg: 'var(--vscode-foreground)',
	descFg: 'var(--vscode-descriptionForeground)',

	// buttons
	buttonBg: 'var(--vscode-button-background)',
	buttonFg: 'var(--vscode-button-foreground)',
	buttonHover: 'var(--vscode-button-hoverBackground)',
	buttonSecondaryBg: 'var(--vscode-button-secondaryBackground)',
	buttonSecondaryFg: 'var(--vscode-button-secondaryForeground)',
	buttonSecondaryHover: 'var(--vscode-button-secondaryHoverBackground)',

	// compact approval buttons (premium multi-tone treatment)
	// ghost = borderless text button (Skip/Back); pill = tinted secondary (Always Run);
	// primary = solid accent pill with depth (Run/Approve).
	//
	// The plain secondary surface reads as flat / "one color" against the card
	// background in most dark themes, so we tint the pill toward the accent and
	// give the primary a subtle elevation shadow. `color-mix` is already used
	// elsewhere in this codebase (BrowserOpenApprovalPreview, ShellToolCard) and
	// resolves against real theme vars at runtime — light/dark adapt for free.
	ghostHoverBg: 'var(--vscode-toolbar-hoverBackground)',
	ghostHoverFg: 'var(--vscode-foreground)',
	// Pill surface: blend secondary bg with a touch of accent for a tonal,
	// distinct-from-the-card look; deepen slightly on hover.
	pillBg: 'color-mix(in srgb, var(--vscode-button-secondaryBackground, #3a3d41) 88%, var(--vscode-button-background, #0e639c) 12%)',
	pillBgHover: 'color-mix(in srgb, var(--vscode-button-secondaryHoverBackground, #4a4d51) 82%, var(--vscode-button-background, #0e639c) 18%)',
	pillFg: 'var(--vscode-button-secondaryForeground)',
	pillBorder: 'color-mix(in srgb, var(--vscode-button-background, #0e639c) 10%, rgba(var(--vscode-void-border-3-rgb, 64, 64, 64), 0.32))',
	pillBorderHover: 'color-mix(in srgb, var(--vscode-button-background, #0e639c) 35%, var(--vscode-button-secondaryBackground, #3a3d41) 65%)',
	// Primary depth: faint inner highlight + soft drop shadow so the accent
	// reads as elevated rather than a flat color swatch.
	primaryShadow: '0 1px 0 0 color-mix(in srgb, var(--vscode-button-foreground, #ffffff) 14%, transparent), 0 1px 2px 0 rgba(0, 0, 0, 0.18)',
	primaryShadowHover: '0 1px 0 0 color-mix(in srgb, var(--vscode-button-foreground, #ffffff) 20%, transparent), 0 2px 5px 0 rgba(0, 0, 0, 0.24)',
	// dimmed glyph/kbd hint on the primary Run/Approve pill
	kbdFg: 'var(--vscode-button-foreground)',

	// focus / selection
	focusBorder: 'var(--vscode-focusBorder)',
	focusRingHalo: 'color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 22%, transparent)',
	selectedBg: 'var(--vscode-list-activeSelectionBackground)',
	selectedFg: 'var(--vscode-list-activeSelectionForeground)',

	// terminal preview block
	terminalBg: 'rgba(var(--vscode-void-bg-2-rgb, 16, 16, 16), 0.4)',
	terminalBorder: 'rgba(var(--vscode-void-border-3-rgb, 64, 64, 64), 0.2)',

	// dividers
	subtleDivider: 'rgba(var(--vscode-void-border-3-rgb, 64, 64, 64), 0.2)',
} as const;