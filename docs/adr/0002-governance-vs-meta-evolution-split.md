# ADR-0002: Governance Evolution vs Meta Evolution split

**Status:** Accepted
**Date:** 2026-06-30

## Context

The original BRSI spec §5 ("Six-Layer Roadmap") presents a single
"Layer 5 — Meta Evolution": the engine modifies its own mutation
grammar, selection pressure, and scoring weights. This conflates two
activities that have very different safety profiles:

1. **Tuning parameters of a policy.** Adjusting confidence thresholds,
   fitness weights, mutation rates, budget caps. The policy is
   fixed; only its numeric knobs move. Each change is testable in
   isolation; rollback is trivial.

2. **Optimising the algorithm that produces the policy.** The engine
   modifies how it decides which confidence thresholds to try, how
   it learns fitness weights, how it generates mutation operators.
   This is closer to academic RSI — the system changes its own
   learning mechanism.

Conflating the two means the safety story for "parameter tuning" is
inadvertently tied to the safety story for "algorithm optimisation".
That makes parameter tuning look scarier than it is, and algorithm
optimisation look easier than it is.

## Decision

Split Layer 5 into two layers:

- **Layer 5 — Governance Evolution.** Tunes confidence thresholds,
  fitness weights, mutation rates, budget caps — within
  SandboxBounds. Each parameter is a known quantity with a known
  safe range. Changes are reversible by restoring the previous
  SandboxBounds value. Auto-apply within bounds; rollback on
  regression.

- **Layer 6 — Meta Evolution.** Optimises the algorithm that
  produces those parameters. Genuine RSI in the academic sense.
  Always human-gated. Promotion gate is stricter than L4→L5.

**Promotion gate L5 → L6:** `N=10 cycles, M=30 ratchets` (vs `N=5,
M=10` for prior layers). The bar to enter Meta Evolution is
deliberately high.

## Consequences

**Easier:**
- The autonomy scale is now precise: "we are at L4, Governance
  Evolution is OFF, Meta Evolution is OFF, no code edits have been
  auto-applied" is a coherent statement.
- Governance Evolution can ship earlier (lower risk) without waiting
  for Meta Evolution's safety review.
- The literature on parameter tuning (Bayesian optimisation, PBT)
  applies cleanly to Layer 5.

**Harder:**
- Two layers to maintain instead of one. The promotion gate, the
  test coverage, the documentation — all doubled for the meta-
  evolution concerns.
- Engineers need to think twice about "is this a parameter change
  (L5) or an algorithm change (L6)?" The boundary can be fuzzy.

**Trade-offs accepted:**
- Two layers instead of one means the framework is bigger. Worth it
  for the safety-story clarity.

## Related

- `docs/brsi-spec.md` §5 (Roadmap), §11 (DAG)
- INVARIANTS.md I9 (SandboxBounds agent-immutable — L5 must not
  widen its own bounds)
- ADR-0007 (Trust boundary) — Governance Evolution operates within
  the trust boundary, Meta Evolution does not