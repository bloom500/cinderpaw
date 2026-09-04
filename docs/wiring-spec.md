# Wiring Spec — Where BRSI Modules Land

> The integration guide for the BRSI modules produced in the opencode
> session (2026-06-30). Each module is pure / isolated today; this
> doc names the EXACT call sites, the EXACT context, and the EXACT
> invariants to keep when wiring them into the existing engine.
>
> **Audience:** Opus, or whoever picks up the wiring next.
> **Status:** Living doc — update as wiring lands.
> **Companion docs:** `docs/brsi-spec.md` (DAG), `docs/invariants.md`,
> `docs/observability-data-model.md`, `docs/adr/`.

---

## 0. Summary table

| Module | File | Wire to | When |
| ------ | ---- | ------- | ---- |
| ~~`confidence.ts`~~ **WIRED 2026-07-01** | `CinderpawAgent/src/rsi/confidence.ts` | `ratchet-handler.ts` (optional `evaluateGate` dep) + live in `sidecar.ts:369` | Before `ratchetAttempt` |
| ~~`journal.ts`~~ **WIRED 2026-07-01 (§2b only)** | `CinderpawAgent/src/rsi/journal.ts` | `dream-cycle.ts` `onEpisodeEnd` (per-episode summary) + live in `index.ts` | On cycle end (per-candidate §2a deferred to Contract FSM) |
| `budget.ts` | `CinderpawAgent/src/rsi/budget.ts` | Contract FSM (new) | Before each contract stage |
| `fitness.ts` | `CinderpawAgent/src/rsi/fitness.ts` | `eval-worker.ts:56` + `ratchet-handler.ts:80` | Lift `ScoreResult` to `FitnessVector` |
| `personal-fitness.ts` | `CinderpawAgent/src/rsi/personal-fitness.ts` | `ratchet-handler.ts:80` (or `engine.ts`) | Compute `userSatisfaction` before compose |
| `provenance.ts` | `CinderpawAgent/src/rsi/provenance.ts` | Frontend (dashboard, journal viewer) | Read-only; no engine wire needed |
| `contract.ts` (NEW) | `CinderpawAgent/src/rsi/contract.ts` | Engine composition root | Type layer shipped; handlers = Opus |
| `instance-paths.ts` (NEW) | `CinderpawAgent/src/rsi/instance-paths.ts` | All path users | `journal.ts` already uses it |

---

## 1. Confidence gate → `ratchet-handler.ts:77`

**Current code (lines 77-90):**

```ts
const result = await this.deps.ratchetAttempt(commitHash, score);

if (result.advanced) {
  await this.bus.emit({
    type: "RatchetAdvanced",
    genomeId,
    commitHash,
    score,
    previousBest: result.previousBest,
    tokenCost: (event.tokenCost as number) ?? 0,
  });
}
```

**Wired:**

```ts
// Build paired samples from eval outcomes (current candidate) +
// previous candidate outcomes (the prior champion).
const samples = buildPairedSamples(event.outcomes, previousCandidateOutcomes);
const decision = this.deps.evaluateGate(samples);

if (!decision.accept) {
  // INVARIANT I6: confidence gate precedence enforced.
  // Do NOT call ratchetAttempt. Emit ConfidenceFailed and write journal.
  this.deps.writeJournal(makeJournalEntry({ ... decision, action: "reject" }));
  await this.bus.emit({
    type: "ConfidenceFailed",
    genomeId,
    reason: decision.reason,
    bootstrap: decision.bootstrap,
  });
  return;
}

// Only on accept: commit and try to ratchet.
const result = await this.deps.ratchetAttempt(commitHash, score);
if (result.advanced) {
  // ... existing emit ...
  this.deps.writeJournal(makeJournalEntry({ ... decision, action: "accept" }));
}
```

**Required changes:**

1. Inject into `RatchetDeps`:
   - `evaluateGate: (samples: readonly PairedSample[]) => GateDecision`
   - `writeJournal: (entry: JournalEntry) => void`
   - `buildPairedSamples: (current, previous) => PairedSample[]`
2. Thread outcomes through `EvalComplete` — see §6 below.
3. Store previous champion's outcomes for paired comparison.

**Invariant coverage:** I6 (confidence gate precedence).

