# ADR-0012: ConfidenceFailed Event

**Status:** Accepted
**Date:** 2026-07-01

## Context

The BRSI confidence gate (§2.7) now sits in front of the ratchet
(`ratchet-handler.ts`, wired 2026-07-01). When a candidate beats main's
prior score but does NOT clear the statistical bar (paired bootstrap +
Cohen's d), the handler rejects it and `return`s silently.

That silence loses information. The episode journal (§2.9, wired at
`dream-cycle.ts:onEpisodeEnd`) counts `ratchets` (promotions) but has no
way to count rejections. "0 promoted" then reads identically whether the
gate rejected ten noisy candidates or none were tried — the exact
evidence that the gate is *doing its job* is invisible, to both the
journal and the UI.

Options considered:

1. **Inject a private counter callback into `RatchetDeps`.** Pro: no
   event-union change, no ADR. Con: a one-off private wire; the UI mirror
   (`mirrorEngineEvents`) can't see it; future consumers (metrics,
   dashboard) would each need their own callback.

2. **New `ConfidenceFailed` event on the engine bus.** Pro: one emission,
   many consumers — the episode counter, the UI mirror (live receipt),
   and any future subscriber, all without touching the ratchet handler
   again. Matches the Evolution Event Schema (wiring-spec §9, ADR-0004).
   Con: adds a member to the `RsiEvent` discriminated union
   (`event-bus.ts`), which is type-coupled across the engine.

## Decision

Add **`ConfidenceFailed`** to `RsiEventType`. The ratchet handler emits it
(with `genomeId`, `reason`, `pValue`, `effectSize`) on gate rejection,
before returning. Consumers:

- `sidecar.ts` run loop tallies it into `RsiRunStats.confidenceRejections`.
- `mirrorEngineEvents` forwards it to the host as a `progress` event with
  `stage: "confidence_rejected"` (live UI receipt).
- `dream-cycle.ts:makeCycleSummary` folds the count into the journal row's
  `observed`.

We do **not** add a symmetric `ConfidencePassed`. Acceptance is already
observable as the subsequent `RatchetAdvanced`; a second event for the
same fact would be redundant (YAGNI). If a future consumer needs an
explicit pass signal distinct from an actual ratchet advance, that is a
separate ADR.

## Consequences

- `RsiEventType` grows from 9 to 10 members. Existing exhaustive switches
  over the union (if any) must handle the new kind.
- `RsiRunStats.confidenceRejections` is optional to keep pre-gate stats
  literals valid; readers default it to 0.
- The event is internal to the RSI bus. It reaches the frontend only via
  the existing `rsi_engine_event` `progress` channel — no new
  `fractal_activity` kind, so no frontend filter change is required.
