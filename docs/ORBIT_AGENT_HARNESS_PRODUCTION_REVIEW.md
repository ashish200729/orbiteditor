# Orbit Agent Harness Production Review

Date: 2026-07-15

## Executive verdict

Orbit already has a credible agent foundation: multi-provider streaming, native and XML tool calling,
parallel read tools, checkpoints, plan mode, queued follow-ups, context compaction, MCP, browser
automation, skills, custom subagents, and an Agents window. It is substantially beyond a prototype.

It is not yet at a production-readiness or control-plane level comparable to current Cursor. The main
gap is not model prompting or visual polish. It is the execution substrate around the model:
transactional edits, one permission broker for every execution path, sandboxing, durable run state,
worktree isolation, lifecycle hooks, privacy-aware observability, and a repeatable agent evaluation
suite.

This review covered the complete `src/vs/workbench/contrib/orbit/` tree structurally (411 files,
approximately 92,000 non-generated lines) and traced the critical harness path in depth:

`React composer -> chatThreadService -> convertToLLMMessageService -> sendLLMMessage -> tool broker
-> file/terminal/MCP/subagent execution -> checkpoints/persistence/UI`

Generated `src2/`, `out/`, and `.build/` artifacts were excluded as required by repository policy.

## Current architecture

| Layer | Primary code | Responsibility |
|---|---|---|
| Conversation runtime | `browser/chatThreadService.ts` | Thread state, agent loop, streaming, approvals, queue, compaction, checkpoints |
| Prompt and policy | `common/prompt/prompts.ts` | System prompts, tool schemas, mode-specific tool policy |
| Context conversion | `browser/convertToLLMMessageService.ts` | Provider message formats, tool-result repair, trimming, rule injection |
| Provider transport | `electron-main/llmMessage/sendLLMMessage.impl.ts` | OpenAI, Anthropic, Gemini, Ollama, OpenAI Codex and compatible streaming |
| Tool implementation | `browser/toolsService.ts` | Validation and execution for read, search, edit, shell, plan, task, and skill tools |
| Delegation | `browser/subAgentService.ts`, `common/subAgentRegistry.ts` | Foreground/background child loops and permission tiers |
| Terminal runtime | `browser/terminalToolService.ts` | Shell lifecycle, waiting, background release, notifications |
| Extensibility | `common/mcpService.ts`, `electron-main/mcpChannel.ts`, skill/agent loaders | MCP, skills, custom agents, marketplace |
| Browser agent | built-in browser MCP plus platform browser automation services | Snapshot, input, screenshots, console/network inspection |
| UI | `browser/react/src/` | Sidebar, message/tool rendering, queue, settings, plan editor, Agents window |

The architecture guide previously referenced a nonexistent
`subAgentOrchestratorService.ts`; the active implementation is `subAgentService.ts`. The guide was
corrected as part of this review.

## What is strong today

- The main agent has a hard iteration cap, retry classification, exponential backoff, provider
  `Retry-After` support, cancellation, and stale-turn protection.
- Tool schemas and policy are centralized enough to support Agent, Plan, and Normal modes.
- Read-only calls are separated from mutating calls, and MCP read-only annotations are honored.
- Context compaction keeps the full UI history and stores a detailed transcript for recovery.
- Chat persistence already includes size caps, media stripping, debounced writes, and a startup
  corruption fallback.
- Browser automation has an explicit CDP denylist and good contract tests.
- Skills and custom agents have size limits, frontmatter validation, and scope precedence.
- The test suite has useful regression coverage for plan mode, tool normalization, browser safety,
  streaming tool accumulation, storage helpers, and sanitization.

## High-impact defects fixed in this pass

### 1. Delegation bypassed the approval boundary

Foreground subagents executed built-in tools directly through `toolsService`. A `general` child could
therefore run edits or terminal commands even when the corresponding global auto-approval setting
was disabled. It also bypassed the parent agent's sensitive-path and outside-workspace guard.

Fix:

- Extracted shared path-security policy into `common/agentToolSecurity.ts`.
- Applied the same sensitive/outside-workspace policy to parent and child tool execution.
- Foreground subagents now honor edit and terminal auto-approval settings.
- Smart-mode shell calls that explicitly require review remain blocked in a subagent.
- Background subagents continue to reject tools that need approval.

### 2. MCP cancellation did not reach a running subagent call

The subagent MCP timeout had a cancellation token, but the user-facing cancel callback was not wired
to it. A stopped child could remain active until the configured timeout.

Fix: the active subagent cancellation callback now cancels the MCP token immediately and is cleared
reliably in `finally`.

### 3. Stopping a parent could leave descendants alive

Stopping the parent turn did not cancel already-launched background children. A child could finish
later, modify files, or wake the parent continuation after the user believed the run was stopped.

