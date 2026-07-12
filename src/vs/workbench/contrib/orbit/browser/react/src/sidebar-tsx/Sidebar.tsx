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

export const Sidebar = ({ className }: { className: string }) => {

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
								<SidebarChat />
							</SubAgentPopupProvider>
						</ErrorBoundary>
					</div>
				</div>
			</ConnectedWindowProvider>
		</div>
	</div>


}
