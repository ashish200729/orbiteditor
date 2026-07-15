# Orbit Codebase Guide

The Orbit codebase is not as intimidating as it seems!

Most of Orbit's code lives in the folder `src/vs/workbench/contrib/orbit/`.

The purpose of this document is to explain how Orbit's codebase works. If you want build instructions instead, see [Contributing](./HOW_TO_CONTRIBUTE.md).

## Orbit Codebase Guide

### VSCode Rundown

Here's a VSCode rundown if you're just getting started with Orbit. You can also see Microsoft's [wiki](https://github.com/microsoft/vscode/wiki/Source-Code-Organization) for some pictures. VSCode is an Electron app. Electron runs two processes: a **main** process (for internals) and a **browser** process (browser means HTML in general, not just "web browser").

- Code in a `browser/` folder always lives on the browser process, and it can use `window` and other browser items.
- Code in an `electron-main/` folder always lives on the main process, and it can import `node_modules`.
- Code in `common/` can be used by either process, but doesn't get any special imports.
- The browser environment is not allowed to import `node_modules`. We came up with two workarounds:
  1. Bundle the raw node_module code to the browser — we're doing this for React.
  2. Implement the code on `electron-main/` and set up a channel between main/browser — we're doing this for sendLLMMessage.

### Terminology

Here's some terminology you might want to know about when working inside VSCode:

