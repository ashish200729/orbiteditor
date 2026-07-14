# Orbit Agent Harness — Fix & Improve Plan (existing funcs only)

**Date:** 2026-07-13
**Scope:** Fix bugs, close fragility, and improve the **functions that already exist** in the agent harness. **No new tools, no new features.** Additive-safe, non-breaking.
**Method:** every claim below was verified against source (file:line confirmed). Ordered by severity: stability → LLM fidelity → editing → autocomplete → cleanup.

All paths relative to `src/vs/workbench/contrib/orbit/`.

---

## Tier A — Stability / correctness (can stall, hang, orphan, or corrupt thread state)

These are the audit's repeatedly-bug-fixed paths. They work in the happy case but are thin on invariants + tests. Highest production priority.

### A1. Parallel-tool-batch + multi-approval path
- **Where:** `chatThreadService.ts:2468-2565` (exec split), `:2206-2225` (serialize multi-approval, walk back to opening assistant msg).
- **Problem:** dense defensive logic, bug-fixed repeatedly, near-zero test coverage. A batch where one tool needs approval mid-flight is the fragile case.
- **Fix:** don't rewrite — **pin the invariants with tests** and tighten the seams. Extract the classify/split step (`:2380-2433`) into a pure, unit-testable function. Assert: (a) read-only builtins + read-only MCP + read-only subagents batch in parallel; (b) any mutating/terminal tool runs alone, sequentially; (c) a mid-batch approval stops the loop cleanly with `awaiting_user` and no half-applied batch.
- **Risk:** Low (mostly test + extract-function). **No behavior change.**

### A2. Placeholder / `running_now` lifecycle orphaning
- **Where:** `_swapOutLatestStreamingToolWithResult` (`:1560`), `_updateLatestTool` (`:1578`); orphan guards at `:1747,:1880,:2287`.
- **Problem:** correctness depends on the swap finding the right message; a miss leaves a stuck "Reading file…" placeholder that stalls the next turn.
- **Fix:** make the swap total — every `running_now` placeholder MUST resolve to `success`/`tool_error`/`rejected` before the turn ends. Add an end-of-turn assertion that no `running_now` survives; add tests for the swap under out-of-order completion.
- **Risk:** Low–Med.

### A3. Abort must reject *every* pending tool_request
- **Where:** `abortRunning` (`:1713-1771`, esp. `:1745`).
- **Problem:** if any pending `tool_request` isn't rejected on abort, its placeholder lingers and stalls the following turn.
- **Fix:** guarantee-all-rejected loop + a post-abort assertion (no pending `tool_request` remains). Test abort mid-parallel-batch and mid-approval.
- **Risk:** Low.

### A4. Compaction: prevent silent lossy fallback + boundary orphaning
- **Where:** `_maybeCompactThread` (`:1139`), `_summarizeForCompaction` (`:1111`), `selectCompactionBoundary` (`common/compactionHelpers.ts`).
- **Problem:** if summarization fails it silently drops to deterministic truncation (lossy, no signal); boundary must never split a `tool_use`/`tool_result` pair.
- **Fix:** on summarizer failure, surface a visible thread notice + retry once before truncation. Add property tests: boundary always snaps forward to a user message; never orphans a `tool_result`. Persist-to-`.orbit/history` path asserted.
- **Risk:** Low.

### A5. MCP interruption best-effort → make cancellation reliable
- **Where:** tool dispatch `chatThreadService.ts:2007`, late-result drop via stale-turn `:2032-2035`; MCP timeout default 60s (`:2004`).
- **Problem:** MCP interruptor can be a no-op; a slow MCP tool only gets cut by the stale-turn check, wasting time/tokens.
- **Fix:** thread a real `AbortSignal` into `callMCPTool` where the transport supports it; make timeout per-server-configurable; ensure interrupt closure actually cancels. Keep stale-turn drop as backstop.
- **Risk:** Med (touches MCP transport).

### A6. Prompt-cache byte-identity guard
- **Where:** `augmentChatMessagesWithHarnessContext` (`convertToLLMMessageService.ts:1525`), timestamp-only-on-fresh-turn (`:1544-1548`).
- **Problem:** mid-loop re-prepare must emit byte-identical harness context or it busts Anthropic prompt caching (silent cost/latency regression).
- **Fix:** golden test asserting identical bytes across mid-loop re-prepares; make the fresh-turn timestamp injection the ONLY nondeterministic field and cover it.
- **Risk:** Low.

---

