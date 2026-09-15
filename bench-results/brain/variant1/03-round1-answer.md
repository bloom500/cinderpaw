# Round 1 answer (brought by Darius, 15 Sep ~18:00), in Romanian as received

Answers A-H of 01-dossier-and-brief.md. Summary in English for the ledger:
- A: chemical contact as the only gap-junction site is too restrictive; eligibility = compatible
  class + local anatomical overlap, same hemisphere; contact and innexin as priors, not proof;
  several network realizations sampled by rules fixed in advance; compare (1) contact-required,
  (2) overlap-without-contact, (3) anatomy-constrained randomized with degree and total
  conductance matched; density and g_gap analysed jointly. eLN-iLN stays chemical.
- B: do not delete eLN->PN chemical edges wholesale: first fix transmitter identity where
  experimental annotation beats prediction, then compare predominantly-electrical vs mixed using
  chemical-block and gap-junction perturbation data; the reference must already have corrected
  labels, or the electrical layer gets credit for fixing signs.
- C: fix passive membrane first, calibrate coupling on subthreshold transfer, then lateral
  excitation amplitude/dynamics under single-glomerulus drive, only then inhibition on Olsen 2010;
  never fit g_gap and inhibition gains together; intervals + sensitivity when data is missing.
- D: patchy LNs = one graded state per (cell, innervated glomerulus) with local inhibitory output.
  Reconcile the lLN2P inventory (34 vs 25) before implementation. PN GABA-B needs its own evidence.
- E: reproduce a published experiment in a reference model first (units/equations), then a hybrid
  FlyWire model: spiking where supported, graded patchy compartments, voltage coupling, one spike
  source per PN. LIF reset vs gap current is a numerical hazard: stability and dt tests mandatory.
- F: convincing test = single-glomerulus drive, PNs without direct ORN input, intact vs chemical
  block vs electrical removal, amplitude and dynamics vs experiment, no refit between conditions,
  compared against the no-gap model with corrected labels/depression/inhibition on the same data.
- G: audit data -> corrected no-gap reference -> reproduce published depression + presynaptic
  inhibition -> local/global inhibition -> electrical coupling over plausible networks -> freeze ->
  confirmatory PN then KC -> product utility with the agreed controls. Drop "add a mechanism if it
  improves held-out". Stop rule: families, ranges, search budget and tolerances fixed first; one
  confirmatory set used once; fail if physiology missed or only a narrow post-hoc combination
  works; if the electrical layer cannot be supported, V1 stops, it is not renamed.
- H: "all gap junctions are below EM resolution" too categorical, say FlyWire 783 does not supply
  them; Hallem may be delta-from-spontaneous (negative values are not Poisson rates), check
  concentration/window/receptor-glomerulus map; uncovered glomeruli are not silent; DL5 values are
  not the whole AL; nS needs an explicit conversion in a current-based sim; "PNs more separable than
  ORNs" must be defined on a panel, metric and window.
