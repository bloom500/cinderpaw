# FERAL HTTP API reference

> **Stability policy:** As of v1.0 the Feral HTTP API is **unstable
> pre-2.0**. Every response carries
> `X-Feral-Api-Stability: stable|unstable`. The **only** stable
> surfaces are the third-party protocol compat:
>   * `/api/*` — Ollama-compatible.
>   * `/v1/*` — OpenAI-compatible.
>
> Everything else (`/runtime/*`, `/meta/*`, `/governance/*`,
> `/modules/*`, `/system_info`, `/providers/test`, `/tokenize`,
> `/events`, the catalog reads) is `unstable`. Additive changes are
> fine; breaking changes can land between minor releases without a
> deprecation cycle. Decision recorded in the spec at
> `docs/2026-07-09-v1-architecture-hardening-spec.md` §B1.

The list below mirrors `crates/feral-core/src/api.rs::router()`.
That file is the source of truth — `scripts/check-api-docs.mjs`
parses its `.route(` lines and fails if any drift from the fenced
`feral-api-routes` block at the bottom of this file. Wired into
`bun test` via `FeralAgent/tests/api-docs.test.ts`.

Operation class tags (`read`, `evolve`, `govern`) come straight from
the comment tags next to each `.route(` line.

---

## Stable surface (third-party compat)

| Method | Path | Stability | Notes |
|---|---|---|---|
| GET  | `/api/tags` | stable | Ollama-compatible. Lists installed models. |
| POST | `/api/show` | stable | Ollama-compatible. Returns model metadata. |
| POST | `/api/generate` | stable | Ollama-compatible. Non-streaming generation. |
| POST | `/api/chat` | stable | Ollama-compatible. Chat-completion format. |
| DELETE | `/api/delete` | stable | Ollama-compatible. Deletes a model by name (validated; refuses path escapes). |
| GET  | `/v1/models` | stable | OpenAI-compatible. |
| POST | `/v1/chat/completions` | stable | OpenAI-compatible. |

## Unstable surface (everything else is `unstable` pre-2.0)

### System / observability

| Method | Path | Stability | Class | Notes |
|---|---|---|---|---|
| GET | `/system_info` | unstable | read | Hardware probe (GPU/VRAM/RAM/disk) for the Setup Wizard. |
| POST | `/providers/test` | unstable | read | Provider key validation; real status text per provider. |
| GET | `/events` | unstable | read | SSE stream of `HostEvent`s; first vertical of the runtime API. |

### Runtime (`/runtime/*`)

| Method | Path | Stability | Class | Notes |
|---|---|---|---|---|
| POST | `/runtime/chat` | unstable | govern | Sidecar-roundtrip chat. |
| POST | `/runtime/ask/respond` | unstable | govern | Answer a pending `ask_user` question (`{requestId, answers}`); the question arrives as a typed `ask_user` SSE event on the chat stream. |
| GET  | `/runtime/connectors` | unstable | read | Redacted state (enabled, filled secret keys, allowlist, channels, mode) per persisted connector. |
| POST | `/runtime/connectors` | unstable | govern | Upsert one connector's config, then pokes the sidecar to reload. Never echoes secret values back. |
| POST | `/runtime/connectors/reload` | unstable | govern | Sidecar reloads the connector catalog from disk. |
| POST | `/runtime/shutdown` | unstable | govern | Fires the runtime's graceful-shutdown signal. |
| GET  | `/runtime/status` | unstable | read | Live status snapshot. |
| GET  | `/runtime/models` | unstable | read | Lists loaded/known models. |
| POST | `/runtime/model` | unstable | evolve | Set the active model. |
| GET  | `/runtime/lora` | unstable | read | Lists LoRAs and provenance. |
| POST | `/runtime/lora/train` | unstable | evolve | Fire-and-forget L2 training cycle (`{domain?}`); result lands as `lora_train_result` on `/events` + a refreshed review inbox. |
| GET  | `/runtime/lora/reviews` | unstable | read | L2 review inbox: pending adapter cards + champions + stats. |
| POST | `/runtime/lora/reviews/resolve` | unstable | govern | THE human decision on an adapter candidate (`{id, action: approve\|reject}`). |
| GET  | `/runtime/manifest` | unstable | read | Active module manifest snapshot. |
| GET  | `/runtime/sessions` | unstable | read | Lists sessions. |
| GET  | `/runtime/resume` | unstable | read | Memory Resume — last-task row for clients. |
| POST | `/runtime/session/compact` | unstable | evolve | Summarize the older portion of one session's transcript now (`{ session_id? }`, default "default"). Sidecar round-trip; the summarizer is a real LLM completion (120s cap). |
| POST | `/runtime/byok/save` | unstable | govern | Persist provider key + metadata; never echoes the key. |
| POST | `/runtime/models/install` | unstable | evolve | Kick off a background model download; returns download id. |
| GET  | `/runtime/models/download/:id` | unstable | read | Polled by the wizard for download progress. |
| GET  | `/runtime/setup/detect` | unstable | read | Guided-setup detection ladder (existing config → local GGUFs → hardware download → env keys → Ollama → OpenClaw import) + hardware summary + security-ack state. |
| POST | `/runtime/setup/verify` | unstable | govern | Real-completion test of a detected candidate ("Reply with the single word OK…", 32 tok, 90s); `persist:true` writes the route only on success. |
| POST | `/runtime/setup/ack` | unstable | govern | Persist the one-time security-acknowledgement timestamp in settings.json. |
| GET  | `/runtime/providers/catalog` | unstable | read | Provider catalog; carries `X-Feral-Catalog-Version`. |
| GET  | `/runtime/connectors/catalog` | unstable | read | Connector catalog; same versioning header. |

