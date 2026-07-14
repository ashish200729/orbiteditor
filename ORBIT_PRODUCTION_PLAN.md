# Orbit Editor — Production-Readiness Plan

Scope: `src/vs/workbench/contrib/orbit/`. Goal: Cursor-level agent harness + UI, production-hardened.
Source of truth: only `src/` is edited (canonical). `src2/` and `out/` are generated — rebuild via `npm run buildreact`. Full typecheck needs `--max-old-space-size=8192`.

Basis: 5-subsystem read-only audit (harness, chat UI, settings/auth, plan/skills, agent-window/git) + web research on Cursor context management, Electron update security, streaming-markdown perf.

## Decisions locked with owner
- **Priority order:** Agent harness parity **first**, then file-safety, then chat UX/perf, then agent-window/edit, then plan/data-integrity, then cleanup.
- **Auto-update signing/notarization: OUT OF SCOPE** this pass (owner: "ignore"). Update-chain RCE, installer shell-injection, Gatekeeper-strip findings are parked in "Deferred" below — do NOT delete the findings, just not fixing now.
- **File-tool safety model:** confine path tools to workspace root; out-of-workspace paths require explicit approval; denylist credential dirs.
- **Deliverable:** this doc first, implement after sign-off. Edit `src/` only.

## Severity legend
P0 = crash / dataloss / security exfiltration. P1 = major correctness/UX. P2 = polish. `[verify]` = strong audit claim to reproduce before fixing.

