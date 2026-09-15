# CinderBrain emotion layer, test E1: do FlyWire's dopamine and serotonin populations show emotion primitives?

Written 2026-09-15, before any code or measurement. Goal stated by Darius the same day: a basic
emotion layer (dopamine, serotonin) that gives the agent a more human feel and can be marketed;
not capability. This test asks only whether the simulated state is REAL in a defined sense,
before any of it reaches the agent or a sentence of marketing.

## What "emotion-like" means here
Anderson & Adolphs 2014 (Cell, "A framework for studying emotions across species") define
emotion primitives a state must show; Gibson et al. 2015 (Curr Biol) showed flies have a state
with them. Four are tested: VALENCE, SCALABILITY, PERSISTENCE, GENERALIZATION. Passing says the
model has an emotion-LIKE internal state with those properties. It does not say the agent or the
fly feels anything, and no marketing may say so.

## Simulator and pack
FlyWire 783 LIF exactly as built (flywire-783-v1, Shiu 2024 kernel, no noise, deterministic),
label set AS-BUILT. The antennal-lobe label uncertainty is irrelevant to taste input, but P1-P3 are
also reported under CORRECTED-U+ and CORRECTED-U- (G2) as a sensitivity check, not gated.

## Populations, fixed now
- REWARD input: gustatory `sugar/water` neurons (129 cells, cell_class gustatory).
- PUNISHMENT input: gustatory `bitter` neurons (65 cells).
- NEUTRAL input (control): 65 cells drawn once (seed 1) from sensory neurons that are neither
  gustatory nor olfactory nor visual.
- PAM: DAN cells whose cell_type starts with PAM (307); the reward-signalling family (Aso 2014).
- PPL: DAN cells whose cell_type starts with PPL (24); includes the punishment-signalling PPL1.
- 5-HT: cells whose literature `known_nt` lists serotonin (197; mostly central complex FC3,
  Delta7, hDeltaC, plus DPM and others). Predicted-only serotonin is EXCLUDED: that class is
  dominated by sensory neurons known not to be serotonergic (R1-6 photoreceptors, ORNs).
- WHOLE BRAIN: all neurons (runaway check).
Readout = mean firing rate per population in 50 ms bins, baseline = the 200 ms before stimulus.
Delta = mean rate during the stimulus minus baseline.

## Protocols
Stimulus = constant drive of I mV/ms for 200 ms, I in {0.5, 1, 2}, then off; record to 2000 ms.
G1: sugar alone; G2: bitter alone; G3: neutral alone; G4: bitter at t = 0, sugar at t = 700 ms
(both I = 1), compared with sugar alone at t = 700 ms.

## Criteria
- **P1 VALENCE** (I = 1 and I = 2): Delta_PAM(sugar) > Delta_PAM(bitter) AND Delta_PPL(bitter) >
  Delta_PPL(sugar), AND the valence-matched Delta (PAM for sugar, PPL for bitter) is at least 2x
  the same population's Delta under NEUTRAL.
- **P2 SCALABILITY:** the valence-matched Delta strictly increases from I = 0.5 to 1 to 2, for both
  sugar (PAM) and bitter (PPL).
- **P3 PERSISTENCE, not runaway** (I = 1): after offset, the valence-matched population's excess
  rate stays above 1/e of Delta for at least 100 ms (5x the 20 ms membrane constant), AND by
  2000 ms it is back within 20% of Delta of baseline, AND the whole-brain rate is back within 2x of
  its baseline. Excess that never returns is RUNAWAY and fails P3.
- **P4 GENERALIZATION** (reported, gated separately): |Delta_PAM(sugar after bitter) -
  Delta_PAM(sugar alone)| >= 20% of Delta_PAM(sugar alone). Direction is not preset; the
  literature does not fix it for this circuit.
- **S SEROTONIN ENGAGED** (reported): |Delta_5HT| >= 2x its NEUTRAL Delta for sugar or bitter.

## Control: is it the real wiring?
The same P1-P3 on a whole-brain degree-and-sign-preserving shuffle (sim/shuffle.ts core rule, seed
1001). The kill gate showed a whole-brain shuffle can go silent, so the control counts ONLY if its
whole-brain rate during the stimulus is within 2x of the real pack's; otherwise it is declared
uninformative, which is NOT evidence for the real wiring.

## Verdict
- EMOTION-LIKE STATE PRESENT: P1, P2 and P3 pass on the real pack.
- CONNECTOME-SPECIFIC: additionally, an informative shuffle fails at least one of P1-P3.
- GENERALIZATION shown: additionally P4.
- Anything else is reported as it is. Nothing is tuned after a number exists; a new idea is a new
  dated section. No LLM, no cost. The release does not wait for this.

## What each outcome allows us to say
- PRESENT + CONNECTOME-SPECIFIC: "emotion-like internal states (reward and punishment signals that
  scale, persist and fade) emerging from a real fruit-fly connectome".
- PRESENT only: "emotion-like states from a spiking fruit-fly brain model" and nothing about the
  wiring being the reason.
- Not present: no emotion claim from the fly model.

## Clarification, 2026-09-15, before any code measures (not a change of threshold)
The simulator has no noise, so with no input every baseline rate is exactly 0. Two criteria compare
against a multiple of a baseline: they are read as "<= max(2 x baseline, 0.1 Hz)" for the whole-brain
return in P3, and the NEUTRAL comparison in P1 and S as "Delta >= max(2 x Delta_NEUTRAL, 0.1 Hz)".
P3 persistence bins: the first two 50 ms bins after offset (200-300 ms) must both exceed Delta / e;
"back by 2000 ms" is the last bin (1950-2000 ms). Shuffle: whole-brain, targets permuted among edges
of the same weight sign (keeps every neuron's in-degree and out-degree and every edge's sign and
weight; duplicates and self-loops are allowed and counted). The MB-only shuffle in sim/shuffle.ts
does not apply to taste input and is not used.