## Tier B — LLM fidelity (wrong budgets, ignored user intent, uneven providers)

### B1. Real tokenizer, replace `chars/4`
- **Where:** `convertToLLMMessageService.ts:51` `CHARS_PER_TOKEN=4` ("abysmal"), used at `:679`; `chatThreadService.ts:79` `COMPACTION_CHARS_PER_TOKEN=4`, `_estimatePromptTokens:1061`, compaction target `:1167`.
- **Problem:** crude estimate mis-fires truncation + compaction, worst on code/CJK; first high-fill turn before real usage arrives is the danger.
- **Fix:** bundle a tokenizer (js-tiktoken / gpt-tokenizer for OpenAI-family; Anthropic token-count where cheap; per-provider selection off `modelCapabilities`). Keep chars/4 as last-resort fallback. Already-tracked real `promptTokens` still wins when present.
- **Risk:** Low. Big accuracy win.

### B2. Reasoning: honor user overrides (stop forcing ON)
- **Where:** `modelCapabilities.ts:2055` `getIsReasoningEnabledState` — currently `// Force reasoning on… ignore user overrides; return true`.
- **Problem:** the `reasoningSlider` / `canTurnOffReasoning` metadata already exists but is dead — user cannot turn thinking off or set budget/effort. Cost + latency the user can't control.
- **Fix:** read `canTurnOffReasoning` + `_modelSelectionOptions` + `overridesOfModel` and return the actual user-chosen state; default-on only when unset and supported. Wire the existing slider through.
- **Risk:** Low. High user value.

### B3. Retry / rate-limit hardening
- **Where:** agent-loop retry `chatThreadService.ts:2328-2340` (`CHAT_RETRIES=3`, exp backoff, `MAX_RETRY_AFTER_MS=60_000`); per-provider 429 handling scattered (Codex `impl.ts:856`, orbit `orbitProviderChat.ts:170`); 401 messages at `impl.ts:137,287,1429`.
- **Problem:** coarse — fixed exponential backoff, single global cap, inconsistent `Retry-After` honoring and 401/429 messaging across providers.
- **Fix:** centralize retry/backoff policy; honor `Retry-After` uniformly across all providers; consistent 401 ("invalid key") / 429 ("rate limited, retrying") surfacing. No new providers — just make the existing paths uniform.
- **Risk:** Med.

### B4. Extend prompt caching beyond Anthropic (improve existing caching func)
- **Where:** `impl.ts:1244-1294` (Anthropic breakpoints); OpenAI `cached_tokens` / Gemini `cachedContentTokenCount` read for reporting only (`:44,:64`).
- **Problem:** only Anthropic gets explicit cache-write control; OpenAI/Gemini leave caching on the table.
- **Fix:** add explicit cache config for providers that support it (OpenAI prompt caching is automatic but order-sensitive — ensure stable prefix ordering; Gemini explicit cached content where the model supports it). Scope: only where the SDK exposes it.
- **Risk:** Med. (Lower priority than B1/B2.)

---

## Tier C — Editing robustness & throughput (existing edit funcs)

### C1. Agent StrReplace fuzzy fallback (stop hard-throwing)
- **Where:** `editCodeService.ts:1395` (not found) / `:1398` (not unique) — hard `throw`. Meanwhile the ClickApply button already has a fast search/replace-block model (`_initializeSearchAndReplaceStream:1241`).
- **Problem:** agent edits fail brittle on trivial whitespace/context mismatch; the robust apply path exists but is only wired to the UI button, not the agent tool.
- **Fix:** on exact-match failure, fall back to the existing fast-apply block model before throwing. Reuses shipped code; matches Cursor's apply robustness. Preserve strict path as the fast happy case.
- **Risk:** Med. Gate behind a flag defaulting to current (throw) until validated.

### C2. Per-file mutating lock (not global-serial)
- **Where:** `toolsService.ts:1473` `_acquireMutatingLock` — single boolean `_mutatingToolInProgress` blocks ALL mutating/terminal tools.
- **Problem:** edits to *different* files are needlessly serialized; throughput loss vs the read-only parallelism already at `chatThreadService.ts:2507`.
- **Fix:** key the lock by target URI so distinct-file edits run concurrently; keep same-file edits + terminal serialized. Terminal stays globally-serial (shared shell state). Reuse existing diff-zone isolation.
- **Risk:** Med. Flag-gated, default current behavior.

