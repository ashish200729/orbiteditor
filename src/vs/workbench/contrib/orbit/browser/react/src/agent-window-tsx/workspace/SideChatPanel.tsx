/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------*/

import * as React from 'react';
import { Sidebar } from '../../sidebar-tsx/Sidebar.js';
import { WorkspacePanelProps } from './workspaceTypes.js';
import { useAccessor } from '../../util/services.js';
import type { TextQuoteAttachment } from '../../../../../common/chatThreadServiceTypes.js';
import { useConnectedDocument } from '../../sidebar-tsx/contexts/ConnectedWindowContext.js';

export interface SideChatSessionSnapshot {
	draftText: string;
	images: string[];
	textQuotes: TextQuoteAttachment[];
}

export const SideChatPanel = ({ tab, isActive, setTitle, initialSession, onSessionChange }: WorkspacePanelProps & {
	initialSession?: SideChatSessionSnapshot;
	onSessionChange: (patch: Partial<SideChatSessionSnapshot>) => void;
}) => {
	const accessor = useAccessor();
	const doc = useConnectedDocument();
	const threadId = tab.threadId;

	React.useEffect(() => {
		if (!isActive || !threadId) return;
		const frame = doc.defaultView?.requestAnimationFrame(() => {
			const textarea = doc.querySelector<HTMLTextAreaElement>(`textarea[data-orbit-thread-id="${CSS.escape(threadId)}"]`);
			textarea?.focus();
		});
		return () => { if (frame !== undefined) doc.defaultView?.cancelAnimationFrame(frame); };
	}, [doc, isActive, threadId]);

	if (!threadId) return null;
	return <div className='agent-side-chat-panel'>
		<div className='agent-side-chat-content'>
			<Sidebar
				className='h-full'
				isAgentWindow
				explicitThreadId={threadId}
				chatSurface='agent-side'
				initialTextQuotes={initialSession?.textQuotes ?? tab.initialQuotes}
				initialDraftText={initialSession?.draftText}
				initialImages={initialSession?.images}
				onFirstSubmit={setTitle}
				onTextQuotesChange={(textQuotes) => onSessionChange({ textQuotes: textQuotes.map(quote => ({ ...quote })) })}
				onDraftTextChange={(draftText) => onSessionChange({ draftText })}
				onImagesChange={(images) => onSessionChange({ images: [...images] })}
				onSessionDirtyChange={(dirty) => accessor.get('IAgentWindowService').setSideChatDirty(threadId, dirty)}
			/>
		</div>
		<footer className='agent-side-chat-footer'>Side Chat</footer>
	</div>;
};
