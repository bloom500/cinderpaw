# Cinderpaw: competence, receipts and the learner that learns to learn

Date: 2026-09-13
Status: working plan, approved in conversation by Darius; slices land on `feat/brsi-learner`.
Baseline: `23b97d0` (S0, S1, S2, the dimension freeze, and metacognition A/B/C are in).
Parent spec: `2026-09-12-recursive-learning-design.md` (S0..S7). This document does not
reopen its locked decisions; it sequences the work between S2 and S3 and names what
comes after S3 that the parent spec does not cover.
Source of the direction: three texts from Astra (GPT), 13 Sep 2026, kept in memory as
`astra-direction-competence-receipts`. They are proposals. Every claim below that is
not marked MEASURED is a hypothesis.

## 0. What is true today (measured, at `23b97d0`)

- The live agent honours 2 of 7 genome dimensions. The other 5 are frozen out of
  mutation (`LIVE_REACH` in `genome.ts`, commit `e807da9`). Every champion record
  says which dimensions reached the agent (`parity`, commit `b7ca846`).
- The paired campaign runner exists (`infra/campaign.ts`): hashed manifest, paired
  seeds, per-arm cost ledger, partition isolation, gate calibrated at 3.5 to 6.5 percent
  false positives over 200 null trials. No fixtures and no arms exist yet; no campaign
  has run.
- M0 (`l3-code/experiment-selector.ts`) picks the next L3 experiment by uncertainty
  times expected gain from a self-model (`l3-code/self-model.ts`): Brier score,
  dominant failure class, uncertainty `4p(1-p)`.
