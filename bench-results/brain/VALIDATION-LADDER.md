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

## 2026-09-15 03:30: step 2 result, and why the GO is not accepted

The criterion above reads GO for 2b (KC overlap 0.007 / 0.024 < 0.30). The
criterion is not edited. But in 2b the KCs are nearly silent: 0.3% / 0.6% of
KCs fire in 50 ms (about 15 to 30 of 5177), against 26 to 29% in 2a and a 5 to
10% biological range. Low overlap between almost-empty sets is separation by
silence, the same failure the first shuffled control had. The criterion did not
anticipate a lower bound; that gap was in the preregistration, not in the data.
Recorded as: GO by the letter, NOT ACCEPTED as evidence that the mushroom body
separates odors. 2a (antennal lobe intact, PNs driven directly) smears again
(PN overlap 0.86 to 0.90, KC overlap 0.78 to 0.79): PN -> LN -> PN recurrence
brings the antennal-lobe spread back even without ORN input.
Nothing retuned. Decision on the next step is Darius's.

## 2026-09-15 19:00: Variant 1, step G2 (corrected transmitter labels, no electrical synapses), criteria before measuring

Why: the G1 audit (bench-results/brain/variant1/04-data-audit.md) found that for 36 of the 62
antennal-lobe local neurons (ALLNs) with a literature transmitter, FlyWire's predicted top_nt is
a different transmitter. Variant 1 adds electrical synapses; any benefit it shows must not be
the benefit of fixing signs. So the reference without electrical synapses is rebuilt first.
Rulings by Darius, 15 Sep: keep predictions only above a preregistered confidence; run the
uncertain cells BOTH excitatory and inhibitory, no post-hoc choice.

**Scope.** Only ALLNs (cell_class ALLN, 429 cells) are relabelled. Every other neuron keeps its
sign as built. Relabelling = the sign of every outgoing edge of that neuron, weight magnitude
unchanged (LifSim effectiveWeight; the pack is not rebuilt).

**Label rule, fixed now.**
1. ALLN with a non-empty known_nt: sign from the FIRST transmitter named in known_nt
   (text before the first ',' or ';'): gaba or glutamate -> -1; acetylcholine -> +1; anything
   else -> treated as no known_nt. ("gaba, MIP; acetylcholine-negative" -> gaba -> -1.)
2. ALLN without a usable known_nt and top_nt_conf >= **0.50**: sign from top_nt as the adapter
   does today (gaba/glutamate -1, everything else +1). 0.50 is judgement, set before any G2
   number exists; it is not tuned afterwards.
3. ALLN without a usable known_nt and top_nt_conf < 0.50: UNCERTAIN.

