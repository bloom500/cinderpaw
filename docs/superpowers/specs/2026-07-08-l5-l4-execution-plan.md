# L5 + L4 Execution Plan — Governance first, Architecture second

**Date:** 2026-07-08 · **Author:** Fable · **Status:** EXECUTION PLAN (the design contracts already exist and are NOT restated here)

**Contracts (read them first, they are the spec):**
- L5: `docs/2026-07-04-l5-governance-evolution-spec.md`
- L4: `docs/2026-07-04-l4-architecture-evolution-spec.md`

This document adds only what those contracts don't have: premise re-verification on today's `main`, ordering, slice boundaries, delegation, and the gate to the next workstream (UI/UX unification across Desktop/TUI/Channels — deferred until L4+L5 are smoked).

---

## 0. Premise re-verification (2026-07-08, branch `main`)

The contracts were verified on `feat/faza4-5-runtime-extraction` on 2026-07-04. That branch has since merged to `main` (L6 included). Re-checked today:

| Premise | Status |
|---|---|
| `FeralAgent/src/rsi/{meta-evolution,confidence,journal,instance-paths,provenance,contract-runner,pending-patches,genome,get-specs,run-eval}.ts` | ✅ all exist on main |
| `FeralAgent/src/sandbox/audit-log.ts` chain pattern | ✅ exists |
| `journal.ts` header `TODO(hash-chain, v2)` | ✅ still open — L5 G-INV-4 implements it |
| `genome.ts` `RETRIEVAL_STRATEGIES` pool | ✅ unchanged (4 builtins) |
| `transports/tauri.ts` `INBOUND_TYPES` exhaustiveness wall | ✅ unchanged, `meta_evolve` registered — same registration path for `governance_*` / `modules_*` |
| `api.rs` `meta_roundtrip` pattern + `/meta/history` | ✅ present — template for `/governance/*`, `/modules/*` |

**Deltas since 2026-07-04 the implementer must absorb:**
1. **Brain Stack landed** (Classifier→CapabilityRouter, capability registry). L4 §12.4's `capabilitiesMeasured` domain vocabulary must use the registry's actual domain names — read the live registry code before hardcoding domains in the EvalReport aggregation.
2. **TUI exists now** (`tui/`, command Registry per TUI-overhaul P0.8). New CLI commands (`feral governance …`, `feral modules …`) live in `crates/feral-cli` per the contracts; TUI slash-commands for them are **out of scope** here (they ride the UI/UX unification workstream, §4).
3. **Working tree is dirty** (connectors-pairing WIP). L5/L4 work starts from a clean feature branch off main after the pairing work is committed or stashed — do not interleave.

If any other named artifact has drifted when you start, re-locate by symbol name and note the correction in the PR; do not silently improvise (see memory: verify spec premises before implementing).

---

## 1. Order: L5 → L4, strictly

L4 §7 calls L5's `governanceCheck()` on every lifecycle transition. The L4 contract permits a local stub — we don't use that permission. Building L5 first means:
- L4 lands governed from its first commit (no stub-removal follow-up, no window where module promotion bypasses policy).
- L5's journal hash-chain (G-INV-4) is in place before L4 starts writing contract-FSM journal rows, so L4's evidence is chained from row one.

## 2. Phase A — L5 Governance (slices, each independently committable)

| Slice | Content | Contract §§ | Accept |
|---|---|---|---|
| A1 | `GovernancePolicy` schema + G0 loader (clamp/reject/fail-closed) + `InstancePaths.governance` | §1, §2.1, §9 rows 1–2 | AC 1, 5 |
| A2 | Journal hash-chain: `prevHash`/`hash` on `JournalEntry`, `verifyJournal`, legacy back-compat; L6 `defaultReadWindow` skips failed files | §2.4 | AC 7 |
| A3 | Lifecycle FSM: propose/direction/auto-adopt/approval/rollback/freeze + `policy_history.jsonl` chain + governance audit mirror | §3–§6, §10, §11 | AC 2, 3, 4, 8, 9 |
| A4 | Integration: L6 reads through policy accessor; `governanceCheck()` single entry point; L2/L3 approval flags policy-referenced | §7, §8 | AC 6 |
| A5 | API (`/governance/*` via sidecar round-trip; register inbound types in `types.ts` + `INBOUND_TYPES`) + CLI (`feral governance …`) + `feral doctor` check | §12, §13 | AC 10 |
| A6 | Desktop UI: Governance card + approval inbox (MetaEvolutionCard/PendingPatches patterns) | §14 | visual |
| A7 | Live smoke on headless gateway (contract §15.11 sequence), documented in PR | §15.11 | AC 11 |

## 3. Phase B — L4 Architecture (after A7 is green)

| Slice | Content | Contract §§ | Accept |
|---|---|---|---|
| B1 | Seam catalog (data-driven from day one, §12.1) + `ModuleManifest` loader (frozen shape, forward-compat fields validated-but-inert) + `ModuleRegistry` + envelope `kind:"module"` | §1, §2, §12.1–12.2 | AC 7, 11 |
| B2 | Module host: Bun subprocess, JSON-lines protocol, lexical import wall, resource walls, seeded RNG | §4 | AC 3 |
| B3 | Seam adapters in runtime (retrieval_strategy, planner) + builtin fast-path (byte-identical when no module active) + watchdog auto-quarantine | §1, §8 | AC 4, 10 |
| B4 | Eval: paired shadow eval over existing harness + `evaluateGate` + Tier-0/latency floors + `capabilitiesMeasured` (Brain Stack domain vocab — see delta #1) | §5 | AC 5, 12 |
| B5 | Promotion: contract FSM `layer:"L4"` + `governanceCheck` (real L5, no stub) + human approval via pending-approval UX + registry re-point | §6, §7 | AC 1, 6 |
| B6 | API/CLI/Desktop card + fixture sample modules in `FeralAgent/tests/fixtures/modules/` | §10, §11.1 | AC 1, 9 |
| B7 | Live smoke: promote sample module → active → demote; zero-writes-outside-modules-dir assertion | §11.2, §11.9 | AC 2, 9 |

## 4. Gate to the next workstream

**UI/UX unification (Desktop–agent–TUI–Channels, "one presence, many rooms")** starts only after B7. Darius's vision text for it is captured; its spec will be written then, and will absorb the surfaces L5/L4 just added (governance card, modules card, CLI commands → TUI command Registry, connector-side notifications for "Feral learned something" events).

## 5. Delegation (per the established split)

- **Fable/Opus:** stateful/integration slices — A3 (FSM), A4 (cross-layer wiring), B2 (module host), B3 (seam adapters + watchdog), B5 (promotion path).
- **MiniMax (fixed contracts, pure leaves):** A1 (loader + clamps — mirror `clampMetaGenome`), A2 (hash-chain — pattern given in `audit-log.ts:47-52`), B1 (manifest/registry validation), B4 eval-report serialization, CLI subcommand plumbing in A5/B6 (mirror `admin.rs`).
- Every MiniMax deliverable: verify on-disk output before review (memory: MiniMax output may not sync).

## 6. Standing rules (from the contracts, repeated because they get skipped)

- Sidecar rebuild after every TS change: `bun run build` + copy to `src-tauri/binaries/` — `cargo tauri dev` does NOT do it.
- Suites that must stay green per slice: `bun test` (FeralAgent), `cargo test -p feral-cli`, `cargo check -p feral-core -p feral`, frontend `vitest run`, `go test ./...` in `tui/` (untouched, but run it — shared api.rs surface).
- Append-only + temp+rename for every persisted artifact; no secrets in governance artifacts; fail loud, never silent-clamp at propose time.
