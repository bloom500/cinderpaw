# CinderBrain emotion layer, test E2: does the connectome transform an outcome history?

Written 2026-09-15, before any E2 code or measurement. Darius approved writing it; he did NOT approve
the implementation. Nothing below is run until he reads the thresholds and says go.

## Why E2, and the one question it asks
E1 (PREREGISTRATION.md in this folder) read NO: taste input dies after about two synapses and never
reaches a dopamine neuron in this model. E2 skips the taste path and drives the reinforcement
neurons directly, which has experimental precedent: activating PAM dopamine neurons substitutes for
reward (Liu et al. 2012, Nature 488:512; Burke et al. 2012, Nature 492:433) and activating PPL1
substitutes for punishment (Claridge-Chang et al. 2009, Cell 139:405; Aso et al. 2010/2012).

Driving a population and reading it back proves nothing: the output would be a copy of the input.
So E2 asks one question, and every criterion below serves it:

> Does the connectome turn the HISTORY of agent outcomes into a response that is structured, is
> not present in the input, and is not reproduced by the best simple integrator of that history?

If yes, the chain is receipt -> simple input, connectome(receipt history) -> experience-dependent
state, and the LLM reads the state, not the receipt. If no, the connectome is only traversed.

## What is ours, said before anything runs
The simulator is point LIF, 20 ms membrane, deterministic, no neuromodulator release, and (E1) its
activity dies in well under a second. It therefore CANNOT carry an outcome from one agent event to
the next, which are seconds to minutes apart. Anything that persists across events comes from one
of three layers that we add, fixed now and never tuned:
- **K, kinetics:** a leaky concentration per readout, tau_DA = 120 s of agent time. Linear.
- **P, plasticity:** the existing kc-mbon-depression-v1 rule (Aso 2014 compartment logic, Hige 2015
  depression), eta = 0.1 as in the pack manifest. Literature-based, but a rule we wrote.
- **R, recovery:** each plastic delta decays toward 0 with tau_rec = 600 s of agent time. Ours; the
  as-built rule never recovers, which would be a permanent state, not a controlled one.

K is applied identically to every arm and every baseline, so it cannot create a difference between
them. The verdict is therefore measured on the per-event network response y, BEFORE K.
Persistence over minutes comes from K and R, never from FlyWire, and no sentence may say otherwise.
Also a pack fact: `manifest.compartments` is valence-lumped, not anatomical. Each of the 25
avoidance MBONs lists all 307 PAM; each of the 71 approach MBONs lists the same 16 DANs. E2 uses
it as built; a per-compartment map would be a new pack and a new test.

## Pack, populations, fixed now
flywire-783-v1 as built (Shiu 2024 kernel, AS-BUILT labels), 139,248 neurons.
- REWARD input: DANs with cell_type starting PAM (307). Caveat stated: a few PAM types (e.g. PAM-g3)
  signal relief or punishment; the whole family is used because it is what Liu 2012 drove.
- PUNISHMENT input: DANs with cell_type starting PPL1 (expected 16; G0 prints the count).
- CONTEXT input: Kenyon cells. A context is a fixed set of 5% of KCs (259), bypassing the antennal
  lobe, which the validation ladder showed smears inputs. Contexts A, B, C, D drawn with seed 2001,
  pairwise disjoint; A' = half of A plus 130 KCs outside A to D (Jaccard with A about 0.33).
- READOUTS, never driven in the event they are read: MBON valence balance m = mean rate of the 71
  approach MBONs minus mean rate of the 25 avoidance MBONs (primary); arousal a = mean rate of all
  96 MBONs; the DAN family NOT injected in that event (PPL1 on reward events, PAM on punishment).
- 5-HT (the 197 literature-serotonin cells): **exploratory readout only**, reported, never gated,
  never marketed from E2. Serotonin in Drosophila is state- and receptor-dependent; it gets its own
  test if a justified input is found.
- WHOLE BRAIN: all neurons, runaway check.

## One agent event
An event is (valence in {reward, punishment}, magnitude in {0.5, 1}, context, gap since the last
event). Simulated from rest for 300 ms: the context KCs get 2 mV/ms for the whole window; the
valence population gets 2 x magnitude mV/ms for 0-100 ms. y = readouts averaged over 0-300 ms.
Arm P+R: after the window, the plastic deltas are updated by the rule, gated by whether the injected
DANs fired (no second DAN drive), using the KC rates of the window; then R decays them over the gap.

## Arms
- **K (harness check):** no plasticity. The network has no memory across events here, so y must
  depend on the current event only. Predicted now: fully explained by B0.
- **P+R (the test):** plasticity with recovery. The only arm that can pass.
- **P as built:** plasticity, no recovery. Reported, not gated.
- **P+R SHUFFLED:** whole-brain target shuffle within weight sign, seed 1001, as E1, except the
  21,438 KC->MBON plastic edges are held fixed so the rule still has its edges. It tests whether the
  rest of the wiring (DAN->MBON, MBON->DAN feedback, everything else) matters. Informative only if,
  on a fresh reward event and a fresh punishment event, whole-brain, MBON and DAN rates are each
  within 2x of the real arm; otherwise declared uninformative, which is not evidence for the wiring.

## Sequences
Training: 120 random sequences of 30 events; test: 60 more; seeds 3001 and 4001. Valence p = 0.5,
magnitude and context uniform over {A, B, C, D}, gaps log-uniform 5 s to 10 min. A' appears only in
the probes. Probes below are never in training.

