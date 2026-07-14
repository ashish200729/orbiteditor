# Customize & Marketplace

The **Customize** hub is a main-window editor tab for managing what the agent can use:
MCP servers, Skills, Subagents, and Rules — at either **User** (global) or **Workspace**
(this folder) scope. It also hosts a **Marketplace** for one-click installs.

## Opening

- Chat-history sidebar → **Customize** button (main window only; hidden in the pop-out Agent window).
- Command Palette → **Orbit: Open Customize** / **Orbit: Open Marketplace**.
- Settings gear (bottom-left) → **Customize**.

Command IDs: `workbench.action.openVoidCustomize`, `workbench.action.openVoidMarketplace`.

## Scope & file locations

| Concern | User scope | Workspace scope |
|---------|-----------|-----------------|
| MCP | `~/.orbit-editor/mcp.json` | `<folder>/.orbit/mcp.json` |
| Skills | `~/.orbit/skills/<name>/SKILL.md` | `<folder>/.orbit/skills/<name>/SKILL.md` |
| Subagents | `~/.orbit/agents/<type>.md` | `<folder>/.orbit/agents/<type>.md` |
| Rules | AI Instructions (global setting) | `<folder>/.orbitrules` |

**MCP merge:** user + project configs are merged by server name; a project server
overrides a user server with the same name. Each server shows a scope badge. Enabling a
user server persists globally; enabling a project server persists per-workspace so it
doesn't leak across folders.

**Skill/Subagent disable** is global by name (built-ins can't be disabled).

## Marketplace

Browse or search curated MCP servers and Skills, filter by type, and **Add** into the
current scope. MCP servers that need secrets (tokens, headers) prompt for those values
before install. Already-installed items show **Installed**.

The catalog is bundled (`common/marketplace/catalog.ts`) behind
`IMarketplaceCatalogService`; a remote backend can replace the source without UI changes.

## Safety

- Project-scoped skill/agent installs require workspace trust.
- Skill/agent deletes are guarded to only touch `.orbit/skills` and `.orbit/agents` paths.
- stdio MCP servers run with a minimal, allowlisted environment plus their declared `env`.
