# FERAL — Architecture Overview

> **TL;DR** — Feral is one repo, **four runtimes**, **three protocols** between
> them. The **BRSI layer model** (L0–L6) lets the engine improve itself
> incrementally while hard walls block the changes that matter.
>
> **Companion docs:**
> - [docs/CONTRIBUTOR_GUIDE.md](./CONTRIBUTOR_GUIDE.md) — long-form
>   contributor guide, runtime narrative, dev workflow, build pipeline.
> - [docs/CONFIGURATION.md](./CONFIGURATION.md) — every `FERAL_*` env var.
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
| 2 | **Rust host** | Tauri 2 + llama.cpp | `src-tauri/` + `crates/feral-core/` | IPC, file system, GGUF inference, `127.0.0.1:11435` HTTP API, sidecar supervision. |
| 3 | **Sidecar** | Bun + TypeScript (compiled to one `.exe`) | `FeralAgent/` | Agent loop, BRSI engine, memory, tools, sandboxed inference router. |
| 4 | **Headless CLI** (gateway) | Rust | `crates/feral-cli/` | Same Rust host, no UI. Exposes `feral` subcommands and the HTTP API for terminal + automation. |
| 5 | **TUI** | Go + Bubble Tea | `tui/` | Terminal chat + onboarding + connectors wizard. API client only. |

(Runtimes 2 and 4 share the same `feral-core` crate — they are two hosts of
one runtime, not two runtimes. The CONTRIBUTOR_GUIDE counts three;
this file counts four because the TUI shares enough surface area to
warrant its own row.)

## 2. The three protocols

| Protocol | Direction | Wire format | Validator | Canonical spec |
|---|---|---|---|---|
| **Tauri IPC** | UI ↔ host | `invoke()` / `listen('feral://…')` | Tauri command registry in `src-tauri/src/lib.rs` | `docs/CONTRIBUTOR_GUIDE.md §2` |
| **Stdout/stderr JSON-lines** | host ↔ sidecar | `{type:"…", …}\n` per line | `FeralAgent/src/transports/tauri.ts` (`isInbound`) + `types.ts` (`InboundMessage` / `OutboundEvent`) | This doc's runtime story + `index.ts` switch (R1 will make it a schema const). |
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
| **L0 — substrate** | Git-backed journal; bounded-ratchet boundary; integrity | Persist all evolution artefacts as git commits; reject non-monotonic advances | Touch user-visible runtime paths | `rsi/journal.ts`, `rsi/repo.ts` (TS proxy), `rsi/hash-chain.ts` | `crates/feral-core/src/rsi/repo.rs` (`ratchet_attempt`), `src-tauri/src/rsi/repo.rs` |
| **L1 — config evolution** | Mutate the 7-field `GenomeConfig`; bounded by schema | Mutate genomes within schema; emit `EvalStarted`/`EvalComplete` | Touch code, LoRA weights, source files | `rsi/genome.ts`, `rsi/mutation.ts`, `rsi/selection-handler.ts`, `rsi/crossover*`, `rsi/population-manager.ts`, `rsi/champion*.ts`, `rsi/taste*.ts`, `rsi/escape-time*`, `rsi/recalcitrance.ts`, `rsi/birth-policy.ts`, `rsi/extinction-handler.ts`, `rsi/dream-*.ts`, `rsi/pbt-*`, `rsi/fractal.ts`, `rsi/goal-mode.ts`, `rsi/strategy-seeds.ts` | `crates/feral-core/src/rsi/scorer.rs` |
| **L2 — continual personal adaptation** | LoRA over user signal | Train / promote LoRAs; manage dataset | Mutate base weights; bypass `personal-fitness.ts` | `rsi/lora-*`, `rsi/trainers/`, `rsi/dataset-builder.ts`, `rsi/personal-fitness.ts` | `crates/feral-core/src/rsi/plan.rs` |
| **L3 — code-RSI** | Patches over existing FeralAgent source | Compose unified diffs; live-apply through worktree | Skip the worktree; touch host or TUI; promote without human approval (first N) | `rsi/code-*`, `rsi/pending-patches.ts`, `rsi/code-sandbox.ts` | `src-tauri/src/rsi/` (full file set; `code_patch.rs` in `feral-core`), `crates/feral-core/src/rsi/repo.rs::watchdog_branch` |
| **L4 — architecture evolution** | Subsystem hot-plug via `seam_runtime` against two v1 seams (`retrieval_strategy`, `planner`) | Promote new modules via `seam-adapter`/`module-host`; registry re-point on strike | Write into `FeralAgent/src/`; ship a third seam in v1 | `rsi/module-*`, `rsi/seam-*` | `crates/feral-core/src/rsi/` (instrumentation) |
| **L5 — governance evolution** | Tunes parameters inside `SandboxBounds`; reversible | Update `policy.json`; emit audit events | Bypass tier-0; ignore an `EvalHalted` | `rsi/governance*` | `crates/feral-core/src/rsi/sandbox_bounds.rs`, `crates/feral-core/src/rsi/audit.rs` |
| **L6 — meta evolution** | Tunes the algorithm that produces parameters | Modify selection pressure, score weights, mutation distributions | Skip human gate; never reversible on its own | `rsi/meta-evolution.ts` | (rust half not implemented) |
| **infra (cross-layer)** | State + transport primitives used by every layer above | Bus events, envelopes, budget, paths | Couple to a specific L-layer's evolution contracts | `rsi/event-bus.ts`, `rsi/hash-chain.ts`, `rsi/instance-paths.ts`, `rsi/provenance.ts`, `rsi/envelope-store.ts`, `rsi/budget.ts`, `rsi/rsi-cost.ts`, `rsi/resource-monitor.ts`, `rsi/adapters.ts`, `rsi/bridge.ts` | (paths only — `crates/feral-core/src/rsi/paths.rs`) |

