/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../../../base/common/uri.js'

/** Converts an LLM path string (absolute path or file:// / vscode-remote:// URI) to a URI. */
export const pathStringToUri = (pathStr: string): URI => {
	if (pathStr.includes('://')) {
		return URI.parse(pathStr)
	}
	return URI.file(pathStr)
}

const pathStringOf = (uri: URI | { fsPath?: string; path?: string } | string | null | undefined): string => {
	if (!uri) {
		return '';
	}
	if (typeof uri === 'string') {
		return uri;
	}
	return uri.fsPath ?? uri.path ?? '';
}

export const getRelative = (uri: any, accessor: any) => {
	const fsPath = pathStringOf(uri);
	if (!fsPath) {
		return undefined;
	}
	const workspaceContextService = accessor.get('IWorkspaceContextService')
	let path: string
	const isInside = workspaceContextService.isInsideWorkspace(uri)
	if (isInside) {
		const f = workspaceContextService.getWorkspace().folders.find((f: any) => fsPath.startsWith(f.uri.fsPath))
		if (f?.uri?.fsPath) { path = fsPath.replace(f.uri.fsPath, '') }
		else { path = fsPath }
	}
	else {
		path = fsPath
	}
	return path || undefined
}

export const getFolderName = (pathStr: string | null | undefined) => {
	if (!pathStr) {
		return '/';
	}
	// 'unixify' path
	pathStr = pathStr.replace(/[/\\\\]+/g, '/') // replace any / or \\ or \\\\ with /
	const parts = pathStr.split('/') // split on /
	// Filter out empty parts (the last element will be empty if path ends with /)
	const nonEmptyParts = parts.filter(part => part.length > 0)
	if (nonEmptyParts.length === 0) return '/' // Root directory
	if (nonEmptyParts.length === 1) return nonEmptyParts[0] + '/' // Only one folder
	// Get the last two parts
	const lastTwo = nonEmptyParts.slice(-2)
	return lastTwo.join('/') + '/'
}

export const getBasename = (pathStr: string | null | undefined, parts: number = 1) => {
	if (!pathStr) {
		return '';
	}
	// 'unixify' path
	pathStr = pathStr.replace(/[/\\\\]+/g, '/') // replace any / or \\ or \\\\ with /
	const allParts = pathStr.split('/') // split on /
	if (allParts.length === 0) return pathStr
	return allParts.slice(-parts).join('/')
}

// Open file utility function
export const voidOpenFileFn = (
	uri: any,
	accessor: any,
	range?: [number, number]
) => {
	const commandService = accessor.get('ICommandService')
	const editorService = accessor.get('ICodeEditorService')

	// Get editor selection from CodeSelection range
	let editorSelection = undefined;

	// If we have a selection, create an editor selection from the range
	if (range) {
		editorSelection = {
			startLineNumber: range[0],
			startColumn: 1,
			endLineNumber: range[1],
			endColumn: Number.MAX_SAFE_INTEGER,
		};
	}

	// open the file
	commandService.executeCommand('vscode.open', uri).then(() => {

		// select the text
		setTimeout(() => {
			if (!editorSelection) return;

			const editor = editorService.getActiveCodeEditor()
			if (!editor) return;

			editor.setSelection(editorSelection)
			editor.revealRange(editorSelection, 0 /* ScrollType.Immediate */)

		}, 50) // needed when document was just opened and needs to initialize

	})

};
