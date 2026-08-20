# BRSI Spec — Bounded Recursive Self-Improvement for Cinderpaw

> **Status:** Conceptual umbrella spec — drafted for Opus when quota returns.
> **Author:** bloom500 + opencode
> **Date:** 2026-06-30
> **Role:** Top-level "what is Cinderpaw trying to *be*" document. **Reads first.**
> **Implementation companions (do not fork):**
> - `docs/rsi-evolution-spec.md` — Faza 1-5 engine internals (config / code / meta / arch / model).
> - `docs/continual-personal-adaptation-plan.md` — 6-layer roadmap + three missing axes (UIA demo pipeline, Personal LoRA, per-instance divergence).

---

## 0. Reading Order for Opus

1. **§1 — Identity & Positioning** (5 min) — internalize the BRSI + EOS framing before any code.
2. **§2 — Conceptual Foundation** (20 min) — the 10 concepts that have to be honored throughout.
3. **§3 — Sakana Influence & Differentiation** (5 min) — what to borrow, what to refuse.
4. **§4 — Implementation Implications** (15 min) — concrete module / data-structure / API shape each concept demands.
5. **§5 — Six-Layer Roadmap** (10 min) — re-read with the new conceptual lens.
6. **§6 — Research Hypotheses** (5 min) — the claims this work is committing to be measurable against.
7. **§7 — Design Principles** + **§8 — Success Metrics** (10 min) — the constraints and gates.
8. **§9 — Open Decisions** — **lock before any code lands**. Defaults are sensible but reversible.
9. **§10 — References** — the two companion specs and the external literature.

Do **not** start coding before §9 is locked.

---

## 1. Identity & Positioning

### 1.1 The name: Bounded Recursive Self-Improvement (BRSI)

The existing spec calls itself "RSI". The existing mechanics are **bounded**
— max lines changed, max LoRA params, immutable core, rollback, audit log.
What the existing spec does not do is **claim** the bound as its identity.

BRSI is the claim:

> Cinderpaw is not designed to improve without limits. It is designed to
> improve **safely, measurably, and reversibly**, within explicit
> user-defined boundaries.

Every other claim in this doc flows from that sentence. If a design
decision cannot be reconciled with "bounded", it is wrong by definition.

**Naming decision (replaces the §5 debate in `rsi-evolution-spec.md`):**

| Phase                | Internal name | External name                         |
| -------------------- | ------------- | ------------------------------------- |
| Layers 0-2           | "Evolution"   | "Personal Adaptation"                 |
| Layers 3-4           | "BRSI"        | "Bounded Self-Improvement"            |
| Layer 5              | "RSI subset"  | "Meta-Evolution (research preview)"   |

The "RSI" label is reserved for the layer where the agent genuinely
modifies the mechanism that does the improving. Until then, marketing
must not use "RSI" — only "Evolution" or "Personal Adaptation".

### 1.2 The framing: Evolutionary Operating System for AI Agents

Cinderpaw is not "a self-improving agent". It is the **layer between** any
foundation model and the user's personal AI:

```
   ┌─────────────────────────────────────────────────┐
   │              Personal AI (per user)              │
   ├─────────────────────────────────────────────────┤
   │                                                 │
   │            Cinderpaw Evolution Engine                │
   │       (BRSI core — this document)                │
   │                                                 │
   ├──────────────┬──────────────┬───────────────────┤
   │   Gemma      │    Qwen      │     Llama         │  …
   │  (foundation model — swappable, immutable in ratchet)
   └──────────────┴──────────────┴───────────────────┘
```

Three consequences follow from the OS framing:

1. **Foundation model is a dependency, not a feature.** Cinderpaw does not
   pick the model; it evolves **on top of** whichever model the user has.
2. **Personal AI is the product.** The user does not buy "Cinderpaw the
   agent". They get "their" agent that improves for them.
3. **The Evolution Engine has an API.** Other researchers can target it.
   This is what makes a "paper" possible, not a "demo".

### 1.3 How this differs from existing RSI work

| Dimension              | Open-ended RSI (DGM, Anthropic)         | Cinderpaw BRSI                       |
| ---------------------- | --------------------------------------- | -------------------------------- |
| Improvement target     | Global capability on benchmark suites   | Personal usefulness for *this* user |
| Fitness signal         | Public benchmarks (SWE-bench, MMLU)     | Personal eval suite + acceptance signals |
| Architecture           | Single agent / single lineage           | Multi-species lineages, preserved in parallel |
| Modification surface   | Open (any code, any model)              | Bounded (Layer-by-layer promotion gates) |
| Rollback               | Version control, manual                 | First-class runtime gate, < 5 s revert |
| Compute                | As much as the budget allows            | User-defined weekly budget, hard cap |
| Publication            | Capability gains                        | Personal-adaptation gains + safety invariants held |
| Audience               | AGI / capability research               | Single-user productivity + research into *bounded* improvement |

