# ADR-0003: Hard vs Soft Invariants

**Status:** Accepted
**Date:** 2026-06-30

## Context

`docs/invariants.md` lists the runtime contracts the engine must
not violate. Not all contracts are equal:

- "Journal is append-only" — never negotiable. A single violation
  breaks the audit trail.
- "Average confidence ≥ 0.95" — a target. If persistent drift
  lowers it to 0.93, that's a signal worth investigating but
  not a safety emergency.
- "Tier 0 tests must pass" — never negotiable. The floor exists
  to prevent regressions.
- "Niche count ≥ 3" — a target. A drift to 2 niches for a few
  cycles is a warning; persistent monoculture is a problem.

Treating these uniformly obscures which violations are emergencies
and which are metrics. The risk is twofold: (a) soft violations get
the same response as hard ones (alert fatigue, "the invariant
violated again, I'll check tomorrow"), or (b) hard violations get
the same response as soft ones (engine keeps running past a
breach, no one notices until later).

## Decision

Classify every invariant as **HARD** or **SOFT**:

- **HARD.** Violation = HALT / Rollback / Error. Negotiable only via
  ADR + version bump. Examples: Journal append-only, Tier 0
  immutable, Budget halt on breach.
- **SOFT.** Violation = Warning + log + (if persistent) ADR + version
  bump that lowers the threshold with documented reason. Examples:
  Average confidence ≥ 0.95, Niche count ≥ 3, Tree depth ≤ N.

Every invariant in `docs/invariants.md` carries its class in the
header. Removing a HARD invariant or reclassifying HARD → SOFT
requires an ADR. Lowering a SOFT threshold requires an ADR + the
drift data.

## Consequences

**Easier:**
- Operators know immediately what to do when an invariant fires.
- Hard invariants are testable as a single boolean; soft invariants
  are observable as a metric.
- The promotion gate L_i → L_{i+1} can require "all HARD invariants
  held for N cycles" — a clean gate.

**Harder:**
- Classification is a judgement call. Some invariants straddle the
  boundary ("personal fitness returns [0, 1]" is hard in code but
  soft in interpretation).
- The list of HARD invariants grows over time. Discipline needed
  to challenge each new addition: is this really never negotiable?

**Trade-offs accepted:**
- Some invariants may be misclassified. We accept the cost of
  revisiting classifications in later ADRs.

## Related

- `docs/invariants.md` §1 (Classification), §2 (Four pillars)
- INVARIANTS.md S1-S4 (soft targets)
- ADR-0002 (Layer 5/6 split — a kind of invariant classification at
  the layer level)