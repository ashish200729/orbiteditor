/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, ChevronUp, MessageCircleQuestion } from 'lucide-react';
import { AskQuestionItem, AskQuestionUserAnswer } from '../../../../../../../common/chatThreadServiceTypes.js';
import { useAccessor } from '../../../../util/services.js';
import { TextShimmer } from '../../../../util/TextShimmer.js';
import { getTitle, getToolStatusIconMeta, toolNameToDesc } from '../../../constants/toolHelpers.js';
import { EditToolCardWrapper } from '../../editTool/EditToolCardWrapper.js';
import {
	ApprovalGhostButton,
	ApprovalPrimaryButton,
} from '../../toolApproval/ApprovalButton.js';
import {
	ASK_QUESTION_BACK_LABEL,
	ASK_QUESTION_CARD_TITLE,
	ASK_QUESTION_CONTINUE_LABEL,
	ASK_QUESTION_OTHER_LABEL,
	ASK_QUESTION_OTHER_PLACEHOLDER,
	ASK_QUESTION_SKIP_LABEL,
} from './askQuestionLabels.js';
import { AskQuestionCardProps, DraftAnswer, OTHER_OPTION_ID } from './askQuestionTypes.js';
import {
	AskQuestionBackButton,
	AskQuestionOptionRow,
	AskQuestionOtherInput,
	AskQuestionProgress,
	KbdHint,
	askQuestionTheme,
} from './askQuestionUi.js';

const letterFor = (i: number): string => (i >= 0 && i < 26 ? String.fromCharCode(65 + i) : '?');