The single most important sentence in this spec:

> **We are not trying to build the smartest AI. We are trying to build
> the AI that gets most valuable for one specific person, with every
> improvement auditable and reversible.**

---

## 2. Conceptual Foundation

These ten concepts are the conceptual layer the existing specs are
missing. Every implementation decision must be checkable against this
list. If a code change violates any of them, it is rejected.

### 2.1 Evolution Contract (the hard pipeline)

A change is not a change until it has passed **every** stage in this
order. There is no "skip the tests", no "we'll benchmark next cycle":

```
       Candidate Change
              │
              ▼
   ┌─────────────────────┐
   │  1. Static analysis  │   tsc --noEmit, lint, secret-scan
   └──────────┬──────────┘
              ▼
   ┌─────────────────────┐
   │  2. Sandbox apply    │   copy to isolated worktree
   └──────────┬──────────┘
              ▼
   ┌─────────────────────┐
   │  3. Tests            │   bun test (full suite, not just touched files)
   └──────────┬──────────┘
              ▼
   ┌─────────────────────┐
   │  4. Benchmark        │   Tier 0 + Tier 1 + personal eval suite
   └──────────┬──────────┘
              ▼
   ┌─────────────────────┐
   │  5. Safety checks    │   resource caps, no-network, scope-of-effect
   └──────────┬──────────┘
              ▼
   ┌─────────────────────┐
   │  6. Regression       │   Goodhart detector: Tier ↑ + Tier ↓ regression?
   └──────────┬──────────┘
              ▼
   ┌─────────────────────┐
   │  7. Deploy (ratchet) │   git fast-forward only on clean signal
   └──────────┬──────────┘
              ▼
   ┌─────────────────────┐
   │  8. Continuous       │   health-check after apply, revert if degraded
   │     monitoring       │
   └─────────────────────┘
```

The contract is **runtime-enforced**, not "we try to follow it". A
change that bypasses a stage is rejected by the engine, not by social
convention. This is the difference between "AI that modifies itself"
and "AI that self-destructs".

**Implementation note (deferred to §4.1):** this becomes a state
machine in the dream cycle; stages are observable; a stage that fails
halts the entire pipeline and writes to the Evolution Journal.

### 2.2 Fitness Function (multi-objective vector, not scalar)

The existing spec scores genomes with a scalar:
`score = 55·success - 15·cost - 20·error - 10·latency`. A scalar is
convenient but loses information. Genetic-algorithm-style evolution
needs a **vector**.

```
Fitness(genome) =
    0.30 · Accuracy
  + 0.20 · Latency
  + 0.15 · Cost
  + 0.15 · ToolSuccess
  + 0.10 · HallucinationRate
  + 0.10 · UserSatisfaction
```

Implementation rule:

- **Default representation:** weighted sum (compatible with the existing
  scalar scorer; just expose the per-component numbers).
- **All six components are persisted** with every candidate, not just
  the aggregate. This is what lets us later switch to Pareto-front
  selection without re-running history.
- **Weights are immutable per Faza.** Changing weights is itself a
  Faza-3 meta change and goes through the contract.

### 2.3 Tree Evolution (not linear v1 → v2 → v3)

The existing spec has a single "champion" branch. Real evolution is a
**tree**:

```
              A  (root, seed)
             / \
            /   \
           B     C        ← divergent mutants preserved
          / \   / \
         D   E F   G     ← niches that turned out useful
              |
              H           ← re-merger / hybrid (see §2.4)
```

Three consequences:

1. **No forced monoculture.** A mutant that is worse on the average
   benchmark but better on a niche (e.g., coding, medical queries)
   **survives**. It becomes the head of a branch, not extinction fodder.
2. **Champion is per-context, not global.** When the user is coding, we
   serve the champion of the Coding species; when researching, the
   Research species. The router selects by query type.
3. **Re-merging is allowed.** Hybrids are first-class operators (see
   §2.4), not a side effect of mutation.

### 2.4 Species (parallel evolutionary lines)

A species is a named lineage with its own:
- fitness function (overlapping but not identical),
- eval suite,
- niche (a query-class or task-class it specializes on),
- active champion,
- archive of retired-but-not-deleted members (re-usable as parents).

Initial species (extensible):

| Species       | Specialization                          | Eval signal                     |
| ------------- | --------------------------------------- | ------------------------------- |
| `research`    | Long-form retrieval, synthesis, citation | Personal research tasks         |
| `coding`      | Tool use, code generation, debugging    | SWE-bench subset + personal code |
| `creative`    | Style-conditioned generation            | Style-adherence + acceptance     |
| `medical`     | Triage-style question answering         | MedQA subset + personal health  |
| `music`       | Composition / lyric work                | Personal music prompts          |

