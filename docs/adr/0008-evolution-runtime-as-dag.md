# ADR-0008: Evolution Runtime as a DAG, not Layers

**Status:** Accepted
**Date:** 2026-06-30

## Context

The BRSI spec §5 ("Six-Layer Roadmap") presents the engine as a
sequence of layers:

```
L0 → L1 → L2 → L3 → L4 → L5 → L6
```

This is misleading. The runtime is not a layered cake. The actual
dependency graph looks more like:

```
                    Budget
                      │
                      ▼
Journal ─── Metrics ─┴── Confidence
    │                 │
    ▼                 ▼
Provenance ─── Contract ─── Ratchet
    │                │
    ▼                ▼
Audit Log      Dream Cycle
                  │
                  ▼
              Champion Tree
                  │
                  ▼
                Species
                  │
                  ▼
            LoRA Evolution
```

Provenance doesn't depend on Confidence. Confidence doesn't depend
on Contract. The Contract FSM consumes Budget, Confidence, and
Fitness — but it's not "above" them in a layer sense; it's a peer.

Presenting the architecture as layers is convenient for
communication (humans think in stacks) but inaccurate for
engineering (the codebase doesn't import top-down). Worse, layered
diagrams invite layered refactors: "let's rewrite Layer 2, it sits
on top of Layer 1" — when in reality the components are peers and
the refactor scope is different.

## Decision

Feral has two views of the architecture:

1. **Layers (for presentation).** BRSI §5 keeps the L0–L6 ladder
   for slides, documentation, marketing. Layers are intuitive for
   newcomers.

2. **DAG (for engineering).** `docs/brsi-spec.md` §11 carries the
   dependency graph. New contributors onboard via the layers; the
   engineering work happens against the DAG.

Refactors are scoped against the DAG, not the layers. "Rewrite the
Contract FSM" is a Contract + Budget + Journal + Confidence + Fitness
change. "Add a new species" is a Population + Provenance + Champion
change. The layers describe what the engine *does at user-visible
levels of autonomy*; the DAG describes what the engine *is*.

## Consequences

**Easier:**
- Engineering scope matches reality. Refactor scope is visible in
  the DAG; layers don't lie about it.
- New contributors see two views: "here's the autonomy scale"
  (layers) and "here's the actual dependency graph" (DAG). Both
  are useful.
- Cross-cutting concerns (Budget, Confidence, Provenance, Journal)
  are correctly identified as cross-cutting rather than "between
  layers".

**Harder:**
- Two views to maintain. When a new component is added, both the
  layer description and the DAG need updating.
- The DAG itself is harder to read for newcomers than a stack.
  Onboarding needs to walk the DAG carefully.

**Trade-offs accepted:**
- Documentation cost is higher; engineering clarity is higher.

## Related

- `docs/brsi-spec.md` §5 (layers), §11 (DAG)
- ADR-0002 (Layer 5/6 split — visible at the layer level; the DAG
  shows Governance operating within Budget / Confidence /
  Fitness)
- INVARIANTS.md (most invariants touch DAG peers, not layered
  components)