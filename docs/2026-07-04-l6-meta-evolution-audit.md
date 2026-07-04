# L6 Meta Evolution — Production Robustness Audit

**Date:** 2026-07-04 · **Auditor:** Fable (author-adversarial pass over the final implementation)
**Scope:** `FeralAgent/src/rsi/meta-evolution.ts`, its wiring (`sidecar.ts`, `index.ts`), the surfaces (`api.rs` `/meta/*`, `admin.rs feral meta`, `feral_meta` + `MetaEvolutionCard`), and their interaction with the journal, PBT and the dream cycle.
**Posture:** no redesign; the layer ships as-is. Findings only: severity, why it matters, minimal fix, ship verdict.

**Verdict: SHIPPABLE** for the local single-user trust model, after the three fixes applied in this pass (F1–F3 below). Two findings (O1, O6) are integrity gaps that are acceptable locally but must be closed by **L5 Governance** before any enterprise/multi-tenant claim — they are explicitly assigned to the L5 spec.

---

## Fixed during this audit (were ship blockers)

### F1 — Acceptance was a coin flip under noise → long-term drift ✅ FIXED
- **Severity:** HIGH (statistical weakness, convergence risk)
- **Why:** baseline and candidate fitness are measured over **different time windows** (different workloads, different luck). They are not paired samples. With bare strict-greater and `MIN_META_CYCLES = 3`, acceptance under a true null effect is ~50% — the metaparams random-walk their bounds forever and every "accepted" row is unearned. L1 has a bootstrap confidence gate for exactly this; L6 had nothing.
- **Fix applied:** `META_ACCEPT_MARGIN = 0.02` (accept requires `score > baseline + margin`) and `MIN_META_CYCLES` 3 → 5. Test pins the margin (a +0.002 window is rejected).
- **Residual risk:** the margin is a heuristic, not a significance test. When per-cycle fitness samples are numerous enough, replace with a bootstrap over per-cycle scores (reuse `confidence.ts` machinery). Not blocking.

### F2 — Corrupt state file silently reset provenance ✅ FIXED
- **Severity:** MEDIUM-HIGH (provenance gap, replay problem)
- **Why:** `writeFileSync` is not atomic; a crash mid-write leaves truncated JSON. The old recovery path returned generation 0 **without writing a history row**, so the generation counter reset while history still held higher generations — duplicate generation numbers, unreplayable lineage.
- **Fix applied:** persist via temp-file + `renameSync`; corrupt-state recovery resumes at `max(history generation) + 1` and appends an explicit `bootstrap … recovered` row. `history()` now skips individual corrupt rows instead of returning `[]` (one bad line no longer hides all provenance). Both behaviors pinned by tests.

### F3 — `rollback_window` was an unwired search dimension ✅ FIXED
- **Severity:** MEDIUM (convergence risk, honest-genome violation)
- **Why:** the field mutated but steered nothing — a pure noise axis eating 1/5 of all mutations, whose "accepted" generations would be statistical lies (credit with no mechanism).
- **Fix applied:** removed from `MetaGenome` entirely. Old state files load fine (`clampMetaGenome` drops unknown keys). Reintroduce only together with a real consumer.

---

## Open findings (documented, non-blocking locally)

### O1 — The Evolution Journal is an unauthenticated decision input
- **Severity:** HIGH for integrity claims; MEDIUM in the local single-user trust model
- **Why it matters:** L6 fitness is computed from `~/.feral/rsi/journal/*.jsonl`, which is best-effort JSONL with **no hash chain** — `journal.ts`'s own TODO says "when the journal becomes a Layer-5 input, add `verifyJournal`". That threshold is now crossed: anything that can append plausible rows (any local process, or a compromised sidecar component) can steer meta-acceptance. This is the ASI06 poisoning gap applied to the meta layer.
- **Minimal fix:** implement the existing TODO — sha256 chain per row mirroring `sandbox/audit-log.ts:47-52` / `src-tauri/src/rsi/audit.rs:226-232`, plus `verifyJournal(path)`; `metaFitness` refuses (returns null) on verification failure.
- **Blocks shipping?** No (local, single user, loopback). **Yes** before enterprise claims. → **Assigned to L5 spec (G-INV-4).**

### O2 — No auto-settle: a pending candidate steers indefinitely
- **Severity:** MEDIUM
- **Why:** `evolve()` is manual (CLI/API/UI). If nobody calls it again, a mediocre-but-bounded candidate steers the live search forever; the epoch never closes. Bounds cap the damage (worst case: sigmas ×~8, gate at 0.995, dream_batch 100), but "worse search for weeks" is a real cost.
- **Minimal fix:** one hook — on dream-episode end (`onIdle` in `index.ts`), if a candidate is pending and its window has ≥ `MIN_META_CYCLES`, call `evolve()` automatically. Operator cadence stays available; the epoch self-closes.
- **Blocks?** No. Operator has `feral meta status` + `rollback`.

### O3 — Stale baseline after rejection
- **Severity:** MEDIUM (drift, regression-to-mean bias)
- **Why:** on rejection, the next candidate inherits `baseline.score` measured in an increasingly old window. Workload drift makes the champion's recorded score progressively less comparable; a lucky old baseline becomes an unfair bar (and vice versa).
- **Minimal fix:** expire baselines: if `baseline.score` is older than N days (or M epochs), spend one epoch re-measuring the champion (deploy champion, no mutation) before proposing again.
- **Blocks?** No — the acceptance margin absorbs most of it.

