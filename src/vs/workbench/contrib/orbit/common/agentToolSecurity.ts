/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import type { BuiltinToolCallParams, BuiltinToolName } from './toolsServiceTypes.js';

// Credential-like paths require an explicit approval even when they are inside the workspace.
// Keep this policy shared by parent and sub-agent execution so delegation cannot bypass it.
const SENSITIVE_PATH_RE = /(?:^|[\\/])(\.env(\.[\w.-]+)?|\.netrc|\.pgpass|\.htpasswd|id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials|\.ssh|\.aws|\.gnupg|\.kube|secrets?)(?:[\\/]|$)|\.(pem|key|p12|pfx|keystore)$/i;

/** The filesystem URIs a path-taking built-in tool would access. */
export function getBuiltinToolPathUris(toolName: BuiltinToolName, params: unknown): URI[] {
	const p = params as Record<string, URI | null | undefined>;
	const pick = (...uris: (URI | null | undefined)[]) => uris.filter((uri): uri is URI => !!uri);

	switch (toolName) {
		case 'Read':
		case 'read_lint_errors':
			return pick(p.uri);
		case 'Write':
		case 'StrReplace':
			return pick(p.path);
		case 'Grep':
		case 'CodebaseSearch':
			return pick(p.path);
		case 'Glob':
			return pick(p.targetDirectory);
		case 'Shell': {
			const workingDirectory = (params as BuiltinToolCallParams['Shell']).workingDirectory;
			return workingDirectory ? [URI.file(workingDirectory)] : [];
		}
		default:
			return [];
	}
}

/**
 * Returns why a path access needs explicit approval, or undefined when it is safe to proceed.
 * Non-filesystem URI schemes are ignored because workspace containment is not meaningful for them.
 */
export function getPathAccessApprovalReason(
	toolName: BuiltinToolName,
	params: BuiltinToolCallParams[BuiltinToolName] | unknown,
	isInsideWorkspace: (uri: URI) => boolean,
): string | undefined {
	for (const uri of getBuiltinToolPathUris(toolName, params)) {
		if (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote') {
			return `access through unsupported URI scheme (${uri.scheme || 'unknown'})`;
		}
		const fsPath = uri.fsPath;
		if (SENSITIVE_PATH_RE.test(fsPath)) {
			return `access to a sensitive path (${fsPath})`;
		}
		if (!isInsideWorkspace(uri)) {
			return `access to a path outside your workspace (${fsPath})`;
		}
	}
	return undefined;
}