## Implementation progress (updated as we go)
**Phase 0 — DONE.** 0.1 clean rebuild (build.js wipes src2; verified clean build). 0.2 token accounting (LLMUsage through all 5 providers → grammar wrappers → channel → chatThreadService store/getter/cleanup). 0.3 partial (removed 3 noisy `[SDK] Extracted N tools` console.logs; full logger deferred).
**Phase 1 — CORE DONE (type-clean, tsc --noEmit x2 exit 0).** 1.1 context-window mgmt (deterministic under-budget guarantee: proper trim loop + hard-floor phase, no more 100-iter give-up; LLM-summarization compaction = follow-up). 1.2 turn cap — REVERTED per owner (2026-07-13): main agent must be unbounded like Cursor. Cap + `maxAgentTurns` setting removed; main loop runs unlimited tool calls. Sub-agents keep their own maxTurns. 1.4 retry classification + exponential backoff + Retry-After. 1.5 Gemini id-less tool-call drop fixed. 1.6 channel-throw hang fixed (fires onError + async rejection guard). 1.7 completion sound/notify gated on true terminal. 1.8 MCP abort (CancellationToken→AbortSignal through mcpService→mcpChannel→SDK; both callers cancel on timeout). 1.10 reserved-token bug (1/2→1/4 clamp). 1.12 `_findLargestByWeight` uses its param.
**Phase 1.1b — Cursor-style compaction DONE (type-clean).** When the prompt nears the window (75%), older turns are summarized via a dedicated no-tools LLM call and the payload becomes [task + assistant summary + recent turns]. Full history stays in the thread (UI/storage untouched); only the sent payload is compacted. Incremental (folds prior summary), safe user-message boundary (no orphaned tool_result), re-validated after the async summary, self-invalidates on edit/branch. Boundary math extracted to pure `common/compactionHelpers.ts` with unit tests (`test/common/compactionHelpers.test.ts`). In-memory state (deterministic truncation covers reload); persistence = optional fast-follow.
**Phase 1 — REMAINING:** 1.3 DONE (bounded .orbit/history overflow files + head/tail). 1.9 addressed (retry classification stops the 3× spin). 1.11 DONE (duration metric). 1.13 DONE (null-token returns, no false completion). 1.14 deferred (per-thread mutating lock — concurrency risk). 1.15 skipped (code cap suffices).
**Phase 2 — Agent-surface security (mostly DONE, type-clean):** 2.1 file-tool workspace boundary + credential denylist (Read/Grep/Glob/Write force approval outside workspace or on sensitive paths). 2.2 git IPC path-traversal guard (resolveInsideRoot). 2.3 javascript:/data: link XSS → scheme allowlist, unsafe links downgraded to text. 2.4 Mermaid SVG sanitizer → DOMParser scrub + strengthened regex fallback (SMIL, fixed-point, broader schemes). 2.5 MCP SSRF now blocks link-local/metadata by RESOLVED IP (IPv6-mapped, DNS-rebind). 2.7 Codex loopback XSS (HTML-escape + CSP/nosniff). 2.8 git discard per-file (staged-new/renames no longer abort the batch). 2.9 workspace-trust gate on project skills + agents (+ rescan on trust change; agents now unconditional-set). 2.10 Codex tokens USER→MACHINE (no Settings-Sync roaming). 2.11 minimal MCP subprocess env (allowlist, not full process.env). 2.12 extension-transfer skips symlinks.
**Phase 2 — REMAINING:** 2.6/2.14 CDP denylist + eval guard (live in platform/browserView, outside orbit/ — pending). 2.13 safeStorage isEncryptionAvailable warning (deferred; tokens still encrypted).
**Phase 3 — Chat perf/UX (key items DONE, build-clean):** 3.1 block-level markdown memoization (closed blocks skip re-render → kills O(n²) streaming DOM jank). 3.4 sticky-scroll listener rebinds on container remount (thread switch no longer freezes offset). 3.6 rAF cleanup on streamed-edit unmount (no leaked frames on detached nodes). 3.11 ParallelToolGroup null-guards (stale index no longer crashes render).
**Phase 3 — REMAINING:** 3.2 virtualization (needs dep decision), 3.3 scroll-driven full rebuild, 3.5 quadratic streamed diff, 3.7 a11y roles, 3.8 empty/welcome state, 3.9 LaTeX, 3.10 ErrorBoundary reset, 3.12 leaks, 3.13 remote img, 3.14 diff row keys, 3.15 drop heuristic.
**Phase 3 — also DONE:** 3.9 LaTeX renders neutral (was red "error"), dead KaTeX removed. 3.10 ErrorBoundary resetKeys. 3.12 copy timer cleanup + length-on-function fix. 3.13 img scheme guard.
**Phase 5 — data-integrity (core DONE, verified):** 5.1 wrong-item marking FIXED (index now over ALL rendered items incl. ✓-completed; +2 unit tests, corrected 1 old test that encoded the bug). 5.2 plan-editor save now takes planFileLock. 5.4 atomic writes for plan/skill docs (planDraftActions, planEditorInput, planTodoSyncService, skillImportService). 5.5 CRLF normalized in parsePlanFile. 5.8 status/timestamp insert field when missing (no silent no-op).
**Phase 5 — REMAINING:** 5.3 checklist sync overwrites plan-tool edits (architectural), 5.6 project-agent watcher (partial: trust-rescan added), 5.9 frontmatter parser robustness, 5.10 command/skill collision warn, 5.11 self-write window, 5.12 autosave dirty race, 5.13 skill-import size guard. Cross-window plan lock (design decision).
**Phase 4:** 3 `[verify]` P0s (terminal pty, Cmd+K type mismatch, streaming diff race) — owner chose reproduce-first; needs a live app session to drive the flows before editing.
**Phase 6 — features (in progress):** 6.3 (partial) API-key hygiene — trim keys on entry + interior-whitespace warning (full network "Test connection" needs probe infra: only ollama/vLLM/lmStudio/openAICompatible are refreshable, cloud providers have static lists — flagged as follow-up). 6.4 DONE — onboarding now has a "Connect a model" step (GitHub/ChatGPT sign-in + Add-API-key) between Theme and All-set, so users no longer exit with zero providers. 6.6 DONE — ModelDropdown persists the fallback when a stored model disappears (no silent displayed-vs-stored drift). Also fixed a latent rules-of-hooks violation in ProviderSetting.
**Phase 6 — REMAINING:** 6.1 logger (console→ILogService sweep), 6.2 settings versioning + migration ladder, 6.3 full Test-connection button (needs probe infra), 6.5 god-class decomposition, as-any/TODO triage.

## Verification status
Every batch: `tsc -p src/tsconfig.json --noEmit` exit 0 (0 orbit errors), `gulp compile` 0 errors, `npm run buildreact` success. Orbit common tests: 406 passing, 1 failing = pre-existing `askQuestionTool` "AskQuestion not in normal" (committed source has it in normal; stale out/ had masked it — unrelated to these changes). New tests: `compactionHelpers.test.ts` (6 passing).