## Baselines: the best simple integrator
Fit on training sequences to the arm's own y, hyperparameters by 5-fold CV inside training only,
scored on the 60 test sequences. The best of the three is "the baseline".
- **B0 current event:** lookup by valence x magnitude x context.
- **B1 leaky integrator:** B0 plus, per valence, an exponential trace of past magnitudes, tau chosen
  on a grid (10 s to 1 h), traces also kept per context and weighted by KC Jaccard with the current
  context (so the baseline knows context overlap; it is not handicapped on H4).
- **B2 second order:** ridge on B1's features, the last 8 events one-hot, gaps, and every pairwise
  product of the current event with each of those (catches plain reward x punishment interaction).

## Gate G0, before any history is measured
Counts printed (PAM 307, PPL1, MBON 96, KC 5177). A fresh reward event and a fresh punishment event,
each in context A: at least 10% of MBONs must fire at least once, and m must differ in sign or by
at least 0.1 Hz between the two. **If not: STOP**, report "the network does not transform injected
dopamine into MBON output in this model", no weight or drive retuned. The window cost is also
measured here and the full run is started only if the arms fit in one night.

## Named effects (all on the primary readout m unless said; Y0 = |m| of a fresh reward event in A)
- **H1 history contrast:** reward in A after 4 punishments in A, versus after 4 rewards in A (gaps
  30 s). |contrast| >= 0.25 Y0.
- **H2 recovery asymmetry:** after 4 punishments, the number of rewards (gaps 30 s) until m is within
  10% of Y0; mirror for punishments after 4 rewards. Ratio >= 1.5 or <= 1/1.5. R is symmetric, so an
  asymmetry cannot come from our layer.
- **H3 interaction:** previous event x current event, 2 x 2 over {reward, punishment}, context A,
  gap 30 s. |y_RR - y_RP - y_PR + y_PP| >= 0.2 x mean |y|.
- **H4 context generalization:** 4 punishments in A, then reward in A' versus reward in B.
  |m(A') - m(B)| >= 0.25 Y0, and A' is shifted further from its fresh value than B.
- **H5 hysteresis:** 40 events in A, reward probability ramped 0 -> 1 -> 0 (fixed sequence, seed 5001).
  m at the p = 0.5 points differs between the up and the down leg by >= 20% of m's range.
An effect PASSES only if it meets its threshold on the arm AND the baseline's prediction of the same
quantity misses it by at least the same threshold (e.g. H1: |real contrast - baseline contrast| >=
0.25 Y0). Meeting the threshold alone shows a difference, not a transformation.

## Verdict
- **V0 harness valid:** in arm K, B0 explains y with test R^2 >= 0.95. If not, the harness is broken:
  STOP, no verdict, fix the harness, new dated section.
- **TRANSFORMS** (arm P+R, all of): V1 the baseline's test R^2 on m is < 0.80; V2 the part it misses
  is structured, not fragile: rerun the 60 test sequences with drive x 1.05, event onsets +2 ms and
  context seed 2002 for the non-probe contexts, and the baseline residuals of the two runs correlate
  >= 0.7; V3 at least 2 of H1-H5 PASS; V4 not runaway: no event's whole-brain rate exceeds 3x the
  first event of its sequence, and no event drives all 96 MBONs above 100 Hz.
- **CONNECTOME-SPECIFIC:** TRANSFORMS, the shuffle is informative, and the shuffle fails at least one
  H that the real arm passes (or its baseline test R^2 is >= 0.80).
- **CONTROLLED PERSISTENCE** (reported, it follows from K and R): after 30 min without events,
  every plastic delta is within 10% of 0 and the K state within 10% of rest.
- **READABLE (for the mascot, no LLM):** the K state of m is cut into 5 moods at training-set
  quintiles. After 6 rewards versus 6 punishments in A (gaps 30 s) the mood differs by >= 2 levels,
  and across the test sequences the mood changes on at most 1 event in 3 (it must not flicker).
- **COST** on this PC (16 logical cores, 16 GB, one thread): p95 wall time per event <= 1.0 s and
  peak RSS <= 1.0 GB, both logged. Failing COST does not change the science; it blocks shipping as-is.
- Whether an LLM can read the state is NOT in E2: it needs paid model calls and gets its own test
  (E3) after asking. 5-HT is reported only. Nothing is tuned after a number exists; a new idea is a
  new dated section. The thresholds are judgement, set before data.

## What each outcome allows us to say
- TRANSFORMS + CONNECTOME-SPECIFIC + CONTROLLED PERSISTENCE: "a hybrid neuromodulatory simulation on
  a real fruit-fly connectome: the connectome shapes how the history of the agent's successes and
  failures becomes an internal state; a kinetics layer models how long that state lasts". Never
  "persistence emerges from FlyWire", never "feels".
- TRANSFORMS only (shuffle also passes or is uninformative): "a spiking brain model shapes the state",
  nothing about the fly's wiring being the reason.
- V0 or TRANSFORMS fails: the connectome is only traversed. If a mood layer ships for the feel, it is
  the simple integrator, described as that, with no connectome claim.
- On a machine that never downloaded the pack, any shipped layer is off and says so on screen; that
  belongs to the implementation spec, not to E2.
