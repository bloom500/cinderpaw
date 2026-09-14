# Attribution

This directory is a modified derivative of the Drosophila larva connectome:

Winding, M., Pedigo, B. D., Barnes, C. L., et al. (2023). The connectome of an
insect brain. Science 379, eadd9330. doi:10.1126/science.add9330

Data: Supplementary Data S1 (all-all_connectivity_matrix.csv, annotations.csv),
as mirrored at https://github.com/brain-networks/larval-drosophila-connectome.
The author manuscript is available on PMC (PMC7614541) under CC BY 4.0.

Modifications made when building this pack:

- synapse floor 5: only connections with at least 5 summed synapses
  (axon and dendrite, all four matrices) are kept;
- signs assumed +1 unless annotated inhibitory. Supplementary Data S1 has no
  neurotransmitter column, so no connection is annotated inhibitory and every
  weight in this pack is positive;
- MBON valence is "approach" for every compartment, the Aso et al. 2014
  convention for an MBON of unknown transmitter;
- roles: celltype "sensory" -> sensory, "KC" -> kc, "MBON" -> mbon, MBINs
  annotated "DAN-*" -> dan, dan plus MBINs annotated "OAN-*" -> neuromodulator.
  Larvae have no mature central complex, so no persistent-state role.
