# Design spec — thread the Evolution Contract FSM into the live engine (BRSI §2.1, §2.9, §2.10)

Status: draft for review. Author: Opus (2026-07-01). Repo root: `D:\FeralLocalAI`.
Companion master spec: `docs/brsi-spec.md` (§2.1 Evolution Contract, §2.2 Fitness
Vector, §2.9 Journal, §2.10 Personal Fitness).

---

## 0. Why this spec exists (the trace that produced it)

While looking for "what comes next after Tree of Champions", the wiring was
traced end to end. The finding that forced this spec:

- The **live** per-candidate path is `RatchetHandler.onEvalComplete`
  (`FeralAgent/src/rsi/ratchet-handler.ts:113`): on each `EvalComplete` it does
  `commitGenome` → `tier0FloorBreach` → confidence gate (I6) → `ratchetAttempt`
  → emits `RatchetAdvanced`. This is hand-rolled; it does **not** use the
  Contract FSM.
- The **Contract FSM** (`runContract`, `contract-runner.ts:98`) is complete and
  pure — 8 stages, I5/I6, one Journal row per candidate, a `FitnessVector`
  result — but has **no production caller**. `contractDepsFrom`
  (`contract-deps.ts:64`) and `runContract` are referenced only by tests.
- `scoreToFitnessVector` / `fitnessVector` (`fitness.ts:96,132`) — the **only**
  functions that ever set `userSatisfaction` — have **no production caller**.
- `computePersonalFitness` + its adapters (`personal-fitness.ts:93,124,144`)
  are a **pure island** — tests, no engine consumer.
- The live Journal writer is `makeCycleSummary` (`dream-cycle.ts:178`); it emits
  **episode-grained** rows with `result: null`, and says so:
  *"per-candidate rows arrive when the Contract FSM journals each candidate."*

**Consequence:** the entire `userSatisfaction` / personal-fitness cluster is
dead code until the Contract FSM runs per candidate in the live path. It is
dormant *by design* (BRSI goodhart gate), not by accident. This spec is the
smallest coherent way to make it live **without** opening the goodhart hole.

## 1. The central safety decision (locks the goodhart gate by construction)

The reason this cluster was gated: a live `userSatisfaction` that **drives
promotion** is gameable — the agent could learn to farm acceptance signal to
ratchet itself. This spec refuses that by splitting *observe* from *decide*:

- **Promotion stays exactly as today.** `main` advances only on the Rust
  strict-greater raw score, guarded by the tier-0 floor (I8) and the confidence
  gate (I6). `userSatisfaction` is **never** an input to the ratchet decision.
- **`userSatisfaction` becomes an *observed*, *journaled* component only.** The
  contract's per-candidate Journal row carries a real `FitnessVector` (incl.
  `userSatisfaction`) for transparency + Layer-5 meta-evolution to read later.

So the goodhart gate stays closed: the signal is *measured and surfaced*, but
*not decisive*. Opening it into the promotion scalar is a separate, later,
explicitly-gated decision (BRSI §9 open decision) — out of scope here.

`ponytail:` this split is the whole reason the increment is safe + small. If a
future ADR decides userSatisfaction should influence promotion, that is a
weights change in `DEFAULT_FITNESS_WEIGHTS` + the ratchet reading the aggregate
instead of the raw score — not a rewrite of this wiring.

## 2. Design: wrap the live ratchet path in the contract, don't replace it

`RatchetHandler.onEvalComplete` already holds every primitive the contract's
real stages need (git commit, ratchet attempt, tier-0 floor, confidence gate,
paired samples, per-task outcomes). Thread the contract by building
`StageHandlerDeps` leaves that **wrap the existing `RatchetDeps`**, then call
`runContract` per candidate. The FSM sequences + journals; the leaves do the
same work the handler does today.

The system is **config-RSI, not code-RSI** (a candidate is a mutated
`GenomeConfig`, not a code diff), so the "code candidate" stages collapse:

