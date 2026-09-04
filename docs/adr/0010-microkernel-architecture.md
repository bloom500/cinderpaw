# ADR-0010: Microkernel Architecture

**Status:** Accepted
**Date:** 2026-06-30

## Context

The 8 production modules in `CinderpawAgent/src/rsi/` already exhibit a
microkernel pattern, even though it has not been named:

```
  ┌────────────────────────────────────────┐
  │           KERNEL (engine.ts)           │
  │     + EventBus + Ratchet + Champion    │
  │     + Contract FSM (Opus territory)   │
  │     + Dream Cycle (Opus territory)    │
  └─────────────────┬──────────────────────┘
                    │
     ┌──────────────┼──────────────┐
     │              │              │
     ▼              ▼              ▼
┌─────────┐   ┌─────────┐   ┌──────────┐
│Confidence│  │ Budget  │  │Provenance│
└────┬────┘   └────┬────┘   └────┬─────┘
     │              │              │
     ▼              ▼              ▼
┌─────────┐   ┌──────────┐  (audit chain)
│ Journal │   │ Personal │
└────┬────┘   │ Fitness  │
     │        └──────────┘
     ▼
   (rust
   substrate)
```

- `confidence.ts` knows nothing about `budget.ts`.
- `budget.ts` references `journal.ts` only for the `DreamStage` type
  re-export.
- `journal.ts` knows nothing about any other module.
- `personal-fitness.ts` knows nothing about `confidence.ts` or
  `budget.ts`.
- `provenance.ts` references only `bridge.ts` (a substrate adapter).

The kernel orchestrates by composition (via the EventBus and direct
dependency injection). Modules are independent. Cross-module
communication goes through the bus or through injected dependencies,
not through shared mutable state.

This is the discipline that lets:
- Confidence be tested without budget.
- Budget be tested without journal.
- The whole wiring be rebuilt at the engine composition root without
  touching any module.

## Decision

Adopt the **microkernel architecture** as an explicit design
principle. The FER's kernel is small (engine.ts + EventBus +
ratchet + champion). Everything else is an independent module that
the kernel composes.

**Rules:**

1. **Modules don't reach into other modules' state.** Cross-module
   communication goes through:
   - The EventBus (events)
   - Injected dependencies (the kernel passes them in)
   - Pure data structures returned by module APIs
2. **Modules are independently testable.** A test for `confidence.ts`
   does not require `budget.ts`, `journal.ts`, or any other module
   to be loaded. (Current state: this holds.)
3. **Adding a new module doesn't touch existing modules.** A new
   `metrics.ts` would consume events from the bus and Journal
   entries from disk; it does not need changes to `confidence.ts`,
   `budget.ts`, or anything else.
4. **The kernel owns composition.** All cross-module wiring happens
   in `engine.ts` (Opus's territory). Modules stay clean.
5. **Modules don't import each other except for type re-exports.**
   `budget.ts` imports `DreamStage` from `journal.ts` because it's
   a type-only re-export. `personal-fitness.ts` doesn't import from
   anything in `rsi/`. `confidence.ts` doesn't import from anything
   in `rsi/`.

**What this enables:**

- Replacing `confidence.ts` with `confidence-v2.ts` (a different gate
  strategy) is a one-line change in the engine composition root.
- Adding a new module (e.g., a Goodhart-aware mutation policy) is
  additive.
- Testing the kernel does not require booting any module; testing a
  module does not require booting the kernel.

## Consequences

**Easier:**

- Refactor scope is explicit: "this change touches module X and the
  kernel's wiring" — both visible in the dependency graph.
- Module ownership is clean: each module has one author, one test
  surface, one purpose.
- The architecture scales: more modules ≠ more coupling.

**Harder:**

- Some operations naturally want to span modules (e.g., a metrics
  aggregator that consumes both confidence and budget). The
  discipline says: that's a new module that reads from the bus +
  reads from the journal, NOT a method on either confidence or
  budget.
- Type re-exports between modules (like `budget.ts` importing
  `DreamStage` from `journal.ts`) create one-way dependencies.
  Discipline needed to keep these minimal and one-directional.

**Trade-offs accepted:**

- The kernel grows slightly as more wiring happens. That's OK — the
  kernel is small.

## Related

- `docs/brsi-spec.md` §10 (Architecture DAG) — the kernel and its
  peers, drawn out
- `docs/wiring-spec.md` §6 — the kernel's wiring responsibilities
- ADR-0009 (FER naming) — the FER is the kernel; the Personal Agent
  is one of its consumers
- INVARIANTS.md — most invariants are owned by one module; the
  kernel composes the checks
- Module ownership map (in topic file) — which module owns which
  invariant