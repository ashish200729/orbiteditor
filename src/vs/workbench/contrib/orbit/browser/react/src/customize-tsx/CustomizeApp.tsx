/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import '../styles.css'
import { Puzzle, BookOpen, Bot, ScrollText, Plus, Trash2, Search, Store, ArrowLeft, ExternalLink, Check, RefreshCw, LogIn, ShieldCheck, KeyRound, type LucideIcon } from 'lucide-react'
import { useAccessor, useIsDark, useMCPServiceState, useSettingsState } from '../util/services.js'
import { VoidSwitch, VoidInputBox2, VoidSimpleInputBox } from '../util/inputs.js'
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js'
import { listSkills, onSkillsChanged } from '../../../../common/skillRegistry.js'
import type { SkillDefinition } from '../../../../common/orbitSkillTypes.js'
import { listSubAgents, onSubAgentsChanged, type ResolvedSubAgentDefinition } from '../../../../common/subAgentRegistry.js'
import { URI } from '../../../../../../../base/common/uri.js'
import { VSBuffer } from '../../../../../../../base/common/buffer.js'
import Severity from '../../../../../../../base/common/severity.js'
import { consumePendingOrbitCustomize, type OrbitCustomizeTab, type OrbitCustomizeScope, type OrbitCustomizeView } from '../../../orbitCustomizeNavigation.js'
import { MCPScope } from '../../../../common/mcpService.js'
import { MarketplaceItem, MarketplaceFilter, MarketplaceCategory } from '../../../../common/marketplaceCatalogTypes.js'
import { MCPConfigFileEntryJSON } from '../../../../common/mcpServiceTypes.js'
import { BUNDLED_MARKETPLACE_CATALOG } from '../../../../common/marketplace/catalog.js'

// ─────────────────────────────────────────────────────────────────────────────
// Small shared UI primitives
// ─────────────────────────────────────────────────────────────────────────────

// Confirmation dialog helper — used by delete actions across tabs and the
// skill-install-overwrite flow so destructive actions never happen silently.
const useConfirm = () => {
	const accessor = useAccessor()
	const dialogService = accessor.get('IDialogService')
	return useCallback(async (title: string, message: string, primaryButton?: string) => {
		const res = await dialogService.confirm({ message, title, primaryButton })
		return res.confirmed
	}, [dialogService])
}

// Debounce a rapidly-changing value (e.g. a search box) so downstream effects
// only fire after the user pauses typing. Keeps the catalog search from issuing
// a query per keystroke once a remote backend is wired in.
const useDebouncedValue = <T,>(value: T, delayMs: number): T => {
	const [debounced, setDebounced] = useState(value)
	useEffect(() => {
		const t = setTimeout(() => setDebounced(value), delayMs)
		return () => clearTimeout(t)
	}, [value, delayMs])
	return debounced
}

const TAB_META: { tab: OrbitCustomizeTab; label: string; icon: LucideIcon }[] = [
	{ tab: 'mcp', label: 'MCPs', icon: Puzzle },
	{ tab: 'skills', label: 'Skills', icon: BookOpen },
	{ tab: 'agents', label: 'Subagents', icon: Bot },
	{ tab: 'rules', label: 'Rules', icon: ScrollText },
]

