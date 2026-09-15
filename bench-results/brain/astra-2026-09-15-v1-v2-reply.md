# Astra, 15 Sep 2026: Variant 1 vs 2 (reply to astra-2026-09-15-v1-v2-brief.md)

**My decision: give 1-lite one bounded research attempt. Keep product integration conditional on beating the simple baseline. Remove the “add mechanisms until something passes” escape hatch.**

Taking your literature summaries as given:

### A. Legitimate, with a precise name

It is a legitimate **phenomenological AL replacement**, implemented through the V2 bypass. It adds a specified input transformation and realistic odor structure.

Call it a **hybrid model combining published olfactory normalization with a spiking adult fly-connectome network**. That describes the engineering honestly. It does not establish a biologically validated antennal lobe or brain.

“Published parameters require no fitting” remains conditional on your inputs having the units, concentrations, and coverage those parameters expect.

### B. Feasibility and odds

By implementation effort: **V2 < 1-lite ≪ full V1**. My preference for this release window is **1-lite**.

Subjective planning estimates for passing the **representation and controlled-learning gates**, assuming adequate runtime:

| Path | Chance within 1–2 weeks |
|---|---:|
| V2 | 20–40% |
| 1-lite | 30–50% |
| Full V1 | Below 10% |

These are judgment ranges, not measured probabilities. I cannot credibly estimate passing the **product gate** before establishing that memory selection affects outcomes.

Sixteen GB is not automatically disqualifying for sparse simulation. Profile one complete trial before committing to the experiment count.

### C. My preregistered step 2-bis

These would be **engineering acceptance thresholds**, not claims about biological normality:

- **Panel:** 24 odors, forming 12 similar pairs; separately fix 12 dissimilar comparisons. Define similarity from the calibrated ORN vectors before inspecting PN/KC results. Suggested cosine thresholds: similar ≥0.70; dissimilar ≤0.20.
- **Presentations:** 20 independent spike realizations per odor. Identical reset procedure; 100-ms baseline and 500-ms stimulation. Primary activity window: **50–100 ms after onset**.
- **Activity:** For every odor, at least 18/20 presentations have **2–15% of KCs firing at least once**.
- **Overlap:** Cosine similarity of binary active-KC vectors. Generate 1,000 null matrices preserving both each presentation’s active count and each KC’s total activation count.
- **Separation:** Mean dissimilar-odor overlap ≤0.30 **and** ≤1.5 times the corresponding null mean.
- **Repeatability:** Median same-odor overlap ≥0.50 and above the null’s 99th percentile.
- **Structure:** Mean similar-pair overlap exceeds dissimilar-pair overlap by ≥0.05, with a positive lower 95% confidence bound using resampling that respects odor/pair dependence.

Report the full response time course without selecting a better window afterward. Failure identifies a failed gate; it does not automatically identify the AL as the cause.

### D. Silent KCs: neither mechanism

**Neither adaptation nor added APL inhibition is the natural rescue for silence.** Both primarily suppress activity.

First check actual emitted PN rates, synaptic delivery, coincident inputs, KC thresholds, and existing inhibition. Poisson events delivered *into* a PN do not guarantee that PN emits the intended rate.

Replacing excessive existing inhibition could disinhibit KCs, but requires evidence that inhibition caused the silence. For excessive **population** activity, graded APL is the better first hypothesis; adaptation addresses excessive persistence.

### E. Any credible product advantage?

One plausible hypothesis: **rapid, context-specific association updates with little interference between unrelated memories**. Measure learning curves against receipt count, reversal recovery, and retention of older associations.

But that remains reranking territory. Compare against a simple contextual learner and matched random sparse features. Depression-only plasticity does not automatically confer fast reversal.

Crucially, odor performance says nothing yet about your task/memory-to-PN encoding. **No demonstrated product advantage currently makes CinderBrain release-critical. I would treat it as research until that comparison wins.**

### F. The missing issue: input calibration

**A consensus ORN response matrix is not automatically an absolute firing-rate matrix.** Verify DoOR’s scale, baseline handling, concentration compatibility, and what “totalORN” means in the normalization model.

An arbitrary conversion into Hz becomes a new free parameter. If chosen by KC activity, it recreates the tuning loophole you intended to close.

Also, preregistering each rescue sequentially does not remove selection bias. Any selected rescue needs untouched confirmatory odors and seeds.
