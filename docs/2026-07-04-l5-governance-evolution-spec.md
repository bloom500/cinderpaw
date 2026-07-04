# BRSI Layer 5 — Governance Evolution: Specification

**Date:** 2026-07-04 · **Author:** Fable (architecture) · **Implementer:** another model (Sonnet/MiniMax) — this document is the contract.
**Status:** SPEC ONLY. No implementation here. Where the spec names an existing artifact, it has been verified to exist at the stated path on branch `feat/faza4-5-runtime-extraction`.

## 0. Mandate

L5 is the layer that keeps L6 (and every other evolving layer) from becoming dangerous. It does three things and only three things:

1. **Owns governance-as-data**: the bounds, gates, budgets and approval requirements that the other layers today hardcode become one versioned, verifiable `GovernancePolicy` object.
2. **Evolves asymmetrically**: policy changes that strictly *tighten* may be adopted automatically; anything else requires explicit human approval. Governance can never loosen itself.
3. **Verifies the evidence**: it makes the journals and histories the other layers decide on *tamper-evident*, and freezes evolution when verification fails.

"Governance Evolution" therefore means: the *parameters* of governance evolve (thresholds, budgets, windows), under a one-way ratchet toward strictness, with humans as the only path to relaxation. L5 never generates code, never mutates prompts, never touches models.

### Non-goals
- No policy DSL, no rule engine, no OPA-style language. The policy is a fixed-schema JSON document.
- No multi-tenant RBAC in v1 (single operator). The API introduces *operation classes* so roles can attach later.
- No remote/signed distribution of policies. Local file + hash chain only.
- Does not replace the Rust-owned invariants (ratchet monotonicity in `src-tauri/src/rsi/repo.rs`, sandbox walls). It *references* them; it cannot re-implement or weaken them.

## 1. Runtime Invariants (Tier G0 — immutable, hardcoded)

These are enforced by the policy **loader** in code, exactly like `clampMetaGenome` in `FeralAgent/src/rsi/meta-evolution.ts` enforces `META_BOUNDS`: any policy document violating them is clamped or rejected at load. No policy version, no approval, no operator flag can change them.

- **G-INV-1 (Strictness floor):** every gate in an active policy is ≥ the locked BRSI §9 #4 values: `pValueMax ≤ 0.05`, `effectSizeMin ≥ 0.1`, `confidenceMin ≥ 0.95` (see `DEFAULT_GATE_THRESHOLDS` in `FeralAgent/src/rsi/confidence.ts`). Meta bounds in policy must be subsets of the hardcoded `META_BOUNDS`.
- **G-INV-2 (One-way auto-ratchet):** a policy transition is auto-adoptable **iff** it is strictly-tightening under the partial order of §5. Everything else requires a human approval record.
- **G-INV-3 (Fail closed):** if no valid policy can be loaded (missing, corrupt, broken chain), the runtime uses the built-in strictest defaults and sets `frozen: true` for all evolution layers until an operator intervenes.
- **G-INV-4 (Verified evidence):** fitness/promotion decisions in any layer may only consume journals that pass hash-chain verification. This implements the existing TODO in `FeralAgent/src/rsi/journal.ts` (header, "TODO(hash-chain, v2)") and closes audit finding O1 of `docs/2026-07-04-l6-meta-evolution-audit.md`.
- **G-INV-5 (Chained governance audit):** every policy transition and every L6 evolve/rollback is mirrored into the tamper-evident audit chain (pattern: `FeralAgent/src/sandbox/audit-log.ts:47-52`, `sha256(prevHash || 0x02 || canonical(row))`, genesis `"GENESIS"`). Closes audit finding O6.
- **G-INV-6 (Human-only relaxation):** there is no API, CLI, IPC or internal code path that activates a non-tightening policy without a persisted `approvedBy` record. The approval UI is the only writer of that record.
- **G-INV-7 (Freeze supremacy):** when a layer is frozen, its evolve/propose/promote entry points return a refusal (`ok:false, reason`) — they do not queue, retry, or bypass.
- **G-INV-8 (Append-only provenance):** policy history and approval records are append-only JSONL; nothing rewrites.

