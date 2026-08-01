# Feral Contributor Guide

Welcome! This is the long-form companion to [CONTRIBUTING.md](./CONTRIBUTING.md) —
read that first for the 60-second version. This guide covers the architecture in
depth, how the three runtimes talk to each other, how to run every test suite,
and how builds and releases work.

> **For the layer model (L0–L6), Faza ↔ L-layer translation, file map
> and glossary, see [ARCHITECTURE.md](../ARCHITECTURE.md). For every
> `FERAL_*` env var, see [CONFIGURATION.md](./CONFIGURATION.md). For the
> Go terminal client (user guide + build instructions), see [TUI.md](./TUI.md).**

> This guide's "three runtimes" narrative predates the Go TUI (`tui/`), a
> fourth runtime that ships as its own binary — [ARCHITECTURE.md](../ARCHITECTURE.md)
> §1 has the current count and table.

---

## 1. The three runtimes

Feral is one repo, three runtimes, three languages:

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Feral (Tauri 2.x app)                        │
│                                                                      │
│  ┌──────────────────────────┐      ┌──────────────────────────────┐  │
│  │ frontend-react/          │      │ src-tauri/                   │  │
│  │ React 18 + TS + Vite     │◄────►│ Rust host                    │  │
│  │ Tailwind + Zustand       │ IPC  │  lib.rs        commands      │  │
│  │                          │      │  inference.rs  llama.cpp     │  │
│  │  invoke() ───────────────┼──────┼─► #[tauri::command]          │  │
│  │  listen('feral://…') ◄───┼──────┼── app.emit(events)           │  │
│  └──────────────────────────┘      │  api.rs   loopback HTTP API  │  │
│                                    │  feral_agent.rs  supervisor  │  │
│                                    └──────────┬───────────────────┘  │
│                                               │ stdin/stdout JSON    │
│                                               ▼                      │
│                                    ┌──────────────────────────────┐  │
│                                    │ FeralAgent/ (sidecar)        │  │
│                                    │ Bun + TS → single .exe       │  │
│                                    │  core/     agent loop, soul  │  │
│                                    │  egress/   inference router, │  │
│                                    │            egress proxy      │  │
│                                    │  tools/    built-in tools    │  │
│                                    │  memory/   SQLite + FTS5     │  │
│                                    └──────────┬───────────────────┘  │
│                                               │ HTTP (token-gated)   │
│                                               ▼                      │
│                                    loopback API :11435 (api.rs)      │
│                                    or a BYOK cloud provider          │
└─────────────────────────────────────────────────────────────────────┘
```

### frontend-react/ — the UI

- **Stack:** React 18, TypeScript, Vite, Tailwind, Zustand, framer-motion.
- **State:** one Zustand store per domain in `src/stores/` (chat, model,
  conversations, agent, feral, settings, ui, …). Stores are module-global —
  they survive page/tab switches; components subscribe to slices.
- **Streaming:** two parallel paths with deliberately identical semantics:
  - `src/lib/chatStream.ts` — local llama.cpp / cloud BYOK chat
  - `src/lib/feralAgentStream.ts` — Feral Agent sidecar (persistent global
    listener; streams survive navigation; `src/lib/feralLiveSession.ts`
    mirrors in-flight state so re-entering a chat rehydrates it)
  - `src/lib/streamControl.ts` — the **only** stop entry point UI code may call.
- **IPC:** typed wrappers in `src/lib/tauri/index.ts`. Never call `invoke()`
  ad-hoc from components — add a typed wrapper.
- **Mascot:** `src/components/chat/mascot/` — pixel frames in `frames.ts`,
  procedural particle effects in `effects.ts`, canvas renderer in
  `FeralMascot.tsx`, idle choreography in `MascotPerch.tsx`.

### src-tauri/ — the Rust host

- **`lib.rs`** — all `#[tauri::command]` handlers (chat, models, conversations,
  BYOK, skills, agents, feral_* sidecar bridge). Commands are registered in the
  `collect_commands![]` block near the bottom; events in `collect_events![]`.