Fix: `abortRunning` now cancels foreground and background descendants for the thread.

### 4. Persisted queued attachments lost URI behavior

Thread history used a URI-aware JSON reviver, but persisted queued messages used plain `JSON.parse`.
After restart, queued file selections could contain plain objects instead of VS Code `URI` instances.

Fix: both stores now use the same URI-aware parser; restored queues are validated and capped before
being accepted.

### 5. Queue deduplication could silently discard valid context

The duplicate check compared only attachment counts. Two otherwise identical messages with one
different file each were treated as duplicates.

Fix: queue equality now compares actual URI, range, browser element, and image content, and queued
selection snapshots clone nested mutable state.

### 6. Parallel tool execution was unbounded

A single model response could launch every read-only/MCP tool through `Promise.all`, creating an
unbounded filesystem, network, and renderer-update burst.

Fix: parallel batches now use ordered bounded concurrency (maximum 8). The reusable helper is tested
for ordering, concurrency, and invalid configuration.

## Cursor comparison

This is a capability comparison, not a request to copy Cursor's UI or proprietary implementation.
The useful lesson is which control-plane concepts have proven important in a mature agent product.

| Production capability | Cursor public behavior | Orbit status |
|---|---|---|
| Agent tools, diff review, checkpoints | Core documented agent workflow | Present |
| Queued follow-ups and reorder | Durable ordered queue with reordering | Queue present; durability and integrity improved; steering semantics remain different |
| Plan mode and todos | Plan workflow and long-running execution | Present |
| Browser control | Screenshots and direct UI targeting | Strong built-in MCP implementation |
| Project/user rules | Always, glob-scoped, agent-requested rules | Basic `.orbit` instructions/skills; no equivalent scoped rule engine |
| Memories | Repository-scoped, user-controlled persistent memories | No native memory lifecycle or approval UI |
| Async subagents | Parallel children and multitask workflows | Foreground/background children exist; state is in-memory and nesting is disabled |
| Worktree isolation | First-class local worktree agents | SCM view exists; agent runs do not receive isolated worktrees |
| Sandboxed execution | Filesystem/network controls plus approval modes | No agent command sandbox or network policy layer |
| Auto-review permission classifier | Allow, sandbox, reroute, or ask | Static approval categories only |
| Lifecycle hooks | Prompt, tool, thought, subagent, compaction, stop, completion hooks | No public harness hook system |
| Side chats and transcript search | Durable side investigations and search | Multiple threads exist; no side-chat relationship or transcript search index |
| Durable background/cloud runs | Resume, follow up, take over, notify | Local background children are process/window-bound |
| Evaluation/review agents | Productized review and security workflows | Review skill content exists; no benchmark/evaluation gate |

Primary references:

- Cursor Agent overview: https://docs.cursor.com/chat/overview
- Cursor tools: https://docs.cursor.com/en/agent/tools
- Cursor planning and queued messages: https://docs.cursor.com/en/agent/planning
- Cursor rules: https://docs.cursor.com/context/rules
- Cursor memories: https://docs.cursor.com/en/context/memories
- Cursor sandbox/async subagent release: https://cursor.com/changelog/2-5
- Cursor auto-review execution mode: https://cursor.com/changelog/auto-review
- Cursor multitask/worktrees release: https://cursor.com/changelog/04-24-26
- Cursor side chats and lifecycle hooks: https://cursor.com/changelog
- Cursor security overview: https://cursor.com/en-US/security

## Remaining production gaps

### P0: required before calling the harness production-safe

1. **Create a single execution broker.** Parent, subagent, MCP, browser, and future automation paths
   must all pass through the same validation, approval, audit, cancellation, timeout, and result-size
   policies. The security helper added here prevents current drift but does not replace a broker.

2. **Make edits transactional across delegation.** Child `Write`/`StrReplace` operations do not flow
   through the parent checkpoint orchestration. Capture a run-level change journal before every
   mutating operation, including subagents, and support atomic accept/reject/restore.

3. **Sandbox shell and risky MCP execution.** Add OS-specific filesystem and network policies with
   three modes: ask every time, auto-run in sandbox, and explicitly trusted allowlists. Treat
   workspace content, tool output, web pages, and MCP results as untrusted prompt input.

4. **Persist a versioned run journal.** Thread JSON is not a durable agent runtime. Persist turn id,
   tool call state, approvals, child relationships, queue state, cancellation reason, usage, and
   checkpoint transaction in an append-only/versioned format. On restart, recover to a safe paused
   state and never replay a mutating call automatically.

5. **Add adversarial harness tests.** Cover prompt injection, delegated permission bypass, MCP schema
   abuse, cancellation races, duplicate/out-of-order streaming frames, crash recovery, huge tool
   output, symlink/path escape, and concurrent file mutation.

