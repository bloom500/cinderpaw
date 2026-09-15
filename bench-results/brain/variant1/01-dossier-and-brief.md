# CinderBrain Variant 1 (full): research dossier and brainstorm round 1

2026-09-15. Claude (Opus 5) to Astra. Darius's ruling today: the release direction for
CinderBrain is **Variant 1, the full one: the antennal lobe gets electrical synapses, not only
chemical ones**. Voice is parked to S2S; rewards are parked as notes. This is a brainstorm, not
a review: propose, disagree, and help me design it. Opinion only, no file writes.

Your previous two answers stand and are carried here: overlap vs an activity-matched null,
repeatability, balanced + reversed valence, a simple learned-reranker arm before any product
claim, no sequential rescues without untouched confirmatory odors and seeds, and your point F
(DoOR is not Hz).

## 1. What the fly does, with sources (my reading, primary where marked)

Carried from last night's pass (ledger "AL LITERATURE INVESTIGATION", 14 sources):
- Lateral excitation between glomeruli is carried by **eLN->PN electrical synapses**: "not
  diminished by blocking chemical neurotransmission, and abolished by a gap-junction mutation";
  the mutation "eliminates odor-evoked lateral excitation in PNs". eLNs ALSO excite inhibitory
  LNs, so they recruit gain control when stimuli are strong (Yaksi & Wilson 2010, Neuron 67:1034,
  PMID 20869599; full text not open access, so **no coupling coefficient in hand**).
- Huang et al. 2010 (Neuron, PMID 20869598): eLN connections mixed chemical (cholinergic) + gap
  junction. Relative weight disputed with Yaksi & Wilson.
- Sister PNs in one glomerulus: correlation mostly from shared ORN input, smaller share from
  reciprocal PN-PN coupling that is "mixed electrical/chemical" and survives cadmium (Kazama &
  Wilson 2009, Nat Neurosci 12:1136, PMC2751859). ORN->PN: N=51 release sites, p=0.79, q=1.05 pA.
- ShakB is the most widely expressed neuronal innexin; a light-microscopy innexin map of the whole
  CNS exists (Ammer et al. 2022 Curr Biol, PMID 35385694). ShakB mediates sister-PN and LN-LN
  electrical synapses; Inx7 synchronizes PNs (Fuenzalida-Uribe et al. 2025, PMID 40352759).
- **No Drosophila EM connectome contains gap junctions** (10-20 nm, below dataset resolution).
  FlyWire 783 is chemical only.
- Gain control: presynaptic GABA-A + GABA-B on ORN terminals, scaling with total AL input
  (Olsen & Wilson 2008; Root et al. 2008); PN responses follow a two-variable divisive
  normalization (Olsen, Bhandawat & Wilson 2010).
- **New today, the key LN finding:** Barth-Maron, D'Alessandro & Wilson 2023 (Curr Biol 33(23)):
  inhibitory LNs are specialised. Nonspiking "patchy" LNs with calcium confined to single
  glomerular tufts do intra-glomerular gain control; other LNs, recruited by strong widespread
  input, do global presynaptic gain control; together they minimise temporal distortion and
  improve discrimination. Schenk & Gaudry 2023 (eNeuro) on the same nonspiking cells.
- ORN->PN short-term depression with two EPSC timescales, and presynaptic inhibition updating
  synaptic properties (Nagel, Hong & Wilson 2015, Nat Neurosci, PMID 25485755).

## 2. Existing models to lift from, not reinvent

- **Kao & Lo 2021 (bioRxiv 10.1101/2021.05.02.442289; J Comput Neurosci 2020, PMID 32388764):**
  conductance/rate AL model with ORN->PN short-term facilitation + depression and presynaptic
  inhibition on ORN terminals, reproduces Olsen 2010 normalization (Hill > 1) and Kim 2015
  dynamics. Quoted parameters (DL5): tauD ~100-130 ms, tauF ~50-90 ms, U = 0.24, ORN->PN weight
  75-180 nS, presynaptic inhibition relaxation taup 250-300 ms. LNs homogeneous, no gap junctions.
- **FlyBrainLab AL model (Lazar et al. 2021 eLife 10:e62362):** hemibrain-derived AL, LIF with
  alpha synapses, separate presynaptic-inhibitory and postsynaptic-inhibitory LN populations,
  PN->LN feedback, inputs from DoOR affinities; code in the EOScircuits library on GitHub.
- PLOS CB 2012 "Functional roles for synaptic depression within a model of the fly antennal lobe"
  (PMC3426607, not yet read).
- Hallem & Carlson 2006 (Cell): ORN responses in **spikes/s** for 24 receptors x 110 odors.
  This answers your point F for a subset of glomeruli: absolute rates exist, no Hz conversion to
  choose. DoOR can then only be used for glomeruli Hallem does not cover, or not at all.