---

## Phase 0 — Foundations (do first, unblocks the rest)

| ID | Item | Files | Why | Acceptance |
|----|------|-------|-----|-----------|
| 0.1 | Clean rebuild hygiene | `browser/react/build.js` | `scope-tailwind -o src2/` never cleans → stale deleted files linger in `src2/`; `out/` can bundle ghosts. | `build.js` wipes `src2/` before scope-tailwind (or `rimraf src2 out` step). `npm run buildreact` produces tree matching `src/`. |
| 0.2 | Token-accounting primitive | `electron-main/llmMessage/*`, `common/sendLLMMessageTypes.ts` | Everything in Phase 1 needs real token counts, not `chars/4`. `include_usage` already requested (`orbitProviderChat.ts:117`) but never read. | Add `usage` (prompt/completion/total) to the stream/onFinal event for all providers; surface per-turn. Unit test parses usage from a captured SSE fixture. |
| 0.3 | Logging discipline scaffold | new `common/helpers/log.ts` or reuse `ILogService` | 231 `console.*` in shipped code leak tool names/IDs. | A gated logger; convert the noisy `[SDK] Extracted N tools` lines (`sendLLMMessage.impl.ts:516,1257,1539`) + metrics `console.log`. Rest converted opportunistically in later phases. |

---

## Phase 1 — Agent harness parity (PRIORITY)

Target: long agent sessions work without provider 400s; bounded spend; robust streaming across providers. Cursor reference: summarize on window-fill, dynamic context discovery, long tool output → file + `tail`/read.

### P0
| ID | Item | File:line | Fix approach | Test / acceptance |
|----|------|-----------|--------------|-------------------|
| 1.1 | Context-window management (the headline gap) | `convertToLLMMessageService.ts:603-702` | Replace the "trim to 120 chars, break after 100 iters" logic. Use real token counts (0.2). When over budget: (a) evict oldest tool-result bodies first (keep tool_use/tool_result envelope to avoid provider 400), (b) then summarize older turns into a compaction message, (c) preserve full history to a thread history file the agent can re-read (Cursor pattern). Loop until actually under budget. | Synthetic 500-message thread stays under model window; no provider 400; compaction message present; recent turns intact. |
| 1.2 | Main-loop turn cap | `chatThreadService.ts:1821` (`while (shouldSendAnotherMessage)`), `:1917` | Add hard cap on `nMessagesSent` (config, default ~50) that ends the turn cleanly with a surfaced "reached step limit — continue?" message. | Loop-forever mock model stops at cap with UI affordance to resume. |
| 1.3 | Long tool-output → file, not silent loss | `toolsService.ts` (shell/read/grep result paths), `common/shellToolHelpers.ts` | For results over a char budget, write full output to a temp file in workspace, return head+tail + file path; agent can Read more. Currently oversized results either bloat context or get hard-truncated. | Shell command emitting 1MB output: transcript gets head/tail + path; full content readable via Read. |

### P1
| ID | Item | File:line | Fix approach | Test |
|----|------|-----------|--------------|------|
| 1.4 | Retry classification + backoff | `chatThreadService.ts:1917-1948` | Only retry transient (5xx / 429 / network). Never retry 401/400. Exponential backoff + honor `Retry-After`. | 401 → no retry, surfaced immediately. 429 with Retry-After honored. |
| 1.5 | Gemini tool calls dropped when id absent | `sendLLMMessage.impl.ts:1491-1492` | Key by function-call index with generated id on first sight (mirror OpenAI/Anthropic path) instead of `if(!toolId) continue`. | Gemini fixture with id-less function calls yields tool calls. |
| 1.6 | Channel throw → renderer hang forever | `sendLLMMessageChannel.ts:75-99` | On catch, fire `onError` to the requestId + clear tracking; add overall request timeout (`:132-139` leak). | Throw injected before impl try-block → renderer gets error, turn ends. |
| 1.7 | "Task complete" fires while blocked | `chatThreadService.ts:2160-2174` | Only play sound / notify on true terminal (`isRunningWhenEnd === undefined`), not `awaiting_user`. | Approval-pending turn → no completion sound. |
| 1.8 | MCP tool timeout can't cancel call | `subAgentService.ts:465-471`, `toolsService.ts:1642` | Thread AbortSignal into `callMCPTool`; abort underlying call on timeout. | Hung MCP server aborts on timeout, no leaked promise. |
| 1.9 | Empty completion treated as hard error + retried | `sendLLMMessage.impl.ts:518-520` | Treat whitespace/stop-only as normal terminal (retry at most once), not error×3. | Empty completion → single clean turn end. |
| 1.10 | Reserved-output-token bug | `convertToLLMMessageService.ts:603-606` | Comment says 1/4, code reserves 1/2 → truncates ~half of usable context early; also clamp so small-window models don't go negative (`:604,:30`). | Budget math matches intended fraction; small window doesn't over-truncate. |

