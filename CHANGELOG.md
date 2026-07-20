# Changelog

All notable changes to Orbit Editor are documented here.

## 0.4.0

### 🚀 Orbit Provider — sign in, pick a model, start coding

Orbit Provider is now the first-class way to use Orbit without bringing your own API keys. Sign in with **GitHub**, and Orbit loads the models your account has access to — no key to paste, no extra setup.

- **GitHub sign-in.** Settings → Providers opens with a dedicated **Orbit Provider** section at the top. Click **Sign in with GitHub**, finish in your browser, and you're back in the editor. Your session stays on your machine.
- **Live model list.** After sign-in, Orbit pulls your available models automatically. Hit **Refresh models** any time to get the latest catalog.
- **Profile footer.** When signed in, the chat sidebar footer shows your GitHub avatar, plan, and remaining credits — matching what you see in Settings.

### 💳 Billing & usage

- **Wallet balance in the editor.** See your remaining credits in Settings → Account and in the chat profile footer. A low-balance warning appears before you run out mid-session.
- **Plan-aware UI.** Free, Pro, and other plan labels are shown consistently across settings and the sidebar.
- **Billing on the web.** **Billing & usage** opens your account page for top-ups, invoices, and subscription management.

### 🎛️ Settings & providers

- **Orbit Provider featured at the top.** The Providers tab separates Orbit Provider from *Bring your own provider* (Anthropic, OpenAI, OpenRouter, ChatGPT, SuperGrok, etc.) and **Local** (Ollama, vLLM, LM Studio).
- **Models tab ordering.** Orbit Provider models appear at the top of the Models list when you are signed in.

### 🛠️ Reliability

- **Balance stays in sync.** Refreshing your wallet balance in Settings updates the sidebar footer too — one source of truth, no stale numbers.
- **Windows SuperGrok sign-in.** If browser sign-in doesn't complete on Windows, Orbit offers a device-code option so you can still connect your subscription.
- **Safer sign-out.** Signing out of Orbit Provider clears your session and revokes access cleanly.

### macOS install

- **Recommended (no Gatekeeper warning):**
  ```bash
  curl -fsSL https://raw.githubusercontent.com/ashish200729/orbiteditor/main/install.sh | bash
  ```
