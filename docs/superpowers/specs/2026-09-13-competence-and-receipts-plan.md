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

### 3.2 Competence scales in FMS (Astra text 3 §3)
**New:** four explicit scales in the fractal tree: action/result, procedure,
strategy, principle; each abstraction keeps links to the receipts and
counterexamples under it, so a summary can never become a truth by repetition.
Today the tree has leaves and RAPTOR-style summaries; it has no notion of "this
summary is supported by these receipts and contradicted by those".
**Depends on:** §2.2 (receipts in FMS) and §2.5 (invalidation).
**Measure:** LongMemEval does not test this. Needs a probe of its own: plant a
counterexample and check the generalisation above it is narrowed, not deleted.

### 3.3 Utility-scored retrieval (Astra text 1 §4)
**New:** a retrieval score that includes "did this memory help when it was
retrieved before", learned from receipts, next to semantic similarity. Requires a
feedback edge from task outcome to the memories that were in context, which does
not exist.
**Depends on:** §2.2 and enough receipts to learn from, i.e. after §2.6.
**Measure:** the `fms` arm of §2.6 with and without utility scoring.

### 3.4 Durable mandate: autonomy as continuous responsibility (Astra text 3 §5)
**New:** a mandate object (result, budget, access, limits, expiry) that survives the
conversation; a watcher that resumes after interruption, detects a method that
became invalid, and repairs incomplete results; receipts as the retrospective
audit. Cowork v1 is reactive by design (`cowork-runtime.ts` ticks only on agents that
exist). This is a product change, not a BRSI change, and it touches approvals,
budgets and the egress wall.
**Depends on:** nothing above, but it is where §3.1's skills get used unattended.
**Size:** its own spec; do not start it from this document.

### 3.5 Learner evolution and the recursive experiment (parent spec S4, S5)
**New:** L3 may propose a successor to M0 and to `self-model.ts`, which are on the
denylist today on purpose. Opens only when §2.6 has produced an H1 result with the
matched control, and under the parent spec's paired evaluation and VM isolation.
**Measure:** H2, recursive versus non-recursive learner search, and Astra's closing
test: after many failures, does it formulate an experiment it could not conceive
before. That is a receipt whose `methodVersion` names a promoted successor.

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

## 6. Order

§2.1 -> §2.2 -> §2.3 -> §2.4 in the current and next session. Then §2.6 (the first
number). §2.5 after. §3.1 when the cost of the product matters more than the next
measurement. §3.4 and §3.5 each get their own spec first.