**Three label sets, all measured, all reported:** AS-BUILT (today's pack), CORRECTED-U+
(uncertain = +1), CORRECTED-U- (uncertain = -1).

**Stimulus and metrics.** Exactly step 1: ORNs of k = 3 and 8 random glomeruli, 8 odors per size,
seed 1, 2 mV/ms for 50 ms, same draw order; uniglomerular / multiglomerular / all ALPN overlap,
KC overlap, KC sparsity. Added: for each overlap, an activity-matched null = mean Jaccard of
random sets of the same sizes drawn from the same population (1000 draws), reported as the ratio
observed / null.

**What G2 decides (it is a reference, not a GO for Variant 1):**
- LABEL EFFECT MATERIAL if uniglomerular ALPN overlap differs from AS-BUILT by >= 0.10 in at
  least one corrected set at both k. Otherwise LABEL EFFECT SMALL.
- UNCERTAIN CELLS DECISIVE if the step-1 criterion (uni < 0.30 AND all < 0.50 at both k) passes
  in exactly one of CORRECTED-U+ / CORRECTED-U-. Then every later Variant 1 claim must hold in
  BOTH label sets, not in the one that looks better.
- Both corrected sets are carried into G3-G5 as the no-gap references. Neither is selected.

## 2026-09-15 19:40: step G2 result

Run: bench-results/brain/variant1/g2/ (log g2-run.log). 211 of 429 ALLNs are UNCERTAIN under the
rule (no literature label, top_nt_conf < 0.50); U+ changes 139 signs vs the pack, U- changes 78.

| set | k | uni PN overlap (null ratio) | uni firing | KC overlap (null ratio) | KC active |
|---|---|---|---|---|---|
| AS-BUILT | 3 / 8 | 0.839 (1.80) / 0.862 (1.65) | 63% / 69% | 0.602 (5.3) / 0.725 (4.5) | 21% / 28% |
| CORRECTED-U+ | 3 / 8 | 0.935 (1.33) / 0.934 (1.30) | 83% / 84% | 0.881 (3.2) / 0.892 (2.9) | 43% / 47% |
| CORRECTED-U- | 3 / 8 | 0.381 (3.05) / 0.489 (2.68) | 22% / 31% | 0.047 (6.3) / 0.056 (7.0) | 1.5% / 1.6% |

Verdicts as preregistered: LABEL EFFECT MATERIAL. UNCERTAIN CELLS not decisive by the step-1
criterion (it fails in both corrected sets). Not preregistered, stated as an observation only:
the two corrected sets span smear (U+) to near-separation with sparse KCs (U-), so the sign of the
211 uncertain ALLNs moves uniglomerular PN overlap by ~0.45-0.55, far more than any mechanism
has moved it so far. Until those cells are labelled from better evidence, every Variant 1 claim
must hold in both sets, as G2 required. No label set is selected; nothing retuned.

## 2026-09-15 20:00: G2-X type-consensus sensitivity analysis (EXPLORATORY, added after G2), rule before computing

Status: exploratory, added AFTER the G2 result was seen. It is NOT the reference. The two G2
extremes (CORRECTED-U+, CORRECTED-U-) stay mandatory in every later analysis.

Source check (Eckstein et al. 2024, Cell, PMC11106717): the paper assigns a neuron's transmitter
by majority vote of its presynapses and reports accuracy at neuron (94% FAFB-Catmaid) and cell-type
level, and notes that conflicted types have lower mean prediction scores. Claude could NOT confirm
that the authors recommend type-level aggregation over per-neuron labels. So this set is named
"type-consensus sensitivity analysis", not a FlyWire-recommended method.

**Rule, deterministic, same for every type, no threshold chosen from PN/KC results:**
1. ALLNs with a G2 literature or confident label keep it (G2 rules 1-2, threshold 0.50 unchanged).
2. An UNCERTAIN ALLN with a non-empty cell_type takes the majority sign of top_nt over ALL ALLNs
   of that cell_type (every cell counts once, regardless of confidence; gaba/glutamate -1, other +1).
   If any cell of the type has a usable literature known_nt, that sign is used for the type instead.
3. Ties, untyped cells, and types where rule 2 cannot apply stay uncertain and are run BOTH ways:
   TYPE-CONSENSUS/T+ and TYPE-CONSENSUS/T-. Counts of each case are reported.

Measured exactly as G2 (step-1 stimulus, same metrics and nulls). No verdict beyond reporting the
numbers next to the two G2 extremes; no parameter is changed in response.

## 2026-09-15 20:15: G2-X result (EXPLORATORY)

Run: bench-results/brain/variant1/g2x/. Type consensus resolves 194 of the 211 uncertain ALLNs;
17 stay uncertain (ties in 7 small types: CB1266, vLN24, CB2845, lLN9, CB3575, l2LN23, v2LN30)
and run both ways. Signs changed vs the built pack: only 30 (T+) / 29 (T-), so type consensus
mostly agrees with the as-built predictions.

| set | k | uni PN overlap (null ratio) | uni firing | KC overlap (null ratio) | KC active |
|---|---|---|---|---|---|
| TYPE-CONSENSUS/T+ | 3 / 8 | 0.921 (1.51) / 0.906 (1.41) | 76% / 79% | 0.794 (4.2) / 0.827 (3.7) | 32% / 37% |
| TYPE-CONSENSUS/T- | 3 / 8 | 0.627 (2.26) / 0.761 (2.18) | 43% / 52% | 0.395 (6.4) / 0.593 (6.4) | 12% / 17% |

Observation only, no verdict: the 17 tied cells alone move uni PN overlap by 0.15-0.29. The
antennal lobe as modelled is very sensitive to the sign of a few LNs, which reads as a network
near a runaway threshold rather than one with robust gain control. It is exploratory and does
not replace the G2 extremes. Nothing retuned.

## 2026-09-15 21:00: Variant 1, step G3 (reference AL rate model, Liu et al. 2021), criteria before measuring

Why: the round-1 answer (variant1/03) asks for a published model reproduced first, to verify
equations, units and parameters before anything is wired into FlyWire. Source read from the
Europe PMC XML (PMC8568954), equations 1-5 and 12, Table 1, and the Figure 4/5 captions. An
automated summary of the same paper had the presynaptic-inhibition and STP equations WRONG;
only the XML is used.

**What CANNOT be reproduced, stated before running:** Figure 2's fit to Olsen et al. 2010 (the
16 / 15 data points exist only as plotted symbols, the public ORN rate of each line was a free
fitted parameter not listed, and Table 1 gives no tau_p and no k). Figure 5's agreement with Kim
et al. 2015 is also plot-only. G3 therefore checks the implementation, not agreement with data.

