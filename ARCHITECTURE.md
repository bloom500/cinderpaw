# FERAL — Architecture Overview

> **TL;DR** — Cinderpaw is one repo, **four runtimes**, **three protocols** between
> them. The **BRSI layer model** (L0–L6) lets the engine improve itself
> incrementally while hard walls block the changes that matter.
>
> **Companion docs:**
> - [docs/CONTRIBUTOR_GUIDE.md](./CONTRIBUTOR_GUIDE.md) — long-form
>   contributor guide, runtime narrative, dev workflow, build pipeline.
> - [docs/CONFIGURATION.md](./CONFIGURATION.md) — every `CINDERPAW_*` env var.
> - [docs/invariants.md](./invariants.md) — the BRSI safety contracts.
> - [docs/brsi-spec.md](./brsi-spec.md) — Bounded RSI, conceptual foundation.

This document is the *map*: layer responsibilities, file locations, the
Faza ↔ L-layer translation, the poetic-term glossary, and the "where
do I add X" cheat sheet.

---

## 1. The four runtimes

| # | Runtime | Stack | Path | Owns |
|---|---|---|---|---|
| 1 | **Desktop UI** | React 18 + Vite + Zustand | `frontend-react/` | Rendering, chat surfaces, mascot, settings UX. |
| 2a | **Rust host** (desktop) | Tauri 2 + llama.cpp | `src-tauri/` + `crates/feral-core/` | IPC, file system, GGUF inference, `127.0.0.1:11435` HTTP API, sidecar supervision. |
| 2b | **Rust host** (headless gateway) | Rust | `crates/feral-cli/` | Same `feral-core`, no UI. Exposes `feral` subcommands and the HTTP API for terminal + automation. |
| 3 | **Sidecar** | Bun + TypeScript (compiled to one `.exe`) | `CinderpawAgent/` | Agent loop, BRSI engine, memory, tools, sandboxed inference router. |
| 4 | **TUI** | Go + Bubble Tea | `tui/` | Terminal chat + onboarding + connectors wizard. API client only. |

(2a and 2b share the same `feral-core` crate — two hosts of one runtime, so
five rows are **four** runtimes. The CONTRIBUTOR_GUIDE's "three runtimes,
three languages" predates the Go TUI; this file counts the TUI because it
ships as its own binary with its own build.)

## 2. The three protocols

| Protocol | Direction | Wire format | Validator | Canonical spec |
|---|---|---|---|---|
| **Tauri IPC** | UI ↔ host | `invoke()` / `listen('cinderpaw://…')` | Tauri command registry in `src-tauri/src/commands/` | `docs/CONTRIBUTOR_GUIDE.md §2` |
| **Stdout/stderr JSON-lines** | host ↔ sidecar | `{type:"…", …}\n` per line | `CinderpawAgent/src/transports/tauri.ts` (`isInbound`) + `types.ts` (`InboundMessage` / `OutboundEvent`) | This doc's runtime story + `CinderpawAgent/src/protocol.ts` (schema const, R1) + `dispatch.ts`'s `dispatchMessage` (routing, R7). |
| **OpenAI/Ollama-compat HTTP** | sidecar (or any client) ↔ host loopback | JSON over HTTP | `crates/feral-core/src/api.rs` `router()` + per-launch bearer token | `docs/API.md` (B1 in flight) |

API keys never reach React: Tauri commands inject BYOK keys in Rust
before forwarding to the sidecar (`feral_set_model`).

## 3. Layer → code map (L0–L6)

The BRSI layer model (see `docs/brsi-spec.md`) treats each layer as
*one stage in the evolution pipeline*, with hard contracts between
them. Each layer owns a slice of code; **don't import sideways across
layers**.

