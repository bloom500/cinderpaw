# Learner evolution and the recursive experiment

Competence plan §3.5; parent spec S4 and S5
(`2026-09-12-recursive-learning-design.md`). A spec, not a build. It opens
only when the preconditions in §6 hold, and none of them hold on 14 Sep 2026.

## 0. What exists, measured 14 Sep 2026

- The learner is `experiment-selector.ts` (M0, `SELECTOR_VERSION = "m0.2"`)
  and `self-model.ts`. Both are on the L3 patch denylist
  (`code-genome.ts` lines 415-416) and mirrored in
  `crates/cinderpaw-core/src/rsi/code_patch.rs`; a parity test fails if the
  two lists drift.
- The campaign runner (`infra/campaign.ts`) compares arms under one frozen
  manifest with a paired gate; the arms (`infra/arms.ts`) are closures over a
  selector, not over a file. Two selector versions were already compared this
  way: m0.2 (live) and m0.3c (`brsi-c`, rejected, 0.479 < fixed 0.542).
- Every receipt carries `methodVersion` (§2.1), so a receipt already says
  which learner produced it.
- S0 isolation (Docker cell) is done and verified on real Docker.

So "a successor to M0" is not a new concept: it is the third selector version,
produced by L3 instead of by hand, compared the way m0.3c was.

## 1. The rule that does not change

**The live denylist does not change.** L3 in a user's install may never patch
`experiment-selector.ts` or `self-model.ts`. Learner search happens only
inside a campaign, and a campaign is a benchmark run, never a user session.

## 2. The mechanism

1. `infra/campaign.ts`: `CampaignManifest` gains `learnerSearch?: true`. Only a
   manifest with it may build a genome wall (`code-genome.ts`
   `makeCodeGenomeWall`) whose denylist omits the two learner files. The wall
   is constructed per campaign, so the live wall is a different object with
   the full list. Test: the live wall (no manifest) still refuses both files;
   the parity test with Rust stays on the live list.
2. A **successor** is a code patch on `experiment-selector.ts` proposed by L3
   inside the campaign's Docker cell, that bumps `SELECTOR_VERSION` (the
   contract runner refuses a successor that does not). It goes through the
   SAME contract stages as any patch (sandbox apply, tests, safety, ratchet),
   then through the paired runner as arm `brsi@<version>` against
   `brsi@m0.2` under the manifest's frozen fixtures and seeds.
3. `infra/arms.ts`: an arm may carry `selectorVersion`; `makeArm` loads the
   selector by version from the campaign's worktree, not from `src/`. m0.2 is
   the control in every learner-search campaign; the manifest freezes both
   versions' hashes before the first seed runs.
4. **Promotion** of a successor means: the gate accepts (paired, matched
   budget, the calibration from S2: 3.5-6.5% false positives) AND a human
   merges the patch into `src/`. There is no automatic path from a campaign
   result to the live file. The receipt of the promoting run has
   `methodVersion = "<new version>"`, which is Astra's closing test in
   measurable form: a receipt whose method names a promoted successor.

## 3. H2, the recursive experiment (S5)

Two arms on the same fixtures, matched budget in proposer tokens:

- `search`: L3 proposes successors to M0 as in §2, K rounds.
- `search-flat`: L3 proposes K patches to a non-learner file of the same size
  (a fixture-level control: same proposer, same budget, nothing recursive).

H2 holds if `search` produces a promoted successor and `search-flat` does not
move the gate. Reported with the pilot's calibration, never alone. The
manifest is frozen and hashed before either arm runs; a second family of
fixtures (competence plan §3.6) is required before the word "transfer" is
used.

## 4. What the successor may not do

- Read the promotion partition (the runner never mounts it into the cell).
- Change `campaign.ts`, `confidence.ts`, `fixtures.ts`, or the receipt
  shape: all stay on the denylist even inside a campaign. A learner that
  rewrites the instrument is m0.3c's "tie becomes a shuffle" at a larger
  scale.
- Run outside the S0 cell.

## 5. Tests

- Live wall refuses a patch to `experiment-selector.ts`; a campaign wall
  with `learnerSearch` accepts it and still refuses `campaign.ts`.
- A successor without a `SELECTOR_VERSION` bump is refused by the contract
  runner with that reason on the receipt.
- Manifest hash includes both selector hashes; changing either changes it.
- A paired run of `brsi@m0.2` against itself gives delta 0 and the gate
  rejects (the null calibration from S2, re-run under this manifest).

## 6. Preconditions, none met on 14 Sep

- §2.6 has an H1 result with the matched control on a **model-in-the-loop**
  campaign. The pilot's numbers are on free fixtures with no model; H1 with a
  model has not been run because this machine cannot host one and no USD cap
  has been written by a human for it.
- A second fixture family exists (§3.6), so a successor cannot overfit the
  only family there is.
- The first Cinderpaw release is tagged. Learner search is research; it does
  not ship.