Species are **not silos**. Hybrids (genomes produced by crossover across
species) are a regular product of the mutation stage. Hybrids that
underperform both parents are extinguished; hybrids that beat at least
one parent on a metric become a new branch under the dominant parent's
species with a `hybrid_of` provenance field.

### 2.5 Evolution Budget (resource constraints)

The engine must not be allowed to consume unbounded resources. Each
dream cycle has a budget that gates every phase:

| Resource           | Default cap (per cycle) | Source of truth          |
| ------------------ | ----------------------- | ------------------------ |
| Wall-clock         | 30 min                  | User setting             |
| CPU                | 50 % of one core        | OS + user setting        |
| RAM                | 2 GB                    | User setting             |
| Tokens (local LLM) | 100 k                   | Token-meter counter      |
| Energy (best-eff.) | measured, not capped    | RAPL / battery report    |
| Disk I/O           | 5 GB written            | Engine self-reports      |

Hard rule: **no phase begins if its estimated cost would exceed the
remaining budget.** If a phase is skipped for budget reasons, it is
logged in the Evolution Journal with the reason and the cycle continues
without it (degraded but observable). The user sees budget burn in the
UI per cycle.

### 2.6 Knowledge Provenance (Git for intelligence)

Every artifact Cinderpaw produces has a parent:

```
LoRA v8
   ↓ derived from
LoRA v5
   ↓ derived from
LoRA v3
   ↓ derived from
Base Gemma
```

Same for code (`Planner v4 → Planner v2 → Planner v1`), config, eval
suites, and even personal eval tasks. This is **queryable**:

```
provenance.show("LoRA-v8") →
  ["LoRA-v5", "LoRA-v3", "base-gemma-9b"]

provenance.descendants("base-gemma-9b") →
  ["LoRA-v1", "LoRA-v3", "LoRA-v5", "LoRA-v7", "LoRA-v8"]
```

Implementation: a queryable graph layer over git history (the existing
audit log) plus a small typed envelope for non-code artifacts (LoRA
metadata, demo metadata, eval tasks). The graph is append-only and
hash-chained — tampering breaks the chain.

### 2.7 Confidence (statistical significance, not just "looks better")

A candidate is not promoted on a single better score. It must clear a
**confidence gate**:

```
Accept iff:
  Δfitness > 0                            AND
  p_value(Δfitness > 0) < 0.05            AND   ← paired bootstrap
  effect_size > 0.1                       AND   ← Cohen's d on the vector
  confidence >= 0.95                      AND   ← from above
  Tier 0 floor intact                     AND
  no regression on Tier 1
```

Two examples from the source material:

| Case                           | Fitness Δ | Confidence | Decision |
| ------------------------------ | --------- | ---------- | -------- |
| LoRA candidate A               | +0.3 %    | 98 %       | **Promote** |
| LoRA candidate B               | +0.1 %    | 42 %       | **Reject** |

A noisy +0.1 % is noise, not improvement. The confidence gate is what
makes the engine survive thousands of cycles without regressing by
accumulating random walk.

### 2.8 Dream Cycles (the orchestration loop)

The dream cycle is the **only** path through which a change reaches
live. It is a 7-stage state machine, observable, with explicit I/O at
each stage:

```
        ┌──────────┐
        │   Wake   │  ← engine resumes from sleep / schedule
        └─────┬────┘
              ▼
        ┌──────────┐
        │ Observe  │  ← collect telemetry, demos, acceptance signals
        └─────┬────┘
              ▼
        ┌──────────┐
        │   Dream  │  ← propose candidates (mutation, crossover, hybrid)
        └─────┬────┘
              ▼
        ┌──────────┐
        │  Mutate  │  ← apply proposal to sandbox
        └─────┬────┘
              ▼
        ┌──────────┐
        │ Evaluate │  ← run contract (§2.1) on the candidate
        └─────┬────┘
              ▼
        ┌──────────┐
        │ Remember │  ← persist to Evolution Journal + provenance graph
        └─────┬────┘
              ▼
        ┌──────────┐
        │   Wake   │  ← loop, or sleep until next trigger
        └──────────┘
```

Rules:

- Every stage writes its start/end to the Journal.
- A stage that fails does **not** abort the cycle silently — it writes
  the failure reason and the cycle continues to Remember with a
  `no-change` outcome.
- Triggers (Wake events): schedule (weekly default), threshold (N demos
  accumulated), user-initiated, budget-available.

### 2.9 Evolution Journal (the lab notebook)

Every cycle writes to a structured journal:

