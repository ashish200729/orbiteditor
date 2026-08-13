/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquarePlus, PanelRightOpen } from 'lucide-react';
import { TextQuoteAttachment, TextQuoteSourceKind } from '../../../../../../common/chatThreadServiceTypes.js';
import { normalizeSelectedQuoteText } from '../../../../../../common/textQuoteAttachments.js';
import { useConnectedDocument } from '../../contexts/ConnectedWindowContext.js';

type SelectionState = {
	text: string;
	sourceKind: TextQuoteSourceKind;
	messageIdx?: number;
	anchorX: number;
	rangeTop: number;
	rangeBottom: number;
};

type ToolbarPosition = { left: number; top: number };

const VIEWPORT_MARGIN = 8;
const SELECTION_GAP = 8;

// Avoid `instanceof Element`: chat can live in an auxiliary window with a
// different DOM realm, where cross-window instanceof checks are unreliable.
const elementOfNode = (node: Node | null): Element | null => node?.nodeType === 1 ? node as Element : node?.parentElement ?? null;
const keycaps = (doc: Document) => /Mac|iPhone|iPad/.test(doc.defaultView?.navigator.platform ?? '')
	? { chat: '⌘L', side: '⇧⌘S' }
	: { chat: 'Ctrl+L', side: 'Ctrl+Shift+S' };

export const ChatSelectionToolbar = ({ threadId, onAddToChat, onAddToSideChat }: {
	threadId: string;
	onAddToChat: (quote: TextQuoteAttachment) => void;
	onAddToSideChat?: (quote: TextQuoteAttachment) => void;
}) => {
	const doc = useConnectedDocument();
	const toolbarRef = useRef<HTMLDivElement | null>(null);
	const [selectionState, setSelectionState] = useState<SelectionState | null>(null);
	const [toolbarPosition, setToolbarPosition] = useState<ToolbarPosition | null>(null);

	const dismiss = useCallback(() => {
		setSelectionState(null);
		setToolbarPosition(null);
	}, []);
	const refresh = useCallback(() => {
		const selection = doc.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return dismiss();
		const anchor = elementOfNode(selection.anchorNode)?.closest<HTMLElement>('[data-orbit-chat-selectable]');
		const focus = elementOfNode(selection.focusNode)?.closest<HTMLElement>('[data-orbit-chat-selectable]');
		if (!anchor || anchor !== focus || anchor.dataset.orbitThreadId !== threadId) return dismiss();
		const text = normalizeSelectedQuoteText(selection.toString());
		if (!text) return dismiss();
		const rangeRect = selection.getRangeAt(0).getBoundingClientRect();
		const sourceKind = anchor.dataset.orbitQuoteSource as TextQuoteSourceKind | undefined;
		if (!sourceKind) return dismiss();
		setToolbarPosition(null);
		setSelectionState({
			text,
			sourceKind,
			messageIdx: Number.isFinite(Number(anchor.dataset.orbitMessageIdx)) ? Number(anchor.dataset.orbitMessageIdx) : undefined,
			anchorX: rangeRect.left + rangeRect.width / 2,
			rangeTop: rangeRect.top,
			rangeBottom: rangeRect.bottom,
		});
	}, [dismiss, doc, threadId]);

	useLayoutEffect(() => {
		if (!selectionState || !toolbarRef.current) return;
		const toolbarRect = toolbarRef.current.getBoundingClientRect();
		const viewportWidth = doc.documentElement.clientWidth;
		const viewportHeight = doc.documentElement.clientHeight;
		const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - toolbarRect.width - VIEWPORT_MARGIN);
		const left = Math.max(VIEWPORT_MARGIN, Math.min(selectionState.anchorX - toolbarRect.width / 2, maxLeft));
		const hasRoomAbove = selectionState.rangeTop >= toolbarRect.height + VIEWPORT_MARGIN + SELECTION_GAP;
		const preferredTop = hasRoomAbove
			? selectionState.rangeTop - toolbarRect.height - SELECTION_GAP
			: selectionState.rangeBottom + SELECTION_GAP;
		const maxTop = Math.max(VIEWPORT_MARGIN, viewportHeight - toolbarRect.height - VIEWPORT_MARGIN);
		const top = Math.max(VIEWPORT_MARGIN, Math.min(preferredTop, maxTop));
		setToolbarPosition({ left, top });
	}, [doc, selectionState]);

	const makeQuote = useCallback((): TextQuoteAttachment | null => selectionState ? {
		id: globalThis.crypto?.randomUUID?.() ?? `quote-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		text: selectionState.text,
		sourceKind: selectionState.sourceKind,
		sourceThreadId: threadId,
		sourceMessageIdx: selectionState.messageIdx,
	} : null, [selectionState, threadId]);

	const act = useCallback((side: boolean) => {
		const quote = makeQuote();
		if (!quote) return;
		if (side) {
			if (!onAddToSideChat) return;
			onAddToSideChat(quote);
		} else {
			onAddToChat(quote);
		}
		doc.getSelection()?.removeAllRanges();
		dismiss();
	}, [dismiss, doc, makeQuote, onAddToChat, onAddToSideChat]);

	useEffect(() => {
		const connectedWindow = doc.defaultView;
		const onPointerUp = () => doc.defaultView?.requestAnimationFrame(refresh);
		const onKeyUp = (event: globalThis.KeyboardEvent) => {
			if (event.key === 'Escape') dismiss();
			else doc.defaultView?.requestAnimationFrame(refresh);
		};
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (!selectionState) return;
			if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'l') {
				event.preventDefault(); event.stopImmediatePropagation(); act(false);
			} else if (onAddToSideChat && (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 's') {
				event.preventDefault(); event.stopImmediatePropagation(); act(true);
			}
		};
		doc.addEventListener('pointerup', onPointerUp, true);
		doc.addEventListener('keyup', onKeyUp, true);
		doc.addEventListener('keydown', onKeyDown, true);
		doc.addEventListener('scroll', dismiss, true);
		connectedWindow?.addEventListener('resize', dismiss);
		return () => {
			doc.removeEventListener('pointerup', onPointerUp, true);
			doc.removeEventListener('keyup', onKeyUp, true);
			doc.removeEventListener('keydown', onKeyDown, true);
			doc.removeEventListener('scroll', dismiss, true);
			connectedWindow?.removeEventListener('resize', dismiss);
		};
	}, [act, dismiss, doc, refresh, selectionState]);

	if (!selectionState || !doc.body) return null;
	const labels = keycaps(doc);
	return createPortal(
		<div
			ref={toolbarRef}
			className='@@orbit-selection-toolbar'
			style={{ left: toolbarPosition?.left ?? 0, top: toolbarPosition?.top ?? 0, visibility: toolbarPosition ? 'visible' : 'hidden' }}
			role='toolbar'
			aria-label='Selected chat text actions'
			onPointerDown={event => event.preventDefault()}
		>
			<button type='button' onClick={() => act(false)}>
				<MessageSquarePlus size={14} strokeWidth={1.8} aria-hidden='true' />
				<span>Add to Chat</span>
				<kbd>{labels.chat}</kbd>
			</button>
			{onAddToSideChat && <>
				<button type='button' onClick={() => act(true)}>
					<PanelRightOpen size={14} strokeWidth={1.8} aria-hidden='true' />
					<span>Add to Side Chat</span>
					<kbd>{labels.side}</kbd>
				</button>
			</>}
		</div>,
		doc.body,
	);
};