### O4 — Fitness attribution is confounded
- **Severity:** MEDIUM (slows genuine convergence; no safety impact)
- **Why:** inside a candidate's window, PBT (Faza 3.5) rotates strategy hyperparams, the model may change, and user workload shifts. The window's fitness credits/blames the meta-genome for all of it.
- **Minimal fix:** record context into history rows (active PBT strategy id, model id, window `[from, to]`, cycle count) so post-hoc analysis can detect confounds; optionally require windows to span ≥ 2 distinct days.
- **Blocks?** No.

### O5 — Mid-episode genome switch
- **Severity:** LOW-MEDIUM
- **Why:** the sidecar reads `metaParams()` live per birth and per gate evaluation. An `evolve()` landing mid-dream-episode changes grammar sigmas/gate strictness mid-episode; that episode's journal row then spans two genomes and pollutes both windows (attribution noise, not a safety issue — the gate can only tighten).
- **Minimal fix:** exclude from the fitness window any cycle whose `cycleId` timestamp predates `deployedAt` (cheap timestamp fence), or snapshot `metaParams()` once at episode start in `sidecar.ts`.
- **Blocks?** No.

### O6 — Meta operations bypass the tamper-evident audit log
- **Severity:** MEDIUM (audit/compliance)
- **Why:** evolve/rollback are governance-relevant actions recorded only in `meta_history.jsonl` (append-only but **not** hash-chained), unlike tool calls which land in the chained sandbox `AuditLog`. An attacker who can edit the history can rewrite the meta lineage undetectably.
- **Minimal fix:** mirror one row per meta transition into the existing `sandbox/audit-log.ts` chain.
- **Blocks?** No locally. → **Assigned to L5 spec (G-INV-5).**

### O7 — Single permission tier on `/meta/*`
- **Severity:** LOW locally, MEDIUM enterprise
- **Why:** the same bearer token that allows chat allows `POST /meta/evolve|rollback`. Loopback + token makes this acceptable for one user on one machine; it is not a role model.
- **Minimal fix:** none now; L5 introduces operation classes (read / evolve / govern). **→ L5 spec (API section).**

### O8 — Cycle-boundary attribution
- **Severity:** LOW
- **Why:** a dream cycle that *starts* under genome A and *ends* (writes its row) after genome B deploys is counted for B.
- **Minimal fix:** same timestamp fence as O5. **Blocks?** No — at most one cycle per epoch is misattributed, and MIN_META_CYCLES=5 dilutes it.

### O9 — 7-day window cap truncates long-lived candidates
- **Severity:** LOW
- **Why:** `defaultReadWindow` reads the last 7 UTC day-files. A candidate deployed >7 days ago silently loses its earliest evidence. Fitness stays valid (recent evidence is arguably better), but `cycles` under-reports.
- **Minimal fix:** derive the day range from `deployedAt` instead of a constant 7. **Blocks?** No.

### O10 — Concurrency review (verified safe, no action)
- `evolve()`/`rollback()` are fully synchronous (sync fs) → the JS event loop serializes them; no torn state between IPC, API and UI callers. A double-evolve race resolves safely: the second call sees a fresh `deployedAt`, finds < MIN cycles, and refuses. The Rust `/meta/*` round-trip subscribes to the event bus **before** sending (no lost-reply race), correlates by UUID, 10s timeout. Desktop `feral_meta` sends no `id` (reply carries `id:""`), which is benign for the single panel but means two desktop panels could not distinguish replies — cosmetic.

### O11 — Fitness replay is under-specified in history rows
- **Severity:** MEDIUM (provenance gap)
- **Why:** mutation replay is complete (seed + parent genome), but **score replay** is not: accepted/rejected rows record the score, not the window (`[from, to]`, cycle ids/count) it was computed over. "Show me why generation 7 was accepted" requires trusting the row, not re-deriving it.
- **Minimal fix:** add `windowFrom`, `windowTo`, `cycles` to the `accepted`/`rejected` history rows (3 fields at the two append sites).
- **Blocks?** No.

---

## Invariant check (all hold)

| Invariant | Status |
|---|---|
| Confidence gate cannot weaken | ✅ double-enforced: `META_BOUNDS.confidence_gate` floor 0.95 **and** `max(0.95, gate)` / `min(0.05, 1−gate)` at the consumer in `sidecar.ts` |
| Bounds are immutable | ✅ hardcoded consts; `clampMetaGenome` re-clamps on every load and mutation; unknown keys dropped (tamper test pins it) |
| Append-only history | ✅ `appendFileSync`; nothing rewrites (test pins prefix-preservation across reloads) |
| Runtime owns evolution/state | ✅ only the in-process `MetaEvolution` instance writes; surfaces go through it |
| No code/prompt/policy mutation | ✅ genome is 5 numeric fields; no interpreter anywhere |
| Neutral gen-0 | ✅ all consumers are ratio-to-default (×1) and dream_batch = episode default 40 |
| Rollback always possible | ✅ baseline travels in state; manual + auto-revert both tested |

## Summary

Ship it. The bounded, ratio-to-default, tighten-only design means the worst reachable state is a *slower or over-cautious* search, never an unsafe one. The remaining exposure is **integrity of the evidence** (O1, O6, O11) — which is precisely the mandate of L5 Governance, specced separately today — and **attribution quality** (O2–O5, O8), which costs convergence speed, not safety.