export const AskQuestionCard = ({
	title,
	questions,
	toolId,
	isInteractive,
	isStreaming,
	onSubmit,
	onSkip,
}: AskQuestionCardProps) => {
	const accessor = useAccessor();
	const [isOpen, setIsOpen] = useState(true);
	const [activeIdx, setActiveIdx] = useState(0);
	const [drafts, setDrafts] = useState<Record<string, DraftAnswer>>(() => {
		const d: Record<string, DraftAnswer> = {};
		for (const q of questions) {
			d[q.id] = { selectedOptionIds: [], otherText: '' };
		}
		return d;
	});
	const [otherOpenForQ, setOtherOpenForQ] = useState<Record<string, boolean>>({});
	const [slideDirection, setSlideDirection] = useState<1 | -1>(1);

	const total = questions.length;
	const currentQ = questions[activeIdx];
	const canGoBack = activeIdx > 0;

	const syntheticToolMessage = useMemo(() => ({
		role: 'tool' as const,
		type: (isInteractive ? 'tool_request' : isStreaming ? 'running_now' : 'tool_request') as 'tool_request' | 'running_now',
		name: 'AskQuestion' as const,
		id: toolId,
		mcpServerName: undefined,
		rawParams: {},
		params: { title, questions },
		content: '',
		result: null,
	}), [isInteractive, isStreaming, toolId, title, questions]);

	const headerTitle = getTitle(syntheticToolMessage);
	const { desc1 } = toolNameToDesc('AskQuestion', { title, questions }, accessor);
	const statusIcon = getToolStatusIconMeta(syntheticToolMessage);

	const syncOtherInputForQuestion = useCallback((q: AskQuestionItem) => {
		const d = drafts[q.id];
		if (d?.selectedOptionIds.includes(OTHER_OPTION_ID)) {
			setOtherOpenForQ((o) => ({ ...o, [q.id]: true }));
		}
	}, [drafts]);

	const goToQuestion = useCallback((index: number) => {
		if (!isInteractive || index < 0 || index >= total || index === activeIdx) {
			return;
		}
		setSlideDirection(index < activeIdx ? -1 : 1);
		setActiveIdx(index);
		const q = questions[index];
		if (q) {
			syncOtherInputForQuestion(q);
		}
	}, [isInteractive, total, activeIdx, questions, syncOtherInputForQuestion]);

	const goBack = useCallback(() => {
		goToQuestion(activeIdx - 1);
	}, [goToQuestion, activeIdx]);

	const advanceOrSubmit = useCallback(() => {
		if (!isInteractive) {
			return;
		}
		if (activeIdx < total - 1) {
			setSlideDirection(1);
			const nextIdx = activeIdx + 1;
			setActiveIdx(nextIdx);
			const nextQ = questions[nextIdx];
			if (nextQ) {
				syncOtherInputForQuestion(nextQ);
			}
			return;
		}
		const answers: AskQuestionUserAnswer[] = questions.map((q) => {
			const d = drafts[q.id] ?? { selectedOptionIds: [], otherText: '' };
			const hasOther = d.selectedOptionIds.includes(OTHER_OPTION_ID);
			return {
				questionId: q.id,
				// Keep __other__ so normalizeAnswer can tie otherText to the Other selection
				selectedOptionIds: d.selectedOptionIds,
				otherText: hasOther ? d.otherText.trim() || undefined : undefined,
			};
		});
		onSubmit(answers);
	}, [activeIdx, total, questions, drafts, onSubmit, isInteractive, syncOtherInputForQuestion]);

	const toggleOption = useCallback((q: AskQuestionItem, optionId: string) => {
		if (!isInteractive) {
			return;
		}
		setDrafts((prev) => {
			const cur = prev[q.id] ?? { selectedOptionIds: [], otherText: '' };
			let next: string[];
			if (q.allow_multiple) {
				next = cur.selectedOptionIds.includes(optionId)
					? cur.selectedOptionIds.filter((x) => x !== optionId)
					: [...cur.selectedOptionIds, optionId];
			} else {
				next = cur.selectedOptionIds.includes(optionId) ? [] : [optionId];
			}
			if (optionId === OTHER_OPTION_ID && !cur.selectedOptionIds.includes(OTHER_OPTION_ID)) {
				setOtherOpenForQ((o) => ({ ...o, [q.id]: true }));
			}
			if (optionId !== OTHER_OPTION_ID) {
				setOtherOpenForQ((o) => ({ ...o, [q.id]: false }));
			}
			return { ...prev, [q.id]: { ...cur, selectedOptionIds: next } };
		});
	}, [isInteractive]);

	const handleCardKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (!isInteractive) {
			return;
		}
		const tag = (e.target as HTMLElement)?.tagName;
		const isTypingField = tag === 'INPUT' || tag === 'TEXTAREA';

		if (e.key === 'Enter' && !isTypingField) {
			e.preventDefault();
			e.stopPropagation();
			advanceOrSubmit();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			if (isTypingField) {
				setOtherOpenForQ((o) => ({ ...o, [currentQ.id]: false }));
				setDrafts((prev) => {
					const cur = prev[currentQ.id] ?? { selectedOptionIds: [], otherText: '' };
					return {
						...prev,
						[currentQ.id]: {
							...cur,
							selectedOptionIds: cur.selectedOptionIds.filter((id) => id !== OTHER_OPTION_ID),
						},
					};
				});
				(e.target as HTMLElement)?.blur();
				return;
			}
			onSkip();
		} else if (e.key === 'ArrowLeft' && !isTypingField && canGoBack) {
			e.preventDefault();
			e.stopPropagation();
			goBack();
		} else if (!isTypingField && e.key.length === 1) {
			const idx = e.key.toLowerCase().charCodeAt(0) - 97; // 'a' -> 0
			const optionCount = currentQ.options.length + 1;
			if (idx >= 0 && idx < 26 && idx < optionCount) {
				e.preventDefault();
				e.stopPropagation();
				if (idx < currentQ.options.length) {
					toggleOption(currentQ, currentQ.options[idx]!.id);
				} else {
					toggleOption(currentQ, OTHER_OPTION_ID);
				}
			}
		}
	}, [isInteractive, advanceOrSubmit, onSkip, goBack, canGoBack, currentQ, toggleOption]);

	const setOtherText = (q: AskQuestionItem, text: string) => {
		setDrafts((prev) => {
			const cur = prev[q.id] ?? { selectedOptionIds: [], otherText: '' };
			return { ...prev, [q.id]: { ...cur, otherText: text } };
		});
	};

	if (!currentQ) {
		return null;
	}

	const selected = drafts[currentQ.id]?.selectedOptionIds ?? [];
	const isOtherOpen = !!otherOpenForQ[currentQ.id] || selected.includes(OTHER_OPTION_ID);
	const displayTitle = typeof headerTitle === 'string' ? headerTitle : ASK_QUESTION_CARD_TITLE;
	const isLastStep = activeIdx >= total - 1;

	return (
		<motion.div
			className="w-full my-1"
			initial={{ opacity: 0, y: 6 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.22, ease: 'easeOut' }}
			onClick={(e) => e.stopPropagation()}
		>
			<EditToolCardWrapper isAwaitingApproval={isInteractive} isRunning={isStreaming}>
				{/* Header */}
				<button
					type="button"
					className="w-full flex items-center gap-2 px-3 py-2.5 text-left select-none transition-colors duration-150"
					style={{ color: askQuestionTheme.fg }}
					onClick={() => setIsOpen((v) => !v)}
					onMouseEnter={(e) => { e.currentTarget.style.background = askQuestionTheme.hoverBg; }}
					onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
				>
					{statusIcon?.icon ?? (
						<MessageCircleQuestion
							size={15}
							className="flex-shrink-0"
							strokeWidth={1.75}
							style={{ color: askQuestionTheme.descFg }}
						/>
					)}
					{isStreaming ? (
						<TextShimmer duration={2.2} spread={2} className="text-[12px] font-medium flex-shrink-0">
							{displayTitle}
						</TextShimmer>
					) : (
						<span className="text-[12px] font-medium flex-shrink-0" style={{ color: askQuestionTheme.fg }}>
							{displayTitle}
						</span>
					)}
					{desc1 && (
						<span
							className="text-[11px] truncate min-w-0 flex-1"
							style={{ color: askQuestionTheme.descFg }}
						>
							{desc1}
						</span>
					)}
					<span className="flex items-center gap-2 ml-auto flex-shrink-0">
						{isOpen && total > 1 && (
							<AskQuestionProgress
								activeIndex={activeIdx}
								total={total}
								isInteractive={isInteractive}
								onStepClick={(i) => goToQuestion(i)}
							/>
						)}
						{isOpen ? (
							<ChevronUp size={14} style={{ color: askQuestionTheme.descFg }} strokeWidth={2} />
						) : (
							<ChevronDown size={14} style={{ color: askQuestionTheme.descFg }} strokeWidth={2} />
						)}
					</span>
				</button>

				<AnimatePresence initial={false}>
					{isOpen && (
						<motion.div
							key="body"
							tabIndex={isInteractive ? 0 : undefined}
							onKeyDown={handleCardKeyDown}
							initial={{ height: 0, opacity: 0 }}
							animate={{ height: 'auto', opacity: 1 }}
							exit={{ height: 0, opacity: 0 }}
							transition={{ duration: 0.18, ease: 'easeOut' }}
							className="overflow-hidden outline-none"
							style={{ borderTop: `1px solid ${askQuestionTheme.subtleDivider}` }}
						>
							<div className="px-3 py-3 flex flex-col gap-3">
								<AnimatePresence mode="wait" initial={false}>
									<motion.div
										key={currentQ.id}
										initial={{ opacity: 0, x: slideDirection * 10 }}
										animate={{ opacity: 1, x: 0 }}
										exit={{ opacity: 0, x: slideDirection * -10 }}
										transition={{ duration: 0.16, ease: 'easeOut' }}
										className="flex flex-col gap-3"
									>
										<div className="flex gap-2.5 items-start">
											<span
												className="font-semibold text-[13px] flex-shrink-0 tabular-nums pt-px"
												style={{ color: askQuestionTheme.descFg }}
											>
												{activeIdx + 1}.
											</span>
											<div className="flex-1 min-w-0 flex flex-col gap-1">
												<p
													className="m-0 text-[13px] font-medium leading-snug"
													style={{ color: askQuestionTheme.fg }}
												>
													{currentQ.prompt}
												</p>
												{currentQ.allow_multiple && (
													<span
														className="text-[10px] uppercase tracking-wider self-start px-1.5 py-0.5 rounded"
														style={{
															color: askQuestionTheme.descFg,
															background: 'rgba(128, 128, 128, 0.1)',
														}}
													>
														Select multiple
													</span>
												)}
											</div>
										</div>

										<div className="flex flex-col gap-1 pl-1">
											{currentQ.options.map((opt, i) => (
												<AskQuestionOptionRow
													key={opt.id}
													letter={letterFor(i)}
													label={opt.label}
													isSelected={selected.includes(opt.id)}
													isInteractive={isInteractive}
													onClick={() => toggleOption(currentQ, opt.id)}
												/>
											))}
											<AskQuestionOptionRow
												letter={letterFor(currentQ.options.length)}
												label={ASK_QUESTION_OTHER_LABEL}
												isSelected={selected.includes(OTHER_OPTION_ID)}
												isInteractive={isInteractive}
												isOther
												onClick={() => toggleOption(currentQ, OTHER_OPTION_ID)}
											/>
											{isOtherOpen && (
												<motion.div
													initial={{ opacity: 0, height: 0 }}
													animate={{ opacity: 1, height: 'auto' }}
													transition={{ duration: 0.15 }}
												>
													<AskQuestionOtherInput
														value={drafts[currentQ.id]?.otherText ?? ''}
														disabled={!isInteractive}
														placeholder={ASK_QUESTION_OTHER_PLACEHOLDER}
														onChange={(text) => setOtherText(currentQ, text)}
														onEnter={advanceOrSubmit}
														onBack={canGoBack ? goBack : undefined}
													/>
												</motion.div>
											)}
										</div>
									</motion.div>
								</AnimatePresence>

					<div
						className="flex items-center justify-end gap-2 pt-1 min-h-[30px]"
						style={{ borderTop: `1px solid ${askQuestionTheme.subtleDivider}` }}
					>
						<ApprovalGhostButton
							disabled={!isInteractive}
							onClick={onSkip}
							ariaLabel="Skip question"
						>
							{ASK_QUESTION_SKIP_LABEL}
							<KbdHint>Esc</KbdHint>
						</ApprovalGhostButton>
						<div className="flex items-center gap-2 flex-shrink-0">
							{canGoBack && (
								<AskQuestionBackButton
									disabled={!isInteractive}
									onClick={goBack}
									label={ASK_QUESTION_BACK_LABEL}
								/>
							)}
							<ApprovalPrimaryButton
								disabled={!isInteractive}
								onClick={advanceOrSubmit}
								ariaLabel={isLastStep ? 'Continue' : 'Next question'}
								showEnterHint
							>
								{isLastStep ? ASK_QUESTION_CONTINUE_LABEL : 'Next'}
							</ApprovalPrimaryButton>
						</div>
					</div>
							</div>
						</motion.div>
					)}
				</AnimatePresence>
			</EditToolCardWrapper>
		</motion.div>
	);
};