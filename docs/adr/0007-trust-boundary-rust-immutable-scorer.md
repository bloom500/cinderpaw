# ADR-0007: Trust Boundary — Rust-Immutable Scorer

**Status:** Accepted
**Date:** 2026-06-30

## Context

The entire safety story for BRSI rests on one property: **the agent
cannot edit the formula that decides whether it improved**. If the
scorer were in TypeScript (the sidecar's language), the agent could
rewrite it at runtime — it has write access to its own skill files,
and the inference router is the only thing it can't bypass.

If the agent could redefine "better", every safety mechanism in the
system (confidence gate, budget halt, Tier 0 floor) becomes a
performance suggestion, not a contract.

## Decision

The scorer formula + weights + per-resource normalisation constants
+ Tier 0 specs + SandboxBounds live in **Rust**, compiled into the
sidecar binary. The agent cannot modify them at runtime.

- The sidecar binary is in a directory the agent has no filesystem
  write access to.
- Every change to a bound requires UI confirmation and is
  hash-chained in `audit.rs::sandbox_bounds.audit.log`.
- There is NO bridge command `rsi_set_bounds`. The bounds change
  path is intentionally not exposed to the agent.

The agent can ship better eval **outcomes**; it cannot redefine
what "better" means.

## Consequences

**Easier:**
- Asymmetric trust boundary is unambiguous. TS = agent territory.
  Rust = engine / host territory.
- The scorer is testable in isolation (Rust's pure functions,
  no globals, no IO).
- A future self-modifying proposal that says "let's also let the
  agent adjust the scorer weights" has an immediate answer:
  violates the trust boundary.

**Harder:**
- Scorer changes require a sidecar rebuild. The dev cost is real
  (the AGENTS.md note about sidecar rebuild workflow).
- Rust is a steeper learning curve for new contributors than
  TypeScript. The scorer is locked behind a smaller pool of
  maintainers.
- Adding new eval signals (e.g., a 5th / 6th component in BRSI
  §2.2) requires Rust changes, not just TS adapter work.

**Trade-offs accepted:**
- The dev cost of Rust changes is real but smaller than the safety
  cost of a mutable scorer.

## Related

- `src-tauri/src/rsi/scorer.rs` (the scorer itself)
- `src-tauri/src/rsi/tier0.rs` (the 13 frozen Tier 0 checks)
- `src-tauri/src/rsi/sandbox_bounds.rs` (immutable contract)
- INVARIANTS.md I7 (scorer immutable), I8 (Tier 0 immutable),
  I9 (SandboxBounds agent-immutable)
- ADR-0002 (Layer 5 — Governance — operates *within* this
  boundary; Layer 6 — Meta — would have to challenge it)