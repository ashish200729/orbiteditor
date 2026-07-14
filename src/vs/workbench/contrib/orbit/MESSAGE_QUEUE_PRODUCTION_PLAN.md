# Orbit — Message-Queue Production-Readiness Plan

Scope: the "send while the agent runs → queue instead of abort" system (Cursor-style) in
`src/vs/workbench/contrib/orbit/`. Goal: correct, durable, discoverable, fully-managed queue from
composer UI to backend drain.

Source of truth: edit `src/` only. `src2/` and `out/` are generated — rebuild via `npm run buildreact`.
Full typecheck needs `--max-old-space-size=8192`.

Basis: read-only audit of the three files that implement the queue today —
`chatThreadService.ts`, `sidebar-tsx/SidebarChat.tsx`, `util/services.tsx` — plus the composer
(`orbitChatArea.tsx`), quick-edit (`QuickEditChat.tsx`), and thread lifecycle (`deleteThread`,
persistence).

## Severity legend
P0 = dataloss / stuck-forever / silent wrong-context. P1 = major correctness/UX gap. P2 = polish.
`[verify]` = reproduce before fixing.

---

## How it works today (baseline)

Data model — `chatThreadService.ts`:
- `QueuedUserMessage = { userMessage, llmInstructions?, _chatSelections?, _images? }` (`:520`).
- In-memory only: `_queuedUserMessagesByThread: Map<string, QueuedUserMessage[]>` (`:549`).
- Event `onDidChangeQueuedMessages` (`:546-547`) → React hook `useQueuedUserMessages` (`services.tsx:512`).

Enqueue — `addUserMessageAndStreamResponse` (`:3066`): if `streamState[threadId].isRunning` is
`'LLM' | 'tool' | 'idle'`, push to the queue and return (`:3074-3081`). `'awaiting_user'` keeps the
legacy interrupt path (queueing there would deadlock — nothing drains).

Drain — `_drainNextQueuedUserMessage` (`:3053`) shifts one FIFO and fires a fresh run. Called from
**exactly one** place: the clean terminal end of the agent loop (`:2600`), gated on
`isRunningWhenEnd !== 'awaiting_user'`. Draining suppresses the completion sound/notification.

Clear — `abortRunning` (Stop) clears the whole queue (`:1718`). `removeQueuedUserMessage(threadId, idx)`
removes one (`:3038`).

UI — `SidebarChat.tsx`: Enter (`:283-284`) is **not** gated on running → calls `onSubmit` → queues.
Queued chips render above the composer (`:508-522`): label "Queued" + truncated text + × remove.
Primary button while running shows **Stop** (`orbitChatArea.tsx:160-166`), not Submit.

---

## The gaps

### P0 — correctness / dataloss

| ID | Item | File:line | Problem | Fix approach | Acceptance |
|----|------|-----------|---------|--------------|-----------|
| Q1 | Queued message loses its attachments (selections) | `SidebarChat.tsx:200,205`; `chatThreadService.ts:2971,3077` | `onSubmit` never passes `_chatSelections`, so the queued entry stores `_chatSelections: undefined`. `onSubmit` then clears staging (`setSelections([])`). On drain, `_addUserMessageAndStreamResponse` falls back to `thread.state.stagingSelections` — now `[]` or the user's **next** staged files → wrong or empty context. | Snapshot selections at submit time and thread them through: `onSubmit` passes `_chatSelections: selections`; enqueue stores that snapshot; drain uses the stored snapshot (never the live thread state). Deep-copy so later staging edits don't mutate the queued entry. | Stage 2 files, send while running: queued chip shows the 2 files; on drain the user message carries exactly those 2, regardless of what's staged now. |
| Q2 | Queue never drains after a run **error** | `chatThreadService.ts:2308,2357` vs `:2600` | Drain runs only at the clean terminal end. The LLM-error (`:2295/2308`) and unexpected-error (`:2357`) paths set `isRunning: undefined` and never drain. A queued message after a failed turn sits stuck until the user manually sends again. | Extract a single "turn fully ended" exit that decides drain-vs-notify, and route error paths through it (or call `_drainNextQueuedUserMessage` in the error handlers). Decide policy: on error, **pause** the queue (keep messages, surface a "resume queue" affordance) rather than silently blasting the next message into a broken turn. Default: pause + banner. | Force an LLM error mid-run with one queued message → message is preserved and a "resume" control appears; clicking it drains. No silent loss, no stuck-forever. |
| Q3 | Drain chain breaks if a drained send throws | `chatThreadService.ts:3060-3062` | `_drainNextQueuedUserMessage` fires `addUserMessageAndStreamResponse(...).catch(log)`. If that rejects before a run starts (throw, or thread vanished), the remaining queue never drains — the terminal-end trigger won't fire again. | On drain failure, either drain the next entry or transition the queue to the paused/error state (Q2). Never leave the queue non-empty with no pending run and no drain trigger. | Inject a throw on the first drained send with 2 queued → second is not orphaned (drained or surfaced as paused). |

### P1 — correctness / UX

