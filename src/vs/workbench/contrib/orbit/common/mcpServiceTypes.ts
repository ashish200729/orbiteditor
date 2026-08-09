/**
 * mcp-response-types.ts
 * --------------------------------------------------
 * **Pure** TypeScript interfaces (no external imports)
 * describing the JSON-RPC response shapes for:
 *
 *   1. tools/list      -> ToolsListResponse
 *   2. prompts/list    -> PromptsListResponse
 *   3. tools/call      -> ToolCallResponse
 *
 * They are distilled directly from the official MCP
 * 2025‑03‑26 specification:
 *   • Tools list response examples
 *   • Prompts list response examples
 *   • Tool call response examples
 *
 * Use them to get full IntelliSense when working with
 * @modelcontextprotocol/inspector‑cli responses.
 */


/* -------------------------------------------------- */
/* Core JSON‑RPC envelope                              */
/* -------------------------------------------------- */

// export interface JsonRpcSuccess<T> {
// 	/** JSON‑RPC version – always '2.0' */
// 	jsonrpc: '2.0';
// 	/** Request identifier echoed back by the server */
// 	id: string | number | null;
// 	/** The successful result payload */
// 	result: T;
// }

/* -------------------------------------------------- */
/* Utility: pagination                                 */
/* -------------------------------------------------- */

// export interface Paginated {
// 	/** Opaque cursor for fetching the next page */
// 	nextCursor?: string;
// }

/* -------------------------------------------------- */
/* 1. tools/list                                       */
/* -------------------------------------------------- */

export interface MCPTool {
	/** Unique tool identifier */
	name: string;
	/** Human‑readable description */
	description?: string;
	/** JSON schema describing expected arguments */
	inputSchema?: Record<string, unknown>;
	/** Free‑form annotations describing behaviour, security, etc. */
	annotations?: Record<string, unknown>;
}

// export interface ToolsListResult extends Paginated {
// 	tools: MCPTool[];
// }

// export type ToolsListResponse = JsonRpcSuccess<ToolsListResult>;

/* -------------------------------------------------- */
/* 2. prompts/list                                     */
/* -------------------------------------------------- */

// export interface PromptArgument {
// 	name: string;
// 	description?: string;
// 	/** Whether the argument is required */
// 	required?: boolean;
// }

// export interface Prompt {
// 	name: string;
// 	description?: string;
// 	arguments?: PromptArgument[];
// }

// export interface PromptsListResult extends Paginated {
// 	prompts: Prompt[];
// }

// export type PromptsListResponse = JsonRpcSuccess<PromptsListResult>;

/* -------------------------------------------------- */
/* 3. tools/call                                       */
/* -------------------------------------------------- */

/** Additional resource structure that can be embedded in tool results */
// export interface Resource {
// 	uri: string;
// 	mimeType: string;
// 	/** Either plain‑text or base64‑encoded binary data */
// 	text?: string;
// 	data?: string;
// }

/** Individual content items returned by a tool */
// export type ToolContent =
// 	| { type: 'text'; text: string }
// 	| { type: 'image'; data: string; mimeType: string }
// 	| { type: 'audio'; data: string; mimeType: string }
// 	| { type: 'resource'; resource: Resource };

// export interface ToolCallResult {
// 	/** List of content parts (text, images, resources, etc.) */
// 	content: ToolContent[];
// 	/** True if the tool itself encountered a domain‑level error */
// 	isError?: boolean;
// }

// export type ToolCallResponse = JsonRpcSuccess<ToolCallResult>;

// MCP SERVER CONFIG FILE TYPES -----------------------------

export interface MCPConfigFileEntryJSON {
	// Command-based server properties
	command?: string;
	args?: string[];
	env?: Record<string, string>;

	// URL-based server properties
	url?: URL;
	headers?: Record<string, string>;
}

export interface MCPConfigFileJSON {
	mcpServers: Record<string, MCPConfigFileEntryJSON>;
}

function canonicalizeConfigValue(value: unknown): unknown {
	if (value instanceof URL) {
		return value.toString();
	}
	if (Array.isArray(value)) {
		return value.map(canonicalizeConfigValue);
	}
	if (value && typeof value === 'object') {
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const child = (value as Record<string, unknown>)[key];
			if (child !== undefined) {
				result[key] = canonicalizeConfigValue(child);
			}
		}
		return result;
	}
	return value;
}

/**
 * Stable, cryptographic approval fingerprint for a project MCP server. The
 * source folder and logical name are included so an approval cannot be moved
 * to another repository or server entry. Any executable configuration change
 * invalidates the approval and returns the server to the disabled state.
 */