> **As-built (2026-07-01) — diverged from the sketch above, simpler:**
> - `RatchetDeps` gained ONE optional field: `evaluateGate?: (samples) => GateDecision`.
>   Absent → Faza 1 behaviour (Rust strict-greater alone). Existing call
>   sites/tests compile unchanged.
> - The champion baseline is cached **inside** `RatchetHandler`
>   (`lastChampionOutcomes`, set only when main advances) instead of
>   injecting a `previousCandidateOutcomes` source. No `PopulationManager`
>   schema change, no snapshot version bump. Not persisted across restarts
>   in v1 — a fresh process re-bootstraps its baseline on the first ratchet.
> - `buildPairedSamples(candidate, baseline)` is an **exported pure
>   function** in `ratchet-handler.ts` (matched by `taskId`, per-task
>   score = `success ? 1 : 0`), not an injected dep.
> - Full `EvalOutcome[]` now rides on `EvalComplete.outcomes` (additive).
> - Live in prod at `sidecar.ts:369` with `evaluateGate`'s strict locked
>   defaults. `writeJournal` is NOT wired here yet — that is §2 below (next).
> - Tests: `tests/rsi-ratchet-with-confidence.test.ts` (reject/accept/
>   bootstrap/no-gate paths + `buildPairedSamples`).

---

## 2. Journal writer → two sites

### 2a. `ratchet-handler.ts:80` (on `RatchetAdvanced` and `ConfidenceFailed`)

```ts
this.deps.writeJournal({
  cycleId: this.currentCycleId(),    // new state on RatchetHandler
  timestamp: Date.now(),
  durationMin: ...,
  observed: [...gatherFromTelemetry()],
  hypothesized: [...gatherFromLastCycleHypotheses()],
  experimented: {
    candidateId: genomeId,
    change: this.describeChange(genomeId),
    layer: "L1", // or read from genome
  },
  result: {
    fitnessVector: this.fitnessFor(genomeId),
    aggregate: ...,
    confidence: decision.bootstrap.pValue ? 1 - decision.bootstrap.pValue : undefined,
    tier0: tier0From(evalOutcomes),
    tier1: tier1From(evalOutcomes),
  },
  decided: decision.accept
    ? { action: "accept", reason: decision.reason }
    : { action: "reject", reason: decision.reason, nextStep: "increase samples" },
  budgetRemaining: this.budgetSnapshot(),
});
```

### 2b. `dream-cycle.ts:71` (cycle-end summary)

Today:
```ts
appendDreamTelemetry(telemetryPath, { ... });
```

Add (alongside, not replacing):
```ts
appendJournal(defaultJournalPath(), makeCycleSummary({
  cycleId: this.currentCycleId(),
  startedAt: currentEpisode.startedAt,
  endedAt: Date.now(),
  durationMin: (Date.now() - currentEpisode.startedAt) / 60_000,
  observed: [...],
  hypothesized: [],
  experimented: null,
  result: null, // cycle-level summary has no per-candidate result
  decided: cycleOutcome === "halt"
    ? { action: "halt", reason: cycleHaltReason, stage: haltStage }
    : { action: "accept", reason: "cycle completed" },
  budgetRemaining: cycleBudgetSnapshot(),
}));
```

**Invariant coverage:** I3 (journal append-only), I4 (corruption observable).

> **As-built (2026-07-01):** only §2b (the per-episode summary) landed.
> `dream-cycle.ts` gained an optional `journalPath?: () => string` dep
> (function, because the file rotates per UTC day) and an exported pure
> `makeCycleSummary(episode, stats, endedAt) → JournalEntry`. Live in
> `index.ts` via `() => defaultJournalPath()`. The row is episode-grained:
> `experimented` / `result` are `null` (an episode spans many candidates);
> `decided` is accept (ratchets>0) / reject (none) / halt (errored run);
> `budgetRemaining` is zeros with a `ponytail:` note until `budget.ts`
> wires in. **§2a (per-candidate journal in the ratchet handler) was
> deliberately NOT done** — per-genome rows are the wrong granularity
> (hundreds/run); the per-candidate row is the Contract FSM's job, where
> one candidate = one journalable decision. Tests: `tests/rsi-dream-journal.test.ts`.

---

## 3. Budget assertion → Contract FSM (Opus: new module)

When the Contract FSM lands (Step 9 of the refactor sequence), each
stage calls `assertBudget(phase, estimate)` BEFORE running:

