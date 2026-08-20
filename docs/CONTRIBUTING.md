# Contributing to Cinderpaw

**Start here.** This page gets you from a fresh clone to a merged PR. It is
deliberately short.

> Deep dive: [Contributor Guide](./CONTRIBUTOR_GUIDE.md) — IPC protocols, test
> matrix, build & release flow.
> Layer map (L0–L6), file locations, glossary: [ARCHITECTURE.md](../ARCHITECTURE.md).
> Every `FERAL_*` env var with threat notes: [CONFIGURATION.md](./CONFIGURATION.md).

---

## Read this first: the license

Cinderpaw is **Business Source License 1.1** — source-available, *not* OSI open
source. Free for individuals, small orgs (<$2M revenue), education, research and
self-hosting; commercial licence needed above that or to offer Cinderpaw as a hosted
service. **Each version converts to Apache 2.0 four years after its release.**

By submitting a contribution you agree it ships under those terms. We would
rather you know that in the first thirty seconds than after writing a patch.

---

## Five minutes to a running build

```bash
# Prereqs: Rust stable, Node 20+, Bun 1.x
cd frontend-react && npm install
cd ../CinderpawAgent && bun install

# Dev (builds the sidecar, starts Vite + Tauri):
cargo tauri dev                       # from src-tauri/ or repo root
```

Sidecar looking stale? `FERAL_FORCE_SIDECAR_BUILD=1 cargo tauri dev`
(or directly: `node src-tauri/scripts/build-sidecar.mjs`).

GPU inference is a **compile-time** feature — default builds are CPU-only and
silently ignore `default_gpu_layers`:

```bash
cargo tauri dev --features inference-vulkan     # GPU
cargo tauri dev --features whisper              # on-device STT (needs LLVM on Windows)
```

**Just want to work on the agent?** You do not need the desktop app at all:

```bash
cd CinderpawAgent && bun test        # 2400+ tests, ~60s, no GPU, no model needed
```

That is the fastest loop in the repo and where most of the interesting work is.

---

## Architecture in 60 seconds

Three runtimes, three languages, one repo:

```
src-tauri/        Rust — Tauri v2 shell
  src/lib.rs          command handlers (chat, models, BYOK, skills, …)
  src/inference.rs    llama.cpp engine: model load, context pool, KV reuse
  src/api.rs          loopback OpenAI/Ollama-compatible HTTP API (:11435, token-gated)
  src/cinderpaw_agent.rs  sidecar spawn + supervision + stdio bridge

frontend-react/   React + TS + Vite + Tailwind — the UI
  src/stores/       Zustand stores (chat, model, conversations, ui, …)
  src/lib/          chatStream / feralAgentStream (the two streaming paths),
                    streamControl (unified stop), tauri/ (typed IPC bindings)
  src/components/   pages, chat surface, models, settings, mascot

CinderpawAgent/       Bun + TS — the agent sidecar (compiled to a single binary)
  src/core/         agent loop, working memory, soul/system prompt
  src/egress/       inference router (primary→fallback), egress proxy,
                    process sandbox, tool permissions, circuit breaker
  src/tools/        tool registry (the sandbox choke point) + built-ins
  src/memory/       episodic (SQLite+FTS5), semantic, working, fractal
  src/rsi/          self-improvement layers L1–L6
```

Data flow: React → Tauri commands → either the local engine (chat mode) or the
sidecar's stdin (agent mode). Streaming returns as Tauri events
(`cinderpaw://token`, `cinderpaw://agent-output`, …). The sidecar infers through the
loopback API on `:11435` (or a BYOK provider) — never directly against the GGUF.

---

## Your first contribution

Pick from the ladder — each rung is genuinely self-contained.

**Rung 1 — no architecture knowledge needed**
- Anything that confused you in the first hour. Seriously: open an issue saying
  so. Onboarding friction is a bug and outsiders see it best.
- Docs that disagree with the code. (This file told people to look in
  `src/sandbox/` for over a year. That directory is `src/egress/`.)
- A test for an untested built-in tool — see `CinderpawAgent/src/tools/builtin/`.

