/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';

export const SmallProseWrapper = ({ children }: { children: React.ReactNode }) => {
	return <div className='
text-void-fg-4
prose
prose-sm
break-words
max-w-none
leading-relaxed
text-[13px]

[&>:first-child]:!mt-0
[&>:last-child]:!mb-0

prose-h1:text-[14px]
prose-h1:my-2.5
prose-h1:leading-tight
prose-h1:text-void-fg-2
prose-h1:font-semibold

prose-h2:text-[13px]
prose-h2:my-2.5
prose-h2:leading-tight
prose-h2:text-void-fg-2
prose-h2:font-semibold

prose-h3:text-[13px]
prose-h3:my-2
prose-h3:leading-tight
prose-h3:text-void-fg-2
prose-h3:font-medium

prose-h4:text-[12px]
prose-h4:my-2
prose-h4:leading-tight
prose-h4:text-void-fg-4
prose-h4:font-medium

prose-p:my-1.5
prose-p:leading-[1.5]
prose-hr:my-2.5
prose-hr:border-void-border-3/20

prose-ul:my-2
prose-ul:pl-4
prose-ul:list-outside
prose-ul:list-disc
prose-ul:leading-[1.5]

prose-ol:my-2
prose-ol:pl-4
prose-ol:list-outside
prose-ol:list-decimal
prose-ol:leading-[1.5]

prose-li:my-0.5

marker:text-inherit

prose-blockquote:pl-3
prose-blockquote:my-2
prose-blockquote:border-l-2
prose-blockquote:border-l-void-border-3/30
prose-blockquote:italic
prose-blockquote:text-void-fg-4

prose-code:text-void-fg-2
prose-code:text-[11px]
prose-code:bg-void-bg-2-alt/40
prose-code:px-1
prose-code:py-0.5
prose-code:rounded
prose-code:before:content-none
prose-code:after:content-none
prose-code:font-medium

[&_.orbit-file-link]:!cursor-pointer

prose-a:text-[var(--vscode-textLink-foreground,var(--void-link-color))]
prose-a:underline
prose-a:decoration-[color-mix(in_srgb,var(--vscode-textLink-foreground,#3794ff)_35%,transparent)]
prose-a:underline-offset-2
prose-a:cursor-pointer
hover:prose-a:decoration-[var(--vscode-textLink-foreground,var(--void-link-color))]

prose-pre:text-[11px]
prose-pre:p-2
prose-pre:my-2
prose-pre:bg-void-bg-2-alt/50
prose-pre:border
prose-pre:border-void-border-3/20
prose-pre:rounded-lg

prose-table:text-[12px]
prose-table:my-2

prose-strong:font-semibold
prose-strong:text-void-fg-2

overflow-hidden
'>
		{children}
	</div>
}
