# Changelog

All notable changes to Orbit Editor are documented here.

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