- **Or download the `.dmg`** from the release, drag Orbit to Applications, then run once:
  ```bash
  xattr -cr /Applications/Orbit.app
  ```
  (Orbit isn't notarized by Apple yet, so a browser-downloaded `.dmg` shows a one-time "unverified developer" prompt; the command above clears it.)

## 0.3.0

### ⚡ Grok through your xAI subscription

Sign in to xAI with your **SuperGrok** or eligible **X Premium** subscription and use **Composer 2.5** and **Grok 4.5** directly in Orbit — no xAI API key required.

- **OAuth sign-in.** Add the *xAI – SuperGrok Subscription* provider in Settings → Providers (or during onboarding) and authenticate in your browser. Orbit stores and refreshes the tokens for you.
- **Subscription models.** Composer 2.5 and Grok 4.5 are available straight from the subscription. If your plan doesn't include Grok API access, Orbit says so and lets you connect an xAI API key instead — no dead ends.
- **Usage aware.** Your weekly and monthly subscription usage is surfaced so you can keep an eye on limits.

### 🎛️ Primary bar & title bar refinements

Cleaner, more focused workbench chrome that matches modern editor conventions.

- **Redesigned "Additional Views" menu.** The primary activity-bar overflow (the chevron) is now a premium, attached dropdown. Each view shows its icon, name, keyboard shortcut, and a pin toggle — pinned views stay marked, unpinned ones reveal their pin on hover. It's fully keyboard-navigable, sensibly ordered, and lists only real navigators (empty/contextual containers like *References* no longer clutter it).
- **Testing moved to the bottom panel.** The Testing view now lives in the bottom panel (bottom-right) instead of the primary sidebar, keeping the activity bar focused on core navigation.
- **Simpler title bar.** Removed the account icon and the duplicate built-in settings gear from the title bar — Orbit's own settings gear is now the single settings entry point.

### Bug fixes

- Fixed a crash that could leave the Additional Views menu empty or broken (an invalid icon class threw while the menu was being built).

### macOS install

- **Recommended (no Gatekeeper warning):**
  ```bash
  curl -fsSL https://raw.githubusercontent.com/ashish200729/orbiteditor/main/install.sh | bash
  ```
- **Or download the `.dmg`** from the release, drag Orbit to Applications, then run once:
  ```bash
  xattr -cr /Applications/Orbit.app
  ```
  (Orbit isn't notarized by Apple yet, so a browser-downloaded `.dmg` shows a one-time "unverified developer" prompt; the command above clears it.)

## 0.2.2

### 🔍 Semantic Codebase Search

Agents can now search your codebase by **meaning**, not just by keywords. Turn it on in Settings → Tools → **Semantic Codebase Search**, point it at a local embedding model (Ollama with `nomic-embed-text`, for instance), and Orbit builds a private per-workspace index of your source code. Once indexed, the agent's `CodebaseSearch` tool finds relevant files, functions, and patterns from a natural-language description — no need to know the exact identifier or grep for the right string.

- **Works locally and privately.** Use Ollama on the same machine and all indexing stays on your hardware. OpenAI-compatible endpoints (OpenAI, vLLM, etc.) are also supported if you prefer a remote model; data is sent to whichever provider you configure.
- **Agents use it automatically.** When the agent needs to find a concept, architecture pattern, or implementation detail (`CodebaseSearch`), it falls back to `Grep` or `Glob` for exact searches and `Read` for digging into results.
- **Fast incremental updates.** After the initial index, Orbit watches your files and re-indexes only the changed ones in the background — saves, creates, deletes, and renames all update the index within about a second.
- **Control what gets indexed.** Orbit respects your existing search exclusions and `.gitignore` patterns. Add a `.orbitignore` file at the workspace root for indexing-specific exclusions:
  ```gitignore
  private/
  fixtures/generated/**
  *.generated.ts
  ```
- **Resilient to interruptions.** If the embedding provider goes down mid-index, the last valid index is preserved and agents fall back to `Grep`, `Glob`, and `Read` with a graceful message — no hard-failing tools.
- **Index state visible in Settings.** An in-settings status panel shows the indexing phase (scanning / embedding / saving), file progress, the current file being processed, and a summary of indexed files and chunks once ready.

**Note:** Semantic indexing is disabled by default and requires a trusted workspace. Enable it in Settings → Tools → Semantic Codebase Search, then configure an embedding endpoint and model.

### Bug fixes

- Fixed a bug where toggling semantic search off and back on would re-embed the entire codebase instead of reusing the cached index from disk.
- Fixed a bug where changing the embedding model/provider while search was enabled could produce an index with vectors from two different models, making rankings meaningless.
- Fixed an indexing progress counter inaccuracy for files larger than the 512 KiB size limit.

### macOS install

- **Recommended (no Gatekeeper warning):**
  ```bash
  curl -fsSL https://raw.githubusercontent.com/ashish200729/orbiteditor/main/install.sh | bash
  ```
- **Or download the `.dmg`** from the release, drag Orbit to Applications, then run once:
  ```bash
  xattr -cr /Applications/Orbit.app
  ```
  (Orbit isn't notarized by Apple yet, so a browser-downloaded `.dmg` shows a one-time "unverified developer" prompt; the command above clears it.)

## 0.2.1

### Customize hub and Marketplace

A new **Customize** view brings MCP servers, Skills, Subagents, and Rules into one place, with a **User** (global) and **Workspace** (this project) scope for each. Open it from the chat-history sidebar, the Command Palette (`Orbit: Open Customize`), or the settings-gear menu.

- **Marketplace**: browse or search a curated catalog of MCP servers (Context7, Linear, Notion, GitHub, Sentry, Atlassian, Stripe, Playwright, Neon, Canva, Hugging Face, DeepWiki, Globalping, Figma, Brave Search, Slack, Puppeteer, and more) and ready-made Skills (Conventional Commits, PR Description Writer, Test Writer, Debugging Methodology, API Design Review). Install with one click; servers that need a token prompt for it before connecting.
- **Project-scoped MCP servers**: a workspace can now define its own `.orbit/mcp.json`, separate from the global `~/.orbit-editor/mcp.json`. Project servers override a user server of the same name, each shows a scope badge, and enabling/disabling a project server only affects that workspace.
- **Project-scoped Skills and Subagents**: skills and subagents can now live in `<workspace>/.orbit/skills` and `<workspace>/.orbit/agents` in addition to the existing user-level directories, gated on workspace trust.
- **OAuth sign-in for MCP servers**: remote MCP servers that require a login (Linear, Notion, Sentry, Atlassian, Neon, Canva) now support an in-app **Authenticate** flow — Orbit opens your browser, completes the login over a local loopback redirect with PKCE, and stores the resulting tokens encrypted at rest.
- **Rules**: edit global AI Instructions or a workspace's `.orbitrules` file directly from Customize.

### Reliability and hardening

- MCP server state is now merged correctly across user and project scopes, including enable/disable persistence and live config-file watching for both `mcp.json` locations.
- Config file watchers are rebuilt cleanly when workspace folders change, so switching projects can no longer leave a stale watch handle behind.
- Reviewed the full MCP OAuth and Marketplace implementation for security issues prior to release: the OAuth loopback server is bound to localhost only, each login flow is bound to its own PKCE verifier, stored tokens are encrypted via the OS keychain where available, and all skill/subagent file deletes are guarded to only ever touch paths inside a `.orbit/skills` or `.orbit/agents` directory.

### macOS install

- **Recommended (no Gatekeeper warning):**
  ```bash
  curl -fsSL https://raw.githubusercontent.com/ashish200729/orbiteditor/main/install.sh | bash
  ```
- **Or download the `.dmg`** from the release, drag Orbit to Applications, then run once:
  ```bash
  xattr -cr /Applications/Orbit.app
  ```
  (Orbit isn't notarized by Apple yet, so a browser-downloaded `.dmg` shows a one-time "unverified developer" prompt; the command above clears it.)

## 0.2.0

### 🧵 Send while the agent is working

You can now type and send follow-up messages while the agent is still running, Cursor-style — they queue up and are sent in order once the current turn finishes. Each queued message snapshots its attachments and selection at the moment you hit send (not whatever's selected later), a failed turn pauses the queue instead of losing it, and queued messages now survive an app reload as "paused" rather than vanishing.

### 🧠 Automatic context compaction for long threads

When a long-running thread gets close to the model's context limit, Orbit now automatically summarizes older turns via a dedicated LLM call and keeps going instead of hitting a hard wall. The summarization boundary always snaps to a user-message so a tool call and its result are never split apart.

### ⚡ Smoother scrolling on long streaming responses

Chat markdown and inline diffs were re-computing from scratch on every streamed chunk, which made very long responses and large diffs get progressively jankier as they grew. Completed markdown blocks and diffs are now memoized/computed once instead of on every chunk, so long agent turns and big diffs stay smooth to scroll through.

### 🪟 Agents window polish

- Dialogs, menus, and the command palette opened from the standalone Agents window now correctly resolve to that window instead of raising the main IDE window behind it.
- The Files panel keeps its expand state and exclude-list cache correct across renames instead of drifting stale.
- Further fixes to the white-flash that could briefly appear when opening the Agents window.

### 🔒 Security & reliability fixes

- Fixed an IPv6 gap in the agent's browser-tool SSRF guard that could let it reach cloud-metadata addresses (e.g. AWS's IPv6 metadata endpoint) even though the IPv4 equivalent was already blocked.
- Fixed a git "discard changes" bug where one file failing partway through a multi-file discard could leave earlier files already reverted with no indication of which ones.
- Fixed MCP tool routing so a configured MCP server's own tool literally named `read_file` is no longer misrouted through the built-in Read tool's parameter handling.
- Fixed a race where a truncated terminal command's "full output" file path could be handed to the agent before the file had actually finished writing.
- Widened the environment variables passed to MCP servers so proxy settings, custom CA bundles, and common language-runtime variables (PYTHONPATH, GOPATH, NVM, etc.) are no longer silently stripped.
- Long-thinking / extended-reasoning models get a longer stream idle-timeout so they're no longer aborted mid-turn during a long silent thinking phase.
- Fixed a bookkeeping bug where two genuinely parallel, identical Gemini tool calls (both missing an id) could collapse into a single call.
- Hardened the Agents-window pane-divider drag so a fast drag that slips off the thin divider strip can no longer get stuck.
- Workspace-trust is now checked before project-scoped skills and sub-agents are loaded.
- Plan and skill documents now save via atomic write + lock so a crash or race can no longer leave a corrupted or partially-written file.

### macOS install

- **Recommended (no Gatekeeper warning):**
  ```bash
  curl -fsSL https://raw.githubusercontent.com/ashish200729/orbiteditor/main/install.sh | bash
  ```
- **Or download the `.dmg`** from the release, drag Orbit to Applications, then run once:
  ```bash
  xattr -cr /Applications/Orbit.app
  ```
  (Orbit isn't notarized by Apple yet, so a browser-downloaded `.dmg` shows a one-time "unverified developer" prompt; the command above clears it.)

## 0.1.4

### 🪟 The Agents window — a full workspace, popped out

Orbit now has a dedicated **Agents window** you can open alongside the editor: a standalone workspace where the AI agent has its own room to work. It's built as five columns you can move between fluidly:

- **Files** — a live file tree of your project, so you can see what the agent is touching without leaving the window.
- **Editor** — a real code editor pane for opening and reading files the agent references.
- **Changes** — a full Git view showing exactly what the agent changed, now with a clean **side-by-side split diff** so additions and deletions line up the way you expect.
- **Terminal** — an integrated terminal in the same window, so commands and their output stay next to the work.
- **Browser** — the agent-driven browser (from 0.1.2) available right inside the Agents window.

Everything lives in one detachable window with a Cursor-style column layout, so you can watch the agent think, edit, run, and browse — all in one place — while your main editor stays uncluttered.

### 🐛 Fixes

- **Browser view white screen** — fixed a blank white page that could appear when the integrated browser opened; pages now paint immediately.
- **Changes split-diff layout** — the Changes tab's side-by-side diff now lays out correctly instead of collapsing or overlapping columns.
- **White-frame flash on window open** — the Agents window no longer shows a stale white frame before its content paints. Cross-document node adoption was skipping the initial compositor raster; the shell now forces a fresh paint once both the native chrome and React content are mounted.
- **White-sheet tooltip bug** — fixed a case where the tooltip layer could promote to an opaque white compositor layer and blank the main window; the tooltip container is now sized 0×0 with pointer-events disabled so it can never cover the UI.

### macOS install

- **Recommended (no Gatekeeper warning):**
  ```bash
  curl -fsSL https://raw.githubusercontent.com/ashish200729/orbiteditor/main/install.sh | bash
  ```
- **Or download the `.dmg`** from the release, drag Orbit to Applications, then run once:
  ```bash
  xattr -cr /Applications/Orbit.app
  ```
  (Orbit isn't notarized by Apple yet, so a browser-downloaded `.dmg` shows a one-time "unverified developer" prompt; the command above clears it.)

## 0.1.3

### 🔒 Plan mode safety

Plan mode no longer lets the agent edit files or run shell commands after presenting a plan unless you explicitly click **Build**. StrReplace, Write, and Shell were previously reachable through guard gaps; those paths are now blocked at both the tool-policy and runtime layers.

### ✨ Tool approval redesign

Tool approval cards (shell, edits, AskQuestion, and more) now use a compact **Skip · Always Run · Run** button cluster aligned with the rest of Orbit's UI — clearer actions, tighter headers, and theme-aware focus states.

### 🖥️ Shell command card polish

The shell tool card now matches edit-tool cards: shimmer animation applies **only to the title text** while a command runs (no full-card sweep), meta tags render as pills, and collapsed/expanded states share one consistent card layout.

### 🐛 Fixes

- **GLM 5.2 and OpenAI-compatible providers** — fixed streaming tool-call fragmentation that caused `path was null` errors when using models like GLM 5.2; argument accumulation and param normalization are now reliable across providers.
- **Plan card in chat** — compact preview (2-line overview, capped todo list) without awkward scrolling.
- **Chat text selection** — fixed highlight overlay breaking selection in the chat input when long messages were truncated.

### macOS install

- **Recommended (no Gatekeeper warning):**
  ```bash
  curl -fsSL https://raw.githubusercontent.com/ashish200729/orbiteditor/main/install.sh | bash
  ```
- **Or download the `.dmg`** from the release, drag Orbit to Applications, then run once:
  ```bash
  xattr -cr /Applications/Orbit.app
  ```
  (Orbit isn't notarized by Apple yet, so a browser-downloaded `.dmg` shows a one-time "unverified developer" prompt; the command above clears it.)

## 0.1.2

### 🌐 A browser your agent can actually use

Orbit now has a real, built-in browser that the AI agent drives for you — no setup, no separate steps.

- **It opens itself when the agent needs it.** Ask the agent to "open cursor.com" or "go to a site and check something," and a browser tab appears, loads the page, and the agent takes over from there. If nothing is open yet, Orbit opens it automatically — you never have to open the browser first.
- **No interruptions.** The agent can open pages and work in the browser without stopping to ask for permission every step, so tasks flow start to finish.
- **The agent can see and act on the page.** It reads what's on screen and can navigate, click, type, fill forms, scroll, and capture screenshots — across multiple tabs — to get things done.
- **You can jump in anytime.** When the agent is driving a tab, a **Take Control** button lets you grab the wheel instantly.
- **Stays signed in.** Tabs keep your logins between sessions, so you're not re-authenticating every time.

### 🐛 Fixes

- **Browser tabs now render reliably.** Fixed a black screen that could appear when opening a browser tab — pages now show up right away.
- **Smoother agent hand-off to the browser.** Opening a page from the agent is now instant and dependable instead of occasionally stalling.
- **Cleaner chat input.** Removed the extra label from the chat toolbar for a tidier, simpler input area.

### macOS install

- **Recommended (no Gatekeeper warning):**
  ```bash
  curl -fsSL https://raw.githubusercontent.com/ashish200729/orbiteditor/main/install.sh | bash
  ```
- **Or download the `.dmg`** from the release, drag Orbit to Applications, then run once:
  ```bash
  xattr -cr /Applications/Orbit.app
  ```
  (Orbit isn't notarized by Apple yet, so a browser-downloaded `.dmg` shows a one-time "unverified developer" prompt; the command above clears it.)

## 0.1.1

- Integrated browser and earlier improvements.

## 0.1.0

- Initial public beta of Orbit Editor for macOS (Apple Silicon and Intel).