### P2 (fold in during Phase 1)
- 1.11 `sendLLMMessage.ts:124` duration metric uses `getMilliseconds()` delta (garbage) → `Date.now()` deltas.
- 1.12 `convertToLLMMessageService.ts:654-666` `_findLargestByWeight` loops closure not param — use the parameter.
- 1.13 `chatThreadService.ts:1896-1899` null-token path `break`s retry but outer loop ends "normally" → return as hard-failed turn.
- 1.14 Mutating-tool lock (`toolsService.ts:1402`) is process-global → two threads block each other's edits; make per-thread or document.
- 1.15 Prompt: pair `task_management` persistence guidance (`prompts.ts:1703`) with the new turn budget; add workspace-relative path guidance (`:1651`).

---

## Phase 2 — Agent-surface security (untrusted model/repo/web output)

Owner chose "confine to workspace + approval outside". These share that boundary; auto-update is excluded.

### P0
| ID | Item | File:line | Fix | Test |
|----|------|-----------|-----|------|
| 2.1 | File-tool workspace boundary | `toolsService.ts:94-121` (`pathToURI`), `toolsServiceTypes.ts:26-31` | Resolve path; if outside workspace root → require approval (reuse approval gate). Denylist `~/.ssh`, `~/.aws`, `~/.config`, credential files even inside workspace. Add path-scope note to prompt (1.15). | Read `~/.ssh/id_rsa` → approval prompt, not silent send. In-workspace read unchanged. |
| 2.2 | Git IPC path traversal | `orbitSCMMainService.ts:262-266, 275-284` | Validate `join(root,file)` stays under `root` (shared guard), or use `git show HEAD:file`. `file` arrives raw over IPC. | `file="../../etc/passwd"` rejected. |
| 2.3 | Chat markdown XSS — `javascript:` links | `markdown/ChatMarkdownRender.tsx:833-834` | Scheme allowlist (`http/https/mailto/file/vscode`) before render/open; drop others. | `[x](javascript:alert(1))` inert. |
| 2.4 | Mermaid SVG sanitizer bypassable | `markdown/svgSanitizer.ts:43-86` (only `dangerouslySetInnerHTML`, `:142`) | Replace regex with DOMPurify (`USE_PROFILES:{svg,svgFilters}`) or DOMParser node-walk scrub. | Known SMIL/nested-tag payloads stripped. |

### P1
| ID | Item | File:line | Fix |
|----|------|-----------|-----|
| 2.5 | MCP SSRF metadata block is string-compare | `orbitIdeBrowserMcpServer.ts:42-53` | Block by resolved IP range (link-local/metadata 169.254/fd00 etc.), reject IPv6-mapped IPv4. |
| 2.6 | CDP `Fetch.*` not denylisted | `browserAutomationPure.ts:21-52` | Add `Fetch.` (and `Browser.close`/`Browser.`, `IO.`, whole `Target.`) to denylist; move `browser_cdp` to allowlist model. |
| 2.7 | Codex loopback callback reflected XSS | `electron-main/openai-codex/oauthManager.ts` (~105-139) | HTML-escape `error_description`/message; add `CSP default-src 'none'`; bind `127.0.0.1`, reject non-GET/foreign Host. |
| 2.8 | Git discard broken for staged-new / renames | `orbitSCMMainService.ts:337-351` | Special-case `A` files (skip `checkout HEAD --`); pass both orig+new for renames (`git restore --staged --worktree`). |
| 2.9 | Project skills/agents auto-loaded, no trust gate | `skillLoader.ts:176`, `projectAgentLoader.ts:170` | Gate project-scoped skills/agents behind workspace-trust; prompt content injection from cloned repo otherwise. |

