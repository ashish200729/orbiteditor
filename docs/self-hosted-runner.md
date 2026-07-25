# Self-hosted Runner (Orbit Editor)

Orbit Editor can send agent tasks to a **Self-hosted Runner** — a separate process you install on your own machine or server. The runner owns the full agent loop (model calls + tools). The editor is the control UI: create tasks, stream live events, approve permissions, cancel, and reconnect after restart.

The composer execution selector shows:

```text
Local
Self-hosted Runner
```

Never labeled “Cloud.” **Local** remains the default and uses the existing in-process agent unchanged.

## Pairing (no Orbit login)

1. Start the Orbit Runner (`orbit-runner` package) and open its dashboard (default HTTP port `7420`).
2. Generate a one-time pairing code (TTL ~10 minutes).
3. In Orbit Editor open **Settings → Self-hosted Runners**.
4. Enter the pairing code and the runner WebSocket URL (default `ws://127.0.0.1:7421/ws`).
5. Click **Pair**. Credentials are stored encrypted in application storage — never logged.

You can rename, test connection, refresh status, or revoke a paired runner from the same settings page.

## Models from Orbit Editor (no re-typing)

1. Configure providers in Orbit **Settings → Models** as usual.
2. Pair a runner (or wait until it comes online). Orbit automatically syncs the **Chat** provider (and fingerprint-changed keys) to that runner.
3. Keep using Orbit’s normal Chat model picker for any synced provider. Debounced Settings changes re-sync **chat-only** (fingerprint-diff). Use **Sync all providers now** under **Settings → Self-hosted Runners** for a full refresh.
4. Remote tasks send only `providerId` + `modelId`. Keys are encrypted on the runner and never returned to the editor.

**Not available on runner v1:** Orbit Provider, ClinePass, ChatGPT Plus/Pro OAuth, SuperGrok, native Anthropic, Google Vertex (ADC). If Chat uses one of these, sync is skipped — switch Chat to a BYOK or OpenAI-Compatible model (DeepSeek, OpenAI, OpenRouter, Groq, custom gateway, …).

Custom OpenAI-Compatible HTTPS base URLs (e.g. `https://compute.virtuals.io/v1`) work after copy/auto-copy with the runner’s default `trusted` origin policy. Restart the runner after upgrading for that default to apply.


## Running a remote task

Same chat composer as Local — no separate remote task form.

1. Open a folder that is a **git repository** with a GitHub or GitLab `origin` HTTPS remote.
2. In the chat composer, open the execution target dropdown and pick a paired **Self-hosted Runner**.
3. A compact **branch** pill appears next to the runner selector. It selects an existing `origin` branch without switching your local checkout; Orbit resolves and pins its immutable remote SHA.
4. Type the task in the normal chat input and submit. Orbit auto-detects the workspace remote URL and selected remote branch (no repo URL field).
5. Model comes from the Chat model picker. Orbit JIT-syncs the provider before submit if needed, then validates via `model.resolve`. If unsupported or offline, submit shows a clear error.
6. Safe reasoning summaries, assistant output, environment setup, tools/results, live status, approvals (Allow once / Allow this tool for this run / Deny), cancel, and reconnect render in the normal chat surface.
7. After an editor restart, active tasks reconnect and replay from the last acknowledged sequence.
8. When a task **completes**, the runner finalizes Cursor-style handoff on the host workspace:
   - Creates branch `orbit/<shortTaskId>`, commits agent changes, and **pushes** when the repo is on `ORBIT_RUNNER_CREDENTIALED_REPOSITORIES` with host git credentials.
   - Emits `artifact.branch`, optional `artifact.pr` (compare or PR URL), and `artifact.patch` (Apply fallback, capped at 1 MiB).
9. The chat completion card offers three actions (same idea as Cursor Cloud Agents):
   - **Open PR** — opens the PR or compare URL (works without switching your local branch).
   - **Checkout locally** — fetches the agent branch; if your tree is dirty, creates a sibling **worktree** instead of overwriting local edits.
   - **Apply locally** — `git apply` into the current tree only when it is **clean** and `HEAD` still equals the pinned base SHA. If HEAD drifted, use Checkout or Open PR instead.
10. A later turn in the same thread continues in the completed remote workspace and **reuses the same `orbit/…` branch**.

Submitting while a runner is selected **does not** call the local `_runChatAgent` path — it creates a runner task against the current workspace git remote.

