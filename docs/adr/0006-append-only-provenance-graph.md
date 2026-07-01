# ADR-0006: Append-Only Provenance Graph

**Status:** Accepted
**Date:** 2026-06-30

## Context

In a self-improving system, "where did this come from?" is the most
important question. Without provenance:

- Rollback is impossible: you don't know what state to roll back to.
- Debugging is archaeology: every regression looks like a fresh
  mystery.
- Trust is impossible: the user can't verify "this LoRA was trained
  on my data, not someone else's".

The git substrate already gives us provenance for code / config
commits (`src-tauri/src/rsi/repo.rs`). For non-code artifacts
(LoRA adapters, UIA demos, personal eval tasks), no provenance
exists yet.

## Decision

Provenance is an **append-only graph**:

1. **Code / config**: git substrate. Each commit carries parent
   hashes. Iteration metadata in the commit body identifies the
   lineage.
2. **Non-code artifacts** (LoRA / demo / eval_task): typed envelopes
   (`ArtifactEnvelope` in `FeralAgent/src/rsi/provenance.ts`) with
   `parents: string[]`. Storage: `~/.feral/rsi/envelopes/<id>.json`
   (deferred to Step 6 of BRSI refactor sequence).
3. **No node deletion.** A retired champion is `ChampionRetired`,
   not "removed". Supersession is recorded as a new node pointing
   to the old one.
4. **Queries are O(parents + children).** `show(id)` walks ancestors
   once; `descendants(root)` BFS-es the reverse index; both
   bounded by cache size.

## Consequences

**Easier:**
- Rollback is always possible (INVARIANT I2).
- Lineage queries are fast and bounded.
- The trust story strengthens: every artifact has a verifiable
  history.

**Harder:**
- Append-only means the graph grows monotonically. Storage pressure
  over years of use. Mitigation: archive to cold storage; in-memory
  cache bounded.
- Non-code artifact storage is TODO. Until envelopes land, LoRA /
  demo / eval_task are "untyped" — they exist but can't be queried
  by parent.

**Trade-offs accepted:**
- Storage growth is a real cost; we accept it for the trust
  guarantee.

## Related

- `FeralAgent/src/rsi/provenance.ts` (the read-side graph)
- `src-tauri/src/rsi/repo.rs` (git substrate)
- INVARIANTS.md I2 (rollback always possible), I12 (graph acyclic)
- `docs/brsi-spec.md` §2.6, §4.6