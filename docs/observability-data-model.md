# Observability Data Model — Evolution Event Schema

> The single stream every observability consumer reads from. Dashboards,
> metrics, journal entries, audit logs, and telemetry all derive from
> this schema. Adding a new consumer = subscribe to the stream. Adding
> a new event type = extend the schema (with an ADR).

---

## 1. Why one schema

Today, Cinderpaw has three near-overlapping observability surfaces:

- `~/.feral/rsi/dream.jsonl` (per-episode telemetry, `dream-telemetry.ts`)
- `~/.feral/rsi/sandbox_bounds.audit.log` (SandboxBounds mutations)
- The forthcoming Evolution Journal (per-cycle structured log)

That's three formats, three consumers, three places a developer has
to look when something goes wrong. The Evolution Event Schema
collapses them into one stream.

## 2. Design principles

| # | Principle | Why it matters |
| - | --------- | -------------- |
| 1 | **Schema-first, format-agnostic.** Same event can flow over stdout JSONL, into SQLite, into a websocket, into a file. | The wire format is a deployment concern; the schema is the contract. |
| 2 | **Self-describing.** Each event carries its own kind, schema version, and lineage. | Consumers don't need an out-of-band schema registry. |
| 3 | **Append-only.** Events are immutable once emitted. | Same property as the Journal and the audit chain. |
| 4 | **Layer-aware.** Each event declares which BRSI layer emitted it. | The dashboard can filter "what did Layer 3 do today?" without grepping. |
| 5 | **Lineage-aware.** Each event can reference its parent events (not just git lineage). | Cycle stage transitions, journal writes, and metric computations can be traced back to their triggers. |
| 6 | **Stable IDs.** Event IDs are ULIDs (sortable, unique, no central allocator). | Consumers can dedupe, sort, and reference events across restarts. |

## 3. Event Schema (v1)

```typescript
/**
 * The single observability stream type. Every consumer — the Journal
 * writer, the dashboard, the metrics aggregator, the audit chain —
 * subscribes to a stream of these.
 *
 * `schemaVersion` lets us evolve the schema over time without
 * breaking consumers. A consumer that doesn't recognise a newer
 * version falls back to the highest version it supports and logs
 * the gap.
 */
export interface EvolutionEvent {
  /** ULID — sortable, unique, no central allocator. */
  id: string;
  /** Wall-clock timestamp, ms since epoch. */
  timestamp: number;
  /** Which BRSI layer emitted the event. */
  layer: "L0" | "L1" | "L2" | "L3" | "L4" | "L5" | "L6";
  /** Optional: which dream cycle this event belongs to. */
  cycleId?: string;
  /** Optional: which candidate (genome / patch / LoRA) this event is about. */
  candidateId?: string;
  /** The event type. Discriminated union; see §4. */
  kind: EvolutionEventKind;
  /** Event-specific payload. Schema per kind. */
  payload: Record<string, unknown>;
  /** Optional: parent event IDs (event lineage, distinct from git lineage). */
  parents?: string[];
  /** Schema version. Bump on incompatible changes. */
  schemaVersion: 1;
}

export type EvolutionEventKind =
  // Candidate lifecycle
  | "MutationCreated"
  | "MutationRejected"
  | "MutationApplied"
  // Eval lifecycle
  | "EvalStarted"
  | "EvalComplete"
  | "EvalHalted"
  // Confidence gate
  | "ConfidencePassed"
  | "ConfidenceFailed"
  // Budget
  | "BudgetExceeded"
  | "BudgetFailOpen"
  // Species / Tree (Layer 5+)
  | "SpeciesForked"
  | "SpeciesExtinguished"
  | "ChampionAdvanced"
  | "ChampionRetired"
  // Rollback
  | "RollbackPerformed"
  // Dream cycle
  | "CycleStarted"
  | "CycleCompleted"
  | "CycleHalted"
  // Observability
  | "JournalWritten"
  | "ProvenanceQueried"
  // Sandbox bounds
  | "BoundsChanged"
  // Invariant
  | "InvariantChecked"
  | "InvariantViolated";
```

## 4. Event catalogue

### 4.1 Candidate lifecycle

| Kind | When | Payload |
| ---- | ---- | ------- |
| `MutationCreated` | A new candidate is born in the Mutate stage. | `{ candidateId, parentIds, mutationType, layer }` |
| `MutationRejected` | A candidate is rejected pre-eval (schema, validation, contract pre-check). | `{ candidateId, reason, stage }` |
| `MutationApplied` | A candidate is committed (post-eval, post-gate). | `{ candidateId, commitHash, fitnessVector, aggregate, confidence }` |

### 4.2 Eval lifecycle

| Kind | When | Payload |
| ---- | ---- | ------- |
| `EvalStarted` | The eval worker begins evaluating a candidate. | `{ candidateId, evalSetPath }` |
| `EvalComplete` | The eval worker finishes (success or errored). | `{ candidateId, score, fitnessVector, tier0, tier1 }` |
| `EvalHalted` | The contract FSM halts an eval before completion (precondition failure, budget breach). | `{ candidateId, stage, reason }` |

