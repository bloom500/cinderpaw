# Contributing to Cinderpaw

Thanks for looking. This page takes you from a fresh clone to a merged pull
request. You do not need to understand the whole project to make one part of
it better.

**On this page:** [Start in 3 commands](#start-in-3-commands) ·
[Pick a first task](#pick-a-first-task) ·
[Where things live](#where-things-live) ·
[Before you open the PR](#before-you-open-the-pr) ·
[The license and your sign-off](#the-license-and-your-sign-off) ·
[Where to ask](#where-to-ask)

> Going deeper: [Contributor Guide](./CONTRIBUTOR_GUIDE.md) (IPC protocols,
> test matrix, build and release) · [ARCHITECTURE.md](../ARCHITECTURE.md)
> (layer map, glossary) · [CONFIGURATION.md](./CONFIGURATION.md) (every
> `CINDERPAW_*` variable, with threat notes)

**Two things to know before your first commit**

- Cinderpaw is **Apache-2.0**. By opening a pull request you agree your work
  ships under it.
- Every commit needs a sign-off: commit with `git commit -s`. CI rejects a pull
  request without one. The sign-off also lets Bloom Media relicense your
  contribution; [read exactly what that means](#the-license-and-your-sign-off)
  before you write a patch, not after.

---

## Start in 3 commands

Most of the interesting work is in the agent: TypeScript, run with
[Bun](https://bun.sh) 1.x. It needs no desktop app, no GPU and no model.

```bash
git clone https://github.com/bloom500/cinderpaw && cd cinderpaw/CinderpawAgent
bun install
bun test        # the whole agent suite: no GPU, no model, no keys
```

If that is green, you are ready to [pick a task](#pick-a-first-task).

### The desktop app, when your change is in the UI or the Rust host

```bash
# Prereqs: Rust stable, Node 20+, Bun 1.x, CMake, LLVM/libclang
# (llama.cpp needs the last two; see the Contributor Guide §3)
cargo install tauri-cli --version "^2"     # once

cd frontend-react && npm install
cd ../CinderpawAgent && bun install
cd .. && cargo tauri dev                   # builds the agent, starts Vite and the app
```

- The first `cargo tauri dev` compiles llama.cpp and takes a while. Later runs
  are quick.
- Agent looking stale in the app? `CINDERPAW_FORCE_SIDECAR_BUILD=1 cargo tauri dev`
  (or `node src-tauri/scripts/build-sidecar.mjs`).
- GPU inference is a compile-time feature. Default builds are CPU-only and
  ignore `default_gpu_layers`; use `cargo tauri dev --features inference-vulkan`.
- UI work only? `cd frontend-react && npx vitest run` tests the React app
  without building any Rust.

---

## Pick a first task

Every task below was checked against the code on 16 October 2026. Say which one
you take (an issue, or a line in [Discord](https://discord.gg/eqvfVRD6y7)) so
two people do not do the same one.

### Good first tasks: no architecture knowledge needed

**Write the first test for a built-in tool.** These tools have no test file of
their own yet. Each one is a single file in `CinderpawAgent/src/tools/builtin/`.
Read it, then test what it promises. Any file in `CinderpawAgent/tests/` shows
the shape.

| Tool | File | Notes |
|---|---|---|
| `calculator` | `calculator.ts` | 276 lines of pure logic: the best first test |
| `time_date` | `time-date.ts` | 171 lines, pure date arithmetic: now, format, parse, diff |
| `escalate_to_human` | `escalate-to-human.ts` | 92 lines |
| `schedule_meeting` | `schedule-meeting.ts` | 89 lines |
| `tool_health` | `tool-health.ts` | 84 lines, reads the tool health report |
| `token_usage` | `token-usage.ts` | 63 lines |
| `suggest_skill` | `suggest-skill.ts` | 48 lines |

**Tell us what confused you in your first hour.** Open an issue and say so.
Onboarding friction is a bug, and newcomers see it best.

**Fix a doc that disagrees with the code.** If a README, guide or comment sent
you to the wrong place, fix it. This page once sent people to `src/sandbox/`
for over a year; that folder is `src/egress/`.

### Next: scoped agent work

Each one has a known failure, so you are not guessing what is wanted.

| Task | Where | What is wrong today |
|---|---|---|
| Typed tool result | `src/tools/registry.ts` → `src/core/agent-loop.ts` | A tool result reaches the model as `ok ? content : "ERROR: …"`, so the model cannot tell *never ran* from *ran and failed*. Thread a field through to the transcript. |
| Tell the next turn about a stopped one | `src/core/agent-loop.ts` | When the person presses stop, nothing tells the next turn that a tool with side effects may have half-run. |
| Desktop end-to-end tests | `src-tauri/`, `frontend-react/` | Plenty of unit tests (about 180 frontend test files, `#[cfg(test)]` modules in about 34 Rust files), but nothing drives the built app end to end. |

### The big one

**End-to-end tests against a live provider.** The agent suite mocks `fetch`, so
no test proves that a real model call works. That gap is the largest limit on
Cinderpaw's release maturity, and it is wide open for someone who wants real
impact.

---

## Where things live

| I want to... | Start here |
|---|---|
| Add a built-in tool | One file, `CinderpawAgent/src/tools/builtin/<name>.ts`, with its manifest (permissions, parameters). `CinderpawAgent/src/boot.ts` registers it. Add a test in `CinderpawAgent/tests/`. |
| Change something on screen | `frontend-react/src/components/` (pages, chat, models, settings). App state lives in `frontend-react/src/stores/`. |
| Change how the agent works through a task | `CinderpawAgent/src/core/agent-loop.ts` |
| Add a model provider | `crates/cinderpaw-core/src/byok.rs` (`provider_catalog()`) first; `CinderpawAgent/src/egress/inference-providers.ts` only for a new protocol family. |
| Add a chat connector | `crates/cinderpaw-core/src/connectors.rs` (catalog), `src-tauri/src/connectors.rs` (desktop), `CinderpawAgent/src/egress/mcp-manager.ts` (the connection). |
| Add or change a desktop command | `src-tauri/src/commands/`, registered in `src-tauri/src/lib.rs`; the typed wrapper the UI calls is `frontend-react/src/lib/tauri/index.ts`. |
| Memory | `CinderpawAgent/src/memory/` (episodic, semantic, working, fractal) |
| Self-improvement (BRSI) | `CinderpawAgent/src/rsi/`. Read `CinderpawAgent/src/rsi/README.md` first. |

### Architecture in 60 seconds

Three runtimes, three languages, one repo:

```
src-tauri/        Rust: the Tauri v2 desktop shell
  src/lib.rs          app setup; registers every command and event
  src/commands/       command handlers (models, BYOK, settings, system, ...)

crates/cinderpaw-core/  Rust, shared by the desktop app and the headless CLI
  src/inference.rs    llama.cpp engine: model load, context pool, KV reuse
  src/api.rs          loopback OpenAI/Ollama-compatible HTTP API (:11435, token-gated)
  src/cinderpaw_agent.rs  agent spawn, supervision, stdio bridge

frontend-react/   React + TypeScript + Vite + Tailwind: the UI
  src/stores/       Zustand stores (conversations, model, onboarding, ui, ...)
  src/lib/          cinderpawAgentStream (the streaming path), streamControl
                    (stop), tauri/ (typed IPC bindings)
  src/components/   pages, chat surface, models, settings, mascot

CinderpawAgent/   Bun + TypeScript: the agent (compiled to a single binary)
  src/core/         agent loop, working memory, soul/system prompt
  src/egress/       inference router (primary→fallback), egress proxy,
                    process sandbox, tool permissions, circuit breaker
  src/tools/        tool registry (the sandbox choke point) + built-ins
  src/memory/       episodic (SQLite+FTS5), semantic, working, fractal
  src/rsi/          self-improvement layers L1–L6
```

Data flow: React → Tauri commands → the agent's stdin. Answers stream back as
Tauri events (`cinderpaw://agent-output`, ...). The agent infers through the
loopback API on `:11435` (or a cloud provider), never directly against the GGUF.

---

## Please don't break these

Two subsystems are the product's differentiator and have the deepest test
coverage in the repo:

- `CinderpawAgent/src/rsi/**`: self-improvement layers
- `CinderpawAgent/src/memory/fractal/**`: fractal memory search

Changing them is welcome; changing them *by accident* is not. Run the gate:

```bash
cd CinderpawAgent && bun test tests/rsi-*.test.ts tests/fractal-*.test.ts \
  tests/leaf-store.test.ts tests/upsert-leaf.test.ts \
  tests/tree-builder-context-cap.test.ts tests/embed-cpu-mode.test.ts tests/recall.test.ts
```

Expected (14 Oct 2026): **1329 pass, 7 skip, 0 fail.** Anything else means stop
and look.

---

## Before you open the PR

```bash
cd CinderpawAgent && bun test            # the agent
cd CinderpawAgent && bunx tsc --noEmit   # its types
cd frontend-react && npx vitest run      # the UI
cd src-tauri      && cargo test --lib    # the Rust host
```

Run the ones for the parts you touched; CI runs all of them. On Windows the
`shell-git` integration tests can flake on temp-dir `EBUSY`; everything else
should be green.

Touched streaming? Run the app and try it by hand: send, stop mid-answer,
switch conversations mid-answer, send again.

The pull request template asks three short things: what changed for a person
using Cinderpaw, how you tested it, and anything you were unsure about.

### Conventions that get enforced in review

- **Comments explain *why*, not *what*.** A non-obvious decision carries a
  comment naming the failure that motivated it. This is the most valuable habit
  in the codebase; keep it.
- **Errors reach the person.** No silent `catch {}` on paths a user is waiting
  on; route them to `stream-error` events or toasts (`lib/humanizeError.ts`).
- **One way to stop.** The UI stops an answer through
  `streamControl.stopActiveStream()`, never by reaching into the stream directly.
- **Words on screen** are plain English that a 12-year-old can read. The UI is
  English only for now; `lib/i18n.ts` holds the existing keys, and new text
  does not need one.
- **Security:** anything touching the filesystem, the network or child
  processes goes through the sandbox layers (see [SECURITY.md](../SECURITY.md)).
  New tools declare manifest permissions; the registry checks them at
  registration.
- **Tests prove behaviour, not implementation.** A regression test fails for
  the reason its name describes.

---

## The license and your sign-off

Cinderpaw is **Apache License 2.0**: OSI-approved open source, free for anyone,
including companies of any size, with no revenue threshold and no commercial
licence to buy. Use it, modify it, redistribute it, sell it; keep the `LICENSE`
and `NOTICE` files with any copy and say what you changed. Cinderpaw was BSL
1.1 until September 2026. It moved so that adoption needs no legal review and
the project can apply for grants that require an OSI-approved licence.

Every commit needs a `Signed-off-by` line. `git commit -s` adds it, and CI
rejects a pull request without one on every commit.

That line is the [Developer Certificate of Origin](https://developercertificate.org/):
you are stating the work is yours to give. **On its own it would not let us
change Cinderpaw's licence later**, because a contribution accepted under
Apache-2.0 stays under Apache-2.0 unless its author says otherwise. So the
sign-off here carries one more thing, stated plainly rather than buried:

> By signing off on a contribution you also grant Bloom Media a perpetual,
> worldwide, irrevocable, royalty-free licence to use, modify and **relicense**
> that contribution under any licence, including licences other than Apache-2.0.

**Why we ask, in the open.** Cinderpaw has moved licence once already, from BSL
1.1 to Apache-2.0, and may move again. Without this grant that decision would
need every past contributor to agree individually, which in practice means it
can never happen. You keep the copyright in your work; this is a licence to us,
not an assignment, and nothing here takes away your right to use your own code
however you like.

If you would rather not grant that, say so in the pull request. We would rather
have the contribution and talk about it than have you walk away quietly.

---

## Where to ask

- [Discord](https://discord.gg/eqvfVRD6y7): the fastest answer, often the same day
- [Discussions](https://github.com/bloom500/cinderpaw/discussions): ideas,
  questions, "is this a bug or am I holding it wrong"
- [Issues](https://github.com/bloom500/cinderpaw/issues): bugs and scoped work
- Security vulnerabilities: **do not** open a public issue; see
  [SECURITY.md](../SECURITY.md)

Bug reports that say what you expected, what happened, and the smallest way to
reproduce it get fixed fastest. A failing test is the best bug report there is.
