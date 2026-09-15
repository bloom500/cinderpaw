# Research track: the transmitter sign of uncertain antennal-lobe local neurons

Separate from the release (Darius, 15 Sep: CinderBrain may not delay it). Variant 1 stopped at G4
because the sign of 211 of 429 ALLNs (no literature label, predicted confidence < 0.50) decides
whether the modelled antennal lobe is calm or runaway. This track tries to label them from
evidence, never from which label makes the simulation look better. Nothing here changes a pack.

## R1, 2026-09-15: hemilineage (read-only, table in r1-hemilineage-table.md)
Principle: Lacin et al. 2019 (eLife 8:e43701) showed that in the ventral nerve cord every neuron of
a hemilineage uses the same fast transmitter. Shown for the VNC, not proven for the antennal lobe.
FlyWire gives each ALLN an ito_lee_hemilineage. Result:
- **ALv2, 168 ALLNs, 98 uncertain.** Evidence inside the hemilineage: literature glutamate 2;
  confident predictions glutamate 62 vs acetylcholine 6. Das et al. 2011 (Neural Syst Circuits,
  PMC3257541) describe a ventral antennal-lobe lineage whose local interneurons are "uniform in
  their glutamatergic neurotransmitter identity". That ALv2 IS that lineage is an inference from
  the v2LN/vLN types and the prediction majority, not verified against their clone images.
  If it holds, the 98 uncertain ALv2 cells are glutamatergic, i.e. inhibitory (GluCl, Liu & Wilson
  2013), and the 6 confident acetylcholine predictions in ALv2 are prediction errors.
- **ALl1_dorsal, 255 ALLNs, 111 uncertain.** The hemilineage rule cannot decide here: literature
  labels in it are both GABA (12) and acetylcholine (44), and Das et al. 2008 (PMID via Europe
  PMC, "Drosophila olfactory local interneurons and projection neurons derive from a common
  neuroblast lineage") show the lateral neuroblast makes GABAergic AND cholinergic LNs plus
  uniglomerular PNs. Either the rule does not hold for this lineage or FlyWire's hemilineage
  label merges two hemilineages.
- 2 putative_primary cells (ALBN1) stay uncertain.
So R1 plausibly resolves 98 of 211 (all as inhibitory) and leaves ~113, almost all in ALl1_dorsal.

## Next, not started
- R2: ALl1_dorsal, a classifier trained ONLY on its literature-labelled cells (12 GABA, 44 ACh)
  using connectivity and morphology features, validated by leave-one-type-out before it labels
  anything. Stop if leave-one-type-out accuracy is not clearly above the majority-class baseline.
- R3: check the ALv2 = Das 2011 lineage mapping against published clone morphology.
- Only after R2/R3, and with new preregistered criteria: rerun G2's measurement with the resolved
  labels. Variant 1 stays stopped unless Darius reopens it.
