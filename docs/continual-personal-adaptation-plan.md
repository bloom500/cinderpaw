# Continual Personal Adaptation — Implementation Plan

> **Scope:** map the 6-layer roadmap from `Feral_Roadmap_RSI_and_Continual_Adaptation.pdf`
> onto Feral's existing substrate (`docs/rsi-evolution-spec.md`, `PLAN.md`,
> `HANDOFF.md`) and identify what is missing.
>
> **Status legend:** ✅ built + tested · 🟡 spec'd, partial · ⬜ not started
> **Source of truth for RSI internals:** `docs/rsi-evolution-spec.md` — this
> doc **aligns** with it; it does not fork it.

---

## 0. Execution Handoff (for Opus)

When this doc is handed to Opus in 2 days, the intended read order is:

1. **§1 TL;DR + §2 Mapping** — orientation, ~2 min.
2. **§3 Three Missing Axes** — the strategic delta vs `rsi-evolution-spec.md`.
3. **§5 Phasing & Dependencies** — what blocks what.
4. **§8 Open Decisions** — six items with defaults; the user picks before
   any code lands.
5. **§4 Per-Layer Work Breakdown** — implementation breakdown by Faza.
6. **§6 Guardrails** — read before touching any auto-apply code path.

Do **not** start coding before §8 is locked. The default answers are
sensible but reversible until anything ships.

---

## 1. TL;DR

The PDF's six layers map **1-to-1** onto Feral's existing Faza naming
(config / code / meta / arch / model) plus two pre-faza streams already
called out as the strategic wedge in `PLAN.md` Partea B (UIA workflow
learning + on-device LoRA). The gap is **not** in the top-level layering —
it is in:

1. The **UIA-demonstration pipeline** (record→replay→parametrize) that
   produces the personal training signal for Layer 2. Spec mentions UIA
   tooling; it does not specify how demonstrations become training data.
2. A **first-class Personal LoRA pipeline** (data → adapter → eval-gate →
   promote/rollback) sitting **between** Layer 1 and Layer 5.
