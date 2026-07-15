# Semantic Codebase Search

Orbit can build a private, per-workspace embedding index and expose it to Chat, Plan,
Agent, and read-only subagents through the `CodebaseSearch` tool. Exact searches still use
`Grep`; filename searches still use `Glob`.

## Local setup with Ollama

1. Install Ollama.
2. Run `ollama pull nomic-embed-text`.
3. Open Orbit Settings > Tools > Semantic Codebase Search.
4. Select `Ollama (local)`, use `http://localhost:11434`, and set the model to
   `nomic-embed-text`.
5. Enable Semantic Codebase Search.

The index is stored under Orbit's workspace storage, not in the repository. Source files
and embeddings remain local when Ollama is used.

## OpenAI-compatible providers

Select `OpenAI-compatible`, then enter an embeddings endpoint, model, and optional API key.
Orbit accepts either a base endpoint such as `https://host.example` or a `/v1` endpoint and
calls `/v1/embeddings`. This mode sends indexed source chunks and search queries to the
configured provider. Only enable it for a provider you trust and whose data-retention policy
you accept.

## Excluding files

Orbit honors the editor's search exclusions and ignore-file behavior. Add a `.orbitignore`
file at a workspace root for semantic-index-only exclusions:

```gitignore
private/
fixtures/generated/**
*.generated.ts
```

Common dependency, build, binary, credential, private-key, and `.env` paths are excluded by
default. Lock files (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`,
`Cargo.lock`, `go.sum`, `Gemfile.lock`, `poetry.lock`, `composer.lock`, `flake.lock`, etc.),
ignore files (`.gitignore`, `.dockerignore`, `.eslintignore`, `.prettierignore`, etc.), VCS
metadata (`.gitattributes`, `.gitmodules`), and common build/tooling files (`Dockerfile`,
`docker-compose.yml`, `Makefile`, `.nvmrc`) are also skipped — they carry no semantic value for
code search. Files larger than 512 KiB are skipped.

## Operational behavior

- Indexing is disabled by default and requires a trusted workspace.
- Initial indexing runs in the background and is bounded to 20,000 files and 50,000 chunks.
- Saves, creates, deletes, and renames update only affected resources; large change sets
  trigger a safe full reconciliation.
- Unsaved open editor contents are used during reconciliation.
- Existing vectors are reused when content hashes have not changed.
- Index generations are written atomically and invalidated when the provider, endpoint,
  model, chunking format, or schema changes.
- If the embedding provider is unavailable, Orbit preserves the last valid local index and
  agents can continue with `Grep`, `Glob`, and `Read`.