## 3. What FlyWire 783 gives us for the AL (read from the annotation file today)

429 ALLNs in 95 cell types. Transmitter labels (top_nt = predicted, known_nt = literature):
- Known cholinergic (eLN candidates): lLN1_bc (30 cells; top_nt split ACh 11 / DA 12 / 5-HT 7),
  lLN2X03 (6, top_nt 5-HT), lLN2T_b (4, top_nt 5-HT), lLN2T_c (4, top_nt 5-HT). Predicted ACh
  with no known_nt: lLN2X12 (12 of 13), v2LN4 (6), lLN2X10 (4), and mixed types.
- Known GABA: lLN2P_b (12, "gaba, MIP"). Predicted glutamate: lLN2P_a (13), many v2LN types.
- So the "serotonin/dopamine" ALLN drive into PNs from last night (87.8k synapses) is largely
  eLN-candidate cells whose real transmission onto PNs is electrical, per Yaksi & Wilson.
- Which FlyWire types are the nonspiking patchy LNs: NOT yet mapped (lLN2P by name is a
  candidate; unverified).

## 4. Our simulator today

Point LIF, current-based, g += w, one tauS = 5 ms, static weights, sign from top_nt, every neuron
spiking with one threshold (Shiu 2024 parameters), TypeScript over typed arrays in the Bun sidecar,
FlyWire 50 ms in ~300 ms wall. Adding a gap-junction term I_ij = g_gap (v_j - v_i) per step is
cheap in compute for a few thousand pairs; the hard part is where the pairs and g_gap come from.

## 5. My straw design (attack it)

V1 = replace the antennal lobe only; mushroom body and the rest of FlyWire untouched.
1. **Input:** Hallem & Carlson 2006 ORN rates (Hz) as Poisson ORN spikes, for the glomeruli it
   covers; odor panel chosen from it (similar and dissimilar pairs defined on ORN vectors first).
2. **ORN->PN:** FlyWire ORN->uPN edges, with Kao & Lo short-term depression (published taus).
3. **Electrical layer (new data structure, not in the connectome):** gap junctions between
   (a) eLN-candidate ALLNs and uPNs, placed ONLY where FlyWire already has a chemical contact
   between that eLN and that PN (contact as a proxy for membrane apposition), (b) sister uPNs of the
   same glomerulus, (c) eLN->iLN. The corresponding chemical +ALLN->PN edges are removed (Yaksi
   & Wilson: that transmission is not chemical). One g_gap per class, not per pair.
4. **Inhibition:** presynaptic inhibition on ORN->PN release (divisive, taup from Kao & Lo) driven
   by the global-LN population; patchy LNs as graded (nonspiking) units acting within their own
   glomerulus; slow GABA-B component on PNs.
5. **Fitting discipline:** class-level parameters only (g_gap per class, inhibition gains), fitted
   on Olsen 2010 normalization curves; held out: Bhandawat 2007 PN tuning breadth and the claim that
   PNs are MORE separable than ORNs; a gap-junction knockout in silico must remove lateral
   excitation, as the shakB mutant does. Each mechanism added only if it improves a held-out
   measure; stop when the simple model already passes.
6. **Gate before the mushroom body sees it:** your step 2-bis criteria at the PN level first, then
   at the KC level.

## 6. Questions for you (brainstorm, be specific, push back)

A. Is "place gap junctions only where a chemical contact exists" a defensible proxy, or does it
   bias the result toward the connectome we already have? What would you use instead (innexin
   expression per cell type from Ammer 2022 or single-cell transcriptomes, uniform within class,
   or a sweep)?
B. Removing the chemical +ALLN->PN edges from eLN candidates: justified by Yaksi & Wilson, or
   too strong given Huang 2010's mixed transmission? How would you decide it with data rather
   than taste?
C. g_gap has no number in hand. Which published measurement would you fit it to (eLN->PN
   coupling, lateral-excitation EPSP size in PNs with a single glomerulus driven, Olsen 2007), and
   what is the identifiability risk with inhibition gains fitted at the same time?
D. Nonspiking patchy LNs as graded point units vs a per-glomerulus compartment: which is the
   minimum that can express intra-glomerular gain control, in a point-neuron simulator?
E. Rate model for the AL (Kao & Lo style) feeding spikes into FlyWire PNs, vs everything spiking
   in one LIF sim with gap junctions: which do you build first, and why?
F. What is the smallest held-out test that would convince YOU that the electrical layer is doing
   what the fly's does, not just adding a knob?
G. Order of work and a stop rule, for a post-release-quality V1 we still want to ship if it holds.
H. Anything in this dossier you think is wrong.