### Meta (`/meta/*` — L6, sidecar roundtrip)

| Method | Path | Stability | Class |
|---|---|---|---|
| GET  | `/meta/current` | unstable | read |
| POST | `/meta/evaluate` | unstable | evolve (alias of `/meta/current` POST) |
| GET  | `/meta/history` | unstable | read |
| POST | `/meta/evolve` | unstable | evolve |
| POST | `/meta/rollback` | unstable | evolve |

### Governance (`/governance/*` — L5, sidecar roundtrip)

| Method | Path | Stability | Class |
|---|---|---|---|
| GET  | `/governance/policy` | unstable | read |
| GET  | `/governance/proposals` | unstable | read |
| GET  | `/governance/history` | unstable | read |
| GET  | `/governance/verify` | unstable | read |
| POST | `/governance/propose` | unstable | evolve |
| POST | `/governance/approve` | unstable | govern |
| POST | `/governance/reject` | unstable | govern |
| POST | `/governance/rollback` | unstable | govern |
| POST | `/governance/freeze` | unstable | govern |
| POST | `/governance/unfreeze` | unstable | govern |

### Modules (`/modules/*` — L4, sidecar roundtrip)

| Method | Path | Stability | Class |
|---|---|---|---|
| GET  | `/modules` | unstable | read |
| POST | `/modules/evaluate` | unstable | evolve |
| POST | `/modules/propose` | unstable | evolve |
| GET  | `/modules/:id` | unstable | read |
| POST | `/modules/:id/approve` | unstable | govern |
| POST | `/modules/:id/reject` | unstable | govern |
| POST | `/modules/:id/demote` | unstable | govern |

### Helpers

| Method | Path | Stability | Notes |
|---|---|---|---|
| POST | `/tokenize` | unstable | llama.cpp-server-compatible tokenizer used by the sidecar for accurate context accounting. Stays unstable because it isn't tied to a public third-party compat; may move into the runtime surface in v2. |

---

## How to read this

- **`read`** — no side effects. Safe to poll.
- **`evolve`** — writes a candidate (e.g. propose a policy, set a model, install a download). Idempotent or rollback-able in well under one second.
- **`govern`** — promotes / rejects / freezes. Requires human gate downstream; one human decision per request.

Every request must present
`Authorization: Bearer <token>` where `<token>` is read from
`~/.feral/api-token` (per-launch, file mode `0o600` on Unix). The
token rotates on every launch; the in-app sidecar receives it via
the host's env, not via the request.

---

<!-- The fenced block below is the canonical list. The check script
     parses ONLY this block; do not list routes anywhere else in
     this file without mirroring them here. Format: METHOD path,
     one per line, alphabetically within each stability class.

     Known checker limitation (R6): `scripts/check-api-docs.mjs`'s regex
     only harvests the first verb of a chained axum MethodRouter
     (`get(...).post(...)` on one `.route()` call), so it cannot see
     `POST /runtime/connectors` — that route is real (see the table
     above + crates/feral-core/src/api.rs) but is deliberately left out
     of this fenced list to avoid a permanent false "unlisted" warning. -->

```feral-api-routes
DELETE /api/delete
GET /api/tags
POST /api/chat
POST /api/generate
POST /api/show
GET /v1/models
POST /v1/chat/completions
GET /events
GET /governance/history
GET /governance/policy
GET /governance/proposals
GET /governance/verify
POST /governance/approve
POST /governance/freeze
POST /governance/propose
POST /governance/reject
POST /governance/rollback
POST /governance/unfreeze
GET /meta/current
GET /meta/history
POST /meta/evaluate
POST /meta/evolve
POST /meta/rollback
GET /modules
GET /modules/:id
POST /modules/:id/approve
POST /modules/:id/demote
POST /modules/:id/reject
POST /modules/evaluate
POST /modules/propose
POST /providers/test
GET /runtime/connectors
GET /runtime/connectors/catalog
GET /runtime/lora
GET /runtime/lora/reviews
POST /runtime/lora/reviews/resolve
POST /runtime/lora/train
POST /runtime/ask/respond
GET /runtime/manifest
GET /runtime/models
GET /runtime/providers/catalog
GET /runtime/resume
POST /runtime/session/compact
GET /runtime/sessions
GET /runtime/status
POST /runtime/byok/save
POST /runtime/chat
POST /runtime/connectors/reload
POST /runtime/model
POST /runtime/models/install
GET /runtime/setup/detect
POST /runtime/setup/verify
POST /runtime/setup/ack
POST /runtime/shutdown
GET /runtime/models/download/:id
GET /system_info
POST /tokenize
```
