# A5 Brief — L5 Governance API + CLI (for MiniMax)

**Date:** 2026-07-08 · **Author:** Fable · **Slice:** A5 of `docs/superpowers/specs/2026-07-08-l5-l4-execution-plan.md` (Phase A table)
**Contract:** `docs/2026-07-04-l5-governance-evolution-spec.md` §12 (API) + §13 (CLI). Read both sections before writing code.
**Branch:** `feat/l5-governance` (A1–A4 are already committed there: 81c8076, 2d7802a, c8ac3f0, efbe14c).

## Ground rules (non-negotiable)

1. **Do NOT touch `tui/`** — TUI commands ride the later UI/UX workstream (plan §0 delta #2). CLI only.
2. **Do NOT modify the governance core** — `FeralAgent/src/rsi/governance.ts`, `governance-lifecycle.ts`, `governance-audit.ts`, `hash-chain.ts`, `journal.ts`, `meta-evolution.ts` are frozen contracts. You only *call* them.
3. Every artifact you reference below has been verified to exist on the branch. If something doesn't match, STOP and report — do not improvise a replacement.
4. All suites must stay green: `cd FeralAgent && bunx tsc --noEmit && bun test`, `cargo test -p feral-cli`, `cargo check -p feral-core -p feral`.
5. After TS changes: `cd FeralAgent && bun run build` + copy the binary to `src-tauri/binaries/` (cargo tauri dev does NOT rebuild the sidecar).

## The three layers of plumbing (mirror the /meta/* pipeline end to end)

### 1. Sidecar (TypeScript, `FeralAgent/`)

**Message types** — add to `src/types.ts` following the existing `meta_status | meta_evolve | meta_rollback | meta_history` pattern (grep `meta_evolve` to find every place a meta type is declared, including the inbound union):

```
governance_status | governance_propose | governance_approve | governance_reject |
governance_rollback | governance_freeze | governance_unfreeze | governance_verify |
governance_history
```

Reply type: `governance_result` (mirror `meta_result`: `{ type: "governance_result", id, op, ...payload }`, payload always has `ok: boolean`).

**Inbound allow-list** — register all nine in `INBOUND_TYPES` in `src/transports/tauri.ts`. There is an exhaustiveness assert that fails the BUILD if you miss one; that is intentional. Check whether `src/transports/connectors.ts` has its own inbound list mirroring it (grep `meta_evolve` there too).

**Handlers** — in `src/index.ts`, next to the existing `case "meta_status":` block (grep it). Construct the lifecycle lazily ONCE (same pattern as the `codePatchGate()` lazy singleton just above the L3 handlers):

```ts
import { GovernanceLifecycle } from "./rsi/governance-lifecycle.ts";
// lazy: const governanceGate = () => (glInstance ??= new GovernanceLifecycle({ log }));
```

Op → call mapping (all methods exist with these exact signatures):

| op | call |
|---|---|
| status | `gl.status()` |
| propose | `gl.propose(msg.document, "operator")` — document arrives as a JSON object in the message |
| approve | `gl.approve(msg.id, msg.documentHash, msg.note ?? "", "operator")` |
| reject | `gl.reject(msg.id, msg.reason ?? "", "operator")` |
| rollback | `gl.rollback(msg.reason ?? "operator rollback", "operator")` |
| freeze | `gl.freeze(msg.layers, msg.reason ?? "", "operator")` — layers: `("l1"\|"l2"\|"l3"\|"l4"\|"l6")[]` |
| unfreeze | `gl.unfreeze(msg.layers, msg.reason ?? "", "operator")` |
| verify | `gl.verify()` **plus** journal check: run `verifyJournal(join(defaultJournalDir(), journalFilename(day)))` (from `./rsi/journal.ts`) for the last 7 UTC days; report `{ chains: gl.verify(), journal: [{file, ok, badRow?, reason?}] }` |
| history | `gl.historyRows(msg.limit ?? 50)` |

Results that are `{ ok: false, reason }` from the FSM are NOT transport errors — send them through as `governance_result` with `ok: false`.

### 2. API (Rust, `crates/feral-core/src/api.rs`)

Mirror `meta_roundtrip` and the `/meta/*` routes exactly (grep `meta_roundtrip` and `/meta/history`). Routes per spec §12:

```
GET  /governance/policy            → op status
GET  /governance/history?limit=50  → op history
GET  /governance/proposals         → op status (pending[] is inside the status payload)
POST /governance/propose           → op propose  (body = the full policy JSON document)
POST /governance/approve           → op approve  (body: {policyId, documentHash, note})
POST /governance/reject            → op reject   (body: {policyId, reason})
POST /governance/rollback          → op rollback
POST /governance/freeze            → op freeze   (body: {layers, reason})
POST /governance/unfreeze          → op unfreeze (body: {layers, reason})
GET  /governance/verify            → op verify
```

Same posture as everything else in the file: 127.0.0.1 + bearer token. Tag each route with its operation class as a code comment (`read` for GETs, `evolve` for propose, `govern` for the rest) — no enforcement in v1 (spec §12 last paragraph).

### 3. CLI (Rust, `crates/feral-cli/`)

Mirror the existing `feral meta …` subcommand plumbing in `src/main.rs` + `src/admin.rs` (reuse `fetch_json`/`post_json` + `palette()`; `--json` honored everywhere via the existing `json()` helper). Commands per spec §13:

```
feral governance status | history | proposals | verify
feral governance propose <file>          # reads policy JSON from disk, POSTs it
feral governance approve <id>            # fetch proposal doc → print diff → confirm → POST with its sha256 documentHash
feral governance reject <id> [-m reason]
feral governance rollback
feral governance freeze <layer...> [-m reason]
feral governance unfreeze <layer...> [-m reason]
```

For `approve`: the documentHash is computed by the SIDECAR world (sha256 over canonical sorted-key JSON). Don't re-implement canonical JSON in Rust — add the proposal's `documentHash` to the `status()` pending[] payload? **No — do not modify governance-lifecycle.ts.** Instead: `GET /governance/proposals` already returns pending ids; have `approve` fetch `GET /governance/policy`… ➜ **Simplest correct path:** send `documentHash: null` is NOT allowed (stale-hash safety is AC4). So: add a *sidecar-side* convenience — in the `approve` **handler** in `index.ts` (yours to write), if `msg.documentHash` is absent, compute it there via `sha256Canonical(gl.proposalDocument(msg.id))` (both exported from `./rsi/hash-chain.ts` / `governance-lifecycle.ts`) and echo the hash in the result. CLI `approve` then: GET proposals → confirm interactively → POST without hash → print the recorded hash. The stale-hash protection stays available for API callers that pass an explicit hash.

`feral governance verify` exits 0 iff all chains + journal files verify (spec AC 8/11).

**Doctor:** `feral doctor` gains ONE check — `GET /governance/policy` succeeds AND `GET /governance/verify` is green AND the policy is not the fail-closed builtin (`source == "file"`). Grep `doctor` in `crates/feral-cli/src/main.rs` for the check-list pattern.

## Tests required

- TS: handler-level test optional; the FSM is already covered (83 governance tests). At minimum add a types test that the nine inbound types are in `INBOUND_TYPES` (the build assert also covers it).
- Rust: `cargo test -p feral-cli` — add subcommand parse tests mirroring the existing `meta` CLI tests (grep `meta` in feral-cli tests).
- Acceptance: spec §15 AC 10 (all suites green, sidecar rebuilt).

## Deliverable

Commits on `feat/l5-governance` (do not rebase/squash the A1–A4 commits). Report: files touched, test counts, and the exact sidecar rebuild command you ran. Fable will verify on-disk output before review (established rule).