const TabPills = ({ tab, setTab }: { tab: OrbitCustomizeTab; setTab: (t: OrbitCustomizeTab) => void }) => (
	<div className='flex items-center gap-1'>
		{TAB_META.map(({ tab: t, label, icon: Icon }) => (
			<button
				key={t}
				onClick={() => setTab(t)}
				className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs transition-colors ${tab === t
					? 'bg-[color-mix(in_srgb,var(--void-fg-1)_10%,transparent)] text-void-fg-0'
					: 'text-void-fg-3 hover:text-void-fg-1 hover:bg-[color-mix(in_srgb,var(--void-fg-1)_5%,transparent)]'}`}
			>
				<Icon className='w-3.5 h-3.5' />
				{label}
			</button>
		))}
	</div>
)

const ScopeToggle = ({ scope, setScope, workspaceLabel, workspaceAvailable }: {
	scope: OrbitCustomizeScope; setScope: (s: OrbitCustomizeScope) => void; workspaceLabel: string; workspaceAvailable: boolean
}) => (
	<div className='inline-flex items-center rounded border border-void-border-3 overflow-hidden text-xs'>
		<button
			onClick={() => setScope('user')}
			className={`px-3 py-1.5 transition-colors ${scope === 'user' ? 'bg-[color-mix(in_srgb,var(--void-fg-1)_10%,transparent)] text-void-fg-0' : 'text-void-fg-3 hover:text-void-fg-1'}`}
		>
			User
		</button>
		<button
			onClick={() => workspaceAvailable && setScope('workspace')}
			disabled={!workspaceAvailable}
			title={workspaceAvailable ? workspaceLabel : 'Open a folder to use workspace scope'}
			className={`px-3 py-1.5 border-l border-void-border-3 transition-colors truncate max-w-[160px] ${scope === 'workspace' ? 'bg-[color-mix(in_srgb,var(--void-fg-1)_10%,transparent)] text-void-fg-0' : 'text-void-fg-3 hover:text-void-fg-1'} ${!workspaceAvailable ? 'opacity-40 cursor-not-allowed' : ''}`}
		>
			{workspaceAvailable ? workspaceLabel : 'Workspace'}
		</button>
	</div>
)

const EmptyState = ({ title, description, actionLabel, onAction, docsUrl }: {
	title: string; description: string; actionLabel?: string; onAction?: () => void; docsUrl?: string
}) => {
	const accessor = useAccessor()
	const openerService = accessor.get('IOpenerService')
	return (
		<div className='rounded-lg border border-void-border-3 bg-void-bg-2 px-6 py-12 text-center'>
			<p className='text-void-fg-1 text-sm font-medium'>{title}</p>
			<p className='text-void-fg-3 text-xs mt-1 max-w-md mx-auto leading-relaxed'>{description}</p>
			<div className='flex items-center justify-center gap-2 mt-4'>
				{actionLabel && onAction && (
					<button onClick={onAction} className='flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-[color-mix(in_srgb,var(--void-fg-1)_10%,transparent)] text-void-fg-0 hover:bg-[color-mix(in_srgb,var(--void-fg-1)_16%,transparent)] transition-colors'>
						<Plus className='w-3.5 h-3.5' /> {actionLabel}
					</button>
				)}
				{docsUrl && (
					<button onClick={() => openerService.open(URI.parse(docsUrl))} className='flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-void-fg-3 hover:text-void-fg-1 transition-colors'>
						<ExternalLink className='w-3.5 h-3.5' /> Documentation
					</button>
				)}
			</div>
		</div>
	)
}

const ScopeBadge = ({ scope }: { scope: MCPScope | 'user' | 'project' | 'built-in' | 'global' }) => (
	<span className='text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded text-void-fg-3 flex-shrink-0' style={{ background: 'color-mix(in srgb, var(--void-fg-1) 8%, transparent)' }}>
		{scope}
	</span>
)

// ── Brand logos ──────────────────────────────────────────────────────────────
const LOGO_PALETTE = ['#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#16a34a', '#0891b2', '#4f46e5', '#0f766e', '#b45309']
const hashColor = (s: string) => LOGO_PALETTE[Math.abs([...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)) % LOGO_PALETTE.length]
const initialsOf = (name: string) => (name.replace(/[^a-zA-Z0-9 ]/g, '').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?')

// Original, simplified white glyphs (24×24 viewBox) for flagship integrations. These
// are our own geometric marks — brand-adjacent, not trademark reproductions — so the
// tiles read as logos while staying legally clean. Anything without a glyph falls back
// to a monogram. A remote catalog can override with a real `iconUrl` later.
const BRAND_GLYPHS: Record<string, React.ReactNode> = {
	'mcp-context7': <><rect x="4" y="4" width="16" height="16" rx="3" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M8 9h8M8 13h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></>,
	'mcp-linear': <><path d="M5 14L14 5M8 17l9-9M11 19l8-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></>,
	'mcp-notion': <><path d="M7 17V7l10 10V7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /></>,
	'mcp-github': <><circle cx="8" cy="7" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.8" /><circle cx="8" cy="17" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.8" /><circle cx="16" cy="9" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M8 9.2v5.6M8 14.8c0-3 8-1.5 8-3.8" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" /></>,
	'mcp-figma': <><rect x="7" y="4" width="10" height="5.5" rx="2.75" fill="currentColor" opacity="0.95" /><rect x="7" y="9.5" width="10" height="5.5" rx="2.75" fill="currentColor" opacity="0.7" /><circle cx="14.5" cy="17.5" r="2.75" fill="currentColor" opacity="0.5" /></>,
	'mcp-sentry': <><path d="M12 5l7 12h-4c0-4-2-6.5-5-8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /><path d="M12 5L5 17h4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></>,
	'mcp-stripe': <><path d="M7 8.5c0-1.4 1.6-2 3.2-2 1.6 0 3 .5 4 1M6.8 15.5c1 .8 2.6 1.5 4.4 1.5 1.8 0 3.2-.7 3.2-2.1 0-2.9-6.8-1.6-6.8-4.4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></>,
	'mcp-slack': <><rect x="10.5" y="4" width="3" height="9" rx="1.5" fill="currentColor" opacity="0.9" /><rect x="4" y="10.5" width="9" height="3" rx="1.5" fill="currentColor" opacity="0.7" /><rect x="10.5" y="11" width="3" height="9" rx="1.5" fill="currentColor" opacity="0.6" /><rect x="11" y="10.5" width="9" height="3" rx="1.5" fill="currentColor" opacity="0.8" /></>,
	'mcp-playwright': <><circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M9 10c1-1 2.5-1 3.5 0M9 14c2 1.5 4 1 5-1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" /></>,
	'mcp-atlassian': <><path d="M6 18l6-11 6 11H6z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></>,
	'mcp-brave-search': <><circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M15.5 15.5L20 20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></>,
	'mcp-puppeteer': <><circle cx="9" cy="10" r="1.5" fill="currentColor" /><circle cx="15" cy="10" r="1.5" fill="currentColor" /><rect x="5" y="5" width="14" height="14" rx="7" fill="none" stroke="currentColor" strokeWidth="2" /></>,
	'mcp-sequential-thinking': <><path d="M6 18V6M6 6h6M12 6v6M12 12h6M18 12v6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></>,
	'mcp-memory': <><circle cx="12" cy="6" r="2" fill="currentColor" /><circle cx="6" cy="16" r="2" fill="currentColor" /><circle cx="18" cy="16" r="2" fill="currentColor" /><path d="M11 7.5L7 14.5M13 7.5l4 7M8 16h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
}

// Official brand domains — used to load each vendor's REAL favicon/logo over HTTPS
// (allowed by the workbench CSP img-src). This shows the actual official logo without
// bundling trademarked artwork; the geometric glyph is the offline fallback.
const LOGO_DOMAINS: Record<string, string> = {
	'mcp-context7': 'context7.com',
	'mcp-linear': 'linear.app',
	'mcp-notion': 'notion.so',
	'mcp-github': 'github.com',
	'mcp-sentry': 'sentry.io',
	'mcp-atlassian': 'atlassian.com',
	'mcp-stripe': 'stripe.com',
	'mcp-playwright': 'playwright.dev',
	'mcp-neon': 'neon.tech',
	'mcp-canva': 'canva.com',
	'mcp-huggingface': 'huggingface.co',
	'mcp-deepwiki': 'deepwiki.com',
	'mcp-globalping': 'globalping.io',
	'mcp-figma': 'figma.com',
	'mcp-brave-search': 'brave.com',
	'mcp-slack': 'slack.com',
	'mcp-puppeteer': 'pptr.dev',
}
const faviconFor = (domain: string) => `https://www.google.com/s2/favicons?domain=${domain}&sz=128`

const Logo = ({ id, name, color, text, size = 34, iconUrl }: { id?: string; name: string; color?: string; text?: string; size?: number; iconUrl?: string }) => {
	const bg = color ?? hashColor(name)
	const glyph = id ? BRAND_GLYPHS[id] : undefined
	const domain = id ? LOGO_DOMAINS[id] : undefined
	const officialUrl = iconUrl ?? (domain ? faviconFor(domain) : undefined)
	const [imgFailed, setImgFailed] = useState(false)

	// Official logo: real favicon on a clean neutral tile.
	if (officialUrl && !imgFailed) {
		return (
			<div
				style={{ width: size, height: size }}
				className='flex items-center justify-center rounded-xl flex-shrink-0 shadow-sm select-none ring-1 ring-black/5 bg-white dark:bg-zinc-800 overflow-hidden'
			>
				<img
					src={officialUrl}
					alt={`${name} logo`}
					width={Math.round(size * 0.62)}
					height={Math.round(size * 0.62)}
					style={{ objectFit: 'contain' }}
					onError={() => setImgFailed(true)}
					draggable={false}
				/>
			</div>
		)
	}

	// Fallback: brand-colored tile with a geometric glyph or monogram.
	return (
		<div
			style={{ width: size, height: size, background: `linear-gradient(140deg, ${bg}, color-mix(in srgb, ${bg} 78%, #000))` }}
			className='flex items-center justify-center rounded-xl text-white flex-shrink-0 shadow-sm select-none ring-1 ring-black/5'
		>
			{glyph ? (
				<svg width={size * 0.62} height={size * 0.62} viewBox="0 0 24 24" fill="none" aria-hidden>{glyph}</svg>
			) : (
				<span style={{ fontSize: Math.round(size * 0.38), letterSpacing: '-0.02em', fontWeight: 650 }}>{text ?? initialsOf(name)}</span>
			)}
		</div>
	)
}

// Look up catalog brand metadata for an installed item by name (best-effort).
const CATALOG_BY_NAME = new Map(BUNDLED_MARKETPLACE_CATALOG.map(i => [i.name.toLowerCase(), i]))
const brandFor = (name: string) => CATALOG_BY_NAME.get(name.toLowerCase())

// ─────────────────────────────────────────────────────────────────────────────
// MCP tab
// ─────────────────────────────────────────────────────────────────────────────

const removeUniquePrefix = (name: string) => name.split('_').slice(1).join('_')

const AddMcpDialog = ({ scope, onClose }: { scope: MCPScope; onClose: () => void }) => {
	const accessor = useAccessor()
	const mcpService = accessor.get('IMCPService')
	const notificationService = accessor.get('INotificationService')
	const [transport, setTransport] = useState<'stdio' | 'http'>('stdio')
	const [name, setName] = useState('')
	const [command, setCommand] = useState('')
	const [args, setArgs] = useState('')
	const [url, setUrl] = useState('')
	const [busy, setBusy] = useState(false)

	const onSave = async () => {
		const trimmed = name.trim()
		if (!trimmed) { notificationService.info('Enter a server name.'); return }
		setBusy(true)
		try {
			if (await mcpService.serverExists(trimmed, scope)) {
				notificationService.info(`A server named "${trimmed}" already exists in ${scope} scope.`)
				setBusy(false)
				return
			}
			let entry: MCPConfigFileEntryJSON
			if (transport === 'stdio') {
				if (!command.trim()) { notificationService.info('Enter a command.'); setBusy(false); return }
				entry = { command: command.trim(), args: args.trim() ? args.trim().split(/\s+/) : [] }
			} else {
				if (!url.trim()) { notificationService.info('Enter a URL.'); setBusy(false); return }
				entry = { url: url.trim() as unknown as URL }
			}
			await mcpService.addMCPServer(trimmed, entry, scope)
			notificationService.info(`Added MCP server "${trimmed}".`)
			onClose()
		} catch (err) {
			notificationService.notify({ message: 'Failed to add MCP server', source: err + '', severity: Severity.Error })
			setBusy(false)
		}
	}

	return (
		<div className='rounded-lg border border-void-border-3 bg-void-bg-2 p-4 mb-3'>
			<div className='flex items-center gap-2 mb-3'>
				{(['stdio', 'http'] as const).map(t => (
					<button key={t} onClick={() => setTransport(t)}
						className={`px-2.5 py-1 rounded text-xs transition-colors ${transport === t ? 'bg-[color-mix(in_srgb,var(--void-fg-1)_10%,transparent)] text-void-fg-0' : 'text-void-fg-3 hover:text-void-fg-1'}`}>
						{t === 'stdio' ? 'Command (stdio)' : 'HTTP / URL'}
					</button>
				))}
			</div>
			<div className='flex flex-col gap-2'>
				<VoidSimpleInputBox value={name} onChangeValue={setName} placeholder='Server name (e.g. github)' />
				{transport === 'stdio' ? (
					<>
						<VoidSimpleInputBox value={command} onChangeValue={setCommand} placeholder='Command (e.g. npx)' />
						<VoidSimpleInputBox value={args} onChangeValue={setArgs} placeholder='Args (space-separated, e.g. -y @scope/server)' />
					</>
				) : (
					<VoidSimpleInputBox value={url} onChangeValue={setUrl} placeholder='https://…/mcp' />
				)}
			</div>
			<div className='flex items-center justify-end gap-2 mt-3'>
				<button onClick={onClose} className='px-3 py-1.5 rounded text-xs text-void-fg-3 hover:text-void-fg-1'>Cancel</button>
				<button onClick={onSave} disabled={busy} className='px-3 py-1.5 rounded text-xs bg-[color-mix(in_srgb,var(--void-fg-1)_12%,transparent)] text-void-fg-0 hover:bg-[color-mix(in_srgb,var(--void-fg-1)_18%,transparent)] disabled:opacity-50'>
					{busy ? 'Adding…' : 'Add server'}
				</button>
			</div>
		</div>
	)
}

const McpRow = ({ name, scope, isOn, status, tools, error }: {
	name: string; scope: MCPScope; isOn: boolean; status: string; tools: { name: string; description?: string }[]; error?: string
}) => {
	const accessor = useAccessor()
	const mcpService = accessor.get('IMCPService')
	const notificationService = accessor.get('INotificationService')
	const confirm = useConfirm()
	const cat = brandFor(name)
	const [authing, setAuthing] = useState(false)

	const onAuthenticate = async () => {
		setAuthing(true)
		try {
			const r = await mcpService.authenticateMCPServer(name)
			if (!r.ok) notificationService.info(r.error ? `Authentication failed: ${r.error}` : `Authentication failed for "${name}".`)
		} finally { setAuthing(false) }
	}

	const onRetry = () => mcpService.toggleServerIsOn(name, true)

	const onRemove = async () => {
		const ok = await confirm(
			'Remove MCP server',
			`Remove "${name}" from ${scope === 'project' ? 'this workspace' : 'your user'} config? Any stored OAuth tokens are also cleared.`,
			'Remove'
		)
		if (ok) mcpService.removeMCPServer(name, scope)
	}

	return (
		<div className='px-4 py-3 border-t border-void-border-3 first:border-t-0'>
			<div className='flex items-center gap-3'>
				<Logo id={cat?.id} name={name} color={cat?.brandColor} text={cat?.iconText} />
				<div className='flex flex-col min-w-0 flex-1'>
					<div className='flex items-center gap-2'>
						<span className='text-void-fg-1 text-sm font-medium truncate'>{name}</span>
						<ScopeBadge scope={scope} />
					</div>
					<span className='text-[11px] text-void-fg-4 mt-0.5 flex items-center gap-1'>
						{status === 'error' && <><span className='inline-block w-1.5 h-1.5 rounded-full bg-red-500' /><span className='text-red-400'>Failed to connect</span></>}
						{status === 'loading' && <><RefreshCw className='w-3 h-3 animate-spin' />Connecting…</>}
						{status === 'needs-auth' && <><span className='inline-block w-1.5 h-1.5 rounded-full bg-amber-500' /><span className='text-amber-500'>Authentication required</span></>}
						{status === 'success' && <><span className='inline-block w-1.5 h-1.5 rounded-full bg-emerald-500' />{tools.length} tool{tools.length !== 1 ? 's' : ''}</>}
						{status === 'offline' && <><span className='inline-block w-1.5 h-1.5 rounded-full bg-void-fg-4' />Disabled</>}
					</span>
				</div>
				<div className='flex items-center gap-1.5 flex-shrink-0'>
					{status === 'needs-auth' && (
						<button onClick={onAuthenticate} disabled={authing}
							className='flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium bg-amber-500/15 text-amber-500 hover:bg-amber-500/25 disabled:opacity-50 transition-colors'>
							{authing ? <RefreshCw className='w-3.5 h-3.5 animate-spin' /> : <LogIn className='w-3.5 h-3.5' />}
							{authing ? 'Authenticating…' : 'Authenticate'}
						</button>
					)}
					{status === 'error' && (
						<button onClick={onRetry} title='Retry connection' aria-label='Retry connection'
							className='flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium text-void-fg-2 hover:text-void-fg-0 border border-void-border-3 hover:bg-[color-mix(in_srgb,var(--void-fg-1)_5%,transparent)] transition-colors'>
							<RefreshCw className='w-3.5 h-3.5' /> Retry
						</button>
					)}
					<VoidSwitch value={isOn} size='xs' aria-label={`Enable or disable ${name}`} onChange={() => mcpService.toggleServerIsOn(name, !isOn)} />
					<button className='p-1 rounded text-void-fg-4 hover:text-void-fg-1 transition-colors' title='Edit mcp.json' aria-label='Edit mcp.json' onClick={() => mcpService.revealMCPConfigFile(scope)}>
						<ExternalLink className='w-3.5 h-3.5' />
					</button>
					<button className='p-1 rounded text-void-fg-4 hover:text-red-400 transition-colors' title='Remove' aria-label={`Remove ${name}`} onClick={onRemove}>
						<Trash2 className='w-3.5 h-3.5' />
					</button>
				</div>
			</div>
			{isOn && status === 'success' && tools.length > 0 && (
				<div className='flex flex-wrap gap-1.5 mt-2.5 pl-[46px]'>
					{tools.slice(0, 24).map(tool => (
						<span key={tool.name} className='px-2 py-0.5 text-void-fg-3 rounded text-[11px]' style={{ background: 'color-mix(in srgb, var(--void-fg-1) 5%, transparent)' }}
							data-tooltip-id='void-tooltip' data-tooltip-content={tool.description || ''}>
							{removeUniquePrefix(tool.name)}
						</span>
					))}
				</div>
			)}
			{error && <div className='mt-2 text-xs text-red-400 break-words pl-[46px]'>{error}</div>}
		</div>
	)
}

const McpTab = ({ scope, mcpScope, query, onBrowse }: { scope: OrbitCustomizeScope; mcpScope: MCPScope; query: string; onBrowse: () => void }) => {
	const accessor = useAccessor()
	const mcpService = accessor.get('IMCPService')
	const mcpState = useMCPServiceState()
	const [showAdd, setShowAdd] = useState(false)

	const rows = useMemo(() => {
		return Object.entries(mcpState.mcpServerOfName)
			.filter(([name]) => (mcpState.scopeOfName[name] ?? 'user') === mcpScope)
			.filter(([name]) => !query || name.toLowerCase().includes(query.toLowerCase()))
			.sort((a, b) => a[0].localeCompare(b[0]))
	}, [mcpState, mcpScope, query])

	const workspaceMissing = scope === 'workspace' && !mcpService.hasWorkspaceFolder()

	return (
		<div>
			<div className='flex items-center justify-between mb-3'>
				<div className='text-void-fg-3 text-xs'>{rows.length} server{rows.length !== 1 ? 's' : ''}</div>
				<div className='flex items-center gap-2'>
					<button onClick={onBrowse} className='flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-void-fg-1 border border-void-border-3 hover:bg-[color-mix(in_srgb,var(--void-fg-1)_5%,transparent)]'>
						<Store className='w-3.5 h-3.5' /> Browse Marketplace
					</button>
					<button onClick={() => setShowAdd(v => !v)} disabled={workspaceMissing} className='flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-[color-mix(in_srgb,var(--void-fg-1)_10%,transparent)] text-void-fg-0 hover:bg-[color-mix(in_srgb,var(--void-fg-1)_16%,transparent)] disabled:opacity-40'>
						<Plus className='w-3.5 h-3.5' /> Add
					</button>
				</div>
			</div>
			{showAdd && !workspaceMissing && <AddMcpDialog scope={mcpScope} onClose={() => setShowAdd(false)} />}
			{workspaceMissing ? (
				<EmptyState title='No workspace folder open' description='Open a folder to manage project-scoped MCP servers in .orbit/mcp.json.' />
			) : mcpState.error ? (
				<div className='rounded-lg border border-void-border-3 bg-void-bg-2 px-4 py-3 text-xs text-red-400'>{mcpState.error}</div>
			) : rows.length === 0 ? (
				<EmptyState
					title='No MCP servers yet'
					description={`Add a tool server for ${mcpScope === 'user' ? 'all your projects' : 'this workspace'}, or browse the marketplace.`}
					actionLabel='Add server'
					onAction={() => setShowAdd(true)}
				/>
			) : (
				<div className='rounded-lg border border-void-border-3 bg-void-bg-2 overflow-hidden'>
					{rows.map(([name, server]) => (
						<McpRow key={name} name={name} scope={mcpScope} isOn={mcpState.isOnOfName[name] ?? false}
							status={server.status} tools={server.tools ?? []} error={server.error} />
					))}
				</div>
			)}
		</div>
	)
}

// ─────────────────────────────────────────────────────────────────────────────
// Skills tab
// ─────────────────────────────────────────────────────────────────────────────

const SkillsTab = ({ scope, query, onBrowse }: { scope: OrbitCustomizeScope; query: string; onBrowse: () => void }) => {
	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const notificationService = accessor.get('INotificationService')
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const skillImportService = accessor.get('ISkillImportService')
	const confirm = useConfirm()
	const [skills, setSkills] = useState<SkillDefinition[]>(() => listSkills())
	useEffect(() => onSkillsChanged(() => setSkills(listSkills())), [])

	// User scope: built-in + user + external(global). Workspace scope: project only.
	const filtered = useMemo(() => skills
		.filter(s => scope === 'user' ? (s.source === 'built-in' || s.source === 'user') : s.source === 'project')
		.filter(s => !query || s.name.toLowerCase().includes(query.toLowerCase()) || s.description.toLowerCase().includes(query.toLowerCase())),
		[skills, scope, query])

	const onCreate = async () => {
		try {
			const name = await skillImportService.createNewSkill(scope === 'user' ? 'user' : 'project')
			if (name) notificationService.info(`Created skill "${name}". Edit its SKILL.md to fill it in.`)
		} catch (err) { notificationService.notify({ message: 'Failed to create skill', source: err + '', severity: Severity.Error }) }
	}
	const onImport = async () => {
		try {
			const r = await skillImportService.importFromCursor()
			notificationService.info(r.imported > 0 ? `Imported ${r.imported} skill(s) from Cursor.` : (r.errors[0] ?? 'No Cursor skills found.'))
		} catch (err) { notificationService.notify({ message: 'Failed to import from Cursor', source: err + '', severity: Severity.Error }) }
	}
	const onToggle = (name: string, enabled: boolean) => {
		const current = voidSettingsService.state.globalSettings.disabledSkills ?? []
		const disabled = enabled ? current.filter((n: string) => n !== name) : Array.from(new Set([...current, name]))
		voidSettingsService.setGlobalSetting('disabledSkills', disabled)
	}
	const onDelete = async (skill: SkillDefinition) => {
		const ok = await confirm(
			'Delete skill',
			`Delete the skill "${skill.name}"? This removes its folder and cannot be undone.`,
			'Delete'
		)
		if (!ok) return
		try { if (!(await skillImportService.deleteSkill(skill.filePath))) notificationService.info(`Could not delete "${skill.name}".`) }
		catch (err) { notificationService.notify({ message: `Failed to delete "${skill.name}"`, source: err + '', severity: Severity.Error }) }
	}
	const onOpen = (skill: SkillDefinition) => { if (skill.filePath) commandService.executeCommand('vscode.open', URI.file(skill.filePath)) }

	return (
		<div>
			<div className='flex items-center justify-between mb-3'>
				<div className='text-void-fg-3 text-xs'>{filtered.length} skill{filtered.length !== 1 ? 's' : ''}</div>
				<div className='flex items-center gap-2'>
					<button onClick={onBrowse} className='flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-void-fg-1 border border-void-border-3 hover:bg-[color-mix(in_srgb,var(--void-fg-1)_5%,transparent)]'>
						<Store className='w-3.5 h-3.5' /> Browse Marketplace
					</button>
					{scope === 'user' && (
						<button onClick={onImport} className='px-3 py-1.5 rounded text-xs text-void-fg-3 hover:text-void-fg-1 border border-void-border-3'>Import from Cursor</button>
					)}
					<button onClick={onCreate} className='flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-[color-mix(in_srgb,var(--void-fg-1)_10%,transparent)] text-void-fg-0 hover:bg-[color-mix(in_srgb,var(--void-fg-1)_16%,transparent)]'>
						<Plus className='w-3.5 h-3.5' /> New
					</button>
				</div>
			</div>
			{filtered.length === 0 ? (
				<EmptyState title='No skills yet' description='Skills are reusable instruction packs the agent loads on demand. Create one or install from the marketplace.' actionLabel='New skill' onAction={onCreate} />
			) : (
				<div className='rounded-lg border border-void-border-3 bg-void-bg-2 overflow-hidden'>
					{filtered.map(skill => {
						const deletable = skill.source !== 'built-in' && !skill.external
						const canOpen = !!skill.filePath
						return (
							<div key={skill.filePath || skill.name} className={`group flex items-center gap-3 px-4 py-3 border-t border-void-border-3 first:border-t-0 ${canOpen ? 'cursor-pointer hover:bg-[color-mix(in_srgb,var(--void-fg-1)_4%,transparent)]' : ''} ${skill.enabled ? '' : 'opacity-55'}`}
								onClick={canOpen ? () => onOpen(skill) : undefined}>
								<Logo id={brandFor(skill.name)?.id} name={skill.name} color={brandFor(skill.name)?.brandColor} text={brandFor(skill.name)?.iconText} size={30} />
								<div className='min-w-0 flex-1'>
									<div className='flex items-center gap-2'>
										<span className='text-void-fg-1 text-sm font-medium truncate'>{skill.name}</span>
										{skill.source === 'built-in' && <ScopeBadge scope='built-in' />}
										{skill.external && <ScopeBadge scope='global' />}
									</div>
									<p className='text-void-fg-3 text-xs mt-0.5 line-clamp-2'>{skill.description}</p>
								</div>
					<div className='flex items-center gap-1.5 flex-shrink-0' onClick={e => e.stopPropagation()}>
						<VoidSwitch value={skill.enabled} size='xs' aria-label={`Enable or disable ${skill.name}`} onChange={v => onToggle(skill.name, v)} />
						{deletable && (
							<button className='p-1 rounded text-void-fg-4 opacity-0 group-hover:opacity-100 hover:text-red-400' onClick={() => onDelete(skill)} title='Delete' aria-label={`Delete ${skill.name}`}>
								<Trash2 className='w-3.5 h-3.5' />
							</button>
						)}
					</div>
							</div>
						)
					})}
				</div>
			)}
		</div>
	)
}

// ─────────────────────────────────────────────────────────────────────────────
// Subagents tab
// ─────────────────────────────────────────────────────────────────────────────

const AgentsTab = ({ scope, query }: { scope: OrbitCustomizeScope; query: string }) => {
	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const notificationService = accessor.get('INotificationService')
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const subAgentImportService = accessor.get('ISubAgentImportService')
	const confirm = useConfirm()
	const [agents, setAgents] = useState<ResolvedSubAgentDefinition[]>(() => listSubAgents())
	useEffect(() => onSubAgentsChanged(() => setAgents(listSubAgents())), [])

	const filtered = useMemo(() => agents
		.filter(a => scope === 'user' ? (a.source === 'built-in' || a.source === 'user') : a.source === 'project')
		.filter(a => !query || a.agentType.toLowerCase().includes(query.toLowerCase()) || a.whenToUse.toLowerCase().includes(query.toLowerCase())),
		[agents, scope, query])

	const onCreate = async () => {
		try {
			const name = await subAgentImportService.createNewAgent(scope === 'user' ? 'user' : 'project')
			if (name) notificationService.info(`Created agent "${name}". Edit its .md to fill it in.`)
		} catch (err) { notificationService.notify({ message: 'Failed to create agent', source: err + '', severity: Severity.Error }) }
	}
	const onToggle = async (agentType: string, enabled: boolean) => {
		if (enabled) await voidSettingsService.enableAgent(agentType)
		else await voidSettingsService.disableAgent(agentType)
		setAgents(listSubAgents())
	}
	const onDelete = async (agent: ResolvedSubAgentDefinition) => {
		if (!agent.filePath) return
		const ok = await confirm(
			'Delete subagent',
			`Delete the subagent "${agent.agentType}"? This removes its definition file and cannot be undone.`,
			'Delete'
		)
		if (!ok) return
		try { if (!(await subAgentImportService.deleteAgent(agent.filePath))) notificationService.info(`Could not delete "${agent.agentType}".`) }
		catch (err) { notificationService.notify({ message: `Failed to delete "${agent.agentType}"`, source: err + '', severity: Severity.Error }) }
	}
	const onOpen = (agent: ResolvedSubAgentDefinition) => { if (agent.filePath) commandService.executeCommand('vscode.open', URI.file(agent.filePath)) }

	return (
		<div>
			<div className='flex items-center justify-between mb-3'>
				<div className='text-void-fg-3 text-xs'>{filtered.length} subagent{filtered.length !== 1 ? 's' : ''}</div>
				<button onClick={onCreate} className='flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-[color-mix(in_srgb,var(--void-fg-1)_10%,transparent)] text-void-fg-0 hover:bg-[color-mix(in_srgb,var(--void-fg-1)_16%,transparent)]'>
					<Plus className='w-3.5 h-3.5' /> New
				</button>
			</div>
			{filtered.length === 0 ? (
				<EmptyState title='Delegate work to subagents' description='Subagents are specialized agents the main agent can hand focused tasks to. Create one to get started.' actionLabel='New subagent' onAction={onCreate} />
			) : (
				<div className='rounded-lg border border-void-border-3 bg-void-bg-2 overflow-hidden'>
					{filtered.map(agent => {
						const isBuiltIn = agent.source === 'built-in'
						const canOpen = !!agent.filePath
						return (
							<div key={agent.agentType} className={`group flex items-center gap-3 px-4 py-3 border-t border-void-border-3 first:border-t-0 ${canOpen ? 'cursor-pointer hover:bg-[color-mix(in_srgb,var(--void-fg-1)_4%,transparent)]' : ''} ${agent.enabled ? '' : 'opacity-55'}`}
								onClick={canOpen ? () => onOpen(agent) : undefined}>
								<Logo name={agent.agentType} size={30} />
								<div className='min-w-0 flex-1'>
									<div className='flex items-center gap-2'>
										<span className='text-void-fg-1 text-sm font-medium truncate'>{agent.agentType}</span>
										<ScopeBadge scope={agent.source} />
										{agent.permissionMode && <ScopeBadge scope={agent.permissionMode as any} />}
									</div>
									<p className='text-void-fg-3 text-xs mt-0.5 line-clamp-2'>{agent.whenToUse}</p>
								</div>
					<div className='flex items-center gap-1.5 flex-shrink-0' onClick={e => e.stopPropagation()}>
						<VoidSwitch value={agent.enabled} size='xs' disabled={isBuiltIn} aria-label={`Enable or disable ${agent.agentType}`} onChange={v => onToggle(agent.agentType, v)} />
						{canOpen && (
							<button className='p-1 rounded text-void-fg-4 opacity-0 group-hover:opacity-100 hover:text-red-400' onClick={() => onDelete(agent)} title='Delete' aria-label={`Delete ${agent.agentType}`}>
								<Trash2 className='w-3.5 h-3.5' />
							</button>
						)}
					</div>
							</div>
						)
					})}
				</div>
			)}
		</div>
	)
}

// ─────────────────────────────────────────────────────────────────────────────
// Rules tab
// ─────────────────────────────────────────────────────────────────────────────

const RulesTab = ({ scope }: { scope: OrbitCustomizeScope }) => {
	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const voidSettingsState = useSettingsState()
	const fileService = accessor.get('IFileService')
	const commandService = accessor.get('ICommandService')
	const workspaceContextService = accessor.get('IWorkspaceContextService')

	const folders = workspaceContextService.getWorkspace().folders
	const orbitRulesUri = folders.length > 0 ? URI.joinPath(folders[0].uri, '.orbitrules') : undefined

	const [rulesText, setRulesText] = useState<string>('')
	const [loaded, setLoaded] = useState(false)

	useEffect(() => {
		if (scope !== 'workspace' || !orbitRulesUri) return
		let cancelled = false
		setLoaded(false)
		fileService.readFile(orbitRulesUri)
			.then(c => { if (!cancelled) { setRulesText(c.value.toString()); setLoaded(true) } })
			.catch(() => { if (!cancelled) { setRulesText(''); setLoaded(true) } })
		return () => { cancelled = true }
	}, [scope, orbitRulesUri?.toString()])

	const saveRules = useCallback(async (text: string) => {
		if (!orbitRulesUri) return
		try { await fileService.writeFile(orbitRulesUri, VSBuffer.fromString(text)) } catch { /* non-fatal */ }
	}, [orbitRulesUri?.toString()])

	if (scope === 'user') {
		return (
			<div>
				<div className='text-void-fg-2 text-sm mb-1'>AI Instructions</div>
				<p className='text-void-fg-3 text-xs mb-3'>Global instructions applied to every project. Included in the system prompt on every request.</p>
				<VoidInputBox2
					className='min-h-[160px] p-3 rounded-sm'
					initValue={voidSettingsState.globalSettings.aiInstructions}
					placeholder={`Do not change my indentation or delete my comments. Prefer TypeScript. Keep responses concise.`}
					multiline
					onChangeText={t => voidSettingsService.setGlobalSetting('aiInstructions', t)}
				/>
			</div>
		)
	}

	if (!orbitRulesUri) {
		return <EmptyState title='No workspace folder open' description='Open a folder to edit its .orbitrules file.' />
	}

	return (
		<div>
			<div className='flex items-center justify-between mb-1'>
				<div className='text-void-fg-2 text-sm'>.orbitrules</div>
				<button onClick={() => commandService.executeCommand('vscode.open', orbitRulesUri)} className='flex items-center gap-1.5 px-2.5 py-1 rounded text-xs text-void-fg-3 hover:text-void-fg-1'>
					<ExternalLink className='w-3.5 h-3.5' /> Open in editor
				</button>
			</div>
			<p className='text-void-fg-3 text-xs mb-3'>Project rules for this workspace. Committed with your repo and shared with your team.</p>
			{loaded && (
				<VoidInputBox2
					key={orbitRulesUri.toString()}
					className='min-h-[200px] p-3 rounded-sm'
					initValue={rulesText}
					placeholder={`Project conventions the agent must follow in this repo…`}
					multiline
					onChangeText={saveRules}
				/>
			)}
		</div>
	)
}

// ─────────────────────────────────────────────────────────────────────────────
// Marketplace
// ─────────────────────────────────────────────────────────────────────────────

const MarketplaceCard = ({ item, scope, onInstalled }: { item: MarketplaceItem; scope: OrbitCustomizeScope; onInstalled: () => void }) => {
	const accessor = useAccessor()
	const mcpService = accessor.get('IMCPService')
	const skillImportService = accessor.get('ISkillImportService')
	const notificationService = accessor.get('INotificationService')
	const mcpState = useMCPServiceState()
	const confirm = useConfirm()
	const [busy, setBusy] = useState(false)
	const [installed, setInstalled] = useState(false)
	const [showEnv, setShowEnv] = useState(false)
	const [envVals, setEnvVals] = useState<Record<string, string>>({})
	const [envMissing, setEnvMissing] = useState<Set<string>>(new Set())

	const mcpScope: MCPScope = scope === 'workspace' ? 'project' : 'user'

	// idempotency: MCP already present in the merged server map by name; skill already
	// present in the registry by its folder/name.
	const alreadyThere = item.kind === 'mcp'
		? (!!item.mcp && !!mcpState.mcpServerOfName[item.name])
		: (!!item.skill && listSkills().some(s => s.name === item.skill!.folderName))
	const isInstalled = installed || alreadyThere

	const doInstallMcp = async (env?: Record<string, string>) => {
		if (!item.mcp) return
		setBusy(true)
		try {
			if (await mcpService.serverExists(item.name, mcpScope)) { setInstalled(true); setBusy(false); return }
			const entry: MCPConfigFileEntryJSON = { ...item.mcp }
			if (env && Object.keys(env).length) {
				// env keys map either to env (stdio) or headers (http). Strip empty values
				// so the config file never carries a blank placeholder.
				const clean: Record<string, string> = {}
				for (const [k, v] of Object.entries(env)) { if (v.trim()) clean[k] = v }
				if (entry.command) entry.env = { ...(entry.env ?? {}), ...clean }
				else entry.headers = { ...(entry.headers ?? {}), ...clean }
			}
			await mcpService.addMCPServer(item.name, entry, mcpScope)
			notificationService.info(`Installed MCP server "${item.name}".`)
			setInstalled(true)
			onInstalled()
		} catch (err) {
			notificationService.notify({ message: `Failed to install "${item.name}"`, source: err + '', severity: Severity.Error })
		} finally { setBusy(false) }
	}

	const onAdd = async () => {
		if (item.kind === 'mcp') {
			if (item.requiredEnv?.length) {
				setEnvVals({})
				setEnvMissing(new Set())
				setShowEnv(true)
				return
			}
			await doInstallMcp()
		} else if (item.kind === 'skill' && item.skill) {
			setBusy(true)
			try {
				const skillScope = scope === 'workspace' ? 'project' : 'user'
				let result = await skillImportService.installSkillFromPack(item.skill.folderName, item.skill.skillMd, skillScope)
				if (result === 'exists') {
					const ok = await confirm(
						'Skill already exists',
						`A skill named "${item.skill.folderName}" already exists in ${scope === 'workspace' ? 'this workspace' : 'your user skills'}. Overwrite it? This replaces your SKILL.md.`,
						'Overwrite'
					)
					if (ok) result = await skillImportService.installSkillFromPack(item.skill.folderName, item.skill.skillMd, skillScope, true)
				}
				if (result && result !== 'exists') { notificationService.info(`Installed skill "${result}".`); setInstalled(true); onInstalled() }
				else if (result === null) notificationService.info('Could not install skill (check workspace trust).')
			} catch (err) { notificationService.notify({ message: `Failed to install "${item.name}"`, source: err + '', severity: Severity.Error }) }
			finally { setBusy(false) }
		}
	}

	const onAuthenticate = async () => {
		setBusy(true)
		try {
			const r = await mcpService.authenticateMCPServer(item.name)
			if (!r.ok) notificationService.info(r.error ? `Authentication failed: ${r.error}` : `Authentication failed for "${item.name}".`)
		} finally { setBusy(false) }
	}

	// Live server state (for MCP) to drive the Add → Authenticate → Installed flow.
	const serverState = item.kind === 'mcp' ? mcpState.mcpServerOfName[item.name] : undefined
	const needsAuth = serverState?.status === 'needs-auth'

	const AuthChip = () => {
		if (item.kind !== 'mcp' || !item.auth || item.auth === 'none') return null
		const isOAuth = item.auth === 'oauth'
		return (
			<span className='inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded text-void-fg-3' style={{ background: 'color-mix(in srgb, var(--void-fg-1) 6%, transparent)' }}>
				{isOAuth ? <ShieldCheck className='w-3 h-3' /> : <KeyRound className='w-3 h-3' />}
				{isOAuth ? 'OAuth' : 'API key'}
			</span>
		)
	}

	const onEnvInstall = () => {
		const missing = new Set<string>()
		for (const f of item.requiredEnv ?? []) {
			if (!(envVals[f.key] ?? '').trim()) missing.add(f.key)
		}
		if (missing.size) {
			setEnvMissing(missing)
			notificationService.info('Please fill in all required fields.')
			return
		}
		setShowEnv(false)
		void doInstallMcp(envVals)
	}

	const cancelEnv = () => {
		setShowEnv(false)
		setEnvVals({})
		setEnvMissing(new Set())
	}

	const Action = () => {
		if (needsAuth) {
			return (
				<button onClick={onAuthenticate} disabled={busy}
					className='flex items-center gap-1 px-3 py-1 rounded text-xs font-medium bg-amber-500/15 text-amber-500 hover:bg-amber-500/25 disabled:opacity-50 transition-colors'>
					{busy ? <RefreshCw className='w-3.5 h-3.5 animate-spin' /> : <LogIn className='w-3.5 h-3.5' />}
					{busy ? 'Authenticating…' : 'Authenticate'}
				</button>
			)
		}
		if (isInstalled) {
			return <span className='flex items-center gap-1 text-xs text-emerald-500'><Check className='w-3.5 h-3.5' /> Installed</span>
		}
		return (
			<button onClick={onAdd} disabled={busy} className='flex items-center gap-1 px-3 py-1 rounded text-xs bg-[color-mix(in_srgb,var(--void-fg-1)_12%,transparent)] text-void-fg-0 hover:bg-[color-mix(in_srgb,var(--void-fg-1)_18%,transparent)] disabled:opacity-50 transition-colors'>
				<Plus className='w-3.5 h-3.5' /> {busy ? 'Adding…' : 'Add'}
			</button>
		)
	}

	return (
		<div className='rounded-xl border border-void-border-3 bg-void-bg-2 p-4 flex flex-col hover:border-[color-mix(in_srgb,var(--void-fg-1)_18%,transparent)] transition-colors'>
			<div className='flex items-start gap-3'>
				<Logo id={item.id} name={item.name} color={item.brandColor} text={item.iconText} size={38} />
				<div className='min-w-0 flex-1'>
					<div className='flex items-center gap-2'>
						<span className='text-void-fg-1 text-sm font-semibold truncate'>{item.name}</span>
						<AuthChip />
					</div>
					<span className='text-[10px] uppercase tracking-wide text-void-fg-4'>{item.kind === 'mcp' ? 'MCP server' : 'Skill'}</span>
				</div>
			</div>
			<p className='text-void-fg-3 text-xs mt-2.5 line-clamp-3 flex-1 leading-relaxed'>{item.description}</p>
			<div className='flex items-center justify-between mt-3 gap-2'>
				<div className='flex flex-wrap gap-1 min-w-0 items-center'>
					{(item.tags ?? []).slice(0, 3).map(t => (
						<span key={t} className='px-1.5 py-0.5 text-[10px] text-void-fg-4 rounded truncate' style={{ background: 'color-mix(in srgb, var(--void-fg-1) 5%, transparent)' }}>{t}</span>
					))}
					{item.homepage && <HomepageLink url={item.homepage} />}
				</div>
				<div className='flex-shrink-0'><Action /></div>
			</div>
			{needsAuth && (
				<div className='mt-2 text-[11px] text-amber-500/90'>Added — sign in to finish connecting.</div>
			)}
			{showEnv && item.requiredEnv?.length && (
				<div className='mt-3 pt-3 border-t border-void-border-3 flex flex-col gap-2'>
					<div className='text-void-fg-3 text-xs'>Configure required values:</div>
					{item.requiredEnv.map(f => {
						const isMissing = envMissing.has(f.key)
						return (
							<div key={f.key}>
								<div className={`rounded border ${isMissing ? 'border-red-500/60' : 'border-void-border-3'}`}>
									<VoidSimpleInputBox value={envVals[f.key] ?? ''} passwordBlur={f.secret}
										onChangeValue={v => { setEnvVals(s => ({ ...s, [f.key]: v })); if (isMissing) setEnvMissing(m => { const n = new Set(m); n.delete(f.key); return n }) }}
										placeholder={f.label ?? f.key} />
								</div>
								{f.description && <div className='text-[10px] text-void-fg-4 mt-1'>{f.description}</div>}
								{isMissing && <div className='text-[10px] text-red-400 mt-1'>This field is required.</div>}
							</div>
						)
					})}
					<div className='flex items-center justify-end gap-2'>
						<button onClick={cancelEnv} className='px-2.5 py-1 rounded text-xs text-void-fg-3 hover:text-void-fg-1'>Cancel</button>
						<button onClick={onEnvInstall} disabled={busy} className='px-2.5 py-1 rounded text-xs bg-[color-mix(in_srgb,var(--void-fg-1)_12%,transparent)] text-void-fg-0 disabled:opacity-50'>
							{busy ? 'Installing…' : 'Install'}
						</button>
					</div>
				</div>
			)}
		</div>
	)
}

// A small, accessible homepage link for marketplace cards.
const HomepageLink = ({ url }: { url: string }) => {
	const accessor = useAccessor()
	const openerService = accessor.get('IOpenerService')
	return (
		<button
			onClick={() => openerService.open(URI.parse(url))}
			title={url}
			aria-label={`Open homepage for ${url}`}
			className='inline-flex items-center p-0.5 rounded text-void-fg-4 hover:text-void-fg-1 transition-colors'>
			<ExternalLink className='w-3 h-3' />
		</button>
	)
}

const Marketplace = ({ scope, onBack }: { scope: OrbitCustomizeScope; onBack: () => void }) => {
	const accessor = useAccessor()
	const catalog = accessor.get('IMarketplaceCatalogService')
	const [filter, setFilter] = useState<MarketplaceFilter>('all')
	const [query, setQuery] = useState('')
	const [categories, setCategories] = useState<MarketplaceCategory[]>([])
	const [results, setResults] = useState<MarketplaceItem[] | null>(null)

	useEffect(() => { catalog.getCategories().then(setCategories).catch(() => setCategories([])) }, [catalog])

	// Debounce the search so each keystroke doesn't trigger a catalog query — important
	// once a remote catalog backend is wired in. A 200ms lead edge is enough to feel
	// instant while collapsing rapid typing.
	const debouncedQuery = useDebouncedValue(query, 200)

	useEffect(() => {
		const q = debouncedQuery.trim()
		// Empty query: always show the categorized browse view (which already respects the
		// kind filter via shownCategories). Only run an actual search when there's a query.
		if (!q) { setResults(null); return }
		let cancelled = false
		catalog.search(q, filter).then(r => { if (!cancelled) setResults(r) }).catch(() => { if (!cancelled) setResults([]) })
		return () => { cancelled = true }
	}, [catalog, debouncedQuery, filter])

	const shownCategories = useMemo(() => {
		if (filter === 'all') return categories
		return categories.map(c => ({ ...c, items: c.items.filter(i => i.kind === filter) })).filter(c => c.items.length)
	}, [categories, filter])

	return (
		<div>
			<div className='flex items-center gap-2 mb-4'>
				<button onClick={onBack} className='flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs text-void-fg-3 hover:text-void-fg-1' aria-label='Back to manage'>
					<ArrowLeft className='w-3.5 h-3.5' /> Manage
				</button>
				<div className='flex items-center gap-2 flex-1 px-2 py-1.5 rounded border border-void-border-3'>
					<Search className='w-3.5 h-3.5 text-void-fg-4' />
					<input value={query} onChange={e => setQuery(e.target.value)} placeholder='Search the marketplace…'
						aria-label='Search the marketplace'
						className='flex-1 bg-transparent outline-none text-xs text-void-fg-0 placeholder:text-void-fg-3' />
				</div>
				<div className='inline-flex rounded border border-void-border-3 overflow-hidden text-xs' role='group' aria-label='Filter marketplace by kind'>
					{(['all', 'mcp', 'skill'] as const).map(f => (
						<button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
							className={`px-3 py-1.5 border-l first:border-l-0 border-void-border-3 ${filter === f ? 'bg-[color-mix(in_srgb,var(--void-fg-1)_10%,transparent)] text-void-fg-0' : 'text-void-fg-3 hover:text-void-fg-1'}`}>
							{f === 'all' ? 'All' : f === 'mcp' ? 'MCPs' : 'Skills'}
						</button>
					))}
				</div>
			</div>

			{results !== null ? (
				results.length === 0 ? (
					<div className='text-void-fg-3 text-sm px-1 py-8 text-center'>No results for "{debouncedQuery.trim()}".</div>
				) : (
					<div className='grid grid-cols-1 md:grid-cols-2 gap-3'>
						{results.map(item => <MarketplaceCard key={item.id} item={item} scope={scope} onInstalled={() => {}} />)}
					</div>
				)
			) : shownCategories.length === 0 ? (
				<div className='text-void-fg-3 text-sm px-1 py-8 text-center'>No items for this filter.</div>
			) : (
				<div className='flex flex-col gap-6'>
					{shownCategories.map(cat => (
						<div key={cat.id}>
							<div className='text-void-fg-2 text-sm font-medium mb-2'>{cat.title}</div>
							<div className='grid grid-cols-1 md:grid-cols-2 gap-3'>
								{cat.items.map(item => <MarketplaceCard key={item.id} item={item} scope={scope} onInstalled={() => {}} />)}
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	)
}

// ─────────────────────────────────────────────────────────────────────────────
// App shell
// ─────────────────────────────────────────────────────────────────────────────

const CustomizeInner = () => {
	const isDark = useIsDark()
	const accessor = useAccessor()
	const workspaceContextService = accessor.get('IWorkspaceContextService')
	const folders = workspaceContextService.getWorkspace().folders
	const workspaceAvailable = folders.length > 0
	const workspaceLabel = workspaceAvailable ? folders[0].name : 'Workspace'

	const pending = useMemo(() => consumePendingOrbitCustomize(), [])
	const [tab, setTab] = useState<OrbitCustomizeTab>(pending?.tab ?? 'mcp')
	const [scope, setScope] = useState<OrbitCustomizeScope>(pending?.scope && (pending.scope === 'user' || workspaceAvailable) ? pending.scope : 'user')
	const [view, setView] = useState<OrbitCustomizeView>(pending?.view ?? 'manage')
	const [query, setQuery] = useState('')

	const mcpScope: MCPScope = scope === 'workspace' ? 'project' : 'user'

	return (
		<div className={`@@void-scope ${isDark ? 'dark' : ''}`} style={{ height: '100%', width: '100%' }}>
			<div className='w-full h-full overflow-y-auto bg-void-bg-1 text-void-fg-1'>
				<div className='max-w-4xl mx-auto px-6 py-6'>
				<div className='flex items-center justify-between mb-1'>
					<h1 className='text-lg font-semibold text-void-fg-0'>Customize</h1>
					<ScopeToggle scope={scope} setScope={setScope} workspaceLabel={workspaceLabel} workspaceAvailable={workspaceAvailable} />
				</div>
				<p className='text-void-fg-3 text-xs mb-4'>Manage MCP servers, skills, subagents, and rules — for {scope === 'user' ? 'all your projects' : 'this workspace'}.</p>

				{view === 'marketplace' ? (
					<Marketplace scope={scope} onBack={() => setView('manage')} />
				) : (
					<>
						<div className='flex items-center justify-between mb-4 gap-3 flex-wrap'>
							<TabPills tab={tab} setTab={setTab} />
							<div className='flex items-center gap-2 flex-1 min-w-[180px] max-w-xs px-2 py-1.5 rounded border border-void-border-3'>
								<Search className='w-3.5 h-3.5 text-void-fg-4' />
								<input value={query} onChange={e => setQuery(e.target.value)} placeholder={`Search ${TAB_META.find(t => t.tab === tab)?.label ?? ''}…`}
									className='flex-1 bg-transparent outline-none text-xs text-void-fg-0 placeholder:text-void-fg-3' />
							</div>
						</div>
						{tab === 'mcp' && <McpTab scope={scope} mcpScope={mcpScope} query={query} onBrowse={() => setView('marketplace')} />}
						{tab === 'skills' && <SkillsTab scope={scope} query={query} onBrowse={() => setView('marketplace')} />}
						{tab === 'agents' && <AgentsTab scope={scope} query={query} />}
						{tab === 'rules' && <RulesTab scope={scope} />}
					</>
				)}
				</div>
			</div>
		</div>
	)
}

export const CustomizeApp = () => (
	<ErrorBoundary>
		<CustomizeInner />
	</ErrorBoundary>
)