**Model, exactly Eqs 1-5:** dR_PN/dt = -R_PN/tauE + k wEE u+ x p R; dR_LN/dt = -R_LN/tauE +
k wIE sum_j R_j; tau_p dp/dt = -p + 1/(1 + rho R_LN); dx/dt = (1-x)/tauD - x u+ p R;
du-/dt = -u-/tauF + U (1-u-) p R; u+ = u- + U (1-u-). Initial x = p = 1, rest 0.
**Unit convention (an inference, not stated in the paper):** seconds and Hz, weights enter as
k * w with k = 5 Hz/nS (the only k given, Figure 5), so A = k rho wIE tauE as in the supplement.

**G3a, analytic consistency (gated):** Table 1 DL5 and VM7 parameters, tau_p = 300 ms (the only
tau_p given), constant private R in {5, 10, 20, 50, 100, 200} Hz, public sum in {0, 100, 500} Hz,
forward Euler dt = 0.05 ms for 10 s. PASS if the final R_PN is within 1% of Equation 12 in every
case, and within 1% again at dt = 0.1 ms (step-size check).
**G3b, text claims with the Figure 4/5 parameter set (gated):** U 0.24, public 0, wEE 75 nS,
wIE 21 nS, tauE 55 ms, rho 8 ms, tau_p 300 ms, tauF 50 ms, tauD 100 ms.
- Ramp R = K t, K in {50, 100, 200, 400} Hz/s: PASS if R_PN at t = 3 s differs by <= 10% across K
  ("adapted responses are independent of K") and is within 10% of Equation 15 with R_eff* = 1/A.
- Triangle, same peak ORN rate 200 Hz for every K, rise at K then fall at the same |K|: PASS if
  PN peak value increases monotonically with K and PN peaks before the input peak for every K.
