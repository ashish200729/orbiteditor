/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Vexelity Ai, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useRef } from 'react';
import { Check } from 'lucide-react';
import type { SlashMenu, SlashRenderRow } from './useSlashMenu.js';
import { VOID_SLASH_MENU } from './cssClasses.js';

type FlatRow = { row: SlashRenderRow; globalIdx: number; sectionTitle?: string; isFirstInSection: boolean };

export const SlashMenuPopup = ({ slash }: { slash: SlashMenu }) => {
	const { floating, sections, activeIdx, selectAt, setActiveIdx } = slash;
	const activeRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		activeRef.current?.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
	}, [activeIdx, sections]);

	const flat: FlatRow[] = [];
	let counter = 0;
	for (const section of sections) {
		section.rows.forEach((row, i) => {
			flat.push({ row, globalIdx: counter, sectionTitle: section.title, isFirstInSection: i === 0 });
			counter++;
		});
	}

	const totalSelectable = counter;

	return (
		<div
			ref={floating.refs.setFloating}
			className={`${VOID_SLASH_MENU} z-[100] flex flex-col overflow-hidden rounded-lg border border-void-border-2 bg-void-bg-1 shadow-lg shadow-black/30`}
			style={{
				position: floating.strategy,
				top: floating.y ?? 0,
				left: floating.x ?? 0,
				width: floating.menuWidth,
			}}
			onWheel={(e) => e.stopPropagation()}
			onMouseDown={(e) => e.preventDefault()}
		>
			<div className="max-h-[min(260px,40vh)] w-full overflow-y-auto overflow-x-hidden py-0.5">
				{totalSelectable === 0 ? (
					<div className="px-2.5 py-2 text-xs text-void-fg-3">No matches</div>
				) : (
					flat.map(({ row, globalIdx, sectionTitle, isFirstInSection }) => {
						const isActive = globalIdx === activeIdx;
						return (
							<React.Fragment key={row.kind === 'item' ? row.item.id : `showmore:${row.categoryId}`}>
								{isFirstInSection && sectionTitle && (
									<div className="px-2.5 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-void-fg-4 select-none">
										{sectionTitle}
									</div>
								)}
								{row.kind === 'showmore' ? (
									<div
										ref={isActive ? activeRef : null}
										className={`mx-1 rounded px-2 py-1 text-[11px] cursor-pointer select-none ${isActive ? 'bg-[var(--void-dropdown-active-bg)] text-void-fg-2' : 'text-void-fg-4 hover:bg-[var(--void-dropdown-hover-bg)]'}`}
										onMouseMove={() => setActiveIdx(globalIdx)}
										onClick={() => selectAt(globalIdx)}
									>
										Show {row.hiddenCount} more
									</div>
								) : (
									<div
										ref={isActive ? activeRef : null}
										className={`mx-1 flex min-w-0 cursor-pointer items-center gap-1.5 rounded px-2 py-1 ${isActive ? 'bg-[var(--void-dropdown-active-bg)] text-void-fg-1' : 'bg-transparent text-void-fg-1 hover:bg-[var(--void-dropdown-hover-bg)]'}`}
										onMouseMove={() => setActiveIdx(globalIdx)}
										onClick={() => selectAt(globalIdx)}
										title={row.item.detail || row.item.name}
									>
										<div className="flex-shrink-0 text-void-fg-3">
											<row.item.icon size={13} />
										</div>
										<span className="min-w-0 flex-shrink-0 truncate text-[13px] leading-tight">{row.item.name}</span>
										{row.item.detail && (
											<span className="min-w-0 flex-shrink truncate text-[11px] leading-tight text-void-fg-4">{row.item.detail}</span>
										)}
										{row.item.isActive && (
											<Check size={12} className="ml-auto flex-shrink-0 text-void-fg-3" aria-hidden />
										)}
									</div>
								)}
							</React.Fragment>
						);
					})
				)}
			</div>
		</div>
	);
};
