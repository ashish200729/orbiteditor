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
	const probeNodeRef = React.useRef<HTMLElement | null>(null);

	const probeRef = React.useCallback((node: HTMLElement | null) => {
		probeNodeRef.current = node;
		if (!node) {
			return;
		}
		const resolved = getConnectedDocument(node);
		setDoc(prev => (prev === resolved ? prev : resolved));
	}, []);

	// When this subtree is portaled into the Agents auxiliary window, the first
	// paint can report 0×0 until the shell receives an explicit size. Nudge the
	// connected window once real dimensions arrive so flex children can measure.
	React.useLayoutEffect(() => {
		const node = probeNodeRef.current;
		if (!node) {
			return;
		}
		const win = getConnectedDocument(node).defaultView;
		if (!win || win === globalThis.window) {
			return;
		}

		const nudge = () => {
			try {
				win.dispatchEvent(new Event('resize'));
			} catch {
				// ignore
			}
		};

		const parent = node.parentElement;
		if (parent) {
			const rect = parent.getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0) {
				nudge();
			}
		}

		if (typeof ResizeObserver === 'undefined' || !parent) {
			return;
		}

		let sawNonZero = false;
		const ro = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const { width, height } = entry.contentRect;
				if (width > 0 && height > 0 && !sawNonZero) {
					sawNonZero = true;
					nudge();
				}
			}
		});
		ro.observe(parent);
		return () => ro.disconnect();
	}, [doc]);

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
