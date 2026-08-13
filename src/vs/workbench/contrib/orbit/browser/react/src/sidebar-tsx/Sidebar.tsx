/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { useIsDark, useThemeSettingsId } from '../util/services.js';
// import { SidebarThreadSelector } from './SidebarThreadSelector.js';
// import { SidebarChat } from './SidebarChat.js';

import '../styles.css'
import { SidebarChat } from './SidebarChat.js';
import ErrorBoundary from './ErrorBoundary.js';
import { SubAgentPopupProvider } from './contexts/SubAgentPopupContext.js';
import { ConnectedWindowProvider } from './contexts/ConnectedWindowContext.js';
import type { TextQuoteAttachment } from '../../../../common/chatThreadServiceTypes.js';
import type { ChatComposerSurface } from './SidebarChat.js';

export const Sidebar = ({ className, isAgentWindow = false, explicitThreadId, chatSurface, initialTextQuotes, initialDraftText, initialImages, onFirstSubmit, onTextQuotesChange, onDraftTextChange, onImagesChange, onSessionDirtyChange }: {
	className: string;
	isAgentWindow?: boolean;
	explicitThreadId?: string;
	chatSurface?: ChatComposerSurface;
	initialTextQuotes?: TextQuoteAttachment[];
	initialDraftText?: string;
	initialImages?: string[];
	onFirstSubmit?: (title: string) => void;
	onTextQuotesChange?: (quotes: readonly TextQuoteAttachment[]) => void;
	onDraftTextChange?: (text: string) => void;
	onImagesChange?: (images: readonly string[]) => void;
	onSessionDirtyChange?: (dirty: boolean) => void;
}) => {

	const isDark = useIsDark()
	const themeSettingsId = useThemeSettingsId()
	const isOrbitDarkTheme = /orbit dark/i.test(themeSettingsId)

	return <div
		className={`@@void-scope ${isDark ? 'dark' : ''} ${isOrbitDarkTheme ? 'void-theme-orbit-dark' : ''}`}
		style={{ width: '100%', height: '100%' }}
	>
		<div
			// default background + text styles for sidebar
			className={`
				w-full h-full
				bg-[var(--void-sidebar-shell-bg)]
				text-void-fg-1
			`}
		>

			<ConnectedWindowProvider>
				<div className={`w-full h-full flex flex-col`}>
					<div className="flex-1 min-h-0">
						<ErrorBoundary>
							<SubAgentPopupProvider>
								<SidebarChat isAgentWindow={isAgentWindow} explicitThreadId={explicitThreadId} chatSurface={chatSurface} initialTextQuotes={initialTextQuotes} initialDraftText={initialDraftText} initialImages={initialImages} onFirstSubmit={onFirstSubmit} onTextQuotesChange={onTextQuotesChange} onDraftTextChange={onDraftTextChange} onImagesChange={onImagesChange} onSessionDirtyChange={onSessionDirtyChange} />
							</SubAgentPopupProvider>
						</ErrorBoundary>
					</div>
				</div>
			</ConnectedWindowProvider>
		</div>
	</div>


}