| ID | Item | File:line | Problem | Fix approach | Acceptance |
|----|------|-----------|---------|--------------|-----------|
| Q4 | Queue is memory-only — lost on reload/restart | `chatThreadService.ts:549,909-930` | `_queuedUserMessagesByThread` is never serialized; persistence writes only `THREAD_STORAGE_KEY`. Window reload / crash / restart silently drops all queued messages. | Persist the queue per-thread (own storage key, or a `queuedMessages` field on the sanitized thread). Rehydrate on load. On startup, if a thread has a queue but no running stream, mark it **paused** (don't auto-fire into a cold thread) and show the resume affordance. Sanitize image data-URIs against the storage-size budget already used for threads. | Queue 2 messages, reload window → both still shown as queued (paused); resume drains them in order. |
| Q5 | No discoverable affordance that Enter queues | `orbitChatArea.tsx:160-166`; `SidebarChat.tsx:283` | While running the primary button is Stop; queueing is reachable only by pressing Enter with faith. New users don't discover it; the composer gives no "will queue" hint. | When running and the composer is non-empty, show a distinct **secondary** "Queue" affordance (small send-to-queue button beside Stop, or a placeholder/hint "Enter to queue • Stop to interrupt"). Keep Stop as primary. Tooltip on the queue button. | While running with text typed, a visible Queue control exists; clicking it queues (same as Enter); Stop still interrupts. |
| Q6 | `deleteThread` leaks the queue | `chatThreadService.ts:3493-3539` | Deletes many per-thread maps but not `_queuedUserMessagesByThread`. Orphaned entry lingers (harmless leak today, real bug once persisted per Q4). | Call `_clearQueuedUserMessages(threadId)` in `deleteThread` (and in any bulk "delete all threads"). | Delete a thread with a queue → Map has no entry for it; persisted store (Q4) has none either. |
| Q7 | No size / content guard on enqueue | `chatThreadService.ts:3074-3081` | Unbounded queue depth; empty/whitespace-only messages can be queued; rapid Enter can enqueue exact duplicates. | Cap depth (e.g. 20) — reject with a toast when full. Trim and reject empty `userMessage` (unless it carries selections/images). Optional: collapse an immediate exact-duplicate of the tail. | Queue past the cap → rejected with feedback; whitespace-only → not queued; two identical fast sends → one entry (if dedup enabled). |

### P2 — polish / management

| ID | Item | File:line | Problem | Fix approach |
|----|------|-----------|---------|--------------|
| Q8  | Queued chips hide attachments/images | `SidebarChat.tsx:508-522` | Chip shows only truncated text — user can't tell what context/images are attached. | Render a small file/image count badge (and thumbnails for images) on each chip. |
| Q9  | Can't edit a queued message | `SidebarChat.tsx:508-522` | Only remove is possible; a typo means delete + retype. | Click chip → load its text+attachments back into the composer for edit, or inline-edit. At minimum "edit" = remove-into-composer. |
| Q10 | Can't reorder the queue | service + UI | FIFO only; user can't reprioritize. | Drag-to-reorder or up/down controls calling a new `reorderQueuedUserMessage(threadId, from, to)`. |
| Q11 | No "clear all" | `SidebarChat.tsx:508-522` | Removing many is one-by-one; Stop clears queue but also aborts the run. | Add a "Clear queued" action (header of the queued list) that clears the queue without aborting the run. |
| Q12 | Queued list not announced to a11y | `SidebarChat.tsx:508` | No `role`/live region; screen readers miss "message queued". | Wrap in `role="list"`, items `role="listitem"`, add an `aria-live="polite"` announcement on enqueue/drain. |
| Q13 | Quick-edit (Ctrl+K) submit-while-running is a silent no-op | `QuickEditChat.tsx:64-65` | `isStreamingRef.current` early-returns with zero feedback; user thinks the app hung. | Out of queue scope, but give feedback: disable the submit affordance while streaming or show a "editing…" state. Do **not** add a queue here (single-shot edit; queueing has no clear semantics). Document the deliberate difference. |
| Q14 | Metrics: queue depth / drain outcomes not captured | service | No telemetry on how often users queue, depth, or drop-on-error. | `capture('Message Queued'/'Message Queue Drained'/'Message Queue Dropped', { depth, reason })` at enqueue/drain/clear. |

---

## Design decisions to lock (need sign-off)

1. **On run error (Q2):** pause the queue + surface resume (recommended), vs auto-continue, vs drop.
   Recommend **pause+resume** — auto-continuing into a failed turn compounds errors.
2. **On Stop (`abortRunning`):** keep current behavior (Stop clears the queue). Confirm this is desired
   vs "Stop only halts the current run, queue survives." Recommend keeping clear-on-Stop but adding the
   separate Q11 "Clear queued" so the two intents are distinct.
3. **Persistence scope (Q4):** per-thread `queuedMessages` on the stored thread (simplest, rides
   existing sanitize/size logic) vs a separate storage key. Recommend on-thread.
4. **Queue depth cap (Q7):** default 20. Confirm number.
5. **Pop-out Agents window:** confirm `SidebarChat` (and thus the queued UI) is the same component there,
   so all UI fixes land in both surfaces automatically. `[verify]`

---

## Phased rollout

- **Phase A — correctness (P0):** Q1 (attachment snapshot), Q2 (error drain/pause), Q3 (drain-chain
  safety). Ship first; these are silent-wrong-context and stuck-forever bugs.
- **Phase B — durability + discoverability (P1):** Q4 (persist+rehydrate as paused), Q5 (queue
  affordance), Q6 (deleteThread cleanup), Q7 (caps/validation).
- **Phase C — management UX (P2):** Q8 chips-with-attachments, Q9 edit, Q10 reorder, Q11 clear-all,
  Q12 a11y, Q13 quick-edit feedback, Q14 metrics.

## Verification per batch
- `tsc -p src/tsconfig.json --noEmit --max-old-space-size=8192` exit 0 (0 orbit errors).
- `npm run buildreact` success.
- Orbit unit tests via `index.js --runGlob` (1 known pre-existing plan-mode Shell failure).
- New unit tests: enqueue snapshot immutability (Q1), error-path drain/pause (Q2), persist→rehydrate
  round-trip (Q4), cap/validation (Q7).
- Live drive: stage files + Enter mid-run; force LLM error mid-run; reload with a queue; delete a
  queued thread — each observed end-to-end (not just typecheck).
