/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import React, { useMemo } from 'react';
import { URI } from '../../../../../../../../base/common/uri.js';
import { FileKind } from '../../../../../../../../platform/files/common/files.js';
import { getIconClasses } from '../../../../../../../../editor/common/services/getIconClasses.js';
import { useAccessor } from '../../util/services.js';
import { pathStringToUri } from './fileUtils.js';

const toFileResource = (filename?: string, uri?: URI): URI | undefined => {
	if (uri) {
		return uri;
	}
	if (!filename) {
		return undefined;
	}

	const pathLike = filename.includes('/') ? filename : `/${filename}`;
	try {
		return pathStringToUri(pathLike);
	} catch {
		return URI.file(pathLike);
	}
};

/**
 * Renders the same file-type icon used in the VS Code explorer (Seti / file icon theme).
 */
export const VsCodeFileIcon = ({
	filename,
	uri,
	size = 14,
	className = '',
	isFolder = false,
}: {
	filename?: string;
	uri?: URI;
	size?: number;
	className?: string;
	/** When true, render the folder icon from the active file icon theme. */
	isFolder?: boolean;
}) => {
	const accessor = useAccessor();
	const modelService = accessor.get('IModelService');
	const languageService = accessor.get('ILanguageService');

	const resource = useMemo(() => toFileResource(filename, uri), [filename, uri]);

	const iconClasses = useMemo(() => {
		if (!resource) {
			return [isFolder ? 'folder-icon' : 'file-icon'];
		}
		return getIconClasses(modelService, languageService, resource, isFolder ? FileKind.FOLDER : FileKind.FILE);
	}, [resource, modelService, languageService, isFolder]);

	if (!resource && !filename) {
		return null;
	}

	const sizeClass = size <= 12
		? 'edit-tool-file-icon--xs'
		: size <= 14
			? 'edit-tool-file-icon--sm'
			: 'edit-tool-file-icon--md';

	return (
		<span
			className={`edit-tool-file-icon show-file-icons inline-flex items-center justify-center flex-shrink-0 ${sizeClass} ${className}`.trim()}
			style={{ width: size, height: size, minWidth: size }}
			aria-hidden="true"
		>
			<span
				className={`monaco-icon-label ${iconClasses.join(' ')}`}
				style={{ width: size, height: size, minWidth: size }}
			/>
		</span>
	);
};

/** @deprecated Use `<VsCodeFileIcon />` instead */
export const getFileIcon = (filename: string | undefined, size: number = 13): React.ReactNode => (
	<VsCodeFileIcon filename={filename} size={size} />
);

/**
 * Get just the file extension for display purposes
 */
export const getFileExtension = (filename: string | undefined): string => {
	if (!filename) return '';
	const ext = filename.toLowerCase().split('.').pop() || '';
	return ext ? `.${ext}` : '';
};

/**
 * Get a descriptive label for the file type
 */
export const getFileTypeLabel = (filename: string | undefined): string => {
	if (!filename) return 'File';

	const ext = filename.toLowerCase().split('.').pop() || '';

	const labels: Record<string, string> = {
		'ts': 'TypeScript',
		'tsx': 'TypeScript React',
		'js': 'JavaScript',
		'jsx': 'React',
		'py': 'Python',
		'html': 'HTML',
		'css': 'CSS',
		'json': 'JSON',
		'md': 'Markdown',
		'sql': 'SQL',
		'sh': 'Shell Script',
		'go': 'Go',
		'rs': 'Rust',
		'java': 'Java',
		'cpp': 'C++',
		'c': 'C',
	};

	return labels[ext] || 'File';
};