```yaml
date: 2026-07-14
cycle_id: c-2026-07-14-001
duration_min: 27

observed:
  - "Tool X failed 14% of the time on coding tasks"
  - "User accepted 92% of research answers this week"
  - "Latency on planning step regressed by 8%"

hypothesized:
  - "Planner depth = 2 is too low for multi-step tool chains"

experimented:
  candidate_id: cfg-2026-07-14-c-014
  change: "decompositionDepth: 2 → 4"

result:
  fitness_vector: [+0.018, -0.040, +0.005, +0.022, -0.001, +0.012]
  aggregate: +0.0034
  confidence: 0.41
  tier0: passed
  tier1: no_regression

decided:
  action: reject
  reason: "confidence below gate; Δ within noise"
  next_step: "Increase sample size; rerun on 200-task subset"

budget_remaining:
  wall_clock_min: 3
  tokens: 18000
```

This is **the audit trail the user reads**. It is also the dataset for
the meta-evolution layer (Layer 5) to learn from. Format: append-only
JSONL (`~/.feral/instances/<tenant>/journal/<yyyy-mm-dd>.jsonl`).

### 2.10 Personal Fitness Function (per-user signal)

This is the differentiator from Sakana-style global-capability
optimization. The fitness vector's `UserSatisfaction` component (and,
in time, the weights themselves) is derived from this user's signals:

| Signal                       | Source                                 |
| ---------------------------- | -------------------------------------- |
| Acceptance of agent message  | `episodic.ts` acceptance events        |
| Tool-call acceptance         | Tool registry audit                    |
| Workflow completion          | UIA demo pipeline + replay success     |
| Memory reuse                 | `recall.ts` hit/miss + re-use count    |
| Preference alignment         | Style / tone / verbosity settings      |
| Edit-after-accept            | User edits → correction signal         |

Personal Fitness is not static. It is the **rolling window** of the
last N accepted interactions, weighted by recency. The user can see it
in the UI; the user can pin weights (turning it back into static for a
period).

**This is what makes BRSI personal.** Without it, we are just running
Sakana at home.

---

## 3. Sakana Influence & Differentiation

### 3.1 What we adopt

| Sakana idea                                | How Cinderpaw adopts it                              |
| ------------------------------------------ | ------------------------------------------------ |
| Evolution > manual design                  | Mutation / selection / crossover is the default mode |
| Population, not singleton                  | Tree of species + niches, not one champion       |
| Benchmark as ground truth                  | Tier 0 / Tier 1 / personal suite as ground truth |
| Open lineage / lineage-as-audit             | Provenance graph (§2.6) is a first-class artifact |
| Transparent publication of negative results | Journal (§2.9) includes rejects and reasons       |

### 3.2 What we adapt (do not copy blindly)

Sakana optimizes **global capability**. Cinderpaw optimizes **personal
usefulness**. The difference is not cosmetic — it changes the fitness
function, the eval suite composition, and the success metric. We
adopt the *mechanism* (evolutionary search) but reject the *objective*
(SWE-bench).

### 3.3 What we explicitly refuse

- **Open-ended evolution from day one.** Sakana can afford the compute
  burn; Cinderpaw cannot. We promote layer-by-layer (Layer 0 first,
  Layer 5 last) with hard gates between. The user sees what the agent
  is allowed to touch.
- **Modification of the immutable core.** Scorer, Tier 0 specs,
  SandboxBounds are off-limits to any evolutionary layer. This is a
  Constitutional-style anchor (Anthropic Constitutional AI parallel).
- **Hidden evolution.** Every cycle is journaled. No silent
  improvements; no auto-applied model changes. The user is always
  able to ask "what did you change and why?"

---

## 4. Implementation Implications

Each concept in §2 has a concrete code shape. This is the **bridge**
between the conceptual spec and the implementation companions. None of
the items below are net-new subsystems; they are extensions or
reframings of what is already in `rsi-evolution-spec.md` or
`continual-personal-adaptation-plan.md`.

### 4.1 Evolution Contract → state machine in `dream-cycle.ts`

- New file: `CinderpawAgent/src/rsi/contract.ts` — the 8-stage state machine.
- Each stage is a function `(state) → Result<state, StageError>`.
- A failed stage writes a `JournalEntry` with `outcome: "halted"` and
  the reason; the cycle ends.
- Wired into the existing dream-scheduler as the **only** path to
  `rsi_commit_*` bridge calls.

### 4.2 Fitness Vector → extend the scorer

- New file: `CinderpawAgent/src/rsi/fitness.ts` — the 6-component vector,
  default weights, and aggregation.
- Rust-side scorer (`scorer.rs`) returns a `FitnessVector` struct, not
  a scalar. Scalar aggregation is opt-in (compute on demand).
