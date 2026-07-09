# Contributing to Feral

> Want the deep dive? See the full [Contributor Guide](./CONTRIBUTOR_GUIDE.md)
> — architecture in depth, IPC protocols, test matrix, build & release flow.
>
> **For the layer map (L0–L6), file locations, Faza ↔ L-layer
> translation, and the glossary of evocative terms, see
> [ARCHITECTURE.md](../ARCHITECTURE.md).**
>
> **For every `FERAL_*` env var (security-group with threat notes
> included), see [CONFIGURATION.md](./CONFIGURATION.md).**

## Architecture in 60 seconds

Three runtimes, three languages, one repo:

```
src-tauri/        Rust — Tauri v2 shell
  src/lib.rs        command handlers (chat, models, BYOK, skills, …)
  src/inference.rs  llama.cpp engine: model load, context pool, KV reuse
  src/api.rs        loopback OpenAI/Ollama-compatible HTTP API (:11435, token-gated)
  src/feral_agent.rs  sidecar spawn + supervision + stdio bridge

frontend-react/   React + TS + Vite + Tailwind — the UI
  src/stores/       Zustand stores (chat, model, conversations, ui, …)
  src/lib/          chatStream / feralAgentStream (the two streaming paths),
                    streamControl (unified stop), tauri/ (typed IPC bindings)
  src/components/   pages, chat surface, models, settings, mascot

FeralAgent/       Bun + TS — the agent sidecar (compiled to a single binary)
  src/core/         agent loop, working memory, soul/system prompt
  src/sandbox/      inference router (primary→fallback), egress proxy,
                    process sandbox, tool permissions
  src/tools/        built-in tools
  src/memory/       episodic (SQLite+FTS5) + semantic memory
```

Data flow: React → Tauri commands → either the local engine (chat mode) or
the sidecar's stdin (agent mode). Streaming comes back as Tauri events
(`feral://token`, `feral://agent-output`, …). The sidecar does its inference
through the loopback API on `:11435` (or a BYOK provider) — never directly
against the GGUF.

## Running it

```bash
# Prereqs: Rust stable, Node 20+, Bun 1.x
cd frontend-react && npm install
cd FeralAgent && bun install

# Dev (builds the sidecar, starts Vite + Tauri):
cargo tauri dev                       # from src-tauri/ or repo root

# Force a sidecar rebuild if it seems stale:
FERAL_FORCE_SIDECAR_BUILD=1 cargo tauri dev
# or directly: node src-tauri/scripts/build-sidecar.mjs
```

GPU inference: build with `--features inference-vulkan` (default is CPU).

Voice messages (on-device whisper.cpp STT) are feature-gated like inference and
are **not** in the default build. Enable them locally with:

```bash
cargo tauri dev --features whisper          # add to inference, e.g. --features whisper,inference-vulkan
```

Windows prerequisite: whisper-rs's bindgen needs a native LLVM/clang. Install
LLVM (e.g. to `C:\Program Files\LLVM`) — `src-tauri/.cargo/config.toml` points
`LIBCLANG_PATH` there, or export your own `LIBCLANG_PATH` to override it. Without
the `whisper` feature the app still runs; voice transcription returns
`voice-unavailable` and the UI falls back to text input.

## Tests

```bash
# Frontend (Vitest):
cd frontend-react && npx vitest run

# Sidecar (bun:test):
cd FeralAgent && bun test
#   Note: shell-git integration tests can be flaky on Windows (temp-dir
#   EBUSY); everything else should be green.

# Rust:
cd src-tauri && cargo test --lib
```

All three suites must pass before a PR. If you touched streaming, run the app
and check both paths (Chat and Agent): send, stop mid-stream, switch tabs
mid-stream, send again.

## Conventions

- **Comments explain *why*, not *what*.** Most non-obvious decisions carry a
  comment referencing the audit/issue id (A2, P3, #11, …) — keep that habit.
- **Errors must reach the user.** No silent `catch {}` on user-facing paths;
  route errors to `stream-error` events / toasts (see `lib/humanizeError.ts`).
- **Two streaming paths, one semantics.** Stop/interrupt behaviour must stay
  identical between `chatStream.ts` and `feralAgentStream.ts`; UI code calls
  `streamControl.stopActiveStream()` — never one path directly.
- **Strings:** new user-facing UI text goes through `lib/i18n.ts` (EN + RO).
- **Security:** anything that touches the filesystem, network, or child
  processes in the sidecar goes through the sandbox layers (see SECURITY.md).
  New tools must declare manifest permissions.

## Release

See `docs/UPDATER_KEY_MIGRATION.md` for the 0.1.x → 0.2.0 signing-key
transition. CI builds installers for Windows/macOS/Linux from
`.github/workflows/`; releases are signed via `TAURI_SIGNING_PRIVATE_KEY`.