export async function fingerprintProjectMcpServer(
	folderUri: string,
	serverName: string,
	entry: MCPConfigFileEntryJSON,
): Promise<string> {
	const material = JSON.stringify(canonicalizeConfigValue({ folderUri, serverName, entry }));
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Storage key for one folder/name pair. The value stored under it is the
 * approved configuration fingerprint, never a bare boolean. */
export function projectMcpApprovalKey(folderUri: string, serverName: string): string {
	return `${folderUri}\n${serverName}`;
}

/**
 * Merge a user-scoped and project-scoped MCP config. Project entries override user
 * entries on name collision. Returns the merged server map plus the scope each name
 * resolved to. Pure — no filesystem access — so it is unit-testable.
 */
export function mergeMcpConfigs(
	userConfig: MCPConfigFileJSON | null | undefined,
	projectConfig: MCPConfigFileJSON | null | undefined,
): { mcpServers: Record<string, MCPConfigFileEntryJSON>, scopeOfName: { [name: string]: 'user' | 'project' } } {
	const mcpServers: Record<string, MCPConfigFileEntryJSON> = {};
	const scopeOfName: { [name: string]: 'user' | 'project' } = {};
	if (userConfig?.mcpServers) {
		for (const [name, entry] of Object.entries(userConfig.mcpServers)) {
			mcpServers[name] = entry;
			scopeOfName[name] = 'user';
		}
	}
	if (projectConfig?.mcpServers) {
		for (const [name, entry] of Object.entries(projectConfig.mcpServers)) {
			mcpServers[name] = entry; // project wins
			scopeOfName[name] = 'project';
		}
	}
	return { mcpServers, scopeOfName };
}

/** Merge user config with an ordered multi-root project sequence without ever
 * reclassifying servers contributed by an earlier project as user-scoped. */
export function mergeMcpConfigsForProjects(
	userConfig: MCPConfigFileJSON | null | undefined,
	projects: Array<{ config: MCPConfigFileJSON | null | undefined; folderUri: string }>,
): {
	mcpServers: Record<string, MCPConfigFileEntryJSON>;
	scopeOfName: { [name: string]: 'user' | 'project' };
	projectFolderOfName: { [name: string]: string | undefined };
} {
	const { mcpServers, scopeOfName } = mergeMcpConfigs(userConfig, null);
	const projectFolderOfName: { [name: string]: string | undefined } = {};
	for (const { config, folderUri } of projects) {
		for (const [name, entry] of Object.entries(config?.mcpServers ?? {})) {
			mcpServers[name] = entry;
			scopeOfName[name] = 'project';
			projectFolderOfName[name] = folderUri;
		}
	}
	return { mcpServers, scopeOfName, projectFolderOfName };
}


// SERVER EVENT TYPES ------------------------------------------

export type MCPServer = {
	// Command-based server properties
	tools: MCPTool[],
	// 'needs-auth': a remote server that requires an OAuth login before it will connect.
	status: 'loading' | 'success' | 'offline' | 'needs-auth',
	command?: string,
	error?: string,
} | {
	tools?: undefined,
	status: 'error',
	command?: string,
	error: string,
}

export interface MCPServerOfName {
	[serverName: string]: MCPServer;
}

export type MCPServerEvent = {
	name: string;
	prevServer?: MCPServer;
	newServer?: MCPServer;
}
export type MCPServerEventResponse = { response: MCPServerEvent }

export interface MCPConfigFileParseErrorResponse {
	response: {
		type: 'config-file-error';
		error: string | null;
	}
}


// export type MCPServerResponse = MCPAddResponse | MCPUpdateResponse | MCPDeleteResponse | MCPLoadingResponse;

// Event parameter types
// export type MCPServerEventAddParam = { response: MCPAddResponse };
// export type MCPServerEventUpdateParam = { response: MCPUpdateResponse };
// export type MCPServerEventDeleteParam = { response: MCPDeleteResponse };
// export type MCPServerEventLoadingParam = { response: MCPLoadingResponse };

// Event Param union type
// export type MCPServerEventParam = MCPServerEventAddParam | MCPServerEventUpdateParam | MCPServerEventDeleteParam | MCPServerEventLoadingParam;

// TOOL CALL EVENT TYPES ------------------------------------------

type MCPToolResponseType = 'text' | 'image' | 'audio' | 'resource' | 'error';

export type ResponseImageTypes = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/svg+xml' | 'image/bmp' | 'image/tiff' | 'image/vnd.microsoft.icon';

interface ImageData {
	data: string;
	mimeType: ResponseImageTypes;
}

interface MCPToolResponseBase {
	toolName: string;
	serverName?: string;
	event: MCPToolResponseType;
	text?: string;
	image?: ImageData;
}

type MCPToolResponseConstraints = {
	'text': {
		image?: never;
		text: string;
	};
	'error': {
		image?: never;
		text: string;
	};
	'image': {
		/** Optional caption / refs YAML when a tool returns both text and pixels. */
		text?: string;
		image: ImageData;
	};
	'audio': {
		text?: never;
		image?: never;
	};
	'resource': {
		text?: never;
		image?: never;
	}
}

type MCPToolEventResponse<T extends MCPToolResponseType> = Omit<MCPToolResponseBase, 'event' | keyof MCPToolResponseConstraints> & MCPToolResponseConstraints[T] & { event: T };

// Response types
export type MCPToolTextResponse = MCPToolEventResponse<'text'>;
export type MCPToolErrorResponse = MCPToolEventResponse<'error'>;
export type MCPToolImageResponse = MCPToolEventResponse<'image'>;
export type MCPToolAudioResponse = MCPToolEventResponse<'audio'>;
export type MCPToolResourceResponse = MCPToolEventResponse<'resource'>;
export type RawMCPToolCall = MCPToolTextResponse | MCPToolErrorResponse | MCPToolImageResponse | MCPToolAudioResponse | MCPToolResourceResponse;

export interface MCPToolCallParams {
	serverName: string;
	toolName: string;
	params: Record<string, unknown>;
}



export const removeMCPToolNamePrefix = (name: string) => {
	return name.split('_').slice(1).join('_')
}
