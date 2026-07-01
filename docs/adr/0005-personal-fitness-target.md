# ADR-0005: Personal Fitness as First-Class Objective

**Status:** Accepted
**Date:** 2026-06-30

## Context

Sakana AI's Darwin Gödel Machine (DGM) and related projects
optimise **global capability** on benchmark suites (SWE-bench,
MMLU, math). The fitness function is "how good is this model at
coding / reasoning / math, on average".

This is not what Feral is optimising.

Feral's pitch is "your AI that gets more valuable to *you* over
time." The fitness function is "how useful am I for *this* user",
which includes signals that public benchmarks cannot measure:
acceptance of agent messages, tool-call success on the user's
workflows, edit-after-accept corrections, memory reuse, preference
alignment.

Treating Personal Fitness as a secondary concern (a "nice to have
metric, but the main signal is the benchmark score") is the default
failure mode. It produces agents that get better at benchmarks but
not at helping.

## Decision

Personal Fitness is a **first-class objective** in Feral:

1. The BRSI fitness vector (BRSI §2.2) carries it as one of six
   components (`userSatisfaction`), with a default weight of 0.10.
2. Personal eval suite (`user_eval_set.json`) gates promotion for
   Layer 2+ candidates. Tier 0 is the floor; personal suite is the
   promotion gate. Both must pass.
3. Personal Fitness signals are collected locally only. The user's
   data never leaves their machine.
4. The Personal Fitness aggregator
   (`FeralAgent/src/rsi/personal-fitness.ts`) is a required consumer
   of the audit log when Personal LoRA is active.

## Consequences

**Easier:**
- Feral's research positioning is honest: BRSI is not Sakana at
  home; it's a different optimisation target.
- The privacy story strengthens: local-first is required for
  Personal Fitness to work at all.
- The user's experience is the success metric. If they don't
  accept more, the fitness signal goes down, and the engine
  adjusts.

**Harder:**
- Personal Fitness is harder to measure than benchmark scores.
  Long evaluation horizons (weeks, months) are needed to see
  effects. Short A/B tests against cloud baselines are noisy.
- Some signals (`acceptance`, `edit_after_accept`,
  `preference_match`, `workflow_completion`) don't have producers
  yet. The aggregator supports them; the engine must wire them
  in.
- Per-instance divergence (BRSI §3.3) becomes important: two
  users' fitness functions will diverge, so the storage paths
  must split.

**Trade-offs accepted:**
- Personal Fitness is noisier than benchmark scores. We accept the
  noisier signal because it measures what we actually care about.

## Related

- `docs/brsi-spec.md` §2.10, §10
- `FeralAgent/src/rsi/personal-fitness.ts` (the aggregator)
- `docs/continual-personal-adaptation-plan.md` §3.2 (Personal LoRA
  pipeline)
- INVARIANTS.md I10 (Personal Fitness bounded)
- ADR-0007 (Trust boundary — Personal Fitness signals stay local)