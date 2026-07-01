# ADR-0011: EvalHalted Event Semantics

**Status:** Accepted
**Date:** 2026-06-30

## Context

`FeralAgent/src/rsi/eval-worker.ts:67-80` always emits
`EvalComplete{errored:true, score:0}` on catch. There is no entry
point that DOESN'T produce an `EvalComplete` event. This is fine for
"the eval crashed mid-run" but bad for "the pre-check blocked the
eval before it started" — the audit trail conflates two different
conditions.

When the Contract FSM (BRSI §2.1) lands, it needs to express "the
pre-check failed and the eval never started". Options considered:

1. **Reuse `EvalComplete{errored:true, reason:"pre-check failed"}`.**
   Pro: no new event kind. Con: ratchet's "errored" check
   (`ratchet-handler.ts:53`) treats this as a crash, which is wrong;
   downstream consumers can't distinguish "eval crashed" from "eval
   never started". The journal entry's `result` is `null` (the eval
   never ran), but the `EvalComplete` event itself implies a run.

2. **New `EvalHalted` event.** Pro: explicit signal for "we
   decided not to run this". Con: requires adding to the
   `RsiEvent` discriminated union (`event-bus.ts:14-23`), which is
   type-coupled across the engine.

## Decision

Add `EvalHalted` as a sibling of `EvalComplete`, not a variant.

**Type extension** (in `FeralAgent/src/rsi/event-bus.ts:14-23`):

```typescript
export type RsiEventType =
  | "GenomeBorn"
  | "EvalStarted"
  | "EvalComplete"
  | "RatchetAdvanced"
  | "GenomeDied"
  | "ExtinctionTriggered"
  | "PBTSyncTriggered"
  | "GoodhartDetected"
  | "RecalcitranceHigh"
  | "EvalHalted";          // NEW
```

**Shape** (consumer-side typing):

```typescript
{
  type: "EvalHalted";
  genomeId: string;
  cycleId: string;
  stage: ContractStage;     // which stage halted (see contract.ts)
  reason: string;            // non-empty (see INVARIANTS.md I15)
  timestamp: number;
}
```

**Who emits it:** Only the Contract FSM (when it lands) or a pre-check
wrapper that runs BEFORE `eval-worker.ts`. `eval-worker.ts` itself
does NOT emit `EvalHalted` — it still emits
`EvalComplete{errored:true}` on crash.

**When:**

- Pre-check stage of the Contract FSM rejects the candidate (budget
  breach, invariant violation, Tier 0 floor concern before launch).
- Future: any pre-condition that gates the eval from running
  (e.g., trust-boundary check, audit-trail consistency check).

**Consumers:**

- **Journal writer:** appends a halt entry (BRSI §2.9 schema; `decided:
  {action: "halt", reason, stage}`).
- **Observability stream:** surfaces to the dashboard per the
  Evolution Event Schema (`docs/observability-data-model.md` §4.2).
- **Audit log:** chain via `audit.rs` (PENDING — same hash-chain
  discipline as `BoundsAuditRow`).
- **Confidence gate:** bypassed (no score to evaluate).
- **Ratchet handler:** NOT called — no eval completed, no ratchet
  attempt.
- **Population manager:** receives no fitness update (the candidate
  is not promoted).

**Relationship with `EvalComplete{errored:true, score:0}`:**

| Condition | Event |
| --------- | ----- |
| Eval started, crashed mid-run | `EvalComplete{errored:true, score:0}` |
| Eval started, completed with errors | `EvalComplete{errored:false, score:N}` |
| Eval never started (pre-check halted) | `EvalHalted` |

The three conditions map to three different downstream behaviours
(ratchet retries vs ratchet skips vs ratchet never invoked). Distinct
events make the audit trail honest.

## Consequences

**Easier:**

- The audit trail distinguishes "crash" from "halt".
- The Contract FSM has a clear signal for "we decided not to run
  this" — it can write a precise journal entry without lying about an
  eval that never ran.
- Future pre-checks (trust-boundary, audit-trail consistency,
  off-policy candidate rejection) can reuse the same event.

**Harder:**

- New `RsiEventType` member; `OutboundEvent` doesn't need changes
  (this is internal to the engine).
- TS type-union change; consumers that exhaustively pattern-match on
  event types need updating (small surface; mostly tests).
- The `eval-worker.ts:67-80` contract doesn't change — it still
  emits `EvalComplete{errored:true}` on crash. The change is purely
  additive.

**Trade-offs accepted:**

- Two events for "didn't complete" (Crash vs Halt) is clearer than
  one event with a discriminator. The cost is one extra union
  member; the benefit is honest audit semantics.

## Related

- INVARIANTS.md **I15** — EvalHalted requires reason (the type
  system enforces non-empty `reason`; the runtime check rejects
  empty strings at emit time)
- `docs/wiring-spec.md` §6.2 (Contract FSM halt handling)
- `docs/observability-data-model.md` §4.2 (eval lifecycle events)
- `FeralAgent/src/rsi/event-bus.ts:14-23` (the union to extend)
- `FeralAgent/src/rsi/contract.ts` (the Contract FSM that emits it)