- Persist all six components per candidate in the existing eval results
  store.

### 4.3 Tree Evolution → lineage data structure

- New file: `CinderpawAgent/src/rsi/lineage.ts` — `LineageNode`,
  `LineageTree`, operations: `add_child`, `merge`, `extinguish`.
- Champion selection is now `select_champion(species, query_context)`,
  not "the best score overall".
- The existing NEAT-speciation code becomes the niche-assignment
  subroutine; the *tree* is the new layer above it.

### 4.4 Species → first-class registry

- New file: `CinderpawAgent/src/rsi/species.ts` — `Species` type,
  `SpeciesRegistry`, per-species `EvalSuite`, `MutationPolicy`.
- Initial species seeded from `defaults/species.toml`.
- New species are themselves a meta-evolution operation (Layer 5).

### 4.5 Evolution Budget → controller

- New file: `CinderpawAgent/src/rsi/budget.ts` — `Budget` type,
  `BudgetController`, `assert_can_spend(phase, estimate)`.
- Surfaced in UI as a per-cycle burn-down indicator.
- Hard-coded defaults in §2.5 are the **v1 defaults**; user overrides
  via settings UI; both persisted in `SandboxBounds` (immutable from
  the agent's side).

### 4.6 Knowledge Provenance → queryable graph

- New file: `CinderpawAgent/src/rsi/provenance.ts` — `ProvenanceGraph`,
  `show(artifact_id)`, `descendants(artifact_id)`.
- Built on top of git history for code/config; typed envelopes for
  LoRA / demo / eval-task / dream-cycle artifacts.
- Append-only; hash-chained; integrity-checked at startup.

### 4.7 Confidence → statistical gate

- New file: `CinderpawAgent/src/rsi/confidence.ts` — paired bootstrap,
  Cohen's d, gate evaluator.
- Threshold defaults (gate: p < 0.05, effect > 0.1) are part of
  `SandboxBounds` and immutable from the agent's side.
- Wired into `Evaluate` stage; reject reason is `"below_confidence_gate"`
  when it fires.

### 4.8 Dream Cycle → explicit 7-stage orchestration

- Existing `dream-scheduler.ts` is renamed/reframed to `dream-cycle.ts`
  with the 7 stages explicit. State transitions are observable via
  `fractal_activity` event kind `cycle_stage` (new variant).
- Triggers: schedule, threshold (N demos), user-initiated,
  budget-available — all selectable in UI.

### 4.9 Evolution Journal → structured log

- New file: `CinderpawAgent/src/rsi/journal.ts` — append-only JSONL writer,
  per-day file rotation, integrity check.
- Path: `~/.feral/instances/<tenant>/journal/<yyyy-mm-dd>.jsonl`.
- UI: journal viewer with filters (cycle / species / rejected-only).
- This is **the data source** for Layer 5 meta-evolution.

### 4.10 Personal Fitness → signal collector

- New file: `CinderpawAgent/src/rsi/personal-fitness.ts` — rolling-window
  aggregator over acceptance / completion / reuse signals.
- Reads from `episodic.ts`, tool audit log, UIA demo replay success.
- User can pin weights via settings UI (turns aggregation static).
- Surfaces as the `UserSatisfaction` component of the fitness vector.

---

## 5. Seven-Layer Roadmap (re-read under BRSI)

> **Note (2026-06-30):** The original spec described six layers
> (L0-L5), with L5 as "Meta Evolution". That single layer conflated
> two activities with very different safety profiles — tuning
> parameters vs optimising the algorithm that produces them. ADR-0002
> split L5 into:
>
> - **L5 Governance Evolution** — tunes confidence thresholds,
>   fitness weights, mutation rates, budget caps within
>   SandboxBounds. Reversible by restoring the previous bounds.
> - **L6 Meta Evolution** — optimises the algorithm that produces
>   those parameters. Genuine RSI. Always human-gated.
>
> Read ADR-0002 for the rationale. The DAG in §10 shows the runtime
> structure; the layers here are the **autonomy scale** the user
> sees and the gate that governs each promotion.

The layer ordering is unchanged from `continual-personal-adaptation-plan.md`
for L0-L4. What is new is **the lens**: each layer is now a stage in
the Evolution Contract, scored by the Fitness Vector, gated by
Confidence, journaled, and budgeted.

| Layer | Name                              | BRSI lens                                                                            | Default auto-apply? |
| ----- | --------------------------------- | ------------------------------------------------------------------------------------ | ------------------- |
| L0    | Memory Adaptation                 | No weights touched. Only memory topology. Lowest-risk layer.                         | Yes                 |
| L1    | Configuration Evolution           | Genome config (7 fields). Bounded by schema. First layer with eval-gated promotion.  | Yes                 |
| L2    | Continual Personal Adaptation     | LoRA on user signal. Base model immutable. Personal Fitness becomes the promotion gate. | Yes, after N demos |
| L3    | Code Evolution                    | First layer that touches CinderpawAgent source. First-10 human gate.                     | First 10 require approval |
| L4    | Architecture Evolution            | Subsystem hot-plug in Worker sandbox. Resource caps hard. Always human gate.          | No                  |
| L5    | **Governance Evolution** (NEW)    | Tunes confidence thresholds, fitness weights, mutation rates, budget caps within SandboxBounds. Reversible by restoring previous bounds. | Yes, within bounds |
| L6    | **Meta Evolution** (renamed)      | Optimises the algorithm that produces those parameters. **Always human gate.**        | No                  |

Promotion gate between layers (must hold):

```
promote L_i → L_{i+1} iff:
  - L_i has been live for >= N dream cycles without rollback
  - audit log shows >= M successful ratchets
  - Tier 0 invariant intact throughout
  - user has explicitly enabled L_{i+1} in settings
```

Defaults: `N = 5`, `M = 10` for L0→L1, L1→L2, L2→L3, L3→L4, L4→L5.
**Stricter for L5→L6**: `N = 10`, `M = 30` — entering Meta Evolution
is a deliberate, well-evidenced commitment. Both user-tunable.

---

## 6. Research Hypotheses

These are the claims this work is willing to be measured against. They
are the difference between "a project that demos well" and "a research
contribution".

**H1 — Bounded beats open-ended on personal tasks.**
A bounded, layer-promotion-gated evolution reaches a higher Personal
Fitness plateau in less wall-clock than an open-ended search starting
from the same seed, on the same user's workflow, over the same budget.
*Measurable:* personal eval suite score vs. budget burn, head-to-head
on the same user.

**H2 — Local + personal can match cloud + generic on a specific user.**
A local small model (Gemma 9B class) with Personal LoRA + memory
adaptation + config evolution reaches user-parity with a large cloud
model on the user's own task distribution within a defined horizon
(8-12 weeks of normal use).
*Measurable:* paired acceptance study, blind.

**H3 — Tree lineages preserve more useful diversity than linear ratchets.**
After N dream cycles, the tree-structured species archive retains
strictly more niche-useful genomes than a single-champion linear
ratchet, measured by per-niche fitness.
*Measurable:* count of niches with a champion within ε of the
historical best; the linear baseline loses niches over time.

**H4 — Confidence gating reduces regression events.**
Promotion with the confidence gate reduces observed regressions (Tier
0 or Tier 1 break, or live agent crash) by ≥ X % compared to the
existing "score > best" promotion, over the same number of cycles.
*Measurable:* regression count per 100 cycles.

**H5 — Per-instance divergence does not regress the Tier 0 floor.**
After N cycles, the Tier 0 invariant (the 1255-test suite) holds for
every promoted candidate in every lineage, with no human intervention.
*Measurable:* continuous; an invariant violation is a publishable
incident.

A negative result on any of these is publishable. The spec does not
pre-commit to all of them being true.

---

## 7. Design Principles (the hard constraints)

These are inherited from `rsi-evolution-spec.md` §4 and tightened:

1. **Every change must be benchmarked.** No skip. No "small change,
   we'll check next cycle".
2. **Rollback must always be possible.** < 5 s revert time for any
   change. Provenance graph must support `revert_to(checkpoint)`.
3. **Improvements must be incremental and bounded.** See resource caps
   (§2.5), per-cycle budget, per-Layer promotion gates (§5).
4. **The user defines autonomy boundaries.** Settings UI exposes every
   cap. The agent cannot widen its own permissions.
5. **Personal adaptation is a first-class objective.** Personal Fitness
   has a real weight in the vector; the personal eval suite is a real
   promotion gate; per-instance divergence is real.
6. **Diversity is preserved.** Tree evolution (§2.3), species
   archives, and a minimum-niche-count invariant per cycle.
7. **Budgets are enforced.** No phase begins if its estimated cost
   exceeds the remaining budget (§2.5).
8. **The Journal is honest.** Failed stages, rejected candidates,
   budget skips, and halted cycles are written with the same
   fidelity as successes.

---

## 8. Success Metrics

### 8.1 Per-Layer

| Layer | Definition of done                                                              |
| ----- | ------------------------------------------------------------------------------- |
| L0    | Fractal bench gate cleared; first memory-evolved candidate promoted.            |
| L1    | Engine runs end-to-end on Tier 0; first config ratchet observed in `dream.jsonl`.|
| L2    | One LoRA trained on real demos, promoted via personal suite + Tier 0 floor.    |
| L3    | First code patch proposed by the agent passes tests, lint, build, benchmark.   |
| L4    | One new subsystem (e.g., graph memory) introduced end-to-end with rollback.    |
| L5    | One meta-patch (e.g., selection pressure) improves convergence speed.           |

### 8.2 Per-Concept

| Concept                  | Metric                                                  |
| ------------------------ | ------------------------------------------------------- |
| Evolution Contract       | % of attempted promotions that traverse all 8 stages    |
| Fitness Vector           | % of cycles where all 6 components are persisted        |
| Tree Evolution           | Niche count retained vs. linear baseline                |
| Species                  | # of species active; # of successful hybrids            |
| Evolution Budget         | % of cycles that hit budget cap; UI burn-down accuracy  |
| Knowledge Provenance     | Query latency on `provenance.show(id)`; integrity-check pass rate |
| Confidence               | Promotion / rejection ratio; regression count / 100 cycles |
| Dream Cycle              | Stage observability: % of cycles with all 7 stages journaled |
| Evolution Journal        | % of cycles journaled; UI-readable; meta-evolution uses it |
| Personal Fitness         | Δ acceptance rate; Δ workflow completion vs. cloud baseline |

### 8.3 System-wide

- **Tier 0 invariant holds** for every promoted candidate in every
  lineage, continuously. Violation = publishable incident.
- **Rollback time** < 5 s for any change at any layer.
- **User-trust survey** (qualitative, periodic): does the user feel
  they understand what Cinderpaw changed and why?

---

## 9. Open Decisions (lock before any code lands)

Defaults are sensible but reversible until anything ships. Each item
should be answered explicitly by the user.

1. **Fitness weights** — are §2.2's defaults the v1 weights, or do we
   learn the weights from data first? Default: ship with the
   defaults, learn from Journal after 30 cycles.
2. **Initial species list** — §2.4 lists five. Is that the v1 set, or
   do we ship with two (`research`, `coding`) and let the engine
   propose more? Default: ship with two; let meta-evolution propose.
3. **Budget defaults** — §2.5 lists 30-min wall-clock / 100 k tokens /
   50 % CPU / 2 GB RAM. Tunable in settings UI from day one. Default
   for power users: 120 min / 500 k tokens. Confirm.
4. **Confidence thresholds** — p < 0.05 + effect > 0.1 + confidence
   ≥ 0.95. Tight or loose? Default: as stated.
5. **Promotion gate defaults** — N=5 cycles, M=10 ratchets. Default:
   as stated.
6. **Personal Fitness signal sources** — full list in §2.10, or
   subset for v1? Default: acceptance + tool-call acceptance +
   workflow completion; add the rest after v1 ships.
7. **Tree-evolution archive size** — how many retired champions per
   species do we keep? Default: 20 per species, age-out by LRU.
8. **Hybrid operator** — implemented at the same time as species, or
   deferred? Default: implemented with species (it is what makes
   species meaningful).
9. **Journal format** — JSONL or YAML? Default: JSONL (one row per
   cycle; readable; appendable; version-controllable).
10. **Provenance graph storage** — git-only, or separate DB? Default:
    git for code/config; typed envelope + small SQLite for
    LoRA/demo/eval artifacts. Cross-referenced by hash.
11. **Confidence-gate failures** — do they appear in the UI as
    "rejected" with reason, or only in the Journal? Default: both
    (UI surfaces recent rejections; Journal has everything).
12. **Dream cycle trigger default** — weekly, daily, or
    threshold-based? Default: weekly + threshold (N=20 demos),
    whichever first.

---

## 10. Architecture DAG (Layers for Engineering)

> Layers (above) describe the **autonomy scale** — what the engine
> is allowed to do, and at what scrutiny. The DAG below describes
> **what the engine actually is** — the dependency graph that
> engineers refactor against. Both views are useful; both live
> in this spec (see ADR-0008).

The runtime is not a layered cake. Cross-cutting concerns (Budget,
Confidence, Provenance, Journal) are peers of the layer-named
components, not "between" them. Refactors are scoped against the
DAG, not the layers.

```
                     ┌──────────┐
                     │ Sandbox- │
                     │  Bounds  │  (Rust, immutable from agent)
                     └────┬─────┘
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
        ▼                 ▼                 ▼
  ┌──────────┐      ┌──────────┐      ┌──────────┐
  │ Scorer   │      │  Tier 0  │      │  Budget  │
  │  (Rust)  │      │  (Rust)  │      │  (TS)    │
  └────┬─────┘      └────┬─────┘      └────┬─────┘
       │                 │                 │
       └────────┬────────┴────────┬────────┘
                │                 │
                ▼                 ▼
          ┌──────────┐      ┌──────────┐
          │ Fitness  │      │ Personal │
          │  Vector  │      │  Fitness │
          └────┬─────┘      └────┬─────┘
               │                 │
        ┌──────┴─────┐           │
        │            │           │
        ▼            ▼           ▼
   ┌──────────┐  ┌──────────┐  ┌──────────┐
   │Confidence│  │  Journal │  │  Audit   │
   │   Gate   │  │   (TS)   │  │  (Rust)  │
   └────┬─────┘  └────┬─────┘  └──────────┘
        │             │
        └──────┬──────┘
               │
               ▼
        ┌──────────────┐
        │   Ratchet    │  (ratchet-handler.ts + repo.rs)
        │   Handler    │
        └──────┬───────┘
               │
               ▼
        ┌──────────────┐
        │  Provenance  │  (read-side graph over git)
        │    Graph     │
        └──────┬───────┘
               │
        ┌──────┴───────┐
        ▼              ▼
  ┌──────────┐   ┌──────────────┐
  │ Champion │   │   Contract   │  (Opus territory)
  │   Tree   │   │   FSM        │
  └────┬─────┘   └──────┬───────┘
       │                │
       ▼                ▼
  ┌──────────┐   ┌──────────────┐
  │ Species  │   │  Dream Cycle │  (Opus territory)
  │ Registry │   │  (7-stage)   │
  └────┬─────┘   └──────┬───────┘
       │                │
       └────────┬───────┘
                ▼
         ┌──────────────┐
         │ Personal LoRA│  (Layer 2+; trains within SandboxBounds)
         └──────────────┘
```

### 10.1 Reading the DAG

**Upward arrows are "depends on".** The Ratchet Handler depends on
the Confidence Gate (pre-check) and the Journal (post-write). The
Champion Tree depends on the Provenance Graph (parent/child
queries). The Contract FSM depends on Budget, Confidence, Fitness,
and Journal.

**Cross-cutting concerns are explicitly peers.** Budget, Confidence,
Fitness, and Journal sit at the same "level" as the layer-named
components because they are not "between" any layers — they are
called from the Contract FSM, the Ratchet Handler, and the Engine
Composition Root as peers.

**Rust / TS asymmetry.** SandboxBounds, Scorer, Tier 0, and Audit
are Rust — agent-immutable per ADR-0007. Everything below them is
TypeScript. The boundary is the trust boundary (INVARIANTS I7, I8,
I9).

### 10.2 Refactoring against the DAG

When you change a node, you change its upstream dependents. Adding
a new event to the Journal schema requires updating the Contract
FSM (writes), the Dashboard (reads), the Metrics (aggregates).
Adding a new species requires updating the Provenance Graph (parent
queries), the Champion Tree (selection), the Budget (per-species
caps).

The DAG makes refactor scope explicit. Layers do not.

---

## 11. References

### Internal (companion specs)

- `docs/rsi-evolution-spec.md` — Faza 1-5 engine internals (config /
  code / meta / arch / model). Authoritative for engine internals.
- `docs/continual-personal-adaptation-plan.md` — 6-layer roadmap +
  three missing axes (UIA demo pipeline, Personal LoRA, per-instance
  divergence).
- `docs/rsi-e2e.md` — end-to-end test plan for the engine.
- `docs/agents-memory/project_fractal_activity_pulses.md` — Layer 0
  wiring contract.
- `docs/agents-memory/reference_windows_vulkan_build.md` — GPU/LLM
  build recipe (needed for any LoRA training path).
- `docs/agents-memory/project_local_models_gpu.md` — local model
  landscape + embedder knobs.
- `PLAN.md` — Partea B (the strategic flagship wedge: UIA workflow
  learning + on-device LoRA).
- `HANDOFF.md` — current RSI Faza 1 work in flight.

### External

- **Sakana AI — Darwin Gödel Machine (2025).** Open-ended evolution of
  self-improving coding agents. Source of the population / benchmark /
  lineage-archive ideas. Reference for *what not to copy blindly*.
- **Sakana AI — LLM-Squared / DiscoPOP (2024).** LLMs invent better
  ways to train LLMs. Conceptual precursor to Layer 5.
- **Sakana AI — Responsible RSI (2026).** Publication discipline,
  including negative results. Model for §2.9.
- **Anthropic — "When AI Builds Itself" (2026).** 80 % AI-written code
  in a semi-autonomous R&D loop. Architecture reference for Layers 3-5.
- **Anthropic — Constitutional AI.** Immutable principles that
  constrain self-modification. Reference for the immutable core.
- **Yudkowsky / Bostrom — Seed AI.** The theoretical target Cinderpaw is
  deliberately **not** aiming at; the bound is the contribution.

---

*End of spec. When Opus resumes, this is the document to internalize
first; the two companions answer "how". This doc answers "what for,
under what rules, against what claims".*