/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { mergeMcpConfigs, MCPConfigFileJSON } from '../../common/mcpServiceTypes.js';
import { BUNDLED_MARKETPLACE_CATALOG } from '../../common/marketplace/catalog.js';

suite('mergeMcpConfigs', () => {
	test('merges disjoint user + project servers with correct scope tags', () => {
		const user: MCPConfigFileJSON = { mcpServers: { a: { command: 'ua' } } };
		const project: MCPConfigFileJSON = { mcpServers: { b: { command: 'pb' } } };
		const { mcpServers, scopeOfName } = mergeMcpConfigs(user, project);
		assert.deepStrictEqual(Object.keys(mcpServers).sort(), ['a', 'b']);
		assert.strictEqual(scopeOfName['a'], 'user');
		assert.strictEqual(scopeOfName['b'], 'project');
	});

	test('project overrides user on name collision', () => {
		const user: MCPConfigFileJSON = { mcpServers: { dup: { command: 'from-user' } } };
		const project: MCPConfigFileJSON = { mcpServers: { dup: { command: 'from-project' } } };
		const { mcpServers, scopeOfName } = mergeMcpConfigs(user, project);
		assert.strictEqual(mcpServers['dup'].command, 'from-project');
		assert.strictEqual(scopeOfName['dup'], 'project');
	});

	test('handles null configs (missing files)', () => {
		assert.deepStrictEqual(mergeMcpConfigs(null, null), { mcpServers: {}, scopeOfName: {} });
		const onlyUser = mergeMcpConfigs({ mcpServers: { x: { command: 'c' } } }, null);
		assert.strictEqual(onlyUser.scopeOfName['x'], 'user');
		const onlyProject = mergeMcpConfigs(null, { mcpServers: { y: { command: 'c' } } });
		assert.strictEqual(onlyProject.scopeOfName['y'], 'project');
	});
});

suite('BundledMarketplaceCatalog', () => {
	// Reproduce the service's search logic against the bundled data (kept in sync with
	// BundledMarketplaceCatalogService) so the test needs no DI container.
	const search = (query: string, filter: 'all' | 'mcp' | 'skill') => {
		const q = query.trim().toLowerCase();
		return BUNDLED_MARKETPLACE_CATALOG.filter(item => {
			if (!(filter === 'all' || item.kind === filter)) return false;
			if (!q) return true;
			const hay = [item.name, item.description, ...(item.tags ?? []), item.category ?? ''].join(' ').toLowerCase();
			return hay.includes(q);
		});
	};

	test('every catalog item has a stable id, name, and kind', () => {
		const ids = new Set<string>();
		for (const item of BUNDLED_MARKETPLACE_CATALOG) {
			assert.ok(item.id, 'missing id');
			assert.ok(!ids.has(item.id), `duplicate id ${item.id}`);
			ids.add(item.id);
			assert.ok(item.name, `missing name for ${item.id}`);
			assert.ok(item.kind === 'mcp' || item.kind === 'skill', `bad kind for ${item.id}`);
		}
	});

	test('mcp items carry an install payload; skill items carry a skill body', () => {
		for (const item of BUNDLED_MARKETPLACE_CATALOG) {
			if (item.kind === 'mcp') {
				assert.ok(item.mcp && (item.mcp.command || item.mcp.url), `mcp ${item.id} needs command or url`);
			} else {
				assert.ok(item.skill?.folderName && item.skill?.skillMd, `skill ${item.id} needs folderName + skillMd`);
			}
		}
	});

	test('filter narrows by kind', () => {
		assert.ok(search('', 'mcp').every(i => i.kind === 'mcp'));
		assert.ok(search('', 'skill').every(i => i.kind === 'skill'));
		assert.strictEqual(search('', 'all').length, BUNDLED_MARKETPLACE_CATALOG.length);
	});

	test('query matches name / description / tags case-insensitively', () => {
		const github = search('GITHUB', 'all');
		assert.ok(github.some(i => i.id === 'mcp-github'));
		const noMatch = search('zzzzz-nonexistent', 'all');
		assert.strictEqual(noMatch.length, 0);
	});
});