### 4.3 Confidence gate

| Kind | When | Payload |
| ---- | ---- | ------- |
| `ConfidencePassed` | A candidate passes the gate. | `{ candidateId, score, confidence, effectSize, ciLower, ciUpper, nSamples }` |
| `ConfidenceFailed` | A candidate fails the gate. | `{ candidateId, reason, bootstrap }` |

### 4.4 Budget

| Kind | When | Payload |
| ---- | ---- | ------- |
| `BudgetExceeded` | `assertCanSpend` returned allow=false on an explicit estimate. | `{ phase, breaches }` |
| `BudgetFailOpen` | `assertCanSpend` returned allow=true with reason "no estimator, fail-open". | `{ phase, missingResources }` |

### 4.5 Species / Tree

| Kind | When | Payload |
| ---- | ---- | ------- |
| `SpeciesForked` | A new species is created from a niche. | `{ speciesId, parentSpeciesId, niche }` |
| `SpeciesExtinguished` | A species is extinguished (monoculture detector or manual). | `{ speciesId, reason }` |
| `ChampionAdvanced` | The per-species champion changes. | `{ speciesId, oldChampionId, newChampionId, score }` |
| `ChampionRetired` | A champion is removed from the active set (not deleted from archive). | `{ speciesId, championId, reason }` |

### 4.6 Rollback

| Kind | When | Payload |
| ---- | ---- | ------- |
| `RollbackPerformed` | The engine rolls back to a prior commit. | `{ targetCommit, reason, triggeredBy }` |

### 4.7 Dream cycle

| Kind | When | Payload |
| ---- | ---- | ------- |
| `CycleStarted` | Wake stage begins. | `{ cycleId, trigger }` |
| `CycleCompleted` | Remember stage finishes (accept or reject). | `{ cycleId, outcome, decided }` |
| `CycleHalted` | Contract FSM halts the cycle (budget, invariant, error). | `{ cycleId, stage, reason }` |

### 4.8 Observability

| Kind | When | Payload |
| ---- | ---- | ------- |
| `JournalWritten` | A row was appended to the Evolution Journal. | `{ journalPath, entryId }` |
| `ProvenanceQueried` | A `provenance.show` / `descendants` / `commonAncestor` was issued. | `{ query, resultCount }` |

### 4.9 Sandbox bounds

| Kind | When | Payload |
| ---- | ---- | ------- |
| `BoundsChanged` | A SandboxBounds field was modified via UI. | `{ field, oldValue, newValue, reason }` |

### 4.10 Invariants

| Kind | When | Payload |
| ---- | ---- | ------- |
| `InvariantChecked` | An invariant was checked and held. | `{ invariantId, layer }` |
| `InvariantViolated` | An invariant was checked and broke. | `{ invariantId, layer, context }` |

## 5. Consumers

| Consumer | What it does | Source events |
| -------- | ------------ | ------------- |
| **Journal writer** | Appends a per-cycle summary row (subset of events). | `CycleStarted`, `CycleCompleted`, `MutationApplied/Rejected`, `ConfidencePassed/Failed`, `BudgetExceeded` |
| **Dashboard (frontend)** | Real-time graph; subscribes via websocket or polling. | All `*Created`, `*Applied`, `*Advanced`, `*Halted`, `*Violated` |
| **Metrics aggregator** | Computes rolling metrics from the stream. | All |
| **Audit log** | Writes hash-chained copy of `BoundsChanged`, `InvariantViolated`, `RollbackPerformed`. | Those three specifically |
| **Test infrastructure** | Asserts that specific kinds fire in the right order during integration tests. | All |

## 6. Transport (deferred)

The schema is the contract. The transport is not yet chosen. Options
for Opus / future work:

| Transport | Pros | Cons |
| --------- | ---- | ---- |
| JSONL over stdout | Zero deps, easy to tail, matches existing `dream.jsonl` discipline. | No backpressure, file rotation manual. |
| SQLite (`evolution_events` table) | Queryable, transactional, fits the existing `bun:sqlite` substrate. | Schema migration cost, larger footprint. |
| WebSocket to frontend | Real-time dashboard updates. | Server lifecycle, reconnect logic. |

For v1, **JSONL over stdout (or a per-day file)** is the safe choice.
It mirrors `dream-telemetry.ts` and `journal.ts`. A SQLite backend
can be added later without breaking consumers — they read the same
schema either way.

## 7. Adding a new event kind

1. Add the kind to the `EvolutionEventKind` union.
2. Define its payload shape in §4.
3. Identify the producer (which module emits it).
4. Identify the consumers (which UI / metric / log reads it).
5. Open an ADR (`docs/adr/NNNN-add-event-kind.md`) capturing the
   decision.
6. Update this file with the new row in §4.

Schema changes (renaming a field, changing a payload shape) require a
schema version bump. Consumers fall back gracefully on unknown
versions.

---

*This file is the contract every observability consumer reads from.
Touch it only via ADR.*