**Rung 2 — scoped, with a known shape**

These come out of the pre-release hardening audit. Each has a defined failure
mode, so you are not guessing at intent:

| Task | Where | Why it matters |
|---|---|---|
| Typed execution provenance | `src/tools/registry.ts` → `src/core/agent-loop.ts` | Tool results flatten to `ok ? content : "ERROR: …"`, so the model cannot tell *never ran* from *ran and failed*. Needs an `executionStarted` equivalent threaded to the transcript. |
| Interrupted-turn marker | `src/core/agent-loop.ts` | A stopped turn leaves no record that a side-effectful tool may have half-run. The next turn should be told. |
| Cross-turn loop detection | `src/core/agent-loop.ts` | Loop counters reset every turn, so a model steered back into the same failing action is undetected. |
| Typed exit reason | `src/core/agent-loop.ts` | "Why did execution stop?" is encoded in prose, not a field. Not machine-answerable. |
| Desktop tests | `src-tauri/`, `frontend-react/` | The desktop app has **zero** test files. Highest-visibility, weakest-evidenced surface. |

**Rung 3 — the big one**

**End-to-end tests against a live provider.** Everything in the suite mocks
`fetch`. That single gap is the largest limit on Cinderpaw's release maturity, and
it is wide open for someone who wants real impact.

---

## Please don't break these

Two subsystems are the product's differentiator and have the deepest test
coverage in the repo (115 of ~230 test files):

- `CinderpawAgent/src/rsi/**` — self-improvement layers
- `CinderpawAgent/src/memory/fractal/**` — fractal memory search

Changing them is welcome; changing them *accidentally* is not. Run the gate:

```bash
cd CinderpawAgent && bun test tests/rsi-*.test.ts tests/fractal-*.test.ts \
  tests/leaf-store.test.ts tests/upsert-leaf.test.ts \
  tests/tree-builder-context-cap.test.ts tests/embed-cpu-mode.test.ts tests/recall.test.ts
```

Expected: **1104 pass, 5 skip, 0 fail.** Any deviation means stop and look.

---

## Before you open the PR

```bash
cd frontend-react && npx vitest run      # frontend
cd CinderpawAgent     && bun test            # sidecar (2400+)
cd CinderpawAgent     && bunx tsc --noEmit   # types
cd src-tauri      && cargo test --lib    # Rust host
```

All four green. Windows note: `shell-git` integration tests can flake on
temp-dir `EBUSY` — everything else should be green.

Touched streaming? Run the app and exercise **both** paths (Chat and Agent):
send, stop mid-stream, switch tabs mid-stream, send again.

---

## Conventions that actually get enforced in review

- **Comments explain *why*, not *what*.** Non-obvious decisions carry a comment
  naming the failure that motivated them. This is the single most valuable habit
  in the codebase — keep it.
- **Errors must reach the user.** No silent `catch {}` on user-facing paths;
  route to `stream-error` events / toasts (`lib/humanizeError.ts`).
- **Two streaming paths, one semantics.** Stop/interrupt behaviour stays
  identical between `chatStream.ts` and `feralAgentStream.ts`. UI calls
  `streamControl.stopActiveStream()` — never one path directly.
- **Strings:** user-facing UI text goes through `lib/i18n.ts` (EN + RO).
- **Security:** anything touching filesystem, network or child processes goes
  through the sandbox layers (see [SECURITY.md](../SECURITY.md)). New tools must
  declare manifest permissions — the registry validates them at registration.
- **Tests prove behaviour, not implementation.** A regression test should fail
  for the reason described in its name.

---

## Where to ask

- [Discussions](https://github.com/bloom500/feral/discussions) — ideas, questions,
  "is this a bug or am I holding it wrong"
- [Issues](https://github.com/bloom500/feral/issues) — bugs and scoped work
- Security vulnerabilities: **do not** open a public issue — see
  [SECURITY.md](../SECURITY.md)

Bug reports that include what you expected, what happened, and the smallest way
to reproduce it get fixed fastest. A failing test is the best bug report there is.
