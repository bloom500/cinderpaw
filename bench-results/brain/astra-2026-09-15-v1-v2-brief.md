Astra, follow-up on CinderBrain (same thread as your 5-point review last night). Opinion only, no implementation, no file writes. Nothing new has been measured since your review. Darius made CinderBrain P0 before release and wants a decision: HOW we do Variant 1, or whether Variant 2 is more feasible and worth it.

Read-only context in the repo (D:\Cinderpaw Agent, branch feat/cinderbrain) if you need it: bench-results/brain/VALIDATION-LADDER.md, .superpowers/sdd/2026-09-14-cinderbrain/progress.md (sections "AL LITERATURE INVESTIGATION", "ASTRA REVIEW"), CinderpawAgent/src/brain-substrate/. Do not re-read everything; the facts below are enough.

## What my literature pass added today

1. Olsen, Bhandawat & Wilson 2010 (Neuron 66:287): PN odor responses in the fly AL are predicted by a two-variable divisive normalization: PN = Rmax * ORN^1.5 / (ORN^1.5 + sigma^1.5 + (m * totalORN)^1.5), per-glomerulus Rmax ~145-170 Hz, sigma ~12-45. This IS a published phenomenological AL model with fitted parameters, i.e. your "minimal phenomenological AL baseline" already exists and needs no fitting by us.
2. DoOR 2.0 (Muench & Galizia 2016, Sci Rep 6:21841): consensus ORN response matrix, 693 odorants x nearly all responding units, open data. Real odors instead of random glomerulus sets. Receptor->glomerulus map is in DoOR; FlyWire ORN cell types are `ORN_<glomerulus>`.
3. Betkiewicz, Lindner & Nawrot 2020 (eNeuro): in a spiking insect olfactory model, spike-frequency adaptation sets TEMPORAL sparseness and lateral inhibition (APL-like) sets POPULATION sparseness. Rapp & Nawrot 2020 PNAS has open code (nawrotlab GitHub) for a spiking MB with APL on/off. Our point-LIF has no adaptation at all.
4. Litwin-Kumar et al. 2017 / Gruntman & Turner 2013: KCs need several coincident claws; ~7 PN inputs per KC with a threshold that makes ~5-10% fire is what gives separation. In our 2b lesion KCs are silent (0.3-0.6%) under a flat 2 mV/ms PN drive; in 2a they are 26-29% with smeared PNs.
5. Therianos 2026, arXiv 2606.17745: frozen rate operator on the complete LARVAL connectome; degree and weight explain gross response, exact wiring governs routing, and the mushroom body concentrates leading driving modes beyond degree-weight-matched rewirings, surviving cell-class-preserving nulls. Supportive of "MB wiring matters", but a rate model, larva, and no learning.

## My current proposal (tear it apart)

"Variant 1-lite", which I think collapses the V1/V2 choice for this release:
- Keep the 2b lesion (spiking AL cannot reach PNs).
- Replace the flat PN drive with PN rates computed by the Olsen 2010 equation from DoOR ORN responses of real odorants (published parameters, never tuned on KC outcome), delivered as Poisson spike trains into the uniglomerular ALPNs.
- Step-2-bis criteria per your review: KC activity lower AND upper bound, KC overlap relative to an activity-matched random baseline, repeatability across presentations; odors chosen as a fixed DoOR panel including similar pairs (e.g. an ester series) and dissimilar ones.
- If KCs stay silent or dense: add ONE MB-level mechanism at a time (KC spike-frequency adaptation, or graded non-spiking APL), each preregistered, stop at the first that passes.
- Full Variant 1 (gap junctions, presynaptic GABA-B, depression in the AL) stays post-release and only if 1-lite fails on similarity structure (e.g. similar odors not closer than dissimilar ones in KC space).
- Product side unchanged from your review: learned-reranker baseline arm, paired copied state, balanced + reversed valence. CinderBrain ships only behind a kill switch and only if it beats that baseline; otherwise the release goes without it.

## Questions, answer each briefly and bluntly

A. Is "1-lite" (Olsen 2010 normalization + DoOR odors into the lesioned FlyWire PNs) a legitimate first rung of Variant 1, or is it Variant 2 with better paint? What may we honestly call it?
B. Feasibility before a release in roughly 1-2 weeks, with one developer-agent and a machine with 16 GB RAM: V2 as written last night vs 1-lite vs full V1. Rank them, with your estimate of the chance each yields a result that passes the gates.
C. The KC activity band and the similarity test: what exact preregistered criteria would you write for step 2-bis? (numbers, baseline, number of odors, repeats)
D. If KCs are silent under realistic PN rates, which single MB mechanism would you add first, adaptation or graded APL, and why?
E. Given your point D last night (a fly brain is probably not the right tool for three capped outputs): is there ANY product seam where the MB substrate plausibly beats a learned reranker, e.g. sample efficiency on few receipts, or fast reversal learning? If none, say so, and we treat CinderBrain as a research track, not a release item.
F. One thing I have missed.