**G3c, reported not gated:** effective Hill coefficient of the 500 ms average PN response vs R
at public 0, DL5 and VM7 Table 1 parameters (the paper's gamma_a ~ 1.5 was fitted to data).
If G3a or G3b fails, the unit convention or the implementation is wrong: fix the cause, never a
parameter, and record it as a new dated section.

## 2026-09-15 21:20: step G3 result, and one follow-up written before running it

Run: bench-results/brain/variant1/g3/. **G3a PASS** (0.000% worst error at both dt), but it is
weaker than it looks: a forward-Euler fixed point equals the analytic steady state at any dt,
and k scales both sides, so G3a verifies the algebra of Eqs 1-5 vs Eq 12, not the unit
convention and not the integrator. **G3b triangle PASS** (peak 96 -> 180 Hz with K, always
before the input peak). **G3b ramp FAIL as preregistered:** spread across K at t = 3 s is 10.1%
(limit 10%), worst deviation from Eq 15 9.1%. **VERDICT G3 = FAIL** stands.

Cause found, not a parameter: Eq 14 says R_eff = K t / (A K (t - tauE) + 1) reaches 1/A only when
A K t >> 1. With A = k rho wIE tauE = 0.0462 /Hz, the slowest ramp (K = 50) has A K t ~ 6.9 at
3 s, so R_eff is still ~11% below 1/A. The 3 s window in the criterion was too early for K = 50;
the implementation agrees with the paper's own asymptotics. The criterion is not edited.

G3c, reported: log-log slope at half-max 0.76 (DL5) / 0.75 (VM7). **Correction of the wording in
G3c, not of the number:** for a Hill function the log-log slope at half-max is gamma / 2, so these
slopes imply gamma ~ 1.52 / 1.50, against the paper's gamma_a ~ 1.5. A diagnostic, run after the
FAIL and labelled as such: with k = 5 Hz/nS the 500 ms average saturates at 176 Hz (DL5) and
197 Hz (VM7); with k = 1 at 35 / 39 Hz. Olsen 2010 reports Rmax 144-170 Hz. So k = 5 is the
convention consistent with the paper's Figure 2; k = 1 is not.

**Follow-up G3b', criteria before running:** same ramps and parameters, evaluated at the time
where A K (t - tauE) = 50 for the slowest ramp (t = 21.7 s; ORN rates there are unphysical, this
checks the asymptotics only). PASS if spread across K <= 10% and every value within 10% of Eq 15.
G3's FAIL is not overwritten by it; both are reported.

G3b' result: at t = 21.7 s, R_PN 95.05 / 95.73 / 96.07 / 96.24 Hz for K = 50 / 100 / 200 / 400;
spread 1.2%, worst deviation from Eq 15 1.0%: **PASS**. Disclosure: the G3b' section above was
written to this file before the run, but committed together with its result in one commit, so
git alone does not prove the order for this follow-up.
Summary: G3 = FAIL as preregistered (criterion window too early); the model reproduces Eq 12,
Eq 15 asymptotics, the Figure 5 trends, gamma ~ 1.5 and an Olsen-range Rmax with k = 5 Hz/nS.
It is usable as the reference AL rate model for G4. Nothing was tuned.

## 2026-09-15 21:45: Variant 1, step G4 (local and global inhibition, still no electrical synapses), design and criteria before any code measures

G3 stays FAIL as preregistered; G3b' and the Rmax / gamma diagnostic are supporting evidence,
not a verdict (Darius, 15 Sep). G4 does not interpret G2's sensitivity as proof that inhibition
will fix it.

### Mechanisms added to the FlyWire LIF (subclass AlSim; LifSim unchanged)
1. **Patchy LNs as graded compartments.** Cells: PATCHY variant, see below. A patchy cell never
   spikes. It has one compartment per glomerulus it has assigned synapses in (glomerulus
   attribution frozen at commit 93cfabc). Each compartment has v and g with exactly the Shiu
   2024 membrane and synapse kernel, no threshold, no reset, no coupling between compartments
   (coupling is a separate question, per round-1 answer D). A pack edge onto a patchy cell is
   split across that cell's compartments in proportion to its assigned synapses per glomerulus;
   unassigned synapses (6%) are distributed in the same proportions.
   **Output, no fitted parameter:** each compartment releases at an expected rate
   f = (1000 / refractoryMs) * clamp((v - vRest) / (vThresh - vRest), 0, 1) Hz, delivered every
   step as w * frac(glomerulus) * f * dt to its targets' g, using only that cell's edges assigned
   to the same glomerulus. This is the expected value of the spiking output at that depolarisation
   under the model's own ceiling, stated as an assumption, not biology.
2. **Presynaptic inhibition on ORN terminals.** Every ALLN -> ORN edge that is inhibitory under
   the label set stops adding current to the ORN membrane. It feeds a presynaptic variable gPre
   of that ORN (same tauS kernel). Each ORN has p with tau_p dp/dt = -p + 1 / (1 + |gPre| / gHalf),
   tau_p = 300 ms (Liu et al. 2021, the only published value), p(0) = 1, and every outgoing edge
   of that ORN delivers w * p. gHalf has no published value: GRID gHalf in {1, 4, 16} mV, primary 4.

### Conditions
Label sets: CORRECTED-U+, CORRECTED-U-, TYPE-CONSENSUS/T+, TYPE-CONSENSUS/T-.
Mechanisms: BASE (none), PATCHY, PRESYN, BOTH.
PATCHY variants: all lLN2P (primary), lLN2P_a only, lLN2P_b only, lLN2P_c only.
Primary setting = patchy all lLN2P, gHalf 4 mV.

### Protocols (seed 1, ORN drive 2 mV/ms as in steps 1 and G2)
- P1 FOCAL: each glomerulus with ORNs, alone, 50 ms.
- P2 DISTRIBUTED: 5 test glomeruli drawn once (seed 1) from the 23 Hallem-covered glomeruli; for
  each, its ORNs driven plus n public glomeruli (n in {0, 4, 16}, drawn once per test glomerulus,
  seed 1, excluding it), 300 ms; readout = mean rate of the test glomerulus's uniglomerular PNs
  over 50-300 ms, and mean p of its ORNs at 300 ms.
- P3 OVERLAP: exactly step 1 (k = 3 and 8), reported for every condition, not gated.

### Q1, is the inhibition local where it should be? (PATCHY and BOTH conditions)
For each focal stimulation and each patchy cell with a compartment in the stimulated glomerulus:
ratio = mean (v - vRest) over 50 ms in that compartment / mean over the cell's other compartments.
LOCAL if the median ratio over all (stimulation, cell) pairs is >= 3.

### Q2, does distributed input produce the global component of gain control? (PRESYN and BOTH)
GLOBAL if, averaged over the 5 test glomeruli: PN readout strictly decreases from n = 0 to 4 to 16,
AND R(16) / R(0) is at least 0.10 lower than the same ratio in BASE for the same label set, AND
mean ORN p strictly decreases with n.

### Q3, is it robust to the label uncertainty?
- Q1 ROBUST if LOCAL in all 4 label sets for every PATCHY variant, in both PATCHY and BOTH.
- Q2 ROBUST if GLOBAL in all 4 label sets at every gHalf, in both PRESYN and BOTH (primary patchy).
- A result that passes in the primary setting for all 4 label sets but not across the grid or
  variants is reported "holds, parameter-sensitive". Anything else is "not robust".
No label set, variant or gHalf is selected afterwards; every row is reported.
G4 answers only Q1-Q3. Whether V1 is becoming a coherent nervous system is decided by Darius after
reading the full table, before any electrical synapse is built.

## 2026-09-15 23:15: step G4 result

Run: bench-results/brain/variant1/g4/ (80 conditions, ~2 h). Code c274dcd, criteria 64cf404.
Sanity: every BASE row reproduces the G2 numbers of its label set (AlSim = LifSim with both off).

**Q1 LOCAL: 36/64 -> NOT ROBUST.** By label set: CORRECTED-U- 16/16 (median ratio 44-162),
TYPE-CONSENSUS/T- 16/16 (11-24), TYPE-CONSENSUS/T+ 4/16 (only lLN2P_c, 4.5-4.7), CORRECTED-U+ 0/16
(1.4-2.0). Locality appears exactly where the uncertain LNs are inhibitory and the lobe is not
globally active, and disappears where it is.
**Q2 GLOBAL: 3/24 -> NOT ROBUST.** Passes only in CORRECTED-U- (PRESYN gHalf 1; BOTH gHalf 1 and 4).
In the + label sets uniglomerular PNs sit at 184-213 Hz for n = 0, 4 and 16 alike: presynaptic
inhibition lowers ORN efficacy p to 0.59-0.87 but the PNs stay saturated. In TYPE-CONSENSUS/T- the
PN readout moves by < 10%. Across all sets p falls mostly from n = 0 to 4 and barely after.
**Q3:** neither Q1 nor Q2 holds across the four label sets, even in the primary setting.

Reported, not gated (P3): neither mechanism improves odor separation in any label set. PRESYN
leaves overlap unchanged; PATCHY slightly RAISES uniglomerular PN overlap and firing (e.g. T- k=8
0.76 -> 0.82, U- k=8 0.49 -> 0.55). KC overlap and activity are unchanged.
Observations only, not tested: (a) PN saturation under the 2 mV/ms ORN drive caps what any
inhibition can show in the + sets; (b) turning lLN2P from spiking into graded cells may REMOVE net
inhibition, since spiking lLN2P fired toward the 450 Hz ceiling; either would need its own
preregistered test. Nothing retuned. Electrical synapses NOT started; decision is Darius's.
