/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Curated, bundled marketplace catalog (V1). Data source behind
 * `BundledMarketplaceCatalogService`. Endpoints + auth verified against each
 * vendor's 2026 docs (see `docs/customize-marketplace.md`).
 *
 * `auth`:
 *   - 'none'   → connects immediately after Add (public server).
 *   - 'apikey' → the requiredEnv sheet collects secrets before install
 *                (written into `env` for stdio servers, `headers` for HTTP).
 *   - 'oauth'  → after Add the server reports 'needs-auth'; the user clicks
 *                Authenticate to run the browser login (loopback + PKCE + DCR).
 *
 * Only servers that work with a generic OAuth client (dynamic client
 * registration) — or with an API key / no auth — are included. Allowlist-only
 * remotes (Figma remote, Vercel, GitHub remote) are intentionally offered via a
 * reliable alternative (Figma Dev Mode local server; GitHub via PAT stdio).
 *
 * MCP `url` entries are strings (the config file stores strings; the channel
 * accepts a string or URL) — cast to URL to satisfy the shared type.
 */

import { MarketplaceItem } from '../marketplaceCatalogTypes.js';

const url = (u: string) => u as unknown as URL;

export const BUNDLED_MARKETPLACE_CATALOG: MarketplaceItem[] = [
	// ─── Featured ──────────────────────────────────────────────────────────────────
	{
		id: 'mcp-context7', kind: 'mcp', name: 'Context7', category: 'Featured',
		brandColor: '#0ea5e9', iconText: 'C7',
		description: 'Up-to-date documentation and code examples for any library or framework, fetched on demand.',
		tags: ['docs', 'reference'], homepage: 'https://context7.com',
		auth: 'none', mcp: { url: url('https://mcp.context7.com/mcp') },
	},
	{
		id: 'mcp-linear', kind: 'mcp', name: 'Linear', category: 'Featured',
		brandColor: '#5e6ad2', iconText: 'L',
		description: 'Find, create, and update Linear issues, projects, and cycles from the agent.',
		tags: ['issues', 'project management'], homepage: 'https://linear.app/docs/mcp',
		auth: 'oauth', mcp: { url: url('https://mcp.linear.app/mcp') },
	},
	{
		id: 'mcp-notion', kind: 'mcp', name: 'Notion', category: 'Featured',
		brandColor: '#0f0f0f', iconText: 'N',
		description: 'Search and edit Notion pages and databases directly from your workspace.',
		tags: ['notes', 'docs'], homepage: 'https://developers.notion.com',
		auth: 'oauth', mcp: { url: url('https://mcp.notion.com/mcp') },
	},
	{
		id: 'mcp-github', kind: 'mcp', name: 'GitHub', category: 'Featured',
		brandColor: '#24292f', iconText: 'GH',
		description: 'Read and manage GitHub repositories, issues, and pull requests.',
		tags: ['git', 'vcs'], homepage: 'https://github.com/github/github-mcp-server',
		auth: 'apikey',
		mcp: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github@2025.4.8'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' } },
		requiredEnv: [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'Personal Access Token', description: 'A GitHub PAT with the scopes you need (e.g. repo).', secret: true }],
	},

	// ─── Official ──────────────────────────────────────────────────────────────────
	{
		id: 'mcp-sentry', kind: 'mcp', name: 'Sentry', category: 'Official',
		brandColor: '#362d59', iconText: 'S',
		description: 'Inspect Sentry issues, events, and stack traces to debug production errors.',
		tags: ['errors', 'observability'], homepage: 'https://mcp.sentry.dev',
		auth: 'oauth', mcp: { url: url('https://mcp.sentry.dev/mcp') },
	},
	{
		id: 'mcp-atlassian', kind: 'mcp', name: 'Atlassian', category: 'Official',
		brandColor: '#0052cc', iconText: 'A',
		description: 'Work with Jira issues and Confluence pages across your Atlassian cloud.',
		tags: ['jira', 'confluence'], homepage: 'https://www.atlassian.com/platform/remote-mcp-server',
		auth: 'oauth', mcp: { url: url('https://mcp.atlassian.com/v1/mcp') },
	},
	{
		id: 'mcp-stripe', kind: 'mcp', name: 'Stripe', category: 'Official',
		brandColor: '#635bff', iconText: 'S',
		description: 'Query Stripe customers, payments, subscriptions, and products.',
		tags: ['payments', 'billing'], homepage: 'https://docs.stripe.com/mcp',
		auth: 'apikey',
		mcp: { url: url('https://mcp.stripe.com'), headers: { Authorization: '' } },
		requiredEnv: [{ key: 'Authorization', label: 'Secret key', description: 'A Stripe restricted key. Enter the full header value including "Bearer ", e.g. "Bearer rk_live_…".', secret: true }],
	},
	{
		id: 'mcp-playwright', kind: 'mcp', name: 'Playwright', category: 'Official',
		brandColor: '#2ead33', iconText: 'PW',
		description: 'Drive a real browser: navigate, click, fill forms, and capture pages for testing and scraping.',
		tags: ['browser', 'testing'], homepage: 'https://github.com/microsoft/playwright-mcp',
		auth: 'none', mcp: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.79'] },
	},

	// ─── Community ─────────────────────────────────────────────────────────────────
	{
		id: 'mcp-neon', kind: 'mcp', name: 'Neon', category: 'Community',
		brandColor: '#00e599', iconText: 'N',
		description: 'Manage Neon Postgres databases: run queries, branches, and migrations.',
		tags: ['database', 'postgres'], homepage: 'https://neon.com/docs/ai/neon-mcp-server',
		auth: 'oauth', mcp: { url: url('https://mcp.neon.tech/mcp') },
	},
	{
		id: 'mcp-canva', kind: 'mcp', name: 'Canva', category: 'Community',
		brandColor: '#00c4cc', iconText: 'C',
		description: 'Create and edit Canva designs, and browse your assets and brand kit.',
		tags: ['design'], homepage: 'https://www.canva.dev/docs/mcp/',
		auth: 'oauth', mcp: { url: url('https://mcp.canva.com/mcp') },
	},
	{
		id: 'mcp-huggingface', kind: 'mcp', name: 'Hugging Face', category: 'Community',
		brandColor: '#ff9d00', iconText: 'HF',
		description: 'Search models, datasets, and Spaces on the Hugging Face Hub.',
		tags: ['ml', 'models'], homepage: 'https://huggingface.co/settings/mcp',
		auth: 'apikey',
		mcp: { url: url('https://huggingface.co/mcp'), headers: { Authorization: '' } },
		requiredEnv: [{ key: 'Authorization', label: 'Access token', description: 'A Hugging Face token. Enter the full value including "Bearer ", e.g. "Bearer hf_…".', secret: true }],
	},
	{
		id: 'mcp-deepwiki', kind: 'mcp', name: 'DeepWiki', category: 'Community',
		brandColor: '#7c3aed', iconText: 'DW',
		description: 'Ask questions about any public GitHub repository and read its generated wiki.',
		tags: ['docs', 'code'], homepage: 'https://deepwiki.com',
		auth: 'none', mcp: { url: url('https://mcp.deepwiki.com/mcp') },
	},
	{
		id: 'mcp-globalping', kind: 'mcp', name: 'Globalping', category: 'Community',
		brandColor: '#17d1c6', iconText: 'G',
		description: 'Run ping, traceroute, DNS, HTTP, and MTR checks from a global probe network.',
		tags: ['network', 'devops'], homepage: 'https://globalping.io',
		auth: 'none', mcp: { url: url('https://mcp.globalping.dev/mcp') },
	},
	{
		id: 'mcp-figma', kind: 'mcp', name: 'Figma (Dev Mode)', category: 'Community',
		brandColor: '#f24e1e', iconText: 'F',
		description: 'Read the current Figma selection and translate designs into code. Requires the Figma desktop app with Dev Mode MCP enabled.',
		tags: ['design'], homepage: 'https://help.figma.com/hc/en-us/articles/32132100833559',
		auth: 'none', mcp: { url: url('http://127.0.0.1:3845/mcp') },
	},
	{
		id: 'mcp-brave-search', kind: 'mcp', name: 'Brave Search', category: 'Community',
		brandColor: '#fb542b', iconText: 'B',
		description: 'Web and local search via the Brave Search API.',
		tags: ['search', 'web'], homepage: 'https://github.com/modelcontextprotocol/servers',
		auth: 'apikey',
		mcp: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search@0.6.2'], env: { BRAVE_API_KEY: '' } },
		requiredEnv: [{ key: 'BRAVE_API_KEY', label: 'Brave API key', description: 'Get one at brave.com/search/api.', secret: true }],
	},
	{
		id: 'mcp-slack', kind: 'mcp', name: 'Slack', category: 'Community',
		brandColor: '#4a154b', iconText: 'S',
		description: 'Read and post Slack messages, list channels, and search history.',
		tags: ['chat', 'team'], homepage: 'https://github.com/modelcontextprotocol/servers',
		auth: 'apikey',
		mcp: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack@2025.4.25'], env: { SLACK_BOT_TOKEN: '', SLACK_TEAM_ID: '' } },
		requiredEnv: [
			{ key: 'SLACK_BOT_TOKEN', label: 'Bot token', description: 'A Slack bot token (xoxb-…).', secret: true },
			{ key: 'SLACK_TEAM_ID', label: 'Team ID', description: 'Your Slack workspace/team ID (T…).' },
		],
	},
	{
		id: 'mcp-puppeteer', kind: 'mcp', name: 'Puppeteer', category: 'Community',
		brandColor: '#40b5a4', iconText: 'P',
		description: 'Headless Chrome automation for navigation, screenshots, and DOM interaction.',
		tags: ['browser', 'automation'], homepage: 'https://github.com/modelcontextprotocol/servers',
		auth: 'none', mcp: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer@2025.5.12'] },
	},
	{
		id: 'mcp-sequential-thinking', kind: 'mcp', name: 'Sequential Thinking', category: 'Community',
		brandColor: '#7c3aed', iconText: 'ST',
		description: 'A structured, step-by-step reasoning tool for breaking down complex problems.',
		tags: ['reasoning'], homepage: 'https://github.com/modelcontextprotocol/servers',
		auth: 'none', mcp: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking@2026.7.4'] },
	},
	{
		id: 'mcp-memory', kind: 'mcp', name: 'Memory', category: 'Community',
		brandColor: '#0891b2', iconText: 'M',
		description: 'A persistent knowledge-graph memory the agent can read and write across sessions.',
		tags: ['memory', 'knowledge'], homepage: 'https://github.com/modelcontextprotocol/servers',
		auth: 'none', mcp: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory@2026.7.4'] },
	},

	// ─── Skills ──────────────────────────────────────────────────────────────────
	{
		id: 'skill-conventional-commits', kind: 'skill', name: 'Conventional Commits', category: 'Featured',
		brandColor: '#16a34a', iconText: 'CC', tags: ['git', 'workflow'],
		description: 'Write commit messages in Conventional Commits format. Use when committing changes or asked to write a commit message.',
		skill: {
			folderName: 'conventional-commits',
			skillMd: `---
name: conventional-commits
description: Write commit messages in Conventional Commits format. Use when committing changes or asked to write a commit message.
---
# Conventional Commits

Format every commit subject as \`<type>(<scope>): <description>\`.

Types: \`feat\`, \`fix\`, \`docs\`, \`style\`, \`refactor\`, \`perf\`, \`test\`, \`build\`, \`ci\`, \`chore\`.

Rules:
- Subject <= 50 chars, imperative mood ("add", not "added").
- Add a body only when the "why" isn't obvious from the subject.
- Reference issues in a footer: \`Refs: #123\`.
`,
		},
	},
	{
		id: 'skill-pr-description', kind: 'skill', name: 'PR Description Writer', category: 'Community',
		brandColor: '#2563eb', iconText: 'PR', tags: ['git', 'workflow'],
		description: 'Draft a clear pull request description from a diff. Use when opening a PR or summarizing branch changes.',
		skill: {
			folderName: 'pr-description',
			skillMd: `---
name: pr-description
description: Draft a clear pull request description from a diff. Use when opening a PR or summarizing branch changes.
---
# PR Description Writer

Produce a PR description with these sections:

## Summary
One or two sentences on what changed and why.

## Changes
Bulleted list of the notable changes, grouped by area.

## Testing
How the change was verified (commands run, cases covered).

Keep it scannable. Omit sections that don't apply.
`,
		},
	},
	{
		id: 'skill-test-writer', kind: 'skill', name: 'Test Writer', category: 'Community',
		brandColor: '#dc2626', iconText: 'T', tags: ['testing', 'quality'],
		description: 'Write focused unit tests for a function or module. Use when adding tests or improving coverage.',
		skill: {
			folderName: 'test-writer',
			skillMd: `---
name: test-writer
description: Write focused unit tests for a function or module. Use when adding tests or improving coverage.
---
# Test Writer

For the target code:
1. Identify the public behavior and its edge cases (empty, zero/negative, large, null, unicode, error paths).
2. Match the repo's existing test framework and file conventions — do not introduce a new one.
3. Write one assertion per behavior; name tests by the behavior, not the method.
4. Cover the happy path, boundaries, and at least one failure path.
5. Keep tests deterministic — no real network, clock, or filesystem unless the repo already does so.
`,
		},
	},
	{
		id: 'skill-debugging', kind: 'skill', name: 'Debugging Methodology', category: 'Community',
		brandColor: '#ea580c', iconText: 'D', tags: ['debugging'],
		description: 'A disciplined process for isolating and fixing a bug. Use when investigating unexpected behavior or a failing test.',
		skill: {
			folderName: 'debugging-methodology',
			skillMd: `---
name: debugging-methodology
description: A disciplined process for isolating and fixing a bug. Use when investigating unexpected behavior or a failing test.
---
# Debugging Methodology

1. Reproduce reliably — find the smallest input that triggers the bug.
2. Read the actual error/stack; don't guess. Quote it.
3. Form ONE hypothesis, then test it with a targeted log or assertion.
4. Bisect: narrow the failing region by halving the search space.
5. Fix the root cause, not the symptom. Add a regression test.
6. Verify the fix and check for similar bugs nearby.
`,
		},
	},
	{
		id: 'skill-api-design', kind: 'skill', name: 'API Design Review', category: 'Community',
		brandColor: '#7c3aed', iconText: 'API', tags: ['architecture', 'api'],
		description: 'Review or design a REST/RPC API for consistency and clarity. Use when adding endpoints or reviewing an API surface.',
		skill: {
			folderName: 'api-design',
			skillMd: `---
name: api-design
description: Review or design a REST/RPC API for consistency and clarity. Use when adding endpoints or reviewing an API surface.
---
# API Design Review

Check the surface for:
- Consistent naming, pluralization, and casing across resources.
- Correct HTTP verbs and status codes; idempotency where expected.
- Clear, typed request/response shapes; explicit error format.
- Pagination, filtering, and versioning strategy.
- Backward compatibility — additive changes only on stable endpoints.
- Authentication/authorization on every mutating route.
`,
		},
	},
];