**Requirements:** git repo + HTTPS GitHub/GitLab remote. No local-folder upload in v1. SSH remotes are rejected.

**Important (same as Cursor Cloud Agents):** the runner **clones from the remote**. Uncommitted local changes and commits that exist only on your machine are **not** available to the runner until you push. Edits made on the runner are **not** streamed into your open folder mid-run — use Open PR / Checkout / Apply after completion.

**Push credentials (for Open PR / Checkout):** on the runner host, set `ORBIT_RUNNER_CREDENTIALED_REPOSITORIES` to the repo HTTPS URL (same allowlist used for private clones) and configure non-interactive git credentials (for example `gh auth setup-git` or a PAT in a credential helper). Push runs on the **host** after the agent finishes (not inside the task container). Without allowlist/credentials, Apply locally remains available when your tree matches the base commit. Optional: install authenticated `gh` on the host to create a draft PR URL instead of a compare URL.

## Protocol

- Version: `orbit-runner-protocol/1` (aligned with `orbit-runner/src/protocol`)
- Envelope: `{ protocol, type, id, ts, payload }`
- Transport (v1): direct WebSocket editor ↔ runner (default `ws://127.0.0.1:7421/ws`)
- Non-loopback runners require `wss://`; Orbit refuses to copy credentials over plaintext LAN WebSockets.
- Pairing: `pair.redeem` → `pair.result` (device credential)
- Auth: `auth` → `auth.result`
- Tasks: idempotent `task.create` → `task.created`; live/reconnect via `task.subscribe`, `task.snapshot`, sequenced `task.event`, and replay from the next needed sequence
- Approvals: `approval.request` → `approval.response`

Editor mirror: `src/vs/workbench/contrib/orbit/common/runner/`.

## Capability negotiation (v1)

Supported: `git_github`, `git_gitlab`, `git_push`, `shell`, `file_tools`.

**Unsupported** (rejected clearly if requested):

| Capability | Why |
|---|---|
| `browser` | No remote browser automation in v1 |
| `computer_use` | Desktop CU stays local |
| `semantic_search` | Index lives in the editor |
| `local_workspace_transfer` | No local-folder upload; use git remotes |

Git remotes: **GitHub and GitLab only** in v1.

Model preference sent as `{ provider, modelId }` from the current Chat model selection — **API keys stay on the runner**.

## Failure messages

| Situation | Typical message |
|---|---|
| Runner offline | Could not connect / Self-hosted runner is offline |
| Pairing code expired | Pairing code expired. Generate a new code… |
| Protocol mismatch | Protocol version mismatch… |
| Unsupported feature | Self-hosted Runner v1 does not support: … |
| Non-GitHub/GitLab repo | Remote host … is not supported in v1 |

## Security notes

- Device tokens are encrypted at rest (`IEncryptionService`) under `orbit.runners.pairedCredentialsI`.
- Never log `deviceToken` or provider keys.
- Prefer pairing / connecting so Orbit auto-syncs all copyable providers, or use **Sync all providers now** in Settings. Dashboard key entry remains optional fallback — keys stay on the runner and are not sent per task.

## Deliberate v1 boundaries

- Direct WebSocket only; an optional relay/control plane is not implemented.
- Each active remote task opens its **own** authenticated WebSocket to the runner (not multiplexed yet).
- Remote image/file-range attachments are blocked with a clear error rather than silently dropped.
- Native Anthropic and OAuth-managed providers are unavailable until protocol-correct provider adapters/task tokens exist.
- MCP tools, browser, computer use, and semantic search are unavailable on the runner — use Local for those features.
- SSH remotes are rejected (HTTPS GitHub/GitLab only). Do not convert SSH → HTTPS silently.

## Related code

| Area | Path |
|---|---|
| Protocol + state machine | `common/runner/` |
| Pairing service | `browser/runnerService.ts` |
| Remote tasks | `browser/remoteTaskService.ts` |
| Settings UI | `browser/react/src/orbit-settings-tsx/RunnersSection.tsx` |
| Run-on picker (empty thread) | `…/chat/ExecutionTargetPicker.tsx` — This Mac/PC \| Self-hosted Runner |
| Remote task actions (inline) | `…/runner/RemoteTaskInlineCard.tsx` |
| Runner daemon | `/orbit-runner` (sibling package) |