### P2
- 2.10 Codex tokens use `StorageTarget.USER` (Settings-Sync roaming) → `MACHINE` (`codex oauthManager ~318`).
- 2.11 stdio MCP gets full host env (`mcpChannel.ts:279`) → minimal env + `server.env`.
- 2.12 Extension transfer copies symlinks (`extensionTransferService.ts:93`) + clobbers config `overwrite=true` → lstat/skip symlinks, back up config.
- 2.13 `safeStorage` no `isEncryptionAvailable()` check on Linux (basic-scheme fallback) — warn/refuse when only basic (`orbitSettingsService.ts:458`, both oauthManagers).
- 2.14 CDP/eval regex guards bracket-notation bypass (`browserAutomationPure.ts:78`) — prefer blocking `Runtime.evaluate` from model.

---

## Phase 3 — Chat UI perf & UX (Cursor-level feel)

### P1
| ID | Item | File:line | Fix | Acceptance |
|----|------|-----------|-----|-----------|
| 3.1 | Per-token full markdown re-lex (O(n²)) | `markdown/ChatMarkdownRender.tsx:951`, `messages/AssistantMessageComponent.tsx:67` | Block-level incremental parse: parse only trailing changed block, wrap closed blocks in `React.memo` (Incremark/StreamMD pattern). | Long streamed message: no quadratic slowdown; closed blocks don't re-render. |
| 3.2 | No virtualization | whole sidebar tree | Windowize the message list (react-window/virtuoso) or lazy-mount off-screen tool bodies. | 300-tool thread scrolls smoothly; bounded DOM. |
| 3.3 | Scroll rebuilds all bubbles | `chat/SidebarChatMessages.tsx:99-176` | Remove `stickyMessageIndex` from the `messageElements` memo; apply sticky via CSS/data-attr; per-row memo. | Scrolling long thread doesn't reconcile every bubble. |
| 3.4 | Stale sticky-scroll listener after thread switch | `hooks/useStickyOffset.ts:15-71` | Reconcile against live element each render (the pattern `useStickyUserMessages` already uses) or key effect on element. | Thread switch keeps `--todo-sticky-offset` live. |
| 3.5 | Quadratic + duplicated streamed-edit diffing | `editTool/editToolInnerContent.tsx:78`, `UnifiedDiffView.tsx:72`, `EditTool.tsx:55` | Gate full `diffLines` on `!isStreamingCode`; compute once, derive stats+rows together. | Large streamed edit doesn't re-diff per chunk. |
| 3.6 | Uncancelled rAFs on streamed edit unmount | `editTool/EditToolExpandableContent.tsx:13-20` | Capture + `cancelAnimationFrame` in cleanup. | No rAF on detached node. |

### P2
- 3.7 a11y: clickable divs → `role="button"`/`tabIndex`/keydown (or `<button>`); `ErrorDisplay.tsx` is the good template. (80 sites; start with primary: user bubble, tool headers, dropdowns.)
- 3.8 Empty/welcome state for the chat pane (suggested prompts, shortcuts) — currently blank (`ChatMessagesScrollArea.tsx:80`).
- 3.9 LaTeX renders as red error text (`ChatMarkdownRender.tsx:148`) — wire sanitized KaTeX or render plain; delete dead block.
- 3.10 `ErrorBoundary.tsx:38` never resets on prop change → add resetKeys; use `ErrorDisplay`.
- 3.11 `ParallelToolGroup.tsx:34` unguarded `previousMessages[index].role` crash; key remount resets expand (`:key`).
- 3.12 Leaks: `ApplyBlockHoverButtons.tsx:136` global map never pruned; CopyButton timer not cleared; `code.length` on a function.
- 3.13 Remote `<img>` from model markdown (`:845`) — restrict/gate (IP-leak/tracking pixel).
- 3.14 Diff/streaming rows keyed by `index` (`UnifiedDiffView.tsx:123`, `StreamingCodeView.tsx:47`) → stable line identity.
- 3.15 Drop-handler file/folder by extension heuristic (`util/inputs.tsx:905`) → use file service `stat`.

