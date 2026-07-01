# ADR-0001: BRSI Naming

**Status:** Accepted
**Date:** 2026-06-30

## Context

Feral is positioned as a self-improving system, but its existing
mechanics are bounded: max lines changed, immutable core (scorer +
Tier 0 specs + SandboxBounds), hash-chained audit log, automatic
rollback on regression. The term "RSI" (Recursive Self-Improvement)
is overloaded:

| Audience | What "RSI" means to them |
| -------- | ------------------------ |
| AI safety researchers | Yudkowsky / Bostrom / Seed AI — intelligence explosion scenarios |
| ML practitioners | Anthropic "When AI Builds Itself" — AI-written 80% of code |
| Academic researchers | Sakana DGM / LLM-Squared — open-ended self-improvement loops |

None of those meanings describe what Faza 1-2 actually does. The
"RSI" label overpromises and underspecifies. Engineers building on
top of Feral today (config evolution, not code evolution) get
sidelong glances from reviewers who expect more.

We need a name that:
1. Says "self-improving" (the Feral pitch).
2. Says "bounded" (what it actually is).
3. Distinguishes Feral from the safety-doomsday crowd.

## Decision

Adopt **BRSI — Bounded Recursive Self-Improvement** as the project's
central identity.

**Naming rule (replaces the §5 debate in `rsi-evolution-spec.md`):**

| Phase | Internal name | External name |
| ----- | ------------- | ------------- |
| Layers 0-2 | "RSI" | "Evolution" / "Personal Adaptation" |
| Layers 3-4 | "BRSI" | "Bounded Self-Improvement" |
| Layer 5 (Governance Evolution) | "BRSI" | "Bounded Self-Improvement" |
| Layer 6 (Meta Evolution) | "RSI" | "Meta-Evolution (research preview)" |

The "RSI" label is reserved for the layer where the engine genuinely
modifies the mechanism that does the improving. Until then, marketing
must not use "RSI" — only "Evolution" or "Personal Adaptation".

## Consequences

**Easier:**
- Researchers reading the project know immediately: this is not
  open-ended RSI.
- PRs proposing "let's remove the confidence gate, it slows
  evolution" have an answer: BRSI is bounded by design. The gate
  *is* the safety mechanism.
- Marketing copy is honest. No "AGI-adjacent" framing.

**Harder:**
- Internal docs still say "RSI" in some places; the rename is a
  discipline, not a single edit.
- Engineers used to "RSI" taxonomies (Anthropic, Sakana) need to
  reframe Feral's contribution.

**Trade-offs accepted:**
- "BRSI" sounds like "BRICs" or "BRCA" — unfortunate, but
  intentional. Distinctiveness > elegance.

## Related

- `docs/brsi-spec.md` §1 (Identity & Positioning)
- `docs/feral_philosophy.md` (Why BRSI, not RSI?)
- INVARIANTS.md I1, I2 (the ratchet contract — what BRSI enforces)