| Layer | Mandate | May | May not | TS code (selection) | Rust code (selection) |
|---|---|---|---|---|---|
| **L0 — substrate** | Git-backed journal; bounded-ratchet boundary; integrity | Persist all evolution artefacts as git commits; reject non-monotonic advances | Touch user-visible runtime paths | `rsi/infra/journal.ts`, `rsi/repo.ts` (TS proxy), `rsi/infra/hash-chain.ts` | `crates/feral-core/src/rsi/repo.rs` (`ratchet_attempt`), `src-tauri/src/rsi/repo.rs` |
| **L1 — config evolution** | Mutate the 7-field `GenomeConfig`; bounded by schema | Mutate genomes within schema; emit `EvalStarted`/`EvalComplete` | Touch code, LoRA weights, source files | `rsi/l1-config/genome.ts`, `rsi/l1-config/mutation.ts`, `rsi/l1-config/selection-handler.ts`, `rsi/l1-config/crossover*`, `rsi/l1-config/population-manager.ts`, `rsi/l1-config/champion*.ts`, `rsi/l1-config/taste*.ts`, `rsi/l1-config/escape-time*`, `rsi/l1-config/recalcitrance.ts`, `rsi/l1-config/birth-policy.ts`, `rsi/l1-config/extinction-handler.ts`, `rsi/l1-config/dream-*.ts`, `rsi/l1-config/pbt-*`, `rsi/l1-config/fractal.ts`, `rsi/l1-config/goal-mode.ts`, `rsi/l1-config/strategy-seeds.ts` | `crates/feral-core/src/rsi/scorer.rs` |
| **L2 — continual personal adaptation** | LoRA over user signal | Train / promote LoRAs; manage dataset | Mutate base weights; bypass `personal-fitness.ts` | `rsi/l2-adapt/lora-*`, `rsi/l2-adapt/trainers/`, `rsi/l2-adapt/dataset-builder.ts`, `rsi/l2-adapt/personal-fitness.ts` | `crates/feral-core/src/rsi/plan.rs` |
| **L3 — code-RSI** | Patches over existing CinderpawAgent source | Compose unified diffs; live-apply through worktree | Skip the worktree; touch host or TUI; promote without human approval (first N) | `rsi/l3-code/code-*`, `rsi/l3-code/pending-patches.ts`, `rsi/l3-code/code-sandbox.ts` (the contract FSM itself — `rsi/infra/contract*.ts` — lives in `infra/`; it's shared with L1/L4) | `src-tauri/src/rsi/` (full file set; `code_patch.rs` in `feral-core`), `crates/feral-core/src/rsi/repo.rs::watchdog_branch` |
| **L4 — architecture evolution** | Subsystem hot-plug via `seam_runtime` against two v1 seams (`retrieval_strategy`, `planner`) | Promote new modules via `seam-adapter`/`module-host`; registry re-point on strike | Write into `CinderpawAgent/src/`; ship a third seam in v1 | `rsi/l4-modules/module-*`, `rsi/l4-modules/seam-*` | `crates/feral-core/src/rsi/` (instrumentation) |
| **L5 — governance evolution** | Tunes parameters inside `SandboxBounds`; reversible | Update `policy.json`; emit audit events | Bypass tier-0; ignore an `EvalHalted` | `rsi/l5-gov/governance*` | `crates/feral-core/src/rsi/sandbox_bounds.rs`, `crates/feral-core/src/rsi/audit.rs` |
| **L6 — meta evolution** | Tunes the algorithm that produces parameters | Modify selection pressure, score weights, mutation distributions | Skip human gate; never reversible on its own | `rsi/l6-meta/meta-evolution.ts` (694 lines: `MetaEvolution`, `mutateMetaGenome`, `metaFitness`) | (rust half not implemented — the TS half is what runs) |
| **infra (cross-layer)** | State + transport primitives used by every layer above | Bus events, envelopes, budget, paths, the contract FSM, confidence gate, eval-spec loading | Couple to a specific L-layer's evolution contracts | `rsi/infra/event-bus.ts`, `rsi/infra/hash-chain.ts`, `rsi/infra/instance-paths.ts`, `rsi/infra/provenance.ts`, `rsi/infra/envelope-store.ts`, `rsi/infra/budget.ts`, `rsi/infra/rsi-cost.ts`, `rsi/infra/resource-monitor.ts`, `rsi/infra/adapters.ts`, `rsi/infra/bridge.ts`, `rsi/infra/contract*.ts`, `rsi/infra/confidence.ts`, `rsi/infra/eval-spec.ts` | (paths only — `crates/feral-core/src/rsi/paths.rs`) |

The orchestrators live at the root of `rsi/`: `rsi/sidecar.ts`,
`rsi/engine.ts`, `rsi/mod.ts`. Every layer's imports go *through*
them; orchestrators know about every layer, but layers do not import
each other directly. Full per-file layer map: `CinderpawAgent/src/rsi/README.md`.

## 4. Faza ↔ L-layer ↔ spec ↔ code

> **Verified by `git log --grep="Faza"` on this branch at commit
> `feat/l5-governance`.** Faza numbers are historical (when the work
> shipped); L-layer numbers are architectural (where the work
> belongs). They overlap but don't coincide exactly.

| Faza | L-layer | Title | Spec | Code (headline) |
|---|---|---|---|---|
| Faza 0 | L0 substrate | Keystone as delivered | `docs/brsi-spec.md` §0 | `rsi/infra/journal.ts`, `crates/feral-core/src/rsi/repo.rs` |
| Faza 1 | L1 mechanics | Event bus → mutation → ratchet | `docs/rsi-evolution-spec.md` | `rsi/infra/event-bus.ts`, `rsi/l1-config/mutation.ts`, `rsi/l1-config/ratchet-handler.ts`, `rsi/l1-config/population-manager.ts` |
| Faza 1 | sidecar/Rust bridge | (a) bridge client | (same) | `rsi/infra/bridge.ts`, `crates/feral-core/src/cinderpaw_agent.rs` |
| Faza 2 | L3 | Code-RSI | `docs/code-rsi-*.md`, `docs/2026-07-04-l4-architecture-evolution-spec.md` | `rsi/l3-code/code-*`, `src-tauri/src/rsi/` |
| Faza 2/3 reproduction | L1/L3 | Wire reproduction into births | — | `rsi/l1-config/crossover*`, `rsi/l1-config/extinction-handler.ts` |
| Faza 3 | L3 stabilisation | Watchdog / revert / rebuild | `docs/2026-07-09-l4-b7-smoke.md` | `src-tauri/src/rsi/watchdog.rs`, `src-tauri/scripts/build-sidecar.mjs` |
| Faza 3.5 | (L1/L2 hybrid) | PBT (strategy-genomes) | `docs/rsi-evolution-spec.md` | `rsi/l1-config/pbt-*` |
| Faza 4 | L2 | LoRA loop (eval runner + LoRA substrate) | `docs/brsi-spec.md` §4.7 + per-slice docs | `rsi/l2-adapt/lora-*`, `rsi/l2-adapt/dataset-builder.ts`, `rsi/l2-adapt/personal-fitness.ts` |
| Faza 4.5 | (infra) | Host-agnostic runtime | `docs/2026-07-03-faza4-5-headless-design.md` | `crates/feral-core/src/boot.rs`, `feral-cli` |
| Faza 4.6 | (infra) | Brain Stack (capability routing) | `docs/2026-07-03-brain-stack-minimax-brief.md` | `CinderpawAgent/src/brain/`, `src-tauri/src/brain*` |
| Faza 5 (shipped) | L5 governance | Policy lifecycle | `docs/2026-07-04-l5-governance-evolution-spec.md` | `rsi/l5-gov/governance*`, `crates/feral-core/src/rsi/sandbox_bounds.rs` |
| Faza 6 (shipped) | L6 meta | Tunes the tuner | `docs/2026-07-04-l6-meta-evolution-audit.md` | `rsi/l6-meta/meta-evolution.ts`, instantiated in `boot.ts` and live via `metaParams` |

**Things that are NOT in the BRSI layer model** (deliberately
out-of-scope per spec §Out-of-scope):
- Brain Stack (Faza 4.6) — capability routing, not evolution.
- Headless CLI (Faza 4.5 slice 2) — host extraction, not a new layer.
- FMS / fractal memory — substrate used by L1/L2 retrievers, not
  evolution.

## 5. Glossary

Poetic terms recur across specs and code. Each is a one-sentence
definition plus the file that "owns" it.

| Term | Definition | Owner |
|---|---|---|
| **BRSI** | Bounded Recursive Self-Improvement — the umbrella discipline; reads as "RSI bounded by invariants + journal + tier-0". | `docs/brsi-spec.md` |
| **RSI** | Recursive Self-Improvement — the unbounded idea BRSI constrains. | — |
| **Tier 0** | The immutable eval floor: a fixed test corpus any candidate must clear before promotion. | `crates/feral-core/src/rsi/tier0.rs`, `rsi/infra/default-tier-specs.ts` |
| **Genome / GenomeConfig** | The 7-field configuration object L1 mutates (retrieval, mutation, selection, crossover, …). | `rsi/l1-config/genome.ts` |
| **Mutation** | Operator that produces a new candidate from parent(s). | `rsi/l1-config/mutation.ts` |
| **Fitness** | Multi-objective *vector* (not a scalar). Promotion ranks on the vector, not on a single number. | `rsi/l1-config/fitness.ts`, `crates/feral-core/src/rsi/scorer.rs` |
| **Champion** | The lineage's current best candidate. | `rsi/l1-config/champion.ts`, `rsi/l1-config/champion-tree.ts` |
| **Champion tree** | Forest of champions per niche; tree of champions picks the lineage forward. | `rsi/l1-config/champion-tree.ts` |
| **Taste / taste mining** | Heuristic that ranks user feedback to seed strategy-genomes. | `rsi/l1-config/taste.ts`, `rsi/l1-config/taste-miner.ts` |
| **Escape time** | How long a niche has gone without an improvement; long escapes trigger extinction pressure. | `rsi/l1-config/escape-time.ts`, `rsi/l1-config/escape-time-recorder.ts` |
| **Recalcitrance** | Empirical signal that a niche resists current operators — RSI pauses and tries harder mutations. | `rsi/l1-config/recalcitrance.ts` |
| **Birth / birth policy** | Spawning a new candidate within population dynamics. | `rsi/l1-config/birth-policy.ts` |
| **Extinction / extinction handler** | Removing a stale niche or catastrophic niche (monoculture, Hall-of-Fame retention). | `rsi/l1-config/extinction-handler.ts` |
| **Ratchet** | The strict-greater advance: `candidate > prior` or no advance. Source of truth for `repo.rs:344`. | `rsi/l1-config/ratchet-handler.ts`, `crates/feral-core/src/rsi/repo.rs` |
| **PBT** | Population-Based Training: strategy-genomes steer Level-1 in lockstep with model training. | `rsi/l1-config/pbt-controller.ts`, `rsi/l1-config/pbt-handler.ts` |
| **Dream / dream cycle** | The 8-stage orchestration loop that decides "what to try next". | `rsi/l1-config/dream-cycle.ts`, `rsi/l1-config/dream-scheduler.ts`, `rsi/l1-config/dream-config.ts` |
| **FMS / fractal memory** | Fractal Memory Search — the memory substrate; tier-by-tier summary tree over SQLite leaves. | `CinderpawAgent/src/memory/fractal/` |
| **Seam** | A typed extension point + builtin + registry key. v1 ships two: `retrieval_strategy`, `planner`. | `rsi/l4-modules/seam-catalog.ts`, `rsi/l4-modules/seam-runtime.ts`, `rsi/l4-modules/seam-adapter.ts` |
| **Module** | An L4 plug-in: a self-contained directory behind a seam. | `rsi/l4-modules/module-host.ts`, `rsi/l4-modules/module-registry.ts` |
| **SandboxBounds** | L5's tunables (caps, weights, ceilings). Reversible by file replacement. | `crates/feral-core/src/rsi/sandbox_bounds.rs` |
| **Strikes** | How many times a module may fail before the registry re-points the seam to builtin. | `rsi/l4-modules/seam-adapter.ts` |
| **Provenance** | The git-backed decision lineage (audit-by-git). | `rsi/infra/provenance.ts` |
| **Journal** | The hash-chained append-only lab notebook. | `rsi/infra/journal.ts`, `rsi/infra/hash-chain.ts` |
| **Confidence** | Statistical significance gate, not "looks better". | `rsi/infra/confidence.ts` |

## 6. Where do I add X

The cheat sheet, because every new contributor asks at least one of these.

### "I'm adding a new inference provider."

Four places, in this order:
1. **`crates/feral-core/src/byok.rs`** `provider_catalog()` — the canonical
   list. Add the entry; `Provider::from_id()` will pick it up.
2. **`CinderpawAgent/src/egress/inference-providers.ts`** — only if you
   need a new protocol *family* (e.g. `anthropic-native`). Otherwise
   the existing OpenAI-compat adapter routes you automatically.
3. **`CinderpawAgent/src/brain/capability-registry.ts`** — a capability
   vector is auto-seeded from the catalog; confirm it matches.
4. **`Settings → Cloud Keys` UI** — wires automatically via
   `useCatalog()` (R4 fix). Confirm with a smoke test.

### "I'm adding a new built-in tool."

```
CinderpawAgent/src/tools/builtin/<name>.ts
```

Declare a manifest (permissions, parameters) in the same file; the
tool registry in `boot.ts` will pick it up. Add a smoke test under
`CinderpawAgent/tests/`.

### "I'm adding a new chat-platform connector."

```
crates/feral-core/src/connectors.rs           # catalog entry
src-tauri/src/connectors.rs                   # desktop IPC
CinderpawAgent/src/egress/mcp-manager.ts         # connection owner (R5)
```

Persistence (`~/.feral/connectors.json`) flows through `feral-core`
(`crates/feral-core/src/connectors.rs`) — both the desktop Tauri
commands and the headless gateway/CLI (`GET`/`POST /runtime/connectors`,
`feral connectors set`) read/write through it.

### "I'm adding a new L4 seam module."

Write the module under `modules/<id>/manifest.json + module.ts` per
L4 spec §1. The registry (`modules/registry.json`) is the source of
truth at runtime — that's where `retrieval_strategy` / `planner`
mapping lives. **Never edit `CinderpawAgent/src/` for an L4 module**;
that's the L3 trust boundary.

### "I'm adding a new memory strategy."

Pick the L-layer first:
- Same engine, different scoring → `rsi/l1-config/fitness.ts`.
- New retriever (graph-of-leaves, hybrid) → add to
  `GenomeConfig.retrievalStrategy` pool
  (`CinderpawAgent/src/rsi/l1-config/genome.ts`); becomes a seam candidate.
- New storage layout (FMS tier change) → `CinderpawAgent/src/memory/fractal/`.

---

*Maintainers' note: this document is the primary *map*. If you add a
new file in `CinderpawAgent/src/rsi/`, update the L-layer table in §3,
the glossary in §5, and `CinderpawAgent/src/rsi/README.md`. Drift here is
a real bug — the next agent will believe the wrong thing.*