```ts
const phase = stageToPhase(currentStage);  // e.g., "evaluate" → "evaluate"
const decision = this.deps.assertBudget(phase, stageEstimate);

if (!decision.allow) {
  // INVARIANT I5: halt on explicit-estimate breach.
  return {
    ok: false,
    stage: currentStage,
    reason: decision.reason,
    halt: true,
    recoverable: true, // next cycle, smaller scope
  };
}
```

**Important:** `null` estimate is fail-open (logged), explicit breach
is HALT. The two paths look similar but are different categories
(see INVARIANTS.md I5).

---

## 4. Fitness Vector composition → `eval-worker.ts:56`

**Current code (lines 51-66):**

```ts
try {
  const outcomes = await this.deps.runEval(genome);
  const { score } = await this.deps.scoreGenome(outcomes);

  await this.bus.emit({
    type: "EvalComplete",
    genomeId: genome.id,
    score,
    ...
  });
}
```

**Wired:**

```ts
try {
  const outcomes = await this.deps.runEval(genome);
  const scoreResult = await this.deps.scoreGenome(outcomes);

  // Lift scalar to 6-component vector. Personal Fitness fills
  // userSatisfaction when wired.
  const fitnessVector = scoreToFitnessVector(scoreResult.score, {
    unmeasured: scoreResult.unmeasured ?? ["hallucination", "userSatisfaction"],
  });
  const aggregate = fitnessVectorAggregate(fitnessVector);

  await this.bus.emit({
    type: "EvalComplete",
    genomeId: genome.id,
    score: aggregate,
    fitnessVector,           // new field on RsiEvent
    outcomes,                // new field — required for paired samples (§1)
    ...,
  });
}
```

**Required changes:**

1. `ScoreResult` (TS) gains `unmeasured?: ReadonlyArray<keyof FitnessVector>` (optional, defaults to Hallucination + UserSatisfaction).
2. `RsiEvent` gains `fitnessVector?: FitnessVector` and `outcomes?: EvalOutcome[]`.
3. The `tokenCost` / `durationMs` aggregation stays as-is.

**Invariant coverage:** I11 (FitnessVector aggregate bounded).

---

## 5. Personal Fitness → `ratchet-handler.ts` (or engine composition root)

Where to compute `userSatisfaction` is a small judgement call:

**Option A: in the eval worker.** Compute from the audit log at
`EvalComplete` time. Pros: localised. Cons: the eval worker doesn't
currently know about the audit log; would need to inject an audit
reader.

**Option B: in the ratchet handler.** Compute from the audit log at
`RatchetAdvanced` time. Pros: the ratchet handler already sees the
full event; one place to compose the fitness vector. Cons: another
dependency.

**Recommendation:** Option B. Inject a `computePersonalFitness: () => number`
into `RatchetDeps`, call it inside `ratchet-handler.ts:80` BEFORE
composing the fitness vector, fold its result into
`fitnessVector.userSatisfaction`.

```ts
const userSatisfaction = this.deps.computePersonalFitness();
const fitnessVector = {
  ...scoreToFitnessVector(score, { unmeasured: ["hallucination"] }),
  userSatisfaction,
};
```

**Invariant coverage:** I10 (Personal Fitness bounded), I13 (per-
instance data isolation once divergence lands).

---

## 6. Threading `EvalOutcome[]` through `EvalComplete`

Today's `EvalComplete` event (in `eval-worker.ts:60-66`) emits the
score but NOT the outcomes. The confidence gate (§1) needs paired
samples — current outcomes + previous champion outcomes. That
requires both:

1. `EvalComplete` carries `outcomes: EvalOutcome[]`.
2. The previous champion's outcomes are stored somewhere (population
   manager? a dedicated cache?).

**Suggested cache:** add `lastChampionOutcomes?: EvalOutcome[]` to
`PopulationManager` (or a new `RsiState` struct). When the ratchet
advances, the new champion's outcomes are written here; the next
candidate's `EvalComplete` reads them for the paired comparison.

This is a small schema change. Document in an ADR if it touches the
git substrate (`IterationMetadata`).

---

## 7. Provenance graph → frontend (no engine wire)

`CinderpawAgent/src/rsi/provenance.ts` is a read-only module over the git
substrate. Wiring happens in the frontend:

```ts
// frontend-react/src/lib/tauri/provenance.ts
import { invoke } from "@tauri-apps/api/core";
const log = await invoke("rsi_log", { max: 10_000 });
// Build the in-memory graph client-side, or expose as a Tauri command.
```