- **`inference.rs`** — llama.cpp engine: GGUF load, context pool, KV-cache
  reuse. GPU builds use `--features inference-vulkan` (default is CPU).
- **`api.rs`** — loopback OpenAI/Ollama-compatible HTTP API on `:11435`,
  gated by a per-launch bearer token. This is how the sidecar does local
  inference — the sidecar never touches the GGUF directly.
- **`feral_agent.rs`** — sidecar lifecycle: spawn, supervise (respawn with
  backoff, `feral://agent-exit` on death), stdio bridge. Outbound messages go
  through `state.feral_agent_tx`; sidecar stdout lines are re-emitted as
  `feral://agent-output` events.

### FeralAgent/ — the agent sidecar

- **Stack:** Bun + TypeScript, compiled with `bun build --compile` into a
  single executable shipped in `src-tauri/binaries/`.
- **`src/index.ts`** — wiring: loads SOUL/IDENTITY/AGENTS, builds the tool
  registry, memory, cron scheduler, transport; the big `transport.onMessage`
  switch is the inbound protocol (`message`, `stop`, `set_model`,
  `ask_user_response`, `cron_*`, …).
- **`src/core/agent-loop.ts`** — the agent loop: system-prompt assembly,
  tool-call parsing, per-session abort (`stop(sessionId)`), budget handling.
- **`src/egress/`** — inference router (primary → fallback, trusted base
  URLs only), egress proxy, process sandbox, tool permissions, circuit breaker.
- **`src/tools/`** — the tool registry (the single choke point every tool call
  passes through: permissions, timeout, abort, retry, fallback) plus built-ins;
  each tool declares manifest permissions.
- **`src/memory/`** — episodic (SQLite + FTS5), semantic, working, and fractal
  memory.
- **`src/rsi/`** — self-improvement layers L1–L6.

> ⚠️ **The sidecar gotcha:** `cargo tauri dev` does **not** rebuild the sidecar
> when you change TS code. After any `FeralAgent/` change run
> `node src-tauri/scripts/build-sidecar.mjs` (or
> `FERAL_FORCE_SIDECAR_BUILD=1 cargo tauri dev`) so the compiled binary in
> `src-tauri/binaries/` is fresh. Also: `bun --compile` does not bundle `.md`
> or other asset files — text assets must be imported with
> `import x from "./file.md" with { type: "text" }` (see `soul-loader.ts`).

---

## 2. The protocols between the layers

### React ⇄ Rust

- **Commands:** `invoke('command_name', { args })` via the typed wrappers in
  `frontend-react/src/lib/tauri/index.ts`.
- **Events:** `listen('feral://…')`. The important ones:

| Event | Meaning |
|---|---|
| `feral://token`, `feral://stream-done`, `feral://stream-error` | chat-mode streaming |
| `feral://agent-output` | every sidecar stdout line (JSON envelope) |
| `feral://agent-ready` / `feral://agent-exit` | sidecar lifecycle |
| `feral://model-load-progress`, `feral://download-progress` | models UI |

### Rust ⇄ Sidecar (stdin/stdout, one JSON object per line)

Inbound (Rust → sidecar): `message`, `stop`, `set_model`, `ask_user_response`,
`ask_user_cancel`, `cron_add/remove/toggle/list`, `ping`, `shutdown`.
The validator lives in `FeralAgent/src/transports/tauri.ts` (`isInbound`) and
the type in `FeralAgent/src/types.ts` (`InboundMessage`) — **adding a message
type means updating both, plus the `onMessage` switch in `index.ts`.**

Outbound (sidecar → Rust → React): `chunk`, `done`, `error`, `tool_start`,
`tool_done`, `tool_progress`, `ask_user`, `spawning`, `model_set`,
`model_error`, `cron_fired`, `cron_error`, `pong`.

API keys never reach React: `feral_set_model` injects BYOK keys in Rust before
forwarding to the sidecar.

---

## 3. Setting up and running

### Prerequisites