| Contract stage    | Config-RSI leaf behaviour                                             |
|-------------------|----------------------------------------------------------------------|
| `static_analysis` | pass-through (`ok:true`) — no code to lint for a config mutation      |
| `sandbox_apply`   | `commitGenome(req)` → artifact `{ rollbackTarget: previous main }`    |
| `tests`           | tier-0 subset already ran in the eval; `ok:true` iff no tier-0 breach |
| `benchmark`       | **the payoff stage** — see §3; builds the `FitnessVector` + samples   |
| `safety_checks`   | `tier0FloorBreach(outcomes)` → `ok:false, halt:false` on breach       |
| `regression`      | pass-through for config (no tier-1 regression suite yet) — `ok:true`  |
| `deploy`          | `ratchetAttempt(commitHash, score)`; artifact `{ commitHash }` if advanced; the I6 gate already ran in the runner before this stage |
| `monitoring`      | pass-through — emit `RatchetAdvanced` here (or keep it in the leaf)   |

The confidence gate is supplied as `evaluateConfidence` in `contractDepsFrom`
(already wired to `evaluateGate`). The runner already applies I6 before
`deploy`. `buildPairedSamples(outcomes, championOutcomes)` (already in
`ratchet-handler.ts:73`) feeds the benchmark leaf's `samples`.

**Champion baseline:** `RatchetHandler.lastChampionOutcomes` moves into the leaf
closure (or is passed in) so the benchmark leaf can build paired samples against
the current champion, exactly as the handler does today.

## 3. The benchmark leaf — where `userSatisfaction` finally plugs in

This is the reason the whole chain exists. The benchmark leaf returns
`{ fitnessVector, aggregate, samples }`:

```
aggregate     = score / maxScore                       // unchanged ratchet scalar
base          = scoreToFitnessVector(score, {          // fitness.ts:96
                  unmeasured: ["hallucination"],       // drop userSatisfaction from unmeasured
                })
userSat       = computePersonalFitness({               // personal-fitness.ts:93
                  signals: auditEntriesToUserSignals(recentAudit),  // :124 — tool_success/tool_error ALREADY flow
                  now,
                })
fitnessVector = { ...base, userSatisfaction: userSat }
samples       = buildPairedSamples(outcomes, championOutcomes)
```

- `recentAudit` = the last N audit-log rows (source: `src/sandbox/audit-log.ts`,
  `actionType === "tool_call"`). This is a **read** — no new event, no new IPC,
  no new UI. `tool_success` / `tool_error` are the two signal kinds that already
  have live sources; the other four (`acceptance`, `edit_after_accept`, …) stay
  `TODO` and simply don't appear yet — the aggregator handles a partial signal
  set (returns 0.5 when empty).
- The `aggregate` fed to `ratchetAttempt` (via the deploy leaf) stays the **raw
  score**, per §1 — `userSatisfaction` colours the journal, not the promotion.

`ponytail:` reuse the existing `auditEntriesToUserSignals` adapter verbatim.
Do NOT build an acceptance producer here — that's a separate later slice and
needs frontend UI + IPC (deliberately not in this spec).

## 4. Journal: per-candidate rows join the episode row

- The contract writes **one row per candidate** via `writeJournal` (already
  wired in `contractDepsFrom` → `appendJournal`). These rows carry the real
  `result` (`fitnessVector`, `aggregate`, `confidence`, `tier0`, `tier1`) — the
  fields `makeCycleSummary` leaves null.
- The Dream Cycle keeps its **episode-grained summary row** (`makeCycleSummary`)
  unchanged. Both coexist: episode = "why we woke + what happened overall",
  candidate = "this genome's fitness + verdict". Same journal file, same writer.
- The journal viewer (§4.9) already filters; per-candidate rows show up with a
  non-null `result`. Confirm the viewer tolerates both granularities (it should
  — `result` is already optional).

## 5. Slices (ship each with runnable tests before the next)

