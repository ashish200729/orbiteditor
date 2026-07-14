/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { MCPConfigFileEntryJSON } from './mcpServiceTypes.js';

export type MarketplaceItemKind = 'mcp' | 'skill';
export type MarketplaceFilter = 'all' | 'mcp' | 'skill';

/**
 * How an MCP server authenticates:
 * - 'none': connects without credentials.
 * - 'apikey': needs a static token/header/env value (collected via requiredEnv before install).
 * - 'oauth': needs an interactive browser login after install (the "Authenticate" flow).
 */
export type MarketplaceAuthKind = 'none' | 'apikey' | 'oauth';

/** A required environment variable a user must supply before an MCP server can connect. */
export interface MarketplaceEnvField {
	key: string;
	label?: string;
	description?: string;
	/** True if the value is a secret (rendered as a password field). */
	secret?: boolean;
}

export interface MarketplaceItem {
	id: string;
	kind: MarketplaceItemKind;
	name: string;
	description: string;
	tags?: string[];
	iconUrl?: string;
	/** Optional monogram override (1-2 chars) for the generated logo tile. */
	iconText?: string;
	/** Optional brand color (hex) for the logo tile background. */
	brandColor?: string;
	/** Section grouping label: Featured, Official, Community, … */
	category?: string;
	/** Homepage / docs link for the item. */
	homepage?: string;

	// --- MCP install payload -------------------------------------------------------
	/** How this MCP server authenticates. Defaults to 'none'. */
	auth?: MarketplaceAuthKind;
	/** The mcp.json entry written on install (env values are filled by the config sheet). */
	mcp?: MCPConfigFileEntryJSON;
	/** Env keys the user must configure before the server will connect (auth: 'apikey'). */
	requiredEnv?: MarketplaceEnvField[];

	// --- Skill install payload -----------------------------------------------------
	/** Skill folder name + inline SKILL.md body written on install. */
	skill?: { folderName: string; skillMd: string };
}

export interface MarketplaceCategory {
	id: string;
	title: string;
	items: MarketplaceItem[];
}

export interface IMarketplaceCatalogService {
	readonly _serviceBrand: undefined;
	search(query: string, filter: MarketplaceFilter): Promise<MarketplaceItem[]>;
	getFeatured(): Promise<MarketplaceItem[]>;
	getCategories(): Promise<MarketplaceCategory[]>;
	getItem(id: string): Promise<MarketplaceItem | undefined>;
}

export const IMarketplaceCatalogService = createDecorator<IMarketplaceCatalogService>('marketplaceCatalogService');