- Every L3 round writes one ledger row with `predicted` (the proposer's bet) and
  `observed` (the runner's verdict, effect, cost, failure class). The proposer never
  writes the observation.
- "I lack X" stops the round, becomes a persistent question in `rsi/questions.json`,
  shows in the Dreams panel until answered, refused or dismissed, and blocks the file
  meanwhile. The answer goes into the next prompt verbatim.
- L3 writes each round into FMS as an episode (`episodic.record("rsi-l3", ...)`).
  **BRSI never reads FMS.** M0 reads its own jsonl. This is the one broken link in
  Astra's loop and the first thing below.
- `nothingLeftToLearn` is computed and not wired: the round does not stop on it.
- **Typed facts with history (Memanto lift, `semantic_history`, `current/asOf/
  changedSince/history`, "superseded" labels in recall) are on
  `audit/astra-fms-bench` (13 commits, `d58d775..4a58b94`) and NOT on
  `feat/brsi-learner`.** §2.2 and §2.5 build on them. Merge that branch first
  (step 0 in §6). Unmerged work is the default state in this repo; check before
  every slice that its dependency is on the branch you are on.
- `memory/fractal/skill-induction.ts` exists from the ARC harness: a verified
  program becomes a reusable tool, append-only JSONL scoped by runId. §3.1 starts
  from it, not from nothing.
- No live round has produced a prediction yet: L3 needs a local primary model and this
  machine cannot host one (`this-machine-cannot-host-local-models`).

## 1. Vocabulary

**Receipt.** One verified experience, in Astra's seven fields:
`objective -> initialState -> intervention -> observedResult -> verification -> cost -> methodVersion`.
The ledger row is five sevenths of one: `initialState` and `methodVersion` are missing.
A receipt is written by the runner. The model contributes `predicted` and nothing else.

**Competence.** A receipt, or a family of receipts, plus the conditions under which
it held. Without conditions it is an anecdote.

**Self-model.** What the receipts say about the agent: where it is calibrated, where it
fails and how, where an experiment is still worth tokens.

**The loop** (Astra text 1): real failure -> FMS finds precedents -> BRSI formulates and
tests a change -> independent evaluation -> promotion -> FMS keeps the receipt -> the
next experiment is cheaper. Today every arrow exists except "FMS finds precedents ->
BRSI".

## 2. Slices on the existing architecture

Each slice: at most three files including tests, one conventional commit, tsc and the
RSI suite green, nothing merged into main by the agent. In order.

### Slice 1. The ledger row becomes a receipt
Add to `Attempt`: `initialState: { baseCommit: string; fileHash: string }` and
`methodVersion: { selector: string; promptHash: string }`. `boot.ts` fills them (the
base commit is already fetched; the prompt hash is `sha256Canonical(SYSTEM_PROMPT)`;
the selector version is a constant in `experiment-selector.ts` bumped by hand when the
policy changes). Old rows stay readable.
Acceptance: a test reads a row written before this slice and one after, and both feed
the self-model.

### Slice 2. BRSI reads FMS
The receipt is written into FMS as a typed record, not a sentence: `episodic.record`
keeps the human line for the dream cycle, and a new `receipts` store (or the typed
facts store, whichever `fms` already exposes for structured rows with history) holds
the fields. M0's `brief` is built from FMS receipts for the target file, newest first,
including refusals, instead of from the jsonl. The jsonl remains the crash-safe append
log; FMS is the read side.
Acceptance: delete the jsonl, restart, M0 still knows what was refused on a file.
A second test: a receipt in FMS with `verification` missing is shown to the proposer
as "claimed, not verified".

### Slice 3. The round stops when there is nothing left to learn
Wire `nothingLeftToLearn(model, pool)` into the L3 round before proposing. When true:
no proposer call, one card line in Dreams ("Nothing left to learn on the N files in
the pool; the next round waits for new code or a new answer"), and the round's cost
is zero. A new answer or a new accept re-opens the pool by construction.
Acceptance: a test with a settled pool asserts the proposer is not called and the
card line is sent.

### Slice 4. Astra's five decisions as the prediction vocabulary
`FAILURE_CLASSES` grows from four to seven: `wrong_proposal`, `wrong_file`,
`unmeasured`, `missing_info`, `need_tool`, `need_method`, `over_mandate`.
`over_mandate` with `expectedCost` above the round budget is treated like `missing`:
the round does not run, a question lands in Dreams ("This looks like ~N tokens,
above the M budget. Allow it once?"). `need_tool` and `need_method` are recorded only
(they are the input to §3.1 and §3.2).
Acceptance: parse test for each new class; a proposer that says `over_mandate` produces
a question, not a round.

### Slice 5. Invalidation without loss
A receipt may carry `supersedes: receiptId` and `invalidates: receiptId[]`. The
self-model and the brief ignore invalidated receipts for selection but keep them in
history; the proposer sees "X was believed until receipt R showed otherwise".
Acceptance: a test where a later receipt invalidates an earlier accept, and M0's
uncertainty on that file goes back up.

### Slice 6. S3: the first campaign (three slices)
6a. Fixtures: a directory of small deterministic repositories with one planted
build/config failure each and a verifier script per fixture (spec §8: one coding
family, whole repos held out). Development, promotion, final, transfer partitions in
a frozen manifest with `usdCap: 0`.
6b. Arms: `fixed` (no learning), `fms` (fixed agent plus receipt retrieval),
`brsi` (M0 selecting experiments, no FMS read), `both`. Same model, same seeds,
same training partition.
6c. Run the five-seed pilot on the free fixtures. Report variance, cost per arm,
and the calibration rate; the gate will say "insufficient samples" and that is the
correct output of a pilot. Decide the confirmatory sample size from the pilot
variance, then and only then request a USD cap.
Acceptance: `runPairedCampaign` on real fixtures produces a `CampaignResult` with
`matched: true` for all four arms against `fixed`.

## 3. Projects that need something new in the architecture

These are not slices. Each is a design of its own, with a spec, and each is named
here so the slices above are cut to fit them rather than against them.

### 3.1 Skill library: expensive solving becomes cheap procedure (Astra text 3 §4)
**New:** an executable skill format with declared conditions (app version, rights
needed, result format, verification method), a store for it, and a promotion path
`exploration -> verified solution -> parametrised procedure -> cheap execution with
checks`. The catalog of skills the agent already loads (`read_skill`, the skills
menu) is the natural home; today it is read-only and hand-written.
**BRSI's part:** proposes the parametrisation from a family of receipts and tests it
on the family's held-out members. **FMS's part:** stores the skill with its receipts
and conditions, at the "procedure" scale.
**Measure:** Astra's metric, total cost divided by verified completed tasks,
including failed attempts, verification and amortised learning. A skill is worth
keeping when it lowers that number on its family.
**Precedent:** Voyager (Minecraft). Generalising to digital work is the open problem;
do not claim it before §2.6 runs on a second task family.
**Size:** one to two weeks. Needs `need_tool` / `need_method` receipts from §2.4 as
its input signal.

**Sketch, files.**
- `CinderpawAgent/src/memory/fractal/skill-induction.ts`: the seed. Today a
  skill is `{code, description}` deduplicated by hash. Grows a `conditions`
  block (app/version, rights, input schema, result schema, `verify` command) and
  a `receipts: string[]` link. Stays append-only JSONL.
- `CinderpawAgent/src/rsi/l3-code/skill-proposer.ts` (new, ~150 lines): given a
  family of receipts with the same objective, asks the model for a parametrised
  procedure; goes through the SAME contract runner as a code patch
  (`contract-runner.ts`), with the family's held-out receipts as the test.
- `CinderpawAgent/src/tools/builtin/list-skills.ts` and the `read_skill` menu:
  induced skills appear next to hand-written ones, marked "learned, N receipts,
  verified <date>", so the agent can pick them and the user can see where they
  came from.
- `src-tauri/src/skills.rs`: untouched. The manifest fetch is for installed
  skills; learned ones never leave the machine.
- Deleted: nothing. `ARC`'s runId scoping stays; interactive use passes
  "interactive".
- Test: a family of three receipts for one planted build failure yields a skill
  that solves the fourth member cheaper than exploration (cost from the S1
  ledger).

### 3.2 Competence scales in FMS (Astra text 3 §3)
**New:** four explicit scales in the fractal tree: action/result, procedure,
strategy, principle; each abstraction keeps links to the receipts and
counterexamples under it, so a summary can never become a truth by repetition.
Today the tree has leaves and RAPTOR-style summaries; it has no notion of "this
summary is supported by these receipts and contradicted by those".
**Depends on:** §2.2 (receipts in FMS) and §2.5 (invalidation).
**Measure:** LongMemEval does not test this. Needs a probe of its own: plant a
counterexample and check the generalisation above it is narrowed, not deleted.

**Sketch, files.**
- `memory/fractal/types.ts`: a tree node gets `scale: "action" | "procedure" |
  "strategy" | "principle"` and `support: { for: string[]; against: string[] }`
  (receipt ids). Leaves are `action`; today's RAPTOR summaries become
  `procedure`; two new summariser passes produce `strategy` and `principle`.
- `memory/fractal/summarize.ts`: the prompt for the two upper scales asks for
  conditions, and the code refuses to write a node whose `support.for` is empty.
- `memory/fractal/tree-query.ts`: a counterexample (a receipt with
  `invalidates`) walks UP and marks every ancestor whose `support.for` shrank to
  zero as `narrowed`, never deleted.
- `memory/fractal/tree-builder.ts`: the build reads receipts from §2.2's store.
- Deleted: the unconditioned summary. A summary with no receipts under it is not
  built.
- Test: plant a counterexample under a strategy; assert the strategy is
  narrowed and the principle above it is untouched.

### 3.3 Utility-scored retrieval (Astra text 1 §4)
**New:** a retrieval score that includes "did this memory help when it was
retrieved before", learned from receipts, next to semantic similarity. Requires a
feedback edge from task outcome to the memories that were in context, which does
not exist.
**Depends on:** §2.2 and enough receipts to learn from, i.e. after §2.6.
**Measure:** the `fms` arm of §2.6 with and without utility scoring.

**Sketch, files.**
- `memory/recall.ts` (or the seam behind the recall tool in `boot.ts:912`):
  every recall records which leaf ids were returned, keyed by turn id, into a
  small table `recall_log(turn, leaf, rank)`.
- `core/agent-loop.ts`, end of turn: when a receipt closes with a verification
  (or a `done_when` passes, or the user gives feedback), the leaves in
  `recall_log` for the turns of that task get `+1 helped` or `+1 present`.
- `memory/fractal/fractal-recall.ts`: score = similarity times
  `(1 + helped) / (1 + present)`, with a floor so a never-tried leaf is not
  buried. One knob, default 1.0 (= today's behaviour) until §2.6 measures it.
- Deleted: nothing.
- Test: two leaves with equal similarity; the one that helped twice ranks first;
  with the knob at 0 the order is today's.

### 3.4 Durable mandate: autonomy as continuous responsibility (Astra text 3 §5)
**New:** a mandate object (result, budget, access, limits, expiry) that survives the
conversation; a watcher that resumes after interruption, detects a method that
became invalid, and repairs incomplete results; receipts as the retrospective
audit. Cowork v1 is reactive by design (`cowork-runtime.ts` ticks only on agents that
exist). This is a product change, not a BRSI change, and it touches approvals,
budgets and the egress wall.
**Depends on:** nothing above, but it is where §3.1's skills get used unattended.
**Size:** its own spec; do not start it from this document.

**Sketch, files.** Own spec first; this is the outline the spec starts from.
- `cowork/types.ts`: `Mandate { objective, doneWhen, budgetUsd, wallMs,
  access: string[], limits: string[], expiresAt, receipts: string[] }`.
- `cowork/runtime.ts`: the tick loop today runs only for agents that exist;
  a mandate is an agent whose job is to keep its objective true. Adds resume
  after restart (state on disk, same pattern as `pending-patches.ts`) and a
  "method invalid" check (the skill's `verify` failed twice) that opens a
  question in Dreams instead of retrying blind.
- `cowork/approval.ts`: approvals inside the mandate's declared access are
  pre-granted; anything outside asks, once, and the answer is stored on the
  mandate.
- `egress/*`: the mandate's `access` becomes an allowlist the egress wall reads;
  nothing new in the wall, a new caller of it.
- `frontend-react/.../CoworkPanel*`: one card per mandate: objective, spend so
  far against budget, last receipt, "Stop".
- Deleted: nothing; v1 reactive cowork stays as the degenerate mandate with no
  objective.

### 3.5 Learner evolution and the recursive experiment (parent spec S4, S5)
**New:** L3 may propose a successor to M0 and to `self-model.ts`, which are on the
denylist today on purpose. Opens only when §2.6 has produced an H1 result with the
matched control, and under the parent spec's paired evaluation and VM isolation.
**Measure:** H2, recursive versus non-recursive learner search, and Astra's closing
test: after many failures, does it formulate an experiment it could not conceive
before. That is a receipt whose `methodVersion` names a promoted successor.

**Sketch, files.**
- `l3-code/code-genome.ts` and `crates/cinderpaw-core/src/rsi/code_patch.rs`:
  `experiment-selector.ts` and `self-model.ts` leave the denylist ONLY inside a
  campaign (`infra/campaign.ts` passes an explicit `learnerSearch: true`), never
  in the live loop. The live denylist does not change.
- `infra/campaign.ts`: an arm may carry a `selectorVersion`; the manifest
  freezes which versions are compared.
- `l3-code/experiment-selector.ts`: `SELECTOR_VERSION` from §2.1 is what a
  successor bumps; a successor is a code patch on this file evaluated by the
  paired runner, in the Docker cell from S0.
- Deleted: nothing.
- Test: the recursive arm and the non-recursive arm on the same fixtures,
  matched budget; H2 is the gate's verdict, reported with the pilot's calibration.

### 3.6 Transfer across unknown applications (Astra text 3 §6)
Not a build. It is the H3 measurement of §2.6 on a second task family and a second
pinned model, using frozen artifacts. Listed so nobody schedules it as a feature.

## 4. Hypotheses this plan serves

- H1: an evolved learner beats M0 on held-out tasks at equal budget. Needs §2.6.
- H2: letting promoted learners steer learner search beats frozen M0. Needs §3.5.
- H3: the gain transfers to a new family and a second model. Needs §3.6.
- H4: users make fewer repeated corrections. Needs §3.4 and consented tracking.
- H5 (new, Astra text 3): total cost per verified task falls as skills accumulate.
  Needs §3.1 and the metric from §2.6.

## 5. What this plan does not authorise

No paid campaign (every manifest has `usdCap: 0` until the pilot variance is known).
No merge into main by the agent. No change to the L3 denylist. No claim of recursive
improvement, transfer, or "learning to learn" before the numbered hypothesis above
has a measured result with its control.

## 7. Status, 13 Sep 2026 evening

All of §2 shipped on `feat/brsi-learner`, pushed at `911e5d0`:
step 0 `d3ee722`, §2.1 `c6244ff`, §2.2 `a6087a5`, §2.3 `ebd0f3f`, §2.4 `1717215`,
§2.5 `0f1a59e`, §2.6 `911e5d0`. Agent suite green throughout (1017 RSI tests at
the end).

**First measured number (§2.6, pilot, free fixtures, 12 paired seeds, 2 attempts
per task, promotion = two templates never seen in training):**
fixed 0.542 | fms 0.542 | brsi 0.625 (p=0.094, not significant) |
both 0.917 (delta 0.375, p<0.001, d=1.38); learning cost fixed 169, fms 137,
brsi 126, both 112 attempts. A pilot, not a claim: the manifest was not frozen
before the runs and the effect is on a toy family. It does say the harness
works end to end and that the gate behaves.

**What the pilot found about the learner, not acted on:** M0's accept rate is
per repair, not per (repair, failure signature). Over-exploration in training
poisons it against repairs that only work on failures it has not met. The
receipt already carries the signature (`rationale`); M0 does not condition on
it. This is §1's "a receipt without conditions is an anecdote", measured. Next
change to M0 = condition on the signature; bump SELECTOR_VERSION to m0.3 and
re-run the same pilot so the two selectors are compared under one manifest.

**§3, started the same evening, all pushed (latest `a983802`):**
- `0a684cc` m0.3c, the conditioned selector, measured as arm `brsi-c`:
  0.479, worse than fixed 0.542. Not adopted; m0.2 stays live; `condition`
  stays on the receipt. Next variant: other conditions as a weak prior.
- `87ceab8` §3.1 slices 1-2: `memory/fractal/skill-library.ts`
  (LearnedProcedure with conditions + receipt evidence, induceProcedure
  refuses without held-out, append-only, retire-not-delete) and arm
  `skilled`. H5 pilot, repeated families, cost per verified task:
  fixed 5.79 | fms 2.90 | brsi 4.86 | both 2.64 | skilled 2.64. On the toy
  the library equals retrieval; its saving is model tokens, which the toy
  has none of. Left in §3.1: live L3 inducing procedures; skills in the menu.
- `171e3d2` §3.2 slice 1: `memory/fractal/competence-scales.ts`, strategy
  scale with support for/against and `narrow`. No principle scale, no
  wording, tree untouched (needs the summariser to take receipts).
- `a983802` §3.3 slice 1: `memory/fractal/utility.ts`, UtilityLedger +
  rerankByUtility with the knob at 0. Left: wire shown() into the recall
  seam (boot.ts:912) and closed() into turn end, behind the knob; then
  measure on the `fms` arm.
- §3.4 and §3.5 untouched: each needs its own spec first.

## 6. Order

Step 0: merge `audit/astra-fms-bench` into `feat/brsi-learner` (typed facts with
history). Then §2.1 -> §2.2 -> §2.3 -> §2.4 in the current and next session. Then §2.6 (the first
number). §2.5 after. §3.1 when the cost of the product matters more than the next
measurement. §3.4 and §3.5 each get their own spec first.
