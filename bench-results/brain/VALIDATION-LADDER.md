# CinderBrain substrate validation ladder

Written 2026-09-15, before any measurement it governs. Committed to git so the
criteria carry a timestamp older than the results. A step's criteria are never
edited after its measurement; a change is a new dated section that says why.

## Why this exists

The FlyWire kill gate read INCONCLUSIVE twice (bench-results/brain/flywire*,
commits e03534b, 8203b95). The second run had an activity-matched control and
showed the bench cannot measure pattern memory yet: shuffled accuracy equalled
the punishment fraction of the key draw in 6 of 6 rows. Measured cause: pattern
overlap is 0.025 across the driven sensory sets and already 0.82 across firing
ALPNs, upstream of the KCs and of APL. That result stands as recorded:
REAL 0.550 vs SHUFFLED 0.575, INCONCLUSIVE, bench invalidated by pattern
overlap / readout collapse. Not a CinderBrain failure, not evidence for it.

## The ladder

1. Stimulus model: odor-like input, measured as overlap per stage.
2. Mushroom body: KC overlap and sparsity under that input.
3. APL: only if KCs stay dense; non-spiking and local, validated ON vs OFF.
4. Freeze dynamics: parameters fixed and recorded before any learning run.
5. One smoke rerun, REAL / SHUFFLED / DENSE, the run.ts rule unchanged, same
   seeds, same rule, same conditions.

Then Task 4 behind a kill switch, then the product ablation (Cinderpaw + BRSI +
FMS, with and without CinderBrain, on real agentic tasks).

No step looks at learning accuracy or reward until step 5.

## Step 1: stimulus model (criteria)

**Stimulus.** An odor is a set of glomeruli. Every ORN of a chosen glomerulus
(FlyWire cell_type `ORN_<glomerulus>`, 54 types) gets the existing drive,
2 mV/ms, for the existing 50 ms. Nothing else is driven: no ALPN, no other
modality. Glomeruli per odor are drawn uniformly without replacement.

**Sizes, fixed now and both reported:** k = 3 and k = 8 glomeruli per odor.
Neither is tuned afterwards. Real odors range from few to many activated
receptors; two fixed sizes show whether a conclusion depends on it.

**Measured, 8 odors per size, seed 1, APL and everything else as built:**
input glomerulus overlap, input ORN overlap, ALPN overlap split into
uniglomerular and multiglomerular (FlyWire cell_sub_class), KC overlap, KC
sparsity (50 ms union and per 5 ms bin). Overlap = mean pairwise Jaccard of the
sets of neurons that fired at least once.

**GO to step 2** if, at both sizes, uniglomerular ALPN overlap is below 0.30
AND all-ALPN overlap is below 0.50 (today: 0.82 over all ALPNs, random input).

**STOP** otherwise: the next work is the olfactory mapping and antennal-lobe
dynamics (ORN->PN convergence, local neurons), not APL and not learning.

Multiglomerular PNs integrate many glomeruli by anatomy, so their overlap is
expected to stay higher and is reported, not gated.

The thresholds are judgement, set before data: 0.30 is well under today's 0.82
and well over the ~0.05 to 0.2 overlap of the input glomerulus sets at these k.

## 2026-09-15 03:10: step 2 under variant 2 (bypass the antennal lobe), criteria before measuring

Why: step 1 stopped at the antennal lobe; the literature pass (ledger, "AL
LITERATURE INVESTIGATION") classified the smear as a model-class limitation:
electrical eLN->PN coupling is absent from FlyWire, and presynaptic, slow and
nonspiking inhibition cannot be expressed by the simulator. Darius chose to
test whether the mushroom body works when it receives clean glomerular input,
and to say in the docs that the antennal lobe is bypassed.

**Stimulus.** Same odors as step 1 (k = 3 and 8 glomeruli, 8 odors, seed 1,
same draw order), but the driven neurons are the uniglomerular ALPNs whose
cell_type starts with `<glomerulus>_`, at 2 mV/ms for 50 ms. ORNs are not driven.

**Two conditions, both measured and both reported:**
- 2a intact: nothing else changed.
- 2b lesion: every edge from an ORN or an ALLN onto any ALPN has effective weight
  0 (the antennal-lobe local circuit cannot reach the PNs). Declared a lesion,
  not biology.

**Measured:** uni PN overlap, all ALPN overlap, KC overlap, KC sparsity (50 ms
union and per 5 ms bin), same metric as step 1.

**GO for variant 2** if KC overlap < 0.30 at both k in 2a (preferred) or,
failing that, in 2b. KC sparsity is reported, not gated; if it is high, APL
(step 3) is the next question, not a reason to retune.

**STOP** if KC overlap >= 0.30 at either k in both 2a and 2b: the mushroom body
does not separate clean input either, CinderBrain leaves the release, and the
release goes ahead without it.
