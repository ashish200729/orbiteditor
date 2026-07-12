/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as React from 'react';
import { getConnectedDocument } from '../../util/connectedWindow.js';

// Re-export the pure resolvers so components can import them alongside the hooks/provider.
export { getConnectedDocument, getConnectedWindow } from '../../util/connectedWindow.js';

/**
 * The Sidebar/ChatHistory React UI is reused inside the standalone Agents pop-out (a VS Code
 * auxiliary window) by portaling it into that window's panes. To keep `instanceof HTMLElement`
 * valid, the aux window's `createElement` is delegated to the MAIN document, so every React node
 * reports `ownerDocument === mainWindow.document` even though it is physically connected to — and
 * painted in — the pop-out. As a result, anything that reaches for the global `window`/`document`
 * or for `ownerDocument` targets the WRONG window (the main IDE), breaking portals, popups, global
 * listeners and viewport measurement inside the pop-out.
 *
 * This context exposes the document the subtree is actually CONNECTED to (resolved via
 * `node.getRootNode()`, which follows the connected tree rather than the delegated ownerDocument).
 * In the main window this resolves to the main document, so consumers are unchanged there.
 */
const ConnectedDocumentContext = React.createContext<Document | null>(null);

/**
 * Provides the connected document to descendants. Renders a hidden probe element whose
 * `getRootNode()` is read once mounted; until then descendants fall back to the main document.
 */
export const ConnectedWindowProvider = ({ children }: { children: React.ReactNode }) => {
	const [doc, setDoc] = React.useState<Document>(() => globalThis.document);

	const probeRef = React.useCallback((node: HTMLElement | null) => {
		if (!node) {
			return;
		}
		const resolved = getConnectedDocument(node);
		setDoc(prev => (prev === resolved ? prev : resolved));
	}, []);

	return (
		<ConnectedDocumentContext.Provider value={doc}>
			<span ref={probeRef} aria-hidden style={{ display: 'none' }} />
			{children}
		</ConnectedDocumentContext.Provider>
	);
};

/** The document the current subtree is painted in (pop-out aux document, or the main document). */
export const useConnectedDocument = (): Document => {
	return React.useContext(ConnectedDocumentContext) ?? globalThis.document;
};

/** The window the current subtree is painted in. */
export const useConnectedWindow = (): Window => {
	const doc = useConnectedDocument();
	return doc.defaultView ?? globalThis.window;
};