### P1: required for dependable Cursor-class UX

1. **Split `chatThreadService.ts`.** At more than 4,000 lines it owns persistence, queueing, agent
   state machine, approvals, checkpoints, compaction, background continuation, telemetry, and UI
   notifications. Extract `AgentRunController`, `ThreadRepository`, `ApprovalBroker`,
   `CheckpointManager`, `MessageQueue`, and `CompactionService` behind explicit interfaces.

2. **Replace implicit state strings with a typed run state machine.** Model terminal, retrying,
   awaiting approval, awaiting answer, compacting, child-running, paused, failed, and completed
   states and validate transitions. This removes scattered early returns that can strand state.

3. **Build an evaluation harness.** Maintain real repository tasks and score completion, diff
   correctness, tests, latency, token cost, approval count, rollback success, and unsafe attempts.
   Gate prompt/model/tool changes on these evaluations.

4. **Add scoped rules and controlled memory.** Support always-on, path/glob, manually invoked, and
   model-requested rules. Any automatically extracted memory should be reviewable, deletable,
   repository-scoped, and disabled by privacy policy when appropriate.

5. **Add local worktree isolation.** Allow long-running or parallel agents to work on dedicated
   branches/worktrees, then present a deterministic diff and one-click foreground handoff.

6. **Make background agents durable.** Persist child state, show ownership and status independently
   of the parent message, support follow-ups/takeover, and reconcile completion after restart.

7. **Add lifecycle hooks.** Provide typed pre/post hooks for prompt submission, tool calls,
   compaction, child start/end, stop, and turn completion. Hooks must have timeouts, output limits,
   clear trust scope, and an audit trail.

8. **Improve context selection.** Current directory strings plus explicit attachments work, but a
   production context engine needs symbol-aware retrieval, recent-change relevance, scoped rules,
   conversation search, and measured context-quality telemetry.

9. **Version storage schemas and migrations.** Chat message comments warn that changes need
   migration, but there is no explicit schema version/migration registry. Add versioned codecs and
   corruption quarantine rather than silently treating every incompatible blob as empty.

10. **Make telemetry privacy-aware.** Add structured run/tool timing and outcomes without prompt,
    code, paths, secrets, or tool output. Define retention, opt-out behavior, sampling, and a local
    diagnostics export.

### P2: valuable after the substrate is safe

- Queue reorder/edit and explicit steer-now versus run-later semantics.
- Side chats linked to a parent turn and searchable transcript history.
- Nested subagents with depth/budget limits after the execution broker exists.
- Cost and context-budget forecasts before expensive runs.
- Voice follow-ups, remote control, mobile review, cloud agents, and automations.
- A first-class review/security agent that reports only new diff findings.

## Performance priorities

1. Move thread persistence from one application-wide JSON blob to an indexed/versioned repository.
2. Keep streaming state outside immutable full-thread replacement paths and measure React commit cost.
3. Enforce byte/token budgets at every tool-result boundary, including MCP and terminal streams.
4. Cache prompt-invariant system/tool schema sections by model and mode.
5. Add tracing for time-to-first-token, tool validation, approval wait, tool execution, compaction,
   persistence, and render latency.
6. Break up the largest React modules (`inputs.tsx`, Settings, file explorer) before adding more UX.

## Recommended delivery sequence

### Milestone 1: safety and observability

- Unified execution broker and typed permission decision.
- Transactional child edits and complete cancellation propagation.
- Versioned run journal and structured local diagnostics.
- Red-team and crash-recovery tests.

### Milestone 2: isolation and durability

- Sandboxed terminal/MCP policies.
- Worktree-backed parallel runs.
- Durable background child lifecycle and recovery.
- Storage migrations.

### Milestone 3: quality and context

- Agent evaluation suite and release gates.
- Scoped rules, controlled memories, transcript search.
- Symbol/relevance-based context selection.
- Prompt and tool-schema caching.

### Milestone 4: product parity and polish

- Side chats, steer/queue controls, queue management.
- Hooks and plugin packaging.
- Review/security agents, remote handoff, automations.

## Verification for this pass

- `npm run compile-client`: passed with zero TypeScript errors.
- `npm run test-node -- --runGlob '**/orbit/test/**/*.test.js'`: 426 passing.
- `npm run buildreact`: passed; the build reported existing unused-import warnings and stale
  Browserslist data, but no build failure.
- `npm run eslint`: completed with repository-wide pre-existing warnings outside the touched Orbit
  harness files and no new harness lint error.
- Focused security, queue, and concurrency tests added under `orbit/test/common/`.
- `git diff --check`: clean.

The existing unrelated/staged React work was preserved and not rewritten by this review.