## 2. Data Model

All files live under `~/.feral/rsi/governance/` (extend `InstancePaths` in `FeralAgent/src/rsi/instance-paths.ts` with a `governance` dir — that module is the single source of truth for paths).

### 2.1 `GovernancePolicy` (`policy.json` — the active version)

```jsonc
{
  "version": 1,                  // schema version, fixed at 1
  "policyId": "gp-7",            // monotonically increasing
  "parentId": "gp-6",            // null for genesis
  "createdAt": 1751600000000,
  "activatedAt": 1751600001000,
  "prevHash": "…",               // hash of the parent policy row in history
  "approval": null,              // null = auto-adopted (tightening); else {approvedBy, at, note}
  "frozen": { "l1": false, "l2": false, "l3": false, "l4": false, "l6": false },
  "gates": {                     // consumed by sidecar.ts evaluateGate wiring
    "pValueMax": 0.05,
    "effectSizeMin": 0.1,
    "confidenceMin": 0.95
  },
  "meta": {                      // consumed by meta-evolution.ts
    "bounds": { "mutation_rate": [0.01, 0.8], "exploration": [0.01, 0.5],
                "confidence_gate": [0.95, 0.995], "dream_batch": [5, 100],
                "selection_pressure": [0.1, 3.0] },
    "minCycles": 5,              // ≥ hardcoded MIN_META_CYCLES
    "acceptMargin": 0.02         // ≥ hardcoded META_ACCEPT_MARGIN
  },
  "budgets": {                   // outer walls over episode-options.ts / budget.ts
    "episodeMaxIterations": 100,
    "episodeMaxTokens": 2000000,
    "episodeMaxCostUsd": 0,
    "episodeMaxWallClockMs": 480000
  },
  "approvals": {                 // which layer actions REQUIRE a human
    "l3CodePatchApply": true,    // matches today's pending-patches gate
    "l2LoraPromote": true,       // matches today's LoRA review gate
    "l4ModulePromote": true,     // always true in v1 (L4 spec §6)
    "l6Evolve": false            // L6 epochs stay autonomous (bounded)
  }
}
```

Notes for the implementer:
- **Loader clamps, never trusts** — mirror the `clampMetaGenome` discipline: unknown keys dropped, every numeric clamped into its G0 wall, missing fields defaulted to the strictest built-in.
- The hardcoded consts in `meta-evolution.ts` (`META_BOUNDS`, `MIN_META_CYCLES`, `META_ACCEPT_MARGIN`) and `confidence.ts` remain in code as the G0 outer walls. Policy values are applied as *further clamps on top* (`max()`/`min()` composition, same trick as the tighten-only gate in `sidecar.ts`).

### 2.2 `policy_history.jsonl` (append-only, hash-chained)

One row per lifecycle transition (§3): `{ policyId, parentId, event, timestamp, actor, diff, reason, prevHash, hash }`. `diff` is a human-readable field list like the L6 history `diff` (`"gates.confidenceMin: 0.95 → 0.96"`).

### 2.3 `ProposedPolicy` (`proposals/gp-8.json`)

The full policy document plus `{ proposedBy: "operator" | "l6" | "system", direction: "tightening" | "relaxing" | "mixed", requiredApproval: boolean }`. `direction` is **computed by the loader**, never supplied by the proposer.

### 2.4 Journal hash chain (G-INV-4)

Extend `JournalEntry` writes in `FeralAgent/src/rsi/journal.ts` with `prevHash`/`hash` per the module's own TODO (chain marker `0x02`, genesis `"GENESIS"`, canonical JSON). Add `verifyJournal(path): { ok: boolean; badRow?: number }`. Chain is per-day-file (each file starts from GENESIS) — cross-file chaining is v2. `metaFitness` consumers (L6 `defaultReadWindow`) must skip files that fail verification and surface the failure as a governance event. **Back-compat:** rows without `hash` (pre-L5) verify as `legacy: true` and are accepted until the first chained row appears in a file; after that, unchained rows fail.

