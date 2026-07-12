/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Window/document resolution for the standalone Agents pop-out (VS Code auxiliary window).
 *
 * React nodes portaled into the aux window are created via the main document's
 * `createElement` (to preserve `instanceof HTMLElement`), so `ownerDocument` points at
 * the main renderer even though `getRootNode()` follows the connected aux document.
 */

/** Resolve the document a node is connected to. */
export const getConnectedDocument = (node: Node | null | undefined): Document => {
	if (node) {
		const root = node.getRootNode();
		if (root.nodeType === 9 && 'defaultView' in root) {
			return root as Document;
		}
	}
	return globalThis.document;
};

/** Resolve the window a node is connected to. */
export const getConnectedWindow = (node: Node | null | undefined): Window => {
	return getConnectedDocument(node).defaultView ?? globalThis.window;
};

/**
 * Find the thread composer textarea painted in `targetWindow`. Composers are always
 * CREATED via the main renderer document's `createElement` (so `ownerDocument` says
 * main), but may be CONNECTED (portaled) into the Agents pop-out's own document tree.
 * `ownerDocument` doesn't affect `querySelectorAll` targeting — only tree connection
 * does — so querying `globalThis.document` can never find a composer that's actually
 * connected in the aux window's tree. Query the target window's own document instead.
 */
export const findThreadComposerInWindow = (targetWindow: Window): HTMLTextAreaElement | undefined => {
	return targetWindow.document.querySelector<HTMLTextAreaElement>('textarea[data-orbit-thread-composer="true"]') ?? undefined;
};

/** Focus an element while keeping OS window focus on the window it is painted in. */
export const focusInConnectedWindow = (
	el: { focus: () => void; getRootNode: () => Node; ownerDocument: Document } | null | undefined,
): void => {
	if (!el) {
		return;
	}
	const root = el.getRootNode();
	if (root.nodeType === 9 && 'defaultView' in root) {
		const connectedWindow = (root as Document).defaultView;
		// Raise the painted window before focusing — portaled nodes have a main-window
		// ownerDocument, so el.focus() alone would pull focus back to the IDE.
		connectedWindow?.focus();
		el.focus();
		connectedWindow?.requestAnimationFrame(() => connectedWindow.focus());
		return;
	}
	el.focus();
};
