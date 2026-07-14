/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IMarketplaceCatalogService, MarketplaceItem, MarketplaceFilter, MarketplaceCategory } from '../common/marketplaceCatalogTypes.js';
import { BUNDLED_MARKETPLACE_CATALOG } from '../common/marketplace/catalog.js';

/**
 * V1 catalog backed by the bundled curated list. Swap this registration for a
 * RemoteMarketplaceCatalogService (same interface) to source from orbit-backend
 * without any UI changes.
 */
export class BundledMarketplaceCatalogService implements IMarketplaceCatalogService {
	readonly _serviceBrand: undefined;

	private readonly _items: MarketplaceItem[] = BUNDLED_MARKETPLACE_CATALOG;

	private _matchesFilter(item: MarketplaceItem, filter: MarketplaceFilter): boolean {
		return filter === 'all' || item.kind === filter;
	}

	async search(query: string, filter: MarketplaceFilter): Promise<MarketplaceItem[]> {
		const q = query.trim().toLowerCase();
		return this._items.filter(item => {
			if (!this._matchesFilter(item, filter)) return false;
			if (!q) return true;
			const haystack = [item.name, item.description, ...(item.tags ?? []), item.category ?? '']
				.join(' ')
				.toLowerCase();
			return haystack.includes(q);
		});
	}

	async getFeatured(): Promise<MarketplaceItem[]> {
		return this._items.filter(item => item.category === 'Featured');
	}

	async getCategories(): Promise<MarketplaceCategory[]> {
		const byCategory = new Map<string, MarketplaceItem[]>();
		for (const item of this._items) {
			const cat = item.category ?? 'Other';
			if (!byCategory.has(cat)) byCategory.set(cat, []);
			byCategory.get(cat)!.push(item);
		}
		// Stable, sensible section order.
		const order = ['Featured', 'Official', 'Community', 'Other'];
		const cats: MarketplaceCategory[] = [];
		for (const title of order) {
			const items = byCategory.get(title);
			if (items?.length) cats.push({ id: title.toLowerCase(), title, items });
		}
		// Any categories not in the predefined order, appended alphabetically.
		for (const [title, items] of [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
			if (!order.includes(title) && items.length) cats.push({ id: title.toLowerCase(), title, items });
		}
		return cats;
	}

	async getItem(id: string): Promise<MarketplaceItem | undefined> {
		return this._items.find(item => item.id === id);
	}
}

registerSingleton(IMarketplaceCatalogService, BundledMarketplaceCatalogService, InstantiationType.Delayed);
