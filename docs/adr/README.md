# Architecture Decision Records

This directory contains the ADRs that shape Feral's design. Each ADR
captures one decision: **context**, **decision**, **consequences**.
Together, they form the project's design history.

When proposing a change that contradicts an ADR, write a new ADR
that supersedes the old one. Don't edit ADRs in place.

| # | Title | Status | Date |
| - | ----- | ------ | ---- |
| [0001](0001-bounded-recursive-self-improvement.md) | BRSI naming (Bounded Recursive Self-Improvement) | Accepted | 2026-06-30 |
| [0002](0002-governance-vs-meta-evolution-split.md) | Governance Evolution vs Meta Evolution split | Accepted | 2026-06-30 |
| [0003](0003-hard-vs-soft-invariants.md) | Hard vs Soft invariants | Accepted | 2026-06-30 |
| [0004](0004-evolution-event-schema.md) | Single Evolution Event Schema | Accepted | 2026-06-30 |
| [0005](0005-personal-fitness-target.md) | Personal Fitness as first-class objective | Accepted | 2026-06-30 |
| [0006](0006-append-only-provenance-graph.md) | Append-only provenance graph | Accepted | 2026-06-30 |
| [0007](0007-trust-boundary-rust-immutable-scorer.md) | Trust boundary: Rust-immutable scorer | Accepted | 2026-06-30 |
| [0008](0008-evolution-runtime-as-dag.md) | Evolution runtime as a DAG, not layers | Accepted | 2026-06-30 |
| [0013](0013-ai-guided-onboarding.md) | AI-Guided Onboarding with Domain-Event Contracts | Accepted | 2026-07-05 |

## Format

Every ADR uses the same template:

```markdown
# ADR-NNNN: <Title>

**Status:** Proposed | Accepted | Superseded by ADR-XXXX
**Date:** YYYY-MM-DD

## Context

What is the issue we're seeing that motivates this decision? Include
the relevant constraints, trade-offs, and prior decisions that bear on
the choice.

## Decision

What did we decide? State it as a single sentence if possible, then
elaborate.

## Consequences

What becomes easier? What becomes harder? What do we give up?
Include both positive and negative consequences. If a future ADR
might supersede this one, note it here.

## Related

- INVARIANTS.md entries that depend on this
- ADRs that supersede or complement this
- Source code locations
```

## Conventions

- **Numbering:** Sequential, never reused. Superseded ADRs keep their
  number and gain a `Superseded by ADR-XXXX` line.
- **Tone:** Explanatory, not promotional. The reader is a future
  contributor who doesn't know the history.
- **Length:** 60-120 lines. Longer is OK for foundational ADRs.
- **Links:** Cross-reference INVARIANTS.md by invariant ID.
  Cross-reference other ADRs by number.

## When to write an ADR

Write one when:
- You're introducing a new invariant (or changing an existing one's
  classification).
- You're splitting or merging layers/concepts.
- You're choosing between two viable approaches with non-trivial
  trade-offs.
- You're establishing a naming convention or schema.
- You're proposing a change that contradicts an existing ADR.

You don't need one for:
- A bug fix.
- A routine code refactor with no architectural impact.
- A test addition.

When in doubt, write one. The cost is small; the value compounds.