| Tool | Version | Check |
|---|---|---|
| Rust | stable (1.75+) | `rustc --version` |
| Node | 20+ | `node --version` |
| Bun | 1.x | `bun --version` |
| Tauri CLI | 2.x | `cargo tauri --version` |
| LLVM/Clang | any recent | `clang --version` — **Windows only, required for the `whisper` feature** (bindgen needs a native clang for MSVC-compatible bindings). Default install path is `C:\Program Files\LLVM\bin`; if yours differs, set `LIBCLANG_PATH` before building. |

### First run

```bash
git clone <repo> && cd FeralLocalAI
cd frontend-react && npm install && cd ..
cd FeralAgent && bun install && cd ..

cargo tauri dev          # builds sidecar on first run, starts Vite + Tauri
```

GPU inference: `cargo tauri dev --features inference-vulkan`.

---

## 4. Tests

```bash
# Frontend — Vitest (+ jsdom):
cd frontend-react
npx tsc --noEmit          # typecheck
npx vitest run            # full suite

# Sidecar — bun:test:
cd FeralAgent
bunx tsc --noEmit
bun test
#   Heads-up: shell-git integration tests can be flaky on Windows
#   (temp-dir EBUSY). Everything else should be green.

# Rust host:
cd src-tauri
cargo check
cargo test --lib
```

All three suites must pass before a PR. If you touched **streaming or stop
semantics**, also verify by hand in the running app, on *both* paths (Chat and
Agent): send → stop mid-stream → switch tabs mid-stream → come back → send
again. The two paths must behave identically.

### Where tests live

| Suite | Location | Pattern |
|---|---|---|
| Frontend | `frontend-react/src/**/__tests__/` | Vitest + Testing Library |
| Sidecar | `FeralAgent/tests/*.test.ts` | bun:test, one file per subsystem |
| Rust | inline `#[cfg(test)]` modules | unit-level |

---

## 5. Builds

### Dev build (fast iteration)

`cargo tauri dev` — debug Rust host, Vite dev server with HMR, sidecar reused
from `src-tauri/binaries/` unless forced (see the gotcha in §1).

### Release build

```bash
# 1. Fresh sidecar binary (bun compile + copy with target-triple suffix)
node src-tauri/scripts/build-sidecar.mjs

# 2. Full bundle (frontend production build + Rust release + installers)
cargo tauri build
# Output: src-tauri/target/release/bundle/
#   Windows: .msi + NSIS setup .exe
```

### Signing & updater

Releases are signed with `TAURI_SIGNING_PRIVATE_KEY` (empty-password key; see
`docs/UPDATER_KEY_MIGRATION.md` for the 0.1.x → 0.2.0 key transition). The
auto-updater requires every release to ship `latest.json` + `.sig` files.
Secrets live in GitHub Secrets, never in the repo.

CI in `.github/workflows/` builds the installer matrix.

---

## 6. Conventions (the short list that gets PRs merged)

- **Comments explain *why*, not *what*** — and reference audit/issue ids
  (A2, P0-3, #18, …) where one exists.
- **Errors must reach the user.** No silent `catch {}` on user-facing paths;
  humanize via `lib/humanizeError.ts`, surface as toasts/stream errors.
- **Two streaming paths, one semantics.** Stop/retry/interrupt behaviour stays
  identical between chat and agent paths; UI calls
  `streamControl.stopActiveStream()` only.
- **No raw `invoke()` in components** — add typed wrappers in `lib/tauri/`.
- **User-facing strings** go through `lib/i18n.ts` (EN + RO).
- **Sidecar security:** filesystem / network / child-process access goes
  through the sandbox layers; new tools declare manifest permissions.
- **Non-technical first.** Feral's primary audience includes people who have
  never opened a terminal: error messages are human, defaults are safe,
  features work without configuration.
- **Commits:** Conventional Commits (`feat(agent): …`, `fix(ui): …`).

---

*Questions? Open a GitHub issue or discussion. TL;DR: clone, `npm install` +
`bun install`, `cargo tauri dev`, make the three test suites pass, open a PR.*
