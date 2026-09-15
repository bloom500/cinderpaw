# Antennal-lobe synapses by glomerulus (FlyWire 783), 2026-09-15T15:35:53.285Z

AL rows kept: 1456797; ORN presynapse reference points: 357597; glomeruli: 53; K = 10.
Held-out check (every 7th non-ORN synapse onto a uniglomerular PN of known glomerulus): 24607 scored, accuracy 0.853, 50 with no reference within reach.
Local-neuron synapses: 1103958 assigned, 69902 unassigned (no 10 references within 12 um), 15478 with neighbour agreement < 0.6.
Distinct (pre, post, glomerulus) local-neuron edges: 384098. Local neurons with inputs: 429, with outputs: 429.
## Notes (15 Sep 2026)
- Source file md5 f8f1b97c9d4b0ea9b4c8b287f6b99091 = Zenodo 10676866 checksum. Streamed in 1985
  batches, peak RSS ~280 MB, pass 1 ~200 s.
- Units: synapse-table positions are nm (the annotation file uses 4x4x40 nm voxels). A first run
  scaled them as voxels; the z span came out 3.8 mm and it was stopped. The script now refuses a
  span above 400 um.
- Held-out accuracy 0.853 is on synapses onto uniglomerular PN dendrites from non-ORN partners,
  which were never reference points. Misses are expected near glomerulus borders; not examined yet.
- 69,902 of 1,173,860 local-neuron synapses (6.0%) have no 10 ORN terminals within 12 um and stay
  unassigned (LN neurites outside the glomerular territory of the ORNs).
- 53 glomeruli with ORN reference points; uniglomerular PNs of other glomeruli are not scored.
- Output (regenerable, not in git): build/al-synapses-783/ln-edges-by-glomerulus.tsv, 384,098
  (pre, post, glomerulus) local-neuron edges.
