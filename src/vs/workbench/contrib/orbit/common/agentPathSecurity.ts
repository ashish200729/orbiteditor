/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { isEqualOrParent, relativePath } from '../../../../base/common/resources.js';
import { FileOperationError, FileOperationResult, toFileOperationResult } from '../../../../platform/files/common/files.js';

export function assertAgentFileScheme(uri: URI): void {
	if (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote') {
		throw new Error(`Agent file tools do not support the "${uri.scheme || 'unknown'}" URI scheme.`);
	}
}

/**
 * Reject a symlink anywhere below a workspace root before an agent file or cwd
 * operation. Lexical containment alone is insufficient because a repository
 * symlink can resolve to credentials or another project. The root itself is the
 * user's selected security boundary and is therefore allowed to be a symlink.
 */
export async function assertNoWorkspaceSymlinkTraversal(
	target: URI,
	workspaceFolders: readonly URI[],
	stat: (uri: URI) => Promise<{ isSymbolicLink: boolean }>,
	allowMissingLeaf = false,
): Promise<void> {
	assertAgentFileScheme(target);
	const root = workspaceFolders.find(folder =>
		folder.scheme === target.scheme
		&& folder.authority === target.authority
		&& isEqualOrParent(target, folder));
	if (!root) return; // outside-workspace access is handled by explicit approval

	const relative = relativePath(root, target);
	if (!relative) return;
	const segments = relative.split('/').filter(Boolean);
	let current = root;
	for (let index = 0; index < segments.length; index++) {
		current = URI.joinPath(current, segments[index]);
		try {
			const item = await stat(current);
			if (item.isSymbolicLink) {
				throw new Error(`Agent access refused: workspace path traverses a symbolic link (${current.fsPath}).`);
			}
		} catch (error) {
			if (allowMissingLeaf && index === segments.length - 1 && isMissingFileError(error)) {
				return;
			}
			throw error;
		}
	}
}

function isMissingFileError(error: unknown): boolean {
	return error instanceof FileOperationError
		? error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND
		: error instanceof Error && toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND;
}