- An **Editor** is the thing that you type your code in. If you have 10 tabs open, that's just one editor! Editors contain tabs (or "models").
- A **Model** is an internal representation of a file's contents. It's shared between editors (for example, if you press `Cmd+\` to make a new editor, then the model of a file like `A.ts` is shared between them. Two editors, one model. That's how changes sync.).
- Each model has a **URI** it represents, like `/Users/.../my_file.txt`. (A URI or "resource" is generally just a path).
- The **Workbench** is the wrapper that contains all the editors, the terminal, the file system tree, etc.
- Usually you use the `ITextModel` type for models and the `ICodeEditor` type for editors.

- VSCode is organized into "**Services**". A service is just a class that mounts a single time (a "singleton"). You can register services with `registerSingleton` so that you can easily use them in any constructor with `@IServiceName`. See `_dummyContrib` for an example of how to register them.

- "**Actions**" are functions you register on VSCode so that either you or the user can call them later. They're also called "**Commands**".
  - You can run actions as a user by pressing `Cmd+Shift+P` (opens the command palette), or you can run them internally by using the commandService to call them by ID. We use actions to register keybinding listeners like `Cmd+L`, `Cmd+K`, etc. The nice thing about actions is the user can change the keybindings.

### Orbit's LLM Message Pipeline

Here's a picture of the dependencies that are relevant between the time you first send a message through Orbit's sidebar, and the time a request is sent to your provider. Sending LLM messages from the main process avoids CSP issues with local providers and lets us use node_modules more easily.

**Key files:**

| File | Role |
|------|------|
| `browser/chatThreadService.ts` | Chat threads, streaming, tool calls, checkpoints |
| `browser/convertToLLMMessageService.ts` | Converts thread messages to provider format |
| `electron-main/llmMessage/sendLLMMessage.impl.ts` | Per-provider HTTP implementations |
| `electron-main/llmMessage/sendLLMMessageChannel.ts` | IPC channel between browser and main |
| `common/modelCapabilities.ts` | Default models and capabilities (FIM, tools, reasoning) |
| `common/orbitSettingsTypes.ts` | Provider names, settings schema, chat modes |

**Notes:** `modelCapabilities` is an important file that must be updated when new models come out!

### Chat Modes

Orbit has three chat modes defined in `orbitSettingsTypes.ts`:

```typescript
export type ChatMode = 'agent' | 'plan' | 'normal'
```

| Mode | Purpose | File read | File edit | Terminal | Plan tools | MCP | Subagents |
|------|---------|-----------|-----------|----------|------------|-----|-----------|
| **normal** | Quick questions | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **plan** | Research & planning | ✅ | Plan file only | ❌ | ✅ | ❌ | ✅ |
| **agent** | Full implementation | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |

Tool policies are defined in `common/prompt/prompts.ts`. See [docs/plan-mode.md](./docs/plan-mode.md) for the full Plan mode workflow.

### Apply

Orbit has two types of Apply: **Fast Apply** (uses Search/Replace), and **Slow Apply** (rewrites whole file).

When you click Apply and Fast Apply is enabled, we prompt the LLM to output Search/Replace block(s) like this:

```
<<<<<<< ORIGINAL
// original code goes here
=======
// replaced code goes here
>>>>>>> UPDATED
```

This is what allows Orbit to quickly apply code even on 1000-line files. It's the same as asking the LLM to press Ctrl+F and enter in a search/replace query.

### Apply Inner Workings

The `editCodeService` file runs Apply. The same exact code is also used when the LLM calls the Edit tool, and when you submit `Cmd+K`. Just different versions of Fast/Slow Apply mode.

Here is some important terminology:

- A **DiffZone** is a {startLine, endLine} region of text where we compute and show red/green areas, or **Diffs**. When any changes are made to a file, we loop through all the DiffAreas on that file and refresh its Diffs.
- A **DiffArea** is a generalization that just tracks line numbers like a DiffZone.
- The only type of DiffArea that can "stream" is a DiffZone. Each DiffZone has an llmCancelToken if it's streaming.

How Apply works:

- When you click Apply, we create a **DiffZone** over the full file so that any changes that the LLM makes will show up in red/green. We then stream the change.
- When an LLM calls Edit, it's really calling Apply.
- When you submit `Cmd+K`, it's the same as Apply except we create a smaller DiffZone (not on the whole file).

### Writing Files Inner Workings

When Orbit wants to change your code, it just writes to a text model. This means all you need to know to write to a file is its URI — you don't have to load it, save it, etc. There are some annoying background URI/model things to think about to get this to work, but we handled them all in `orbitModelService`.

### Orbit Settings Inner Workings

We have a service `orbitSettingsService` that stores all your Orbit settings (providers, models, global Orbit settings, etc). Imagine this as an implicit dependency for any of the core Orbit services.

Here's a guide to some of the terminology we're using:

- **FeatureName**: Autocomplete | Chat | Ctrl+K | Apply | SCM
- **ModelSelection**: a {providerName, modelName} pair.
- **ProviderName**: The name of a provider: `'ollama'`, `'openAI'`, etc.
- **ModelName**: The name of a model (string type, eg `'gpt-4o'`).
- **RefreshProvider**: a provider that we ping repeatedly to update the models list.
- **ChatMode** = normal | plan | agent

### Subagents

Orbit's subagent system lets the main agent delegate bounded tasks to isolated child agents. Each sub-agent runs in its own conversation context, has a restricted tool policy, and returns a structured summary to the parent.

**Key files:**

| File | Role |
|------|------|
| `common/subAgentRegistry.ts` | Built-in subagent definitions |
| `browser/subAgentService.ts` | Session management, LLM loop, tool execution, and cancellation |
| `browser/projectAgentLoader.ts` | Loads custom agents from `.orbit/agents/` |

Built-in subagents: `explore` (read-only), `plan` (read-only), `general` (full access). Custom agents live in `~/.orbit/agents/*.md` and `.orbit/agents/*.md`.

See [docs/orbit-subagents.md](./docs/orbit-subagents.md) for the full architecture.

### Skills

Skills are reusable instruction packs loaded on demand via the `skill` tool.

| Source | Path |
|--------|------|
| Built-in | `common/skillRegistry.ts` |
| User | `~/.orbit/skills/<name>/SKILL.md` |
| Project | `.orbit/skills/<name>/SKILL.md` |

### MCP (Model Context Protocol)

MCP servers extend Agent mode with additional tools. Configuration lives at `~/.orbit-editor/mcp.json`. The service is split between `common/mcpService.ts` (browser) and `electron-main/mcpChannel.ts` (main process).

### Built-in Browser MCP (`orbit-ide-browser`)

Orbit ships a built-in MCP server, `orbit-ide-browser`, that gives agents Cursor-parity control over the integrated browser without needing an external stdio server. It is toggled by the `browserAutomationEnabled` setting (Settings → Browser Automation, default on).

- **Tool schemas + instructions**: `common/builtinMcp/orbitIdeBrowserMcpTypes.ts` (17 tools, `readOnly` annotations).
- **Built-in registry**: `electron-main/builtinMcp/orbitBuiltinMcpRegistry.ts` manages in-process MCP server lifecycle; `mcpChannel.ts` routes `callTool` to built-in servers before external SDK clients.
- **Automation primitives**: `src/vs/platform/browserView/electron-main/browserAutomationMainService.ts` owns per-tab CDP sessions, the ref map, input dispatch, the automation lock, console/network buffers, health checks, and large-response spill files. Pure helpers (CDP denylist, snapshot YAML) live in `src/vs/platform/browserView/common/browserAutomationPure.ts`.
- **Renderer tab registry**: `src/vs/workbench/contrib/browserView/electron-sandbox/browserTabRegistryService.ts` listens for `orbit:browserAutomation:*` IPC and opens/selects/closes `BrowserEditorInput` tabs.
- **UI**: first-class tool renderer at `browser/react/src/sidebar-tsx/components/toolResults/BrowserMcpToolWrapper.tsx` (renders screenshots inline); status badge at `browser/react/src/sidebar-tsx/components/chat/BrowserAutomationStatusBadge.tsx`.

See [docs/browser-automation.md](./docs/browser-automation.md) for the full tool list, the CDP denylist, the architecture diagram, and the manual test plan.

### Checkpoints

Before each user message and LLM edit, Orbit snapshots file state. Users can restore any checkpoint to roll back changes. Logic lives in `browser/chatThreadService.ts`; UI in `browser/react/src/sidebar-tsx/components/chatComponents/Checkpoint.tsx`.

### React UI

Orbit mounts React + Tailwind inside VS Code's workbench. This is not possible in plain VS Code and required extending the build pipeline to compile React and [scope](https://github.com/andrewpareles/scope-tailwind) Tailwind ourselves.

**Build pipeline** (`browser/react/`):

```
src/  →  src2/  (scope-tailwind)  →  out/  (tsup)
```

Run `npm run buildreact` before `compile` when React source changes. All external imports in React code must end with `.js`.

Key React directories:

| Path | Contents |
|------|----------|
| `react/src/sidebar-tsx/` | Chat sidebar, tool cards, mode selector |
| `react/src/orbit-settings-tsx/` | Settings UI |
| `react/src/plan-editor-tsx/` | Plan markdown editor |

### Approval State

`editCodeService`'s data structures contain all the information about changes that the user needs to review. However, they don't store that information in a useful format. We wrote helper services to get a more useful derived state for the UI.

### Build Process

Orbit's maintainers distribute builds on [orbiteditorai.com](https://orbiteditorai.com). The build pipeline is based on the VS Code and Void Editor build systems, with GitHub Actions for packaging and auto-update.

For macOS release builds (`.app`, `.dmg`, signing, publishing), see [docs/BUILD_MACOS.md](./docs/BUILD_MACOS.md).

If you want to completely control Orbit's build pipeline for your own internal usage, which comes with a lot of time cost (and is typically not recommended), see the distributing section in [HOW_TO_CONTRIBUTE.md](./HOW_TO_CONTRIBUTE.md).

## VSCode Codebase Guide

For additional references, here is a list of links to get up and running with VSCode.

#### Links for Beginners

- [VSCode UI guide](https://code.visualstudio.com/docs/getstarted/userinterface) — covers auxbar, panels, etc.
- [UX guide](https://code.visualstudio.com/api/ux-guidelines/overview) — covers Containers, Views, Items, etc.

#### Links for Contributors

- [How VSCode's sourcecode is organized](https://github.com/microsoft/vscode/wiki/Source-Code-Organization) — this explains where the entry point files are, what `browser/` and `common/` mean, etc. This is the most important read on this whole list!
- [Built-in VSCode styles](https://code.visualstudio.com/api/references/theme-color) — CSS variables built into VSCode. Use `var(--vscode-{theme but replacing . with -})`.

#### Misc

- [Every command](https://code.visualstudio.com/api/references/commands) built-in to VSCode.
- Note: VSCode's repo is the source code for the Monaco editor! An "editor" is a Monaco editor, and it shares the code for ITextModel, etc.
