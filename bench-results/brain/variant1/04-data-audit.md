# Variant 1, step G1: data audit (read-only, nothing in the model changed)

2026-09-15. Script: `CinderpawAgent/src/brain-substrate/bench/al-audit.ts` (40 s), raw table
`04-al-audit-raw.md`. Hallem coverage computed from ropensci/DoOR.data per-receptor CSVs,
raw `04-hallem-coverage-raw.txt`.

## 1. Antennal lobe cells in FlyWire 783
- 429 ALLNs, 95 types, left 214 / right 213 / center 2.
- **Transmitter labels are unreliable exactly where it matters:** 62 ALLNs carry a literature
  `known_nt`; for **36 of 62 (58%)** the predicted `top_nt` is not the known one. Median top_nt
  confidence of the key types is 0.29-0.35. This supports round-1 answer B: the no-gap reference
  must be rebuilt with corrected labels first, or any electrical-layer gain is confounded with
  fixing signs.
- **eLN candidates behave like broad lateral-excitation cells.** Known cholinergic lLN1_bc (30
  cells, predicted ACh 11 / DA 12 / 5-HT 7) and lLN2X03 (6, predicted 5-HT) are the broadest
  types (median 31 and 35 glomeruli carry 80% of their glomerulus-attributed synapses) and send
  the most synapses to uniglomerular PNs (median 1163 and 1510 per cell).
- **lLN2P inventory reconciled:** lLN2P_a 13 (predicted Glu, no known), lLN2P_b 12 (known GABA +
  MIP), lLN2P_c 9 (predicted GABA) = 34 cells over both sides, ~17 per side, consistent with
  Schlegel 2021's 14 patchy lLN2P in the one-hemisphere hemibrain. The "25" in the brief counted
  only a+b. lLN2P_b sends the most to ORN terminals (median 1070), lLN2P_c the most to uPNs (1320):
  the subtypes are not wired alike, so "which lLN2P are nonspiking" must be settled per subtype.
- Glomerulus proxy for compartments (answer D): a synapse's glomerulus is inferred from the
  partner's type (ORN_<g>, <g>_uPN). Works for ORN and uPN partners only; LN-LN synapses
  (lLN1_bc: ~2200 per cell each way) have no glomerulus by this proxy. That is the main data
  gap for per-glomerulus compartments; FlyWire synapse coordinates + glomerulus meshes would
  close it and are not downloaded.
- Glomeruli: 53 with FlyWire ORN types, 56 with uniglomerular PN types, 50 with both.

## 2. Hallem & Carlson 2006 as the ORN input (answer H checked)
- DoOR dataset info for Hallem.2006.EN: **spontaneous firing reported AND subtracted**, odorants
  at 10^-2, and "EN" = receptors expressed in the **empty-neuron** system (ab3A decoy), not
  recordings from native ORNs. Negative values exist (e.g. Or59b 17 of 110 odors, Or7a 14).
  So rate = spontaneous + delta, clipped at 0, and the spontaneous rate per receptor must come
  from the table's SFR row. Round-1 answer H was right.
- Coverage: **24 receptors -> 23 FlyWire glomeruli of 53 (43%)**; Or33b maps to DM5+DM3 jointly.
  The other 30 glomeruli are NOT silent by default (answer H): first conclusions stay limited to
  the covered glomeruli; any DoOR fill-in is a separate sensitivity analysis.

## 3. What this changes in the plan
- Step G2 (no-gap reference with corrected labels) is now clearly necessary and has a concrete
  input list: the 36 disagreeing ALLNs, plus a rule for the 367 ALLNs with no literature label.
- Patchy compartments need glomerulus attribution for LN-LN synapses; decide between downloading
  synapse coordinates + meshes and restricting compartments to ORN/uPN-facing synapses.
- Odor input: 110 odors x 23 glomeruli in Hz is enough for a first, explicitly partial panel.