## 3. State Machine (policy lifecycle)

```
draft ──propose──► proposed ──[direction=tightening]──► active (auto, G-INV-2)
                      │
                      ├──[else]──► awaiting_approval ──approve──► active
                      │                    │
                      │                    └──reject──► rejected (terminal)
                      │
                      └──withdraw──► withdrawn (terminal)

active ──supersede(new active)──► superseded (terminal)
active ──rollback──► superseded  +  parent policy re-activated as a NEW policyId
frozen is a FLAG on the active policy, not a state — toggled by freeze/unfreeze events.
```

Rules:
- Exactly one `active` policy at all times (fail-closed built-in counts as the implicit active when none loads).
- `rollback` re-activates the parent **as a new policyId** with `parentId` = the rolled-back policy — history stays linear and append-only, mirroring the L6 revert-then-propose pattern.
- Freeze/unfreeze are transitions recorded in history (with actor + reason) even though they only flip flags.
- Unfreeze of a `frozen` set by G-INV-3 (fail-closed) or by verification failure requires `actor: "operator"`.

## 4. Safety Gates

Applied **in order** to every proposal at `propose` time; first failure terminates with a reason:

1. **Schema gate** — parses, version supported, unknown keys dropped.
2. **G0 gate** — every value inside its hardcoded wall (G-INV-1). Violations *reject* (not clamp) at propose time: a proposal that needed clamping is a buggy or hostile proposer and must be visible.
3. **Direction gate** — compute `direction` (§5). `tightening` → auto-adopt path; else `awaiting_approval`.
4. **Chain gate** — `prevHash` matches the current active policy's hash (no forked lineage; concurrent proposals race on this, loser must rebase).
5. **Freeze gate** — while `frozen.l6` (or global freeze), proposals from `l6` are refused outright (G-INV-7); operator proposals still flow.

## 5. Promotion Rules (the partial order)

A proposal is **tightening** iff *all* of the following hold, and at least one is strict:
- every `gates.*` is stricter-or-equal (`pValueMax ≤`, `effectSizeMin ≥`, `confidenceMin ≥`);
- every `meta.bounds.*` interval is a sub-interval of the current one; `minCycles ≥`; `acceptMargin ≥`;
- every `budgets.*` is `≤` current;
- every `approvals.*` is `≥` current (false→true is tightening; true→false is relaxing);
- `frozen.*` flags: setting a freeze is tightening; clearing one is relaxing.

Anything not tightening — including *mixed* changes — takes the human path. There is no netting ("tightened three things, loosened one" is `mixed` → approval).

Auto-adoption additionally requires a **cooldown**: at most one auto-adopted policy per 24h (prevents a runaway proposer from thrashing the active policy; excess tightening proposals queue).

## 6. Rollback Rules

- `rollback` is always available to the operator, needs no approval (relaxation-by-rollback returns to a policy that was itself legitimately active — record `actor` + `reason`).
- Rollback depth: one step per invocation (to `parentId`); repeated invocations walk back. No arbitrary-target jumps in v1.
- Rolling back past a policy that introduced journal chaining does **not** disable verification (G-INV-4 is G0, not policy).
- On rollback, all layers re-read policy on their next decision point — no restart required (accessor pattern, §7).

## 7. Interaction with L6

- **L6 reads through L5.** Replace the direct consts consumption: `MetaEvolution` and the `sidecar.ts` wiring take a `policy: () => GovernancePolicy` accessor (same live-accessor pattern as `metaParams` today). Effective bound = `intersect(hardcoded G0 wall, policy.meta.bounds)`; effective margin = `max(META_ACCEPT_MARGIN, policy.meta.acceptMargin)`; effective gate = the tighten-only composition already in `sidecar.ts`, further tightened by `policy.gates`.
- **L5 can freeze L6:** `frozen.l6 = true` → `MetaEvolution.evolve()` and `rollback()` return `ok:false, reason:"frozen by governance"`. `status()` keeps working (read is never frozen).
- **L6 may propose policy** (optional, v1.1): only tightening proposals, `proposedBy:"l6"`, e.g. "raise acceptMargin after 3 consecutive rejections". Never required for v1.
- **L5 consumes L6 evidence:** on every L6 evolve/rollback, one row into the chained governance audit (G-INV-5). L6's own `meta_history.jsonl` stays as-is (it gains no chain; the chained mirror is the authority).

