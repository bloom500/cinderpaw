# ADR-0004: Single Evolution Event Schema

**Status:** Accepted
**Date:** 2026-06-30

## Context

Feral has three near-overlapping observability surfaces today:

- `~/.feral/rsi/dream.jsonl` — per-episode telemetry, 10 flat fields,
  written by `dream-telemetry.ts`.
- `~/.feral/rsi/sandbox_bounds.audit.log` — SandboxBounds mutations,
  hash-chained, written by `audit.rs`.
- The forthcoming Evolution Journal — per-cycle structured log, written
  by `journal.ts` (one row per cycle).

Three formats, three consumers, three places to look when something
goes wrong. Adding a fourth (the dashboard the user is planning)
without unifying the schema would make this worse: each new consumer
reinvents its own data shape.

The single biggest cost in observability tooling is not "we don't
have a dashboard" — it's "every dashboard tells a slightly different
story because each reads from its own source".

## Decision

Define a single `EvolutionEvent` schema (`docs/observability-data-model.md`)
that every observability consumer reads from. Existing surfaces
collapse into it:

| Today | After |
| ----- | ----- |
| `dream.jsonl` (per-episode) | `CycleStarted` + `CycleCompleted` events |
| `sandbox_bounds.audit.log` (hash-chained) | `BoundsChanged` events (with the same hash-chain discipline applied to the event stream) |
| Evolution Journal | `JournalWritten` event + a per-cycle summary view derived from the stream |

Adding a new observability consumer (dashboard, metrics, audit)
becomes adding a subscriber to the event stream. Adding a new event
type is an ADR + schema bump.

## Consequences

**Easier:**
- One source of truth. Every consumer tells the same story.
- New dashboards / metrics / alerts are additive — no schema
  reinvention.
- The audit chain can wrap the event stream (vs the bounds
  mutations specifically) for a uniform tamper-evidence story.

**Harder:**
- Migration: existing telemetry (`dream-telemetry.ts`) and the
  bounds audit (`audit.rs`) need to emit events instead of (or in
  addition to) their current formats. The bounds audit chain
  *can* keep its current file as a downstream consumer.
- Schema discipline: every new event kind needs an ADR. Bumps the
  cost of small additions.

**Trade-offs accepted:**
- A unified stream requires every producer to agree on the event
  schema. The cost is in coordination, not implementation.

## Related

- `docs/observability-data-model.md` (the schema itself)
- INVARIANTS.md I3, I4 (Journal append-only, corruption observable)
- ADR-0007 (Trust boundary — events from the agent side cannot
  redefine the schema)