The dashboard, journal viewer, and lineage inspector all subscribe to
this. **No engine-side changes.**

**Invariant coverage:** I12 (provenance graph acyclic — already enforced
by git substrate).

---

## 8. Contract FSM → engine composition root

`CinderpawAgent/src/rsi/contract.ts` ships the **type layer** only:

- `STAGE_ORDER` (9 stages)
- `ContractState` (the data object)
- `StageResult` (the discriminated union)
- `ContractDeps` (the runner's needs)
- `makeInitialState` (helper)

The runner and stage handlers are Opus's work. Wire-up looks like:

```ts
// engine.ts (Opus's territory)
import { runContract, type ContractDeps } from "./contract.ts";

const contractDeps: ContractDeps = {
  staticAnalysis: stageStaticAnalysis(deps),
  sandboxApply: stageSandboxApply(deps),
  tests: stageTests(deps),
  benchmark: stageBenchmark(deps),
  safetyChecks: stageSafetyChecks(deps),
  regression: stageRegression(deps),
  deploy: stageDeploy(deps),
  monitoring: stageMonitoring(deps),
  assertBudget: deps.assertBudget,
  evaluateConfidence: deps.evaluateConfidence,
  writeJournal: deps.writeJournal,
};

// When a candidate arrives (e.g., from selection-handler):
const initial = makeInitialState({ cycleId, candidateId, layer, ... });
const final = await runContract(initial, contractDeps);
```

**Invariant coverage:** I1 (ratchet strict-greater), I5 (budget halt),
I6 (confidence precedence).

> **As-built (2026-07-01) — runner + handlers + composition root LANDED,
> live threading GATED:**
> - `contract-runner.ts` (`runContract`) + `contract-stages.ts` (8 `StageFn`
>   factories over `StageHandlerDeps`) + `contract-deps.ts`
>   (`contractDepsFrom(stage, opts)`) all shipped, green (`rsi-contract-*.test.ts`).
> - `contractDepsFrom` binds the live engine-half (`evaluateGate` I6,
>   `appendJournal` I3/I4, `assertCanSpend` I5). The `StageHandlerDeps` LEAVES
>   stay injectable — NOT yet wired to real eval/bridge/ratchet.
> - **Why the leaves aren't live (Faza-1 reality):** re-audited each stage's
>   primitive. static_analysis=grammar (TS ✓), sandbox_apply=`rsi_commit_genome`
>   (✓, but for a config genome this is just a commit), tests=tier0 (✓),
>   benchmark=eval+`rsi_score` (✓), safety_checks=SandboxBounds (✓),
>   deploy=`rsi_ratchet_attempt` (✓) — BUT **regression=`goodhart.rs` is DORMANT
>   until Faza 4.5** (Tier 2 eval suite empty → `tier2_delta:None` → detector
>   skips every sample), and **monitor has no meaning for a config genome** (no
>   deployed service to health-check).
> - So wiring the leaves + threading a candidate from `selection-handler` into
>   `runContract` (the "live" step) would put ~2 structural no-ops on the
>   HARD-invariant ratchet path AND write per-candidate Journal rows —
>   explicitly the wrong granularity for config ("hundreds/run", §2 above; the
>   per-candidate row is right for **code** candidates, Faza 2). Deferred until
>   the Faza-2 (code candidates) / Faza-4.5 (Tier 2) substrate exists. The FSM
>   is complete and ready; it just has nothing real to drive in Faza 1.

---

## 9. New event kinds on `event-bus.ts`

Currently `RsiEventType` has 9 members. The wiring adds:

- ~~`EvalHalted`~~ **LANDED 2026-07-01** — added to `RsiEventType` per ADR-0011; the bus throws on a reason-less `EvalHalted` at emit time (INVARIANT I15 runtime guard). Emitter (Contract FSM) still pending.
- `ConfidencePassed` / `ConfidenceFailed` — for the confidence gate verdict.
- `BudgetExceeded` / `BudgetFailOpen` — for the budget gate verdict.
- `MutationCreated` / `MutationRejected` / `MutationApplied` — for the candidate lifecycle.

**Before adding these:** open an ADR per the Evolution Event Schema
(ADR-0004). The schema in `docs/observability-data-model.md` already
defines most of them.

**Front-end impact:** `fractal_activity.kind` is sealed
(`recall | grow | seed | prune`). Adding `cycle_stage` for the new
7-stage Dream Cycle requires updating
`frontend-react/src/lib/tauri/events.ts:87` and
`frontend-react/src/pages/MemoryLayersPage.tsx:139-145` to ignore
the new kind. Cross-stack change.

---

## 10. Per-instance paths → `instance-paths.ts`

Already wired into `journal.ts`. Future call sites:

- `champion.ts:defaultChampionPath()` — should delegate to
  `paths().champion`. (Pre-existing file; defer this refactor to a
  dedicated maintenance pass to keep the diff narrow.)
- New envelope writers (LoRA / demo / eval-task) — use `paths().envelopes`.

The per-instance split (BRSI §3.3) is a one-file change in
`instance-paths.ts` when it lands.

---

## 11. Test scaffolding

When wiring lands, add tests that exercise the integration:

| File | What it asserts |
| ---- | --------------- |
| `tests/rsi-ratchet-with-confidence.test.ts` | Ratchet handler with confidence gate; reject path skips ratchet; journal written. |
| `tests/rsi-engine-with-journal.test.ts` | End-to-end: eval → ratchet → journal row. |
| `tests/rsi-personal-fitness-wired.test.ts` | EvalComplete triggers Personal Fitness computation; userSatisfaction flows into FitnessVector. |
| `tests/rsi-instance-paths-split.test.ts` | After split: distinct tenants get distinct paths. |

For the Contract FSM, the type-layer tests in
`tests/rsi-contract.test.ts` are the foundation; add handler tests
when Opus writes the handlers.

---

## 12. Risks summary

1. **`bridge.ts:54` timeout (30s).** Per `adapters.ts:49`. Faza 2
   LLM-driven mutations may exceed. Per-stage timeouts needed
   before the Code Evolution layer goes live.
2. **`fractal_activity` kind sealed.** Adding `cycle_stage` for the
   new 7-stage Dream Cycle requires FE filter update. See §9.
3. **`eval-worker.ts:67-80` catch block.** Always emits
   `EvalComplete{errored:true, score:0}`. The contract's pre-check
   stage has no entry point that DOESN'T produce an eval. Add
   `EvalHalted` event (§9) OR move pre-check before eval launch
   (recommendation: add `EvalHalted`).
4. **`engine.ts:118-120` silently overwrites `selection.taste`.**
   When wiring taste into contract stages, be aware that an
   explicit `selection.taste` dep is silently dropped if a
   `tasteMiner` is also supplied. Right precedence for production,
   confusing in tests.
5. **`pbt-controller.ts:46` requires `tokenCost: number`.** Future
   regression that forgets to set it produces NaN. Already
   normalised by `ratchet-handler.ts:88` (`?? 0`). Watch for
   upstream callers that bypass this.
6. **`tier-loader.ts:43-77` throws on malformed JSON.** Future
   personal eval suite loader will need its own validator.

---

## 13. Order of operations (recommended)

1. **Read this spec, INVARIANTS.md, brsi-spec §10 (DAG), and the
   relevant ADRs.** (~30 min total.)
2. **Extend `RatchetDeps` and `EvalWorkerDeps` with the new
   fields.** TypeScript-only; no behaviour change. Tests pass.
3. **Wire `confidence.ts` into `ratchet-handler.ts:77`.** See §1.
   First wired module; smallest blast radius.
4. **Wire `journal.ts` into `ratchet-handler.ts:80` and
   `dream-cycle.ts:71`.** See §2. Begin populating the Journal.
5. **Wire `personal-fitness.ts` aggregator.** See §5. The audit
   log reader is injected; the ratchet handler calls it.
6. **Wire `fitness.ts` into `eval-worker.ts:56`.** See §4. Extends
   the `ScoreResult` shape.
7. **Add new event kinds to `event-bus.ts`.** See §9. ADR per new
   kind. Coordinate with FE filter update.
8. **Build the Contract FSM runner + handlers.** §8. Uses
   everything wired in steps 3-7.
9. **Per-instance path split.** Touches `instance-paths.ts`,
   `paths.rs`, `champion.ts`, and every path user. Last step;
   once wired, all earlier modules inherit per-tenant storage.

---

*When this doc's "Wired" column says "Yes", strike through the row
and update the date. When all rows are wired, BRSI is live.*