### C3. Lint feedback: event-driven, not fixed 2s
- **Where:** `toolsService.ts:1390` — waits fixed 2s after edit then reads markers.
- **Problem:** fixed sleep is both too slow (fast linters) and too fast (slow linters miss errors).
- **Fix:** wait on `IMarkerService` change event for the edited URI with a 2s ceiling. Same output, better timing.
- **Risk:** Low.

---

## Tier D — Autocomplete quality (existing func, currently degraded)

### D1. Un-stub cross-file context
- **Where:** `autocompleteService.ts:260` AND `:568` — `relevantContext=''`; the context-gathering service is commented out at `:256-259`.
- **Problem:** autocomplete runs on ±30 lines only (`constants.ts` `CONTEXT_LINES_BEFORE/AFTER=30`); the whole cross-file/snippet context feature is dead code. Quality far below what the FIM prompt supports.
- **Fix:** revive the context-gathering path (recently-viewed files + LSP symbols + import neighbors) into `prepareFIMMessage`. This is *restoring an existing, disabled function*, not new work. Cap context by tokens (uses B1 tokenizer).
- **Risk:** Med. Flag-gated; measure acceptance-rate before/after.

### D2. Robust partial-filtering (badPhrases)
- **Where:** `autocompleteService.ts:346-353` — hardcoded English `badPhrases` list rejecting models that explain instead of complete.
- **Problem:** brittle, English-only; misses non-English explanations, false-positives on legit completions.
- **Fix:** replace with structural detection (prose-vs-code heuristics: leading capital + sentence punctuation, code-token density) instead of a phrase list. Keep list as a supplement.
- **Risk:** Low.

---

## Tier E — Cleanup / migration debt (reduce fragility surface)

### E1. Finish or remove the hidden plan-tool migration
- **Where:** `prompts.ts:1216` `llmHiddenBuiltinToolNames` — `update_plan_section` / `add_plan_todo` / `mark_plan_item_complete` defined but hidden; handled defensively at `chatThreadService.ts:2417-2431`.
- **Problem:** mid-migration to the Plan Editor UI; dead-but-present LLM tools add branches and confusion.
- **Fix:** decide — either fully remove the LLM path (and the defensive handling) or finish wiring. Recommend remove, since plans are authored via `create_plan` + the Plan Editor.
- **Risk:** Low.

### E2. Dead code removal
- **Where:** `convertToLLMMessageService.ts:1138` (`prepareLLMSimpleMessages` reserved dead branch); `chatThreadService.ts:871` (`// TODO URI.revive instead of this?`).
- **Fix:** remove reserved/dead code; resolve the URI.revive deserialization TODO (correctness in thread reload).
- **Risk:** Low.

---

## Execution order & sizing

| # | Item | Tier | Effort | Risk |
|---|---|---|---|---|
| 1 | A1–A3 loop invariants + tests (batch/approval, placeholder, abort) | A | M | Low |
| 2 | A4 compaction safety, A6 cache byte-identity test | A | S | Low |
| 3 | B1 real tokenizer | B | M | Low |
| 4 | B2 reasoning honors overrides | B | S | Low |
| 5 | A5 MCP cancellation | A | M | Med |
| 6 | B3 retry/rate-limit uniformity | B | M | Med |
| 7 | C3 lint event-driven; E1/E2 cleanup | C/E | S | Low |
| 8 | C1 StrReplace fuzzy fallback | C | M | Med |
| 9 | C2 per-file mutating lock | C | M | Med |
| 10 | D1 autocomplete cross-file context | D | M | Med |
| 11 | D2 partial-filtering robustness | D | S | Low |
| 12 | B4 non-Anthropic prompt caching | B | M | Med |

**Start with #1–2 (Tier A).** They make the *current* harness production-grade — the fragile, repeatedly-patched loop paths get real invariants + tests before anything else changes. #3–4 are cheap, high-value fidelity fixes. Everything below is flag-gated with the current behavior as default until measured.

## Non-breaking guardrails (every item)
- No tool schema/semantics changes; no new tools. Existing `builtinTools` contract untouched.
- Behavior changes (C1, C2, D1, B2, B4) ship behind settings flags defaulting to **current** behavior.
- Per item: `npm run buildreact` (edit `src/`, never `src2/`/`out/`), typecheck `--max-old-space-size=8192`, orbit unit tests via `index.js --runGlob` (one known pre-existing plan-mode Shell failure expected).
- Tool schemas that change must round-trip all 4 serializers (Anthropic/OpenAI/Gemini/Codex) + XML fallback.
- Prompt-cache byte-identity (A6) is a merge gate for any harness-context change.