---

## Phase 4 — Agent-window / inline-edit / terminal / autocomplete

### P0 (verify then fix)
| ID | Item | File:line | Fix | Acceptance |
|----|------|-----------|-----|-----------|
| 4.1 `[verify]` | Closing Agents window kills all terminal ptys | `TerminalPanel.tsx:240-244` | Route incidental teardown through `detachProcessAndDispose()`; hard-kill only on explicit tab-close. | Close window → shells survive, reattach on reopen. |
| 4.2 `[verify]` | "Preserve pty" branch still `removeEntry` → orphan | `agentWindowTerminalStore.ts:186`, `TerminalPanel.tsx:233` | Keep the ptyId entry on detach/preserve; remove only on genuine kill. | Detached process is reattachable, not orphaned. |
| 4.3 `[verify]` | Cmd+K pre-apply type mismatch | `QuickEditChat.tsx:74` vs `editCodeServiceInterface.ts:47` | Pass the CtrlK zone's real URI (`diffAreaOfId[diffareaid]._URI`), or switch on `from`. | Cmd+K submit applies + saves target file. |
| 4.4 | Streaming diff has no read-only lock → mid-stream typing corrupts | `editCodeService.ts` (~1685/1968) | Lock DiffZone range read-only while streaming, or re-derive mutable position from live bounds after user edits. | Typing during stream doesn't corrupt/throw. |

### P1
- 4.5 Autocomplete CancellationToken never threaded (`autocompleteService.ts:481`) → thread token, check post-debounce + around LLM await, wire `abort(requestId)`.
- 4.6 Autocomplete 60s dead pending entry (`:408`, `constants.ts:13`) → ~3-8s interactive timeout; delete error entries (`:187`).
- 4.7 `_realignAllDiffAreasLines` off-by-one (`editCodeService.ts:924`) → `endLine = startLine + newTextHeight - 1`.
- 4.8 Per-keystroke full diff rebuild on large files (`editCodeService.ts:224,981`) → debounce user-change refresh; incremental recompute.
- 4.9 BrowserPanel bounds effect races async view-creation, no `.catch()` (`BrowserPanel.tsx:516`) → gate on `viewOpenedRef`.

### P2
- 4.10 Autocomplete instance-wide state desyncs across split panes (`:50,206`) → key by doc URI.
- 4.11 SCM listeners never disposed on repo removal (`agentGitService.ts:111`) → per-repo DisposableStore.
- 4.12 `GitDiffView` refetches every visible file on any mutation (`:105`) → scope to changed files.
- 4.13 `mostRecentTextOfCtrlKZoneId` never deleted (`editCodeService.ts:380`); titlebar observer re-registered (`agentWindowActions.ts:122`) → MutableDisposable.
- 4.14 git non-zero exit rendered as "No changes" (`orbitSCMMainService.ts:248`); `push` refs unvalidated (`:381`).

---

## Phase 5 — Plan / skills / data-integrity

### P1
| ID | Item | File:line | Fix |
|----|------|-----------|-----|
| 5.1 | Wrong-item marking | `planTemplate.ts:458`, `toolsService.ts:1201` | `itemIndex` counts incomplete-only but list renders stable 1..N → index over all rendered items, or key by id. |
| 5.2 | Editor save + status write bypass file lock | `planEditorInput.ts:232`, `planEditorPane.ts:155` | Route both through `planFileLock.withLock`. |
| 5.3 | Checklist sync overwrites plan-tool edits | `planTodoSyncService.ts:130` | Feed `add_plan_todo`/`mark_complete` back into `thread.todoList`, or merge instead of whole-checklist replace. |
| 5.4 | Non-atomic writes corrupt plan/SKILL.md on crash | `planDraftActions.ts:113,172`, `planEditorInput.ts:232`, `planTodoSyncService.ts:138`, `skillImportService.ts:211` | Pass `{ atomic }` (temp+rename) to `writeFile`. |