The orchestrators live at the root of `rsi/`: `rsi/sidecar.ts`,
`rsi/engine.ts`, `rsi/mod.ts`. Every layer's imports go *through*
them; orchestrators know about every layer, but layers do not import
each other directly.

## 4. Faza ↔ L-layer ↔ spec ↔ code

> **Verified by `git log --grep="Faza"` on this branch at commit
> `feat/l5-governance`.** Faza numbers are historical (when the work
> shipped); L-layer numbers are architectural (where the work
> belongs). They overlap but don't coincide exactly.

| Faza | L-layer | Title | Spec | Code (headline) |
|---|---|---|---|---|
| Faza 0 | L0 substrate | Keystone as delivered | `docs/brsi-spec.md` §0 | `rsi/journal.ts`, `crates/feral-core/src/rsi/repo.rs` |
| Faza 1 | L1 mechanics | Event bus → mutation → ratchet | `docs/rsi-evolution-spec.md` | `rsi/event-bus.ts`, `rsi/mutation.ts`, `rsi/ratchet-handler.ts`, `rsi/population-manager.ts` |
| Faza 1 | sidecar/Rust bridge | (a) bridge client | (same) | `rsi/bridge.ts`, `crates/feral-core/src/feral_agent.rs` |
| Faza 2 | L3 | Code-RSI | `docs/code-rsi-*.md`, `docs/2026-07-04-l4-architecture-evolution-spec.md` | `rsi/code-*`, `src-tauri/src/rsi/` |
| Faza 2/3 reproduction | L1/L3 | Wire reproduction into births | — | `rsi/crossover*`, `rsi/extinction-handler.ts` |
| Faza 3 | L3 stabilisation | Watchdog / revert / rebuild | `docs/2026-07-09-l4-b7-smoke.md` | `src-tauri/src/rsi/watchdog.rs`, `src-tauri/scripts/build-sidecar.mjs` |
| Faza 3.5 | (L1/L2 hybrid) | PBT (strategy-genomes) | `docs/rsi-evolution-spec.md` | `rsi/pbt-*` |
| Faza 4 | L2 | LoRA loop (eval runner + LoRA substrate) | `docs/brsi-spec.md` §4.7 + per-slice docs | `rsi/lora-*`, `rsi/dataset-builder.ts`, `rsi/personal-fitness.ts` |
| Faza 4.5 | (infra) | Host-agnostic runtime | `docs/2026-07-03-faza4-5-headless-design.md` | `crates/feral-core/src/boot.rs`, `feral-cli` |
| Faza 4.6 | (infra) | Brain Stack (capability routing) | `docs/2026-07-03-brain-stack-minimax-brief.md` | `FeralAgent/src/brain/`, `src-tauri/src/brain*` |
| Faza 5 (spec only) | L5 governance | Policy lifecycle | `docs/2026-07-04-l5-governance-evolution-spec.md` | `rsi/governance*`, `crates/feral-core/src/rsi/sandbox_bounds.rs` |
| Faza 6 (spec only) | L6 meta | Tunes the tuner | `docs/2026-07-04-l6-meta-evolution-audit.md` | `rsi/meta-evolution.ts` (scaffold) |

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
| **Tier 0** | The immutable eval floor: a fixed test corpus any candidate must clear before promotion. | `crates/feral-core/src/rsi/tier0.rs`, `rsi/default-tier-specs.ts` |
| **Genome / GenomeConfig** | The 7-field configuration object L1 mutates (retrieval, mutation, selection, crossover, …). | `rsi/genome.ts` |
| **Mutation** | Operator that produces a new candidate from parent(s). | `rsi/mutation.ts` |
| **Fitness** | Multi-objective *vector* (not a scalar). Promotion ranks on the vector, not on a single number. | `rsi/fitness.ts`, `crates/feral-core/src/rsi/scorer.rs` |
| **Champion** | The lineage's current best candidate. | `rsi/champion.ts`, `rsi/champion-tree.ts` |
| **Champion tree** | Forest of champions per niche; tree of champions picks the lineage forward. | `rsi/champion-tree.ts` |
| **Taste / taste mining** | Heuristic that ranks user feedback to seed strategy-genomes. | `rsi/taste.ts`, `rsi/taste-miner.ts` |
| **Escape time** | How long a niche has gone without an improvement; long escapes trigger extinction pressure. | `rsi/escape-time.ts`, `rsi/escape-time-recorder.ts` |
| **Recalcitrance** | Empirical signal that a niche resists current operators — RSI pauses and tries harder mutations. | `rsi/recalcitrance.ts` |
| **Birth / birth policy** | Spawning a new candidate within population dynamics. | `rsi/birth-policy.ts` |
| **Extinction / extinction handler** | Removing a stale niche or catastrophic niche (monoculture, Hall-of-Fame retention). | `rsi/extinction-handler.ts` |
| **Ratchet** | The strict-greater advance: `candidate > prior` or no advance. Source of truth for `repo.rs:344`. | `rsi/ratchet-handler.ts`, `crates/feral-core/src/rsi/repo.rs` |
| **PBT** | Population-Based Training: strategy-genomes steer Level-1 in lockstep with model training. | `rsi/pbt-controller.ts`, `rsi/pbt-handler.ts` |
| **Dream / dream cycle** | The 8-stage orchestration loop that decides "what to try next". | `rsi/dream-cycle.ts`, `rsi/dream-scheduler.ts`, `rsi/dream-config.ts` |
| **FMS / fractal memory** | Fractal Memory Search — the memory substrate; tier-by-tier summary tree over SQLite leaves. | `FeralAgent/src/memory/fractal/` |
| **Seam** | A typed extension point + builtin + registry key. v1 ships two: `retrieval_strategy`, `planner`. | `rsi/seam-catalog.ts`, `rsi/seam-runtime.ts`, `rsi/seam-adapter.ts` |
| **Module** | An L4 plug-in: a self-contained directory behind a seam. | `rsi/module-host.ts`, `rsi/module-registry.ts` |
| **SandboxBounds** | L5's tunables (caps, weights, ceilings). Reversible by file replacement. | `crates/feral-core/src/rsi/sandbox_bounds.rs` |
| **Strikes** | How many times a module may fail before the registry re-points the seam to builtin. | `rsi/seam-adapter.ts` |
| **Provenance** | The git-backed decision lineage (audit-by-git). | `rsi/provenance.ts` |
| **Journal** | The hash-chained append-only lab notebook. | `rsi/journal.ts`, `rsi/hash-chain.ts` |
| **Confidence** | Statistical significance gate, not "looks better". | `rsi/confidence.ts` |

