/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { Check, MessageCircleQuestion, Minus } from 'lucide-react';
import { AskQuestionItem, AskQuestionUserAnswer } from '../../../../../../../common/chatThreadServiceTypes.js';
import { EditToolCardWrapper } from '../../editTool/EditToolCardWrapper.js';
import { ASK_QUESTION_ANSWERS_HEADING } from './askQuestionLabels.js';
import { askQuestionTheme } from './askQuestionUi.js';

export const AskQuestionAnswersSummary = ({
	title,
	questions,
	answers,
	wasSkipped,
}: {
	title: string | null;
	questions: AskQuestionItem[];
	answers: AskQuestionUserAnswer[];
	wasSkipped: boolean;
}) => {
	return (
		<div className="orbit-card-enter w-full my-1">
			<EditToolCardWrapper>
				<div
					className="flex items-center gap-2 px-3 py-2.5"
					style={{ borderBottom: `1px solid ${askQuestionTheme.subtleDivider}` }}
				>
					<MessageCircleQuestion
						size={15}
						className="flex-shrink-0"
						strokeWidth={1.75}
						style={{ color: askQuestionTheme.descFg }}
					/>
					<span className="text-[12px] font-medium" style={{ color: askQuestionTheme.fg }}>
						{ASK_QUESTION_ANSWERS_HEADING}
					</span>
					{title && (
						<span
							className="text-[11px] truncate min-w-0 flex-1"
							style={{ color: askQuestionTheme.descFg }}
						>
							{title}
						</span>
					)}
				</div>

				<div className="px-3 py-2.5 flex flex-col gap-2.5">
					{wasSkipped ? (
						<p className="m-0 text-[12px]" style={{ color: askQuestionTheme.descFg }}>
							Skipped{title ? ` — ${title}` : ''}.
						</p>
					) : (
						questions.map((q) => {
							const a = answers.find((x) => x.questionId === q.id);
							const labels = (a?.selectedOptionIds ?? [])
								.map((id) => q.options.find((o) => o.id === id)?.label)
								.filter(Boolean) as string[];
							const hasAnswer = labels.length > 0 || !!a?.otherText;
							const Icon = hasAnswer ? Check : Minus;
							const iconColor = hasAnswer
								? 'var(--vscode-testing-iconPassed, #89d185)'
								: askQuestionTheme.descFg;

							return (
								<div key={q.id} className="flex gap-2 min-w-0">
									<Icon
										size={14}
										className="flex-shrink-0 mt-0.5"
										strokeWidth={2.5}
										style={{ color: iconColor, opacity: hasAnswer ? 1 : 0.5 }}
									/>
									<div className="flex flex-col gap-0.5 min-w-0 flex-1">
										<span
											className="text-[12px] leading-snug"
											style={{ color: askQuestionTheme.descFg }}
										>
											{q.prompt}
										</span>
										{labels.length > 0 ? (
											<span
												className="text-[12.5px] font-medium leading-snug"
												style={{ color: askQuestionTheme.fg }}
											>
												{labels.join(', ')}
											</span>
										) : (
											<span
												className="text-[12px] italic"
												style={{ color: askQuestionTheme.descFg, opacity: 0.75 }}
											>
												Skipped
											</span>
										)}
										{a?.otherText && (
											<span
												className="text-[11.5px] leading-snug pl-0.5"
												style={{ color: askQuestionTheme.descFg }}
											>
												{a.otherText}
											</span>
										)}
									</div>
								</div>
							);
						})
					)}
				</div>
			</EditToolCardWrapper>
		</div>
	);
};