### P2
- 5.5 CRLF not normalized in plan frontmatter/section parse (`planTemplate.ts:232,307`) → normalize like `skillFrontmatter.ts:32`.
- 5.6 Project agents loaded once, no watcher, conditional set (`projectAgentLoader.ts:165`) → mirror skillLoader (watcher + unconditional set).
- 5.7 Divergent checklist parsers (`PlanChecklist.tsx:28` vs `parsePlanFile`) → shared extractor.
- 5.8 Status/timestamp regex no-ops if field missing (`planTemplate.ts:358,525`) → insert field if absent.
- 5.9 Skill/agent frontmatter parsers: multi-line description truncation (`skillFrontmatter.ts:42`), no CRLF/quote-strip in `projectAgentLoader.ts:46`.
- 5.10 Command/skill name collision unreachable + silent (`builtinCommands.ts`) → warn/namespace.
- 5.11 Self-write ignore window drops genuine external edits (`planEditorInput.ts:105`) → prefer hash check over time window.
- 5.12 Auto-save `isDirty=false` can drop last edit during in-flight save (`PlanEditor.tsx:90`) → re-check newest content after save.
- 5.13 Skill import copies whole folder, no size/symlink guard (`skillImportService.ts:139`).

Architectural (needs design decision, may defer): cross-window plan lock is per-renderer singleton (`planFileLock.ts:66`) — main window ↔ Agents window writes not serialized. Options: single owning process, or cross-process advisory lock.

---

## Phase 6 — Maintainability / cleanup (ongoing, low-risk)

- 6.1 Route remaining `console.*` (231) through gated logger / `ILogService`; strip secret/tool-name leakage (`sanitizeForLog` exists — extend).
- 6.2 Settings versioning: `_storeState` writes no `version`; migration hook is dead (`orbitSettingsService.ts:445`) → real version int + migration ladder.
- 6.3 API-key validation + "Test connection" (`ProvidersSection.tsx:89`); validate `headersJSON`/endpoint at entry; debounce persistence (currently every keystroke).
- 6.4 Onboarding has no provider/sign-in step (`orbitOnboarding.tsx:322`) → add provider + GitHub sign-in step (Orbit has no-API-key GitHub path unsurfaced).
- 6.5 God-class decomposition (opportunistic, guard with tests): `chatThreadService.ts` (3458) → split streaming / persistence / tool-orchestration; `editCodeService.ts` (2666); `prompts.ts` (2348).
- 6.6 `ModelDropdown.tsx:31` silent model substitution → persist fallback or show explicit state.
- 6.7 60 `as any`, 90 TODO/HACK — triage during touched files.

---

## Deferred / explicitly out of scope this pass
- **Auto-update security chain** (owner: ignore): manifest signature, notarization verify, installer shell-injection (`manifest.version`), Gatekeeper-strip. Findings retained for later; recommend before any wide public release.
- Metrics opt-out-by-default / consent prompt (`metricsMainService.ts:126`).
- Cross-process plan lock (5.x architectural) — pending design decision.

---

## Sequencing & process
1. Phase 0 (foundations) → then Phase 1 fully (harness), sign-off gate.
2. Phase 2 (file-safety + agent-surface security).
3. Phases 3–5 in parallel-ish tranches by subsystem owner; Phase 6 opportunistic.
4. Each phase: implement in `src/` → `npm run buildreact` → run affected unit tests (`test/common/*`, `index.js --runGlob`) → typecheck `--max-old-space-size=8192` → manual smoke of the touched flow (per `/verify`).
5. `[verify]` items (4.1–4.3): reproduce first; if not reproducible, downgrade and note.
6. New unit tests required for: context compaction (1.1), turn cap (1.2), retry classification (1.4), Gemini tool-id (1.5), workspace boundary (2.1), git path-guard (2.2), link-scheme allowlist (2.3), atomic writes (5.4), wrong-item index (5.1).

## Open questions before implementation
- Turn-cap default value + whether it's user-configurable in settings.
- Compaction strategy for 1.1: summarize via a cheap model call vs pure eviction — acceptable to add an extra LLM round-trip on window-fill?
- Virtualization (3.2): acceptable to add a dependency (react-window/virtuoso) or hand-roll windowing?
