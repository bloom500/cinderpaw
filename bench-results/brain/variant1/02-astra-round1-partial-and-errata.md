# Round 1: Astra's partial answer, and the dossier errata it forced

2026-09-15. Astra's run (119.8k tokens, with web search) hit the Codex usage limit before writing
her answer; the limit resets 2026-09-19 12:43. Before it stopped she reported three corrections
while checking sources. Claude verified each one the same afternoon.

## Errata to 01-dossier-and-brief.md

1. **Wrong attribution, wrong parameters (VERIFIED).** The short-term plasticity + presynaptic
   inhibition model that reproduces Olsen 2010 normalization is **Liu, Li, Tang, Qin & Tu 2021**
   (bioRxiv 10.1101/2021.05.02.442289; Front Comput Neurosci 15:730431, "Short-Term Plasticity
   Regulates Both Divisive Normalization and Adaptive Responses in Drosophila Olfactory System"),
   NOT Kao & Lo. The journal version gives DL5 tauD = 368 ms, tauF = 339 ms; VM7 tauD = 160 ms,
   tauF = 150 ms. The 100-130 / 50-90 ms values in the dossier came from a summary of the preprint
   and are NOT to be used. Kao & Lo 2020 (J Comput Neurosci, PMID 32388764) is a separate spiking
   AL model with diverse LN types (paywalled, not read).
2. **eLN->iLN is chemical, not electrical (VERIFIED, Yaksi & Wilson 2010, PMC2954501).**
   "eLN-to-iLN synapses are largely cholinergic", reduced by Cd2+ and by a nicotinic antagonist.
   Straw design point 3(c) is withdrawn: eLN->iLN stays a chemical ACh edge.
   Also from the full text: 74 dual recordings PN x krasavietz LN, 37 excitatory LN->PN
   connections, 17 inhibitory; eLN->PN "coupling coefficients are small" and **rectifying**
   (depolarization passes better than hyperpolarization); abolished in shakB2; sister PNs coupled
   by "mixed chemical-electrical connections". No single coupling number is stated in the text
   extract; figures would have to be read for one.
3. **Patchy LN identity (NOT independently verified, paywall).** Astra reports Barth-Maron,
   D'Alessandro & Wilson 2023 map the nonspiking patchy cells to lLN2P subtypes. Consistent with
   Schlegel 2021 (14 patchy lLN2P in the hemibrain) and with FlyWire's lLN2P_a (13, top_nt Glu),
   lLN2P_b (12, known GABA), lLN2P_c (9, top_nt GABA). Which subtypes are nonspiking is open.

## Consequences for the straw design

- Electrical layer = eLN<->uPN (rectifying) + sister uPN<->uPN; eLN->iLN kept chemical.
- STP parameters come from Liu et al. 2021 per glomerulus where fitted (DL5, VM7), not a
  single class value.
- Round 2 questions A-H in 01 are still open; resend after 19 Sep with these errata on top.