## 8. Interaction with L3 / L4

- **L3 (code-RSI):** the existing human approval gate (`pending-patches.ts`, `rsi_code_patch_resolve` IPC) becomes policy-referenced: apply is allowed only if `approvals.l3CodePatchApply` is honored (it is `true` and cannot go `false` without human approval — which is intentionally circular and therefore sticky). Episode budgets for the code-RSI round respect `budgets.*`.
- **L2 (LoRA):** same — the LoRA review gate (`lora-eval-gate.ts`) reads `approvals.l2LoraPromote`.
- **L4 (architecture, specced separately):** every lifecycle transition in the L4 module pipeline calls a single `governanceCheck(action, context)` function exported by L5 — see `docs/2026-07-04-l4-architecture-evolution-spec.md` §7. L4 promotion requires `approvals.l4ModulePromote` (always true in v1).
- L5 exposes **one** check entry point to all layers: `governanceCheck(action: GovernedAction, ctx): { allowed: boolean; reason: string }` — layers never read policy fields ad hoc for permission decisions (they may read numeric knobs directly through the accessor).

## 9. Failure Modes (required handling)

| Failure | Required behavior |
|---|---|
| `policy.json` missing | Fail closed: built-in strictest defaults, `frozen.*` all true, governance event emitted, `feral doctor` check fails |
| `policy.json` corrupt / fails G0 | Same as missing, plus the corrupt file is preserved as `policy.json.quarantine-<ts>` for forensics |
| `policy_history.jsonl` chain broken | Freeze all evolution layers; read surfaces stay up; only operator `feral governance verify` + explicit `unfreeze` recover |
| Journal verification failure (G-INV-4) | The affected day-file is excluded from fitness windows; if the *current* window loses ≥ half its cycles, L6 refuses to settle (insufficient verified evidence); governance event emitted |
| Approval requested, no operator response | Proposal stays `awaiting_approval` indefinitely; no timeout-auto-anything |
| Two proposals race | Chain gate (§4.4): second proposer gets `prevHash mismatch`, must re-propose against the new active |
| Crash mid-activation | Activation = atomic temp+rename of `policy.json` **after** the history row is appended; recovery rule: if history's last row says `activated` but `policy.json` hash differs, re-write `policy.json` from history (history is the authority) |

## 10. Provenance Requirements

- Every policy version carries `parentId`, `prevHash`, `createdAt`, `actor`, computed `direction`, and full document — the lineage is replayable from genesis by folding history.
- Every approval record: who, when, free-text note, and the exact document hash approved (approving a hash, not an id — re-proposals need re-approval).
- Governance events (freeze, verification failure, fail-closed boot) are history rows too, not just logs.

## 11. Audit Requirements

- The governance audit chain is verifiable end-to-end offline: `feral governance verify` walks `policy_history.jsonl` + the mirrored L6 rows and reports the first break.
- Chain format identical across TS and Rust surfaces (marker `0x02`, genesis `"GENESIS"`) so `src-tauri/src/rsi/audit.rs`-style walkers can verify TS-written chains.
- No secrets in any governance artifact (policies contain thresholds only — assert in tests).

## 12. API (extends `crates/feral-core/src/api.rs`, same posture: 127.0.0.1 + bearer token)

```
GET  /governance/policy            → active policy (full document + hash)
GET  /governance/history?limit=50  → history rows, newest last
GET  /governance/proposals         → pending proposals
POST /governance/propose           → body: full policy document; returns {policyId, direction, status}
POST /governance/approve           → body: {policyId, documentHash, note}
POST /governance/reject            → body: {policyId, reason}
POST /governance/rollback          → one step
POST /governance/freeze            → body: {layers: ["l6", …], reason}
POST /governance/unfreeze          → body: {layers, reason}
GET  /governance/verify            → chain + journal verification report
```