3. The **per-instance divergence model** ("every Feral evolves
   differently") — current spec is single-instance; the data model for
   diverged lineages is implicit at best.

Three new work-streams + alignment of existing five. No code in this doc.

---

## 2. Layer ↔ Faza Mapping

| PDF Layer | Name                          | Existing Faza          | Status        |
| --------- | ----------------------------- | ---------------------- | ------------- |
| **L0**    | Memory Adaptation             | Faza 5/6 Fractal Memory| ✅ built, bench-gated (`PLAN.md`)  |
| **L1**    | Configuration Evolution       | Faza 1 Config Genome   | 🟡 engine built; 7b-part2 in flight (`HANDOFF.md`) |
| **L2**    | Continual Personal Adaptation | Faza 5 LoRA (subset)   | 🟡 spec-only, no trainer           |
| **L3**    | Code Evolution                | Faza 2 Code Genome     | 🟡 spec-only                      |
| **L4**    | Architecture Evolution        | Faza 4 Arch Genome     | 🟡 spec-only                      |
| **L5**    | Meta Evolution                | Faza 3 Meta Genome     | 🟡 spec-only                      |

Parallel streams (not in rsi-evolution-spec, called out in `PLAN.md` Partea B):

| Stream          | Today                          | Gap                                  |
| --------------- | ------------------------------ | ------------------------------------ |
| UIA Demo Capture| `desktop-control-bridge.ts`, `control-app.ts` tool | Record/replay/parametrize pipeline absent |
| Personal LoRA   | `inference-providers.ts` knows about adapters | No trainer, no eval-gate, no rollback |

---

## 3. Three Missing Axes (the strategic wedge)

### 3.1 UIA Demonstration Pipeline (feeds 3.2)

**Why it matters:** "Personal adaptation" needs a personal signal. The PDF
implies this comes from user interactions. The richest signal is
**demonstrations** — the user does a workflow once in a desktop app, the
agent records it (UIA tree + inputs), replays it later parametrized.

**What exists today:**
- `desktop-control-bridge.ts` — read+invoke UIA on Windows (and AX on macOS)
- `control-app.ts` — agent tool for live control
- `user-loader.ts` — per-user prompt personalization (USER block)
- `inner-thoughts.ts` — episodic log of agent activity

**What does not exist (designed here, no code):**

1. **Demonstration recorder** — captures (action, target, args) tuples
   from UIA events into a versioned artifact (`.feral/demos/<id>.jsonl`).
2. **Replay engine** — deterministic replay against a target window with
   parameter substitution (`{{date}}`, `{{selected_text}}`, etc.).
3. **Generalizer** — turns one specific demo into a parametrized
   template (which fields become variables? which stay fixed?).
4. **Coverage estimator** — scores how well the demo set covers the
   user's actual workflows (rough; no perfect answer is possible).
5. **Signal extraction** — turns replay+generalize outputs into
   `(instruction, successful_trajectory)` pairs that the Personal LoRA
   pipeline (3.2) can consume as training data.

**Guardrails (must be in the spec, not just implied):**
- Recording is **opt-in per app** (capability manifest). No silent
  capture.
- Recorded artifacts live under the user's data root only
  (`~/.feral/users/<id>/demos/`). Never sync to a shared store without
  explicit consent.
- Demos are **executable code** in disguise (replay → actions). Treat
  them like any other tool invocation: scope, permissions, audit.
- Replay requires a confirmation prompt if the demo was recorded > 30
  days ago (stale workflows drift).

### 3.2 Personal LoRA Pipeline

**Why it matters:** This is Layer 2 of the PDF and the substantive part of
the "Feral becomes yours" pitch in `PLAN.md` Partea B #2. The spec's
Faza 5 is a *superset* (covers LoRA + ensembles + arch proposals);
Layer 2 is just LoRA + the eval-gate that makes it reversible.

**What does not exist:**

1. **Dataset assembler** — turns the signal from 3.1.5 + episodic memory
   into `(instruction, ideal_response)` or `(prompt, accepted_completion)`
   training pairs. Two paths:
   - **Demo-derived** (high quality, low volume): from 3.1.
   - **Acceptance-derived** (medium quality, high volume): from
     `episodic.ts` rows where the user accepted a tool call / message.
2. **Trainer** — LoRA fine-tune on the active chat model. **GPU-only** on
   the dev box (Vulkan path documented in
   `reference_windows_vulkan_build.md`). CPU fallback is single-batch
   only (regression gate). **NOT** always-on; runs in dream cycles.
3. **Adapter registry** — versioned on disk
   (`~/.feral/users/<id>/loras/<adapter_id>/`), with lineage
   (`parent_adapter_id`, `dataset_hash`, `training_run_id`).
4. **Eval-gate** — runs the agent on a *personal eval suite*
   (`user_eval_set.json`) with and without the adapter; only promotes if
   delta > threshold on the user's own tasks AND no regression on Tier 0.
5. **Rollback / unload** — instant adapter swap; ratchet only on the
   adapter version, never on the base model (base stays immutable).
6. **Cost gate** — trainer cannot run if estimated compute > user-set
   weekly budget. Falls back to "queue for next dream cycle".

**Personal eval suite — design point:**
The Tier 0/1/2 eval suite is *general capability*. The personal suite
is *the user's own ground truth*. Minimum viable form: a curated set of
50–200 tasks the user has done before, with expected answers / accepted
behaviors. Built incrementally as the agent works.

**Where this sits in the engine composition root:**
It is **not** a new genome type. It is a separate subsystem that reads
the active `GenomeConfig` (Faza 1) and registers a LoRA adapter in
`InferenceRouter`. The RSI engine's role is to *trigger* it on a slow
clock (weekly or N demos accumulated); not to evaluate the LoRA itself
(Tier 0 is the safety net, personal suite is the promotion gate).

### 3.3 Per-Instance Divergence Model

**Why it matters:** PDF long-term vision: "Every Feral instance starts
from the same foundation but evolves differently." Today the substrate
does not have a notion of "this is user X's lineage vs user Y's". All
RSI state lives in `~/.feral/rsi/` (shared).

**What needs designing (no code yet):**

1. **Lineage root keying** — every genome, adapter, eval result, and
   audit-log row gets a `tenant_id` (today this is implicit "single
   user"). Default to a UUID generated at first run; surface in UI.
2. **Per-instance storage roots** — split `~/.feral/` into
   `~/.feral/shared/` (Tier 0 specs, scoring weights, immutable core)
   and `~/.feral/instances/<tenant_id>/` (genomes, adapters, demos,
   eval suites, audit).
3. **Divergence policy** — explicitly choose: shared Tier 0 + divergent
   everything above. Tier 0 is the contract that makes divergence safe
   (an instance cannot regress general capability below the floor).
4. **Cross-instance export** (out of scope for v1, listed for awareness):
   "share my LoRA" is a future product question. For now, adapters are
   strictly local.

---

## 4. Per-Layer Work Breakdown

### Layer 0 — Memory Adaptation ✅ (gate)

- Status: built, 46 new tests, 916/954 → 954/954.
- Open: `FERAL_RUN_FRACTAL_BENCH=1` live verdict (`project_fractal_bench_blockers.md`).
- Owner: gate on real bench numbers before unlocking Layer 1 promotion.

### Layer 1 — Configuration Evolution 🟡

- Status: `FeralAgent/src/rsi/*` engine built (40+ files); Tier 0 specs
  in `src-tauri/src/rsi/tier0.rs`; bridge client done in `bridge.ts`.
- In flight: `HANDOFF.md` items 7b-part2 → 7d (Rust dispatcher, TS
  adapters, IPC, minimal UI).
- New for PDF alignment: ensure the `GenomeConfig` schema (`genome.ts`)
  has an explicit slot for **personal_eval_suite_path** and
  **personal_lora_adapter_id** (read-only at Faza 1 — set by Layer 2,
  consulted by eval scoring). This makes the L0/L1 boundary clean.
- Exit criteria: 7d minimal UI live; engine runs end-to-end on Tier 0;
  first ratchet observed in `data/dream.jsonl`.

### Layer 2 — Continual Personal Adaptation ⬜ (NEW stream)

- Depends on: 3.1 (UIA demo pipeline — even a stub), Layer 1 (engine
  must exist to schedule trainer runs).
- Sequence:
  1. **Spec the personal LoRA pipeline** (this doc + a new
     `docs/personal-lora-spec.md` once code starts).
  2. **Dataset assembler MVP** — demo-only at first; acceptance-derived
     later.
  3. **Trainer** — Bun-orchestrated subprocess calling the same Vulkan
     path used for inference; same model file, LoRA-only training run.
  4. **Adapter registry + eval-gate** — wired through `InferenceRouter`.
  5. **Cost gate + rollback** — non-negotiable safety.
- Exit criteria: agent trains one LoRA on real demos, passes the user's
  eval suite with delta > threshold, promotes without crashing the live
  chat, can be reverted in <5s.

### Layer 3 — Code Evolution 🟡 (spec → build)

- Status: spec'd in `rsi-evolution-spec.md` §Faza 2; nothing built.
- Depends on: `process-sandbox.ts` (done), `circuit-breaker.ts` (done),
  `field-crypto.ts` (done), `egress-proxy.ts` (done). All guardrails
  exist; need wiring.
- Sequence:
  1. `CodeGenome` type + `code-genome.ts`.
  2. `rsi_commit_code_patch` Rust command (mirror `commands.rs::rsi_commit_genome`).
  3. TS adapter in `adapters.ts` (`makeCommitCodePatchAdapter`).
  4. Code-RSI eval runner: edit → `bun test` → `bunx tsc --noEmit` →
     `bun run build` → score.
  5. Rollback: snapshot pre-apply, health-check post-apply, auto-revert
     on regression.
  6. **First-10 human-approval gate** (UI).
- Constraint: code patches limited to `FeralAgent/src/rsi/` only
  (per spec open-question #1 answer — start narrow).
- Exit criteria: agent proposes a patch, tests pass, score improves, no
  regression on Tier 0, ratchet observed.

### Layer 4 — Architecture Evolution 🟡 (spec → build)

- Status: spec'd §Faza 4; nothing built.
- Hardest of the five. Subsystem sandbox (Worker thread), resource caps
  (512MB / 50% CPU), dependency allowlist (`package.json` + `Cargo.lock`
  only — no new packages), integration test before live apply.
- Sequence: see spec; can be deferred until Layer 3 is stable. Subsystem
  hot-plug is risky and only worth doing once the engine's auto-apply
  story is proven on smaller genomes.
- Exit criteria: agent introduces one new memory type end-to-end.

### Layer 5 — Meta Evolution 🟡 (spec → build)

- Status: spec'd §Faza 3; nothing built.
- The most "academic RSI" of the five. Tightens the loop: agent modifies
  its own mutation grammar, selection pressure, scoring weights (with
  Tier 0 weights immutable — Rust-enforced).
- Must be **always human-gated** (spec §4.2). Never auto-apply.
- Sequence: deferred; do not start until Layer 3 is observably safe
  (no rollback events in N dream cycles, audit log clean).

---

## 5. Phasing & Dependencies

```
  L0 (Fractal Memory)        ─── ship gate ──┐
                                              │
  L1 (Config Evolution)  ─── 7b-part2 → 7d ──┤  (in flight per HANDOFF.md)
                                              │
  Stream A: UIA Demo Capture ────────────────┤
       │  (parallel)                          │
       ▼                                      │
  Stream B: Personal LoRA ───────────────────┤  ← Layer 2
       │                                      │
       ▼                                      │
  L3 (Code Evolution) ────────────────────────┤
       │                                      │
       ▼                                      │
  L4 (Architecture) ─────────────────────────┤
       │                                      │
       ▼                                      │
  L5 (Meta) ─────────────────────────────────┘  ← last, always human-gated
```

Parallelizable: **Stream A (UIA Demo)** can start now — it has no
dependency on the RSI engine. **Stream B (Personal LoRA)** needs Stream A
producing real signal, but the trainer skeleton + eval-gate can start in
parallel.

Sequential: L3 → L4 → L5 must each be unblocked by the previous (each
one increases the blast radius of a bad auto-apply).

---

## 6. Guardrails (inherited + new)

Inherited from `docs/rsi-evolution-spec.md` §4 (no change):
- Hash-chained audit log; Tier 0 immutable; scorer Rust-side;
  SandboxBounds; resource caps per Faza.

**New for the personal-adaptation streams (must be spec'd before code):**

| Risk                                            | Mitigation                                                |
| ----------------------------------------------- | --------------------------------------------------------- |
| Demo recording captures PII                     | Capability manifest opt-in per app; redaction layer in extractor |
| Training data poisoning (user accepts bad output) | Acceptance-derivation requires ≥ 2 independent acceptances or explicit "use as canonical" |
| Adapter overfits to one user quirk              | Personal eval suite must grow alongside demos; promotion gate rejects tiny suites |
| Cross-instance data leak                        | Hard path separation: `~/.feral/instances/<id>/`; no shared reads except Tier 0 |
| Compute exhaustion from LoRA training           | Weekly budget cap; falls back to "queue next cycle"        |
| Stale demo replay                               | Confirm prompt for demos > 30 days old                     |
| Per-instance divergence breaks Tier 0 floor    | Tier 0 suite must pass on every promoted adapter; if not, adapter is rejected even if personal suite improved |

---

## 7. What this plan explicitly does NOT cover

- **Cloud sync / "share my adapter"** — product question, deferred.
- **Multi-user instances on one machine** — single-user-per-tenant
  assumption; revisit if a "family plan" or shared workstation use case
  emerges.
- **Federated / distributed LoRA training** — out of scope; trainer is
  local-only.
- **Replacing Tier 0 with the personal suite** — Tier 0 is the safety
  floor; personal suite is the promotion gate. Both must pass.

---

## 8. Open Decisions (please lock before any code lands)

1. **Naming:** spec recommends renaming "RSI" → "AGE (Agent Genome
   Evolution)" for Faza 1-2. PDF uses "RSI". Default: keep "RSI" in
   internal docs, use "AGE" in user-facing copy for Faza 1-2 only.
2. **UIA demo capture scope:** all desktop apps the user controls, or
   allowlist per app? Default: allowlist per app (capability manifest).
3. **Personal LoRA scope in v1:** chat-model LoRA only, or also embedder
   LoRA? Default: chat-model only (the embedder is already a
   specialized model; mixing LoRA there is risky).
4. **Dream-cycle trigger for LoRA training:** every cycle, every N demos,
   weekly, or user-initiated only? Default: weekly OR after N=20 new
   demos accumulated, whichever first; user can disable.
5. **Human-approval gate count for L3 code patches:** spec says "first
   10". Keep? Default: keep 10, with a UI counter so the user sees
   progress.
6. **Personal eval suite bootstrap:** who seeds it — the user manually,
   the agent proposes tasks from demos, or both? Default: both, agent
   proposes, user confirms.

---

## 9. Sources

- `docs/rsi-evolution-spec.md` — Faza 1-5 spec (config / code / meta /
  arch / model). Authoritative for engine internals.
- `docs/rsi-e2e.md` — end-to-end test plan for the RSI engine.
- `PLAN.md` — Fractal Memory plan + Partea B (the strategic flagship
  wedge: UIA workflow learning + on-device LoRA).
- `HANDOFF.md` — current RSI Faza 1 work in flight (7b-part2 → 7d).
- `docs/agents-memory/reference_windows_vulkan_build.md` — Windows
  GPU/LLM build recipe (needed for any LoRA training path).
- `docs/agents-memory/project_local_models_gpu.md` — local model
  landscape + `FERAL_EMBED_GPU_LAYERS=0` knob.
- `docs/agents-memory/project_fractal_activity_pulses.md` — Layer 0
  wiring contract.