**Slice 1 — contract leaves over the live ratchet deps (no userSatisfaction yet).**
Build `contractLeavesFromRatchet(deps: RatchetDeps, ...)` producing
`StageHandlerDeps` per §2. Replace the hand-rolled body of
`onEvalComplete` with: build `ContractState` for the candidate → `runContract` →
emit `RatchetAdvanced` on an `accept` whose deploy advanced main. Behaviour must
be **identical** to today's ratchet (same promotions, same `ConfidenceFailed`
emissions, same tier-0 rejects) — the only new thing is per-candidate Journal
rows. Test: a candidate that beats the champion promotes + writes an `accept`
row; a tier-0 breach writes a `halt`/`reject` row and does not promote; a
confidence-gate reject writes a `reject` row and does not promote.

**Slice 2 — real `userSatisfaction` in the benchmark leaf (§3).** Wire
`auditEntriesToUserSignals` + `computePersonalFitness` into the benchmark leaf;
drop `userSatisfaction` from `unmeasured`. Promotion path unchanged (assert the
ratchet still sees the raw score). Test: a candidate evaluated with N successful
tool-call audit rows gets `userSatisfaction > 0.5` in its Journal row, while the
`aggregate` handed to `ratchetAttempt` is unchanged from Slice 1.

**Slice 3 — journal viewer surfaces per-candidate fitness (FE, optional).** If
the viewer doesn't already render `result.fitnessVector`, add a compact per-row
fitness readout. Read-only, mirrors the champions-by-niche UI pattern
(`FeralDreamsPanel.tsx`). Skip if the viewer already shows it.

## 6. Guardrails / non-goals (hard)

1. **Promotion semantics unchanged.** `main` advances iff the Rust
   strict-greater + tier-0 floor + confidence gate say so. `userSatisfaction`
   MUST NOT enter the ratchet scalar. A test must prove the promotion set is
   identical before/after Slice 2.
2. **No new burn.** The contract runs inside the existing `EvalComplete`
   reaction — one contract run per candidate that already evaluated. No new
   scheduler, no new episode trigger. (The `threshold` / `budget_available`
   triggers stay RESERVED — out of scope.)
3. **No acceptance/demo producer.** Slice 2 uses only signals that already flow
   (`tool_success`/`tool_error`). No frontend UI, no new IPC. `acceptance` et al.
   stay `TODO`.
4. **No green-stub tests.** Every test asserts real behaviour (a row with the
   right decision/fitness), not a stub that passes if the wiring were deleted.
5. **Verify before touching.** Every file/function named here was read on
   2026-07-01; re-grep before editing and STOP + report if the code diverged.
6. **Config-RSI only.** Do not invent code-candidate machinery (real static
   analysis, sandbox diff apply, regression suite) — those stages are
   pass-through until/unless the system grows a code-mutation path.

## 7. Files touched (estimate)

- `FeralAgent/src/rsi/ratchet-handler.ts` — `onEvalComplete` body swapped to
  `runContract`; add `contractLeavesFromRatchet` (here or a small sibling file).
- `FeralAgent/src/rsi/fitness.ts` — no change (the `unmeasured` override is a
  call-site arg, not a new field).
- `FeralAgent/src/rsi/personal-fitness.ts` — no change (adapters already exist).
- `FeralAgent/tests/rsi-ratchet-*.test.ts` — extend for the Journal-row +
  userSatisfaction assertions.
- (Slice 3 only) `frontend-react/.../FeralDreamsPanel.tsx` + its test.

No Rust changes. No sidecar protocol changes. `personal-fitness` and `fitness`
stay pure.

## 8. Open decisions (lock before Slice 1)

1. **Where the leaves live** — extend `ratchet-handler.ts`, or a new
   `contract-leaves.ts` sibling? (Recommend: sibling, keeps the handler small
   and the leaves fake-testable in isolation.)
2. **Champion baseline persistence** — `lastChampionOutcomes` is process-local
   today (re-bootstraps on restart). Keep that for v1? (Recommend: yes; out of
   scope to persist.)
3. **`recentAudit` window** — how many rows / what time window feeds
   `computePersonalFitness`? (Recommend: reuse the 7-day `windowMs` default the
   aggregator already ships.)
4. **Emit `RatchetAdvanced` from `monitoring` leaf vs after `runContract`
   returns `accept`?** (Recommend: after the run returns, so the emit stays in
   the handler and the leaves stay pure.)