## 6. Where do I add X

The cheat sheet, because every new contributor asks at least one of these.

### "I'm adding a new inference provider."

Four places, in this order:
1. **`crates/feral-core/src/byok.rs`** `provider_catalog()` — the canonical
   list. Add the entry; `Provider::from_id()` will pick it up.
2. **`FeralAgent/src/sandbox/inference-providers.ts`** — only if you
   need a new protocol *family* (e.g. `anthropic-native`). Otherwise
   the existing OpenAI-compat adapter routes you automatically.
3. **`FeralAgent/src/brain/capability-registry.ts`** — a capability
   vector is auto-seeded from the catalog; confirm it matches.
4. **`Settings → Cloud Keys` UI** — wires automatically via
   `useCatalog()` (R4 fix). Confirm with a smoke test.

### "I'm adding a new built-in tool."

```
FeralAgent/src/tools/builtin/<name>.ts
```

Declare a manifest (permissions, parameters) in the same file; the
tool registry in `index.ts` will pick it up. Add a smoke test under
`FeralAgent/tests/`.

### "I'm adding a new chat-platform connector."

```
crates/feral-core/src/connectors.rs           # catalog entry
src-tauri/src/connectors.rs                   # desktop IPC
FeralAgent/src/sandbox/mcp-manager.ts        # connection owner (R5)
```

Persistence (`~/.feral/connectors.json`) flows through `feral-core`
after R6 lands; before that, it's desktop-only.

### "I'm adding a new L4 seam module."

Write the module under `modules/<id>/manifest.json + module.ts` per
L4 spec §1. The registry (`modules/registry.json`) is the source of
truth at runtime — that's where `retrieval_strategy` / `planner`
mapping lives. **Never edit `FeralAgent/src/` for an L4 module**;
that's the L3 trust boundary.

### "I'm adding a new memory strategy."

Pick the L-layer first:
- Same engine, different scoring → `rsi/fitness.ts`.
- New retriever (graph-of-leaves, hybrid) → add to
  `GenomeConfig.retrievalStrategy` pool
  (`FeralAgent/src/rsi/genome.ts`); becomes a seam candidate.
- New storage layout (FMS tier change) → `FeralAgent/src/memory/fractal/`.

---

*Maintainers' note: this document is the primary *map*. If you add a
new file in `FeralAgent/src/rsi/`, update the L-layer table in §3
and the glossary in §5. Drift here is a real bug — the next agent
will believe the wrong thing.*
