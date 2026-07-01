# Design spec — Faza 2: Code Evolution (code-RSI), skeleton + delegation split

Status: draft, Slice 0 (skeleton) in progress. Author: Fable (2026-07-01).
Parents: `docs/rsi-evolution-spec.md` (Faza 2), `docs/brsi-spec.md` (§2.1 contract,
§5 layers), `docs/superpowers/specs/2026-07-01-contract-fsm-live-design.md`
(the FSM this rides on — landed 2026-07-01, Slices 1-3 on main).

---

## 0. Entry condition (met)

Faza 1 (config-RSI) is complete AND the Contract FSM runs live per candidate
(`contract-leaves.ts` → `runContract`, per-candidate Journal rows, receipts
UI). Faza 2 exists to make the pass-through stages REAL: a candidate that is a
*code patch* has something to statically analyse, sandbox-apply, test, and
build — exactly the stages config-RSI collapses.

## 1. Shape: CodeGenome rides the SAME machinery, not a parallel engine

- `GenomeSpec` gains an optional `code?: CodeGenome` (sibling of `config?`,
  which is already optional — verified `population-manager.ts:48`). One
  population, one bus, one FSM. A genome is config-RSI or code-RSI by which
  field is set.
- The Contract FSM needs **zero structural change** — `contractLeavesFromRatchet`
  grows code-aware leaves behind the same `StageHandlerDeps`:

| Stage             | Config-RSI (today)     | Code-RSI (Faza 2)                                   |
|-------------------|------------------------|-----------------------------------------------------|
| `static_analysis` | pass-through           | `validateCodePatch` (diff guard: policy wall)       |
| `sandbox_apply`   | commitGenome           | apply patch to an isolated git worktree             |
| `tests`           | tier-0 floor           | `bun test` in the worktree — ALL existing tests     |
| `benchmark`       | eval suite score       | Rust-scored f(test pass rate, tsc clean, build ok, diff size) |
| `safety_checks`   | tier-0 floor re-assert | policy re-assert + worktree escape check            |
| `regression`      | pass-through           | `bunx tsc --noEmit` in the worktree                 |
| `deploy`          | ratchetAttempt         | `rsi_commit_code_patch` (Rust) + approval gate      |
| `monitoring`      | pass-through           | live-crash watchdog → auto-revert (rollback)        |

## 2. Trust boundaries (locked, non-negotiable)

1. **Scoring is Rust (I7).** The code-RSI score formula lives in `scorer.rs`
   next to the config formula. TS reports raw measurements (pass counts, tsc
   exit, build exit, changed lines); Rust computes the scalar. The agent can
   patch TS; it cannot patch its own grader.
2. **Promotion is Rust (I1).** `rsi_commit_code_patch` + ratchet + rollback
   live in the Rust git substrate.
3. **The current engine evaluates the patched copy — never itself.** Patches
   apply to a disposable worktree; the running process is never the patched
   process. Live apply happens only at deploy, behind the approval gate.
4. **Policy wall (`validateCodePatch`) is enforcement code and is DENYLISTED
   from patching.** rsi/ files that implement the guardrails (`code-genome`,
   `contract-leaves`, `ratchet-handler`, `confidence`, `contract-runner`,
   `contract-stages`, `contract-deps`) cannot be targets of a patch, even
   though they live inside the allowlisted dir. Tier-0 "all tests pass" backs
   this up but must not be the only wall.
5. **Guardrails from rsi-evolution-spec §Faza 2:** ≤200 changed lines/patch;
   `.ts` under `FeralAgent/src/rsi/` only; first 10 patches need UI approval;
   no network during proposal (local inference only).

## 3. Slices

- **Slice 0 — skeleton + contracts (Opus/Fable, THIS session).**
  `code-genome.ts`: `CodeGenome` type, `ParsedDiff` shape, the
  `parseUnifiedDiff` contract (stub), `validateCodePatch` policy wall
  (IMPLEMENTED — security stays home) + `DEFAULT_CODE_PATCH_POLICY` + tests
  over hand-built `ParsedDiff` fixtures. No engine wiring yet.
- **Slice 1 — MiniMax leaves (delegate AFTER Slice 0 lands).** See §4.
- **Slice 2 — sandbox eval runner (Opus).** Worktree lifecycle (create from
  baseCommit → apply → `bun test` / `bunx tsc --noEmit` / `bun run build` →
  raw measurements → destroy), fail-safe teardown, wall-clock caps. Process
  spawning = sandbox territory.
- **Slice 3 — Rust half (Opus).** `rsi_commit_code_patch` bridge command,
  scorer extension (code formula), rollback (revert to last-good on crash).
- **Slice 4 — proposal operator (Opus).** LLM-driven patch proposal through
  the existing InferenceRouter (local-only enforced), reading its own rsi/
  sources; emits `CodeGenome` candidates into the population. Mutation-type
  `"code_patch"`.
- **Slice 5 — approval gate + UI (Opus IPC, MiniMax UI leaf).** First-10
  confirmation flow; Dreams panel "pending patches" card mirroring the
  receipts pattern.

Each slice ships with runnable tests before the next (same discipline as the
contract-live spec).

## 4. MiniMax M3 delegation (the answer to "ce delegăm")

Rule (unchanged): pure leaf + frozen contract + existing caller. After Slice 0
lands, these are real, non-speculative leaves:

1. **`parseUnifiedDiff(patch: string): ParsedDiff | DiffParseError`** — pure
   string → structure. No policy, no IO, no fs. The contract (types + edge
   cases: multi-file, new/deleted file, malformed hunk headers, CRLF, binary
   markers → error) is frozen in `code-genome.ts` with a reference fixture
   test. Policy stays in `validateCodePatch` (Fable) — parser and wall are
   separate so the security-critical half is never delegated.
2. **`CodeGenome` serializer round-trip** (`serializeCodeGenome` /
   `deserializeCodeGenome` with versioned envelope, mirroring
   `population-snapshot.ts` discipline) + property tests.
3. **(Slice 5, later) approval-gate UI card** in `FeralDreamsPanel.tsx`
   pattern, after the IPC shape is frozen.

NOT delegable (trust boundary / integration): policy wall, worktree runner,
anything Rust, proposal operator, engine threading, approval IPC.

## 5. Open decisions (lock before Slice 2)

1. Worktree location + reuse (fresh per candidate vs pooled) — recommend
   fresh-per-candidate under scratch, destroy always; pool only if measured
   too slow.
2. Does code-RSI share the population capacity with config-RSI or get a
   reserved slot fraction? Recommend: shared, PBT decides — revisit if code
   candidates starve.
3. Score weights f(pass_rate, tsc, build, diff_size) — Rust-side constants,
   locked like §2.2 weights; propose 0.6/0.15/0.15/0.1 (small diffs favoured)
   and learn from Journal later.