Operation classes (for future roles; single token honors all in v1): `read` (GETs), `evolve` (propose), `govern` (approve/reject/rollback/freeze/unfreeze). Tag each route now; enforcement later.

Transport: same sidecar round-trip pattern as `/meta/*` (`meta_roundtrip` in `api.rs`): message types `governance_status | governance_propose | governance_approve | governance_reject | governance_rollback | governance_freeze | governance_unfreeze | governance_verify | governance_history`, replies `governance_result` correlated by `id`. Register the new inbound types in `FeralAgent/src/types.ts` **and** the `INBOUND_TYPES` allow-list in `FeralAgent/src/transports/tauri.ts` (the exhaustiveness assert will fail the build if you miss one — that is intentional).

## 13. CLI (extends `crates/feral-cli/src/main.rs` + `admin.rs`, reuse `fetch_json`/`post_json` + `palette()`)

```
feral governance status            # active policy, direction lineage, frozen flags
feral governance history
feral governance proposals
feral governance propose <file>    # reads a policy JSON from disk
feral governance approve <id>      # prints the diff, asks for confirmation, records approval
feral governance reject <id> [-m reason]
feral governance rollback
feral governance freeze <layer…> [-m reason]
feral governance unfreeze <layer…> [-m reason]
feral governance verify            # exit 0 = chains verified
```

`--json` honored everywhere (existing `json()` helper). `feral doctor` gains one check: active policy loads + chain verifies.

## 14. UI Hooks (desktop, minimal)

Reuse the FeralDreamsPanel card pattern (`MetaEvolutionCard` is the template):
- **Governance card**: active policy id + direction badge (`tightening auto` / `human-approved`), frozen-layer chips, verify status dot.
- **Approval inbox**: pending proposals rendered like `PendingPatches` — diff list, Approve / Reject buttons, disabled-while-resolving set. Approving writes the approval record (this UI is the only writer, G-INV-6).
- Events: one `governance_result` line type, same `events.onMetaResult`-style filtered listener.

## 15. Acceptance Criteria

1. Policy loader clamps/rejects per G0; property test: no loadable document can produce effective gates weaker than `DEFAULT_GATE_THRESHOLDS` or meta bounds wider than `META_BOUNDS`.
2. Direction computation: unit tests for tightening / relaxing / mixed on every field class; mixed → approval.
3. Auto-adoption: a strictly-tightening proposal activates without approval, appends chained history, survives process restart; cooldown enforced.
4. Relaxation: cannot activate without an approval record; approval of a stale hash fails.
5. Fail-closed: deleting/corrupting `policy.json` boots into strictest defaults with all layers frozen; quarantine file created; `feral governance status` and `feral doctor` show it.
6. Freeze: `frozen.l6` makes `feral meta evolve` return the governance refusal end-to-end (CLI → API → sidecar → MetaEvolution).
7. Journal chaining: new rows chain; `verifyJournal` detects a mutated middle row; L6 fitness excludes failed files; legacy unchained files pass as legacy.
8. Audit mirror: every L6 evolve/rollback and every policy transition appears in the chained audit; `feral governance verify` exit 0; flipping one byte anywhere → exit 1 naming the row.
9. Rollback: walks exactly one step, re-activates parent under a new id, layers pick it up without restart.
10. All existing suites stay green: `bun test` (FeralAgent), `cargo test -p feral-cli`, `cargo check -p feral-core -p feral`, frontend `vitest run`. Sidecar rebuilt (`bun run build` + copy to `src-tauri/binaries/` — see project memory: `cargo tauri dev` does NOT rebuild the sidecar).
11. Live smoke via headless gateway: propose-tighten → auto-active → freeze l6 → `feral meta evolve` refused → unfreeze → rollback → `verify` green. Documented in the PR like the L6 smoke.
