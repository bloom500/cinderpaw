# CinderBrain: a biologically derived neural substrate for Cinderpaw

Date: 2026-09-14. Status: design approved in conversation, awaiting written review.

## 0. What it is, in one paragraph

CinderBrain runs a spiking simulation of a real whole-brain connectome (FlyWire,
adult Drosophila, v783) inside the sidecar and connects it to the agent through
exactly two narrow seams: it re-ranks the candidates FMS already returns, and it
nudges two inference dials (temperature, recall-injection budget) with a slowly
drifting internal state. The LLM keeps every word, every tool call and all
reasoning. The connectome is loaded from a replaceable, versioned **brain pack**;
the simulator never knows what animal it is running. Every mechanism is kept only
if the real wiring measurably beats a degree-and-sign-preserving shuffle of the
same wiring AND the agent without a brain. When the pack is absent, corrupt, or
the feature is off, Cinderpaw is bit-for-bit today's Cinderpaw.

Non-goals: reasoning, knowledge, language, better screen understanding. A
`sensory-visual` role (optic lobe as a change/motion salience reflex for
computer_use and video) is reserved in the pack format but is NOT built here.

## 1. Architecture

New module `CinderpawAgent/src/brain-substrate/` (the name `brain/` is taken by
the Brain Stack capability router). Four pieces, one job each, no sideways
imports between them except through the types in `pack/`:

| Piece | Job | Knows about |
|---|---|---|
| `pack/` | `BrainPack` type, manifest schema, loader + validator, atomic installer, and the build-time adapters (`flywire`, `larva`) | nothing else |
| `sim/` | LIF with sparse spike propagation over a `BrainPack` (Shiu et al. 2024 parameters) | `pack/` |
| `plasticity/` | compartment-specific, dopamine-gated KC→MBON delta on the declared plastic edges only (§4); learned state persisted separately from the pack | `pack/`, `sim/` |
| `seams/` | `memory-rerank` (into `Recaller`) and `control-dial` (into `#championParams`), each with a kill switch | all three above, plus the two existing agent-loop inlets |

Runtime: TypeScript over typed arrays (`Int32Array` CSR, `Float32Array`
weights) in the Bun sidecar, because FMS and BRSI live there. Rust only if
measured too slow on the FlyWire pack.

## 2. Brain pack

### 2.1 On disk

`~/.cinderpaw/brain/packs/<packId>/`

- `manifest.json`
  - `packId` (e.g. `flywire-783-v1`), `species`, `source` (dataset name, DOI,
    release), `completeness: "whole-brain" | "region"`
  - `packFormatVersion` (layout of these files), `simulatorAbiVersion` (what the
    sim expects: parameter names, CSR semantics). Independent of `packId` and of
    each other: a new file layout, a new sim contract and a new connectome are
    three separate version bumps.
  - `license` (SPDX), `attributionFile` (required; loader refuses a pack without it)
  - `neurons`, `edges`, `simParams` (see §3), `seed` (for the fixed sensory projection)
  - `populations`: role → `Int32Array` of neuron indices. Roles: `sensory`, `kc`,
    `mbon`, `dan`, `persistent-state`, `neuromodulator`; `sensory-visual` reserved.
    A pack may omit roles; each seam refuses to activate without the roles it
    needs and says so on screen.
  - `plasticEdges`: `[start, end)` ranges in the CSR that are KC→MBON. Only these
    may ever carry a learned delta.
  - `sha256` per file.
- `csr.bin`: `rowPtr Int32`, `colIdx Int32`, `weight Float32`. `weight` is the
  **signed effective structural weight of the connection**,
  `sign × synCount × W_syn` (W_syn = 0.275 mV from `simParams`), so a
  connection made of 40 synapses is 8× stronger than one made of 5. It is
  NOT a per-synapse weight; the synapse count is folded in at build time and
  `synCount` is not stored separately. No JSON for large numerics.
- `ATTRIBUTION.md`: citations and the derived-work notice.

### 2.2 Learned state, separate from the pack

`~/.cinderpaw/brain/state/<packId>/`

- `learned_delta.bin`: `Float32Array` over the plastic edge ranges only.
- `cx_state.bin`: membrane state of the `persistent-state` population.
- `meta.json`: `packSha256` (of `csr.bin`), `plasticitySchemaVersion`, `updatedAt`.

Mismatch on `packSha256` or `plasticitySchemaVersion` → state is NOT loaded,
left untouched on disk, and the UI shows why. "Reset brain" deletes this
directory and nothing else. Replacing a connectome never migrates learned state.

### 2.3 Building packs (never on the user's machine)

`scripts/brain/build-pack.ts --adapter flywire|larva`:

- **flywire**: Zenodo 10676866 `proofread_connections_783.feather` → keep
  connections with ≥ 5 synapses → sign from `top_nt` in Schlegel 2024
  Supplementary Data (`flywire_annotations` repo) (ACh/DA/5-HT/OA positive,
  GABA/Glu negative) → roles from `cell_class` / `super_class` (Kenyon cells,
  MBONs, DANs, central-complex EPG/PEN/Δ7 for `persistent-state`, dopaminergic +
  octopaminergic for `neuromodulator`, antennal-lobe projection neurons as the
  default `sensory` set) → `csr.bin` + manifest. Output uploaded to the GitHub
  release as `cinderbrain-flywire-783-v1.tar.zst`.
- **larva** (Winding et al. 2023, ~3k neurons): same script, same roles, output
  committed to `CinderpawAgent/test-fixtures/brain/larva/` if its data license
  allows redistribution; otherwise built in CI from the official source. To
  verify at implementation time.

### 2.4 Licensing (verified 2026-09-14)

- Connections: Zenodo 10676866, **CC BY 4.0**.
- Annotations: Supplementary Data of Schlegel et al. 2024, Nature, **CC BY 4.0**
  (the GitHub mirror has no license file; the article does).
- Dorkenwald et al. 2024, Nature: CC BY 4.0.

Redistributing a derived pack is permitted with attribution. `ATTRIBUTION.md`
cites the FlyWire Consortium, Dorkenwald 2024, Schlegel 2024, Eckstein 2024
(neurotransmitter prediction), the Zenodo DOI, and states the pack is a modified
derivative. Same entries go into `THIRD-PARTY-NOTICES.md`.

CC BY covers data, not trademarks. Using the FlyWire logo or "Cinderpaw x
FlyWire" on the site is a **release task**: email FlyWire/Princeton first, or
document the credit on the site without the logo. Not a code task.

### 2.5 First run (what a stranger sees)

`brain.enabled` defaults to on. At boot the sidecar checks for the default pack
(`packs.default = "flywire-783-v1"` in the sidecar config, the same way a model
is named).

- Missing → emit `brain: {status: "downloading", packId, bytes}` on the existing
  host protocol, download in the background with retry. UI status line:
  "CinderBrain: downloading the FlyWire pack (42 MB)".
- Installed atomically: `<id>.partial` → verify sha256 → unpack to temp dir →
  validate manifest + CSR (row pointers monotone, indices in range, populations
  in range, plastic ranges inside the CSR) → atomic rename to `packs/<id>/`. A
  crash at any step leaves either the previous pack intact or no pack, never a
  partial one.
- Loaded → "CinderBrain: active · 139,255 neurons" (shown after load, not after download).
- Hash mismatch → pack removed, "CinderBrain: off, corrupt pack, retrying".
- No network → "CinderBrain: off, no connection; the agent works normally".
- `CINDERPAW_BRAIN=0` → off, for benchmarks and CI.

Every off state carries its reason on screen, not only in a log.

## 3. Simulator

Leaky integrate-and-fire with α-synapses, parameters from Shiu et al. 2024 as
used by flypoke, carried in the manifest's `simParams` so a future pack can
override them: rest −52 mV, threshold −45 mV, τ_membrane 20 ms, τ_synapse 5 ms,
refractory 2.2 ms, delay 1.8 ms, W_syn 0.275 mV per synapse, dt 0.1 ms,
exponential Euler. Spike propagation is sparse over the CSR (only neurons that
spiked traverse their row), but membrane potential and synaptic conductance
evolve continuously for every neuron (`dv/dt`, `dg/dt` with τ_membrane and
τ_synapse) and must preserve the Shiu LIF/α-synapse dynamics; "event-driven"
refers to edge traversal, never to skipping state decay. Lazy state updates
or vectorised stepping are implementation choices, benchmarked for
correctness against a dense reference on the fixture circuit (§8.5a) and for
speed on FlyWire. Deterministic under a seed. The sim exposes `inject(population, currentVector)`,
`step(ms)`, `rates(population)` and nothing species-specific.

## 4. Plasticity

- Only on the CSR ranges the manifest declares as `plasticEdges` (KC→MBON). Any
  edge outside those ranges has a learned delta of exactly 0, always.
- Rule: a configurable dopamine-gated KC→MBON learning rule, chosen at
  implementation time from published Drosophila mushroom-body models after
  research, not invented here. In the fly this plasticity is
  compartment-specific and frequently depressive (reward depresses the
  KC→MBON synapses onto avoidance-coding MBONs, punishment depresses those
  onto approach-coding MBONs), with valence and timing carried by which DANs
  fire. It must NOT be described or implemented as generic Hebbian
  strengthening. The pack manifest therefore carries, per plastic range, the
  MBON valence and the DAN subset that gates it. A positive receipt drives the
  reward DANs, a negative receipt the punishment DANs; no receipt → no change.
  The rule name and its parameters are in `plasticity.rule` and are part of
  `plasticitySchemaVersion`.
- `base_weight` (from the pack) and `learned_delta` are stored and logged
  separately; the effective weight is their sum at load time and after each
  update. `|learned_delta|` is clamped per edge (`plasticity.maxDelta`, default
  = base per-synapse weight × 4). Delta is resettable by "Reset brain".
- `plasticity=off` is a first-class flag for benchmarks.

## 5. The two seams

### 5.1 `memory-rerank` (per user message)

1. FMS recalls top-k exactly as today.
2. Query and candidates already have embeddings (`embed.ts`). Each is projected
   by a fixed random matrix (seed from the manifest) onto the `sensory`
   population; the top 5% receive input current. Same text, same pattern.
3. The sim runs 50 ms simulated per pattern from a fixed resting state (not from
   the persistent CX state; rerank must be a pure function of pack + learned
   delta + input). Read the rate vector on `mbon`.
4. `brainScore = cosine(rates(query), rates(candidate))`;
   `final = (1 − w) · fmsScore + w · brainScore`. `w` seeds at 0.3 and is a
   genome field (§6). The list is re-ordered; nothing is added or removed.
5. After the turn, plasticity (§4) runs on the query pattern and the patterns of
   the candidates that were actually injected into context.

Requires roles `sensory`, `kc`, `mbon`, `dan`. Kill switch: seam off → FMS list
unchanged.

### 5.2 `control-dial` (once per turn, after the reply)

1. The turn's outcome (positive / negative / no receipt, tool error, reply
   length) becomes input current on `neuromodulator` (dopaminergic subset for
   positive, an inhibitory subset for negative).
2. `persistent-state` runs 200 ms with no external input. Its membrane state
   persists across turns in memory and in `cx_state.bin`.
3. Two numbers are read: mean rate of `persistent-state`, mean rate of
   `neuromodulator`. A 4-coefficient linear map (genome fields, §6) turns them
   into `Δtemperature` and `ΔrecallChars`.
4. The brain **modulates the existing base, it never replaces it**:

   ```
   baseTemp   = uiOverride.temperature ?? champion.temperature ?? default
   finalTemp  = uiOverride.temperature !== undefined
                ? uiOverride.temperature
                : clamp(baseTemp + Δtemperature, 0.3, 1.0)
   ```
   Same shape for `recallInjectionMaxChars`, clamped to `[0, today's max]`.
   A UI override wins outright; otherwise the brain delta rides on top of the
   champion. Seam off → Δ = 0.

Requires roles `persistent-state`, `neuromodulator`. Status: experimental, kept
in the product only as a small documented delta until a task-level benchmark
(tau2) confirms it. No convenient benchmark will be invented to green-light it.

### 5.3 What does not flow

The brain never sees text, tool names, tool results, or the system prompt. It
never writes to FMS. It never touches BRSI state, the journal, the event bus,
or proposes patches. Its only outputs are one score per candidate and two
deltas. Each turn's receipt records `brain: {packId, w, dialDelta, stateHash}`
for audit.

## 6. BRSI, bidirectional and bounded

- **BRSI → brain**: five new `GenomeConfig` fields, mutated by L1 like any
  other, bounded by schema, ratcheted by `repo.rs` like any other genome:
  `brain.rerankWeight ∈ [0, 0.6]`, `brain.dial[0..3] ∈ [−0.3, 0.3]`. They reach
  the agent through `#championParams`, the one champion path already proven to
  reach the wire. BRSI cannot touch the pack, the synapses, or the learned delta.
- **Brain → BRSI**: through fitness only. Turns with the brain on produce the
  same receipts as today; L1 sees whether a genome with `w = 0.3` scores better
  than one with `w = 0` and concludes on its own.
- **Wall**: `brain-substrate/` is added to L3's forbidden paths (next to host
  and TUI). A code patch that "improves" plasticity is exactly the change
  tier-0 cannot measure.

## 7. Benchmark and retention gate

One command, `bun run brain:bench`, results in `bench-results/brain/`.

Conditions:

| Condition | Meaning |
|---|---|
| `baseline` | seam off; must be bit-for-bit today's behaviour (a test, §8.1) |
| `shuffled` | same pack, edges permuted preserving each neuron's in/out degree and each edge's sign; same plasticity, same seeds. **Five independent shuffles**; the verdict is against their median, never a single draw |
| `real` | the true pack |

Mechanisms and their gates:

- **rerank**: LongMemEval recall@k on the existing FMS bench, grid
  `w ∈ {0, 0.1, 0.3, 0.5}` × `plasticity ∈ {on, off}`. Kept only if `real`
  beats both `shuffled` (median) and `baseline` on at least one `w`, by more
  than the spread across seeds. Report the distribution, not only the mean.
- **plasticity** (the decisive experiment, no API cost): 200 (key, value) pairs
  learned with positive receipts, then recall after 500 turns of interference.
  Three networks: real KC→MBON, shuffled KC→MBON, random dense associative
  network with the same plasticity rule. Measures whether any advantage comes
  from the wiring or merely from having Hebbian learning somewhere.
- **control-dial**: no cheap agentic benchmark. Diagnostic gates only: state
  persists across turns, drift is bounded, deltas never leave the clamp, and
  `shuffled` should not discriminate positive from negative outcomes as well as
  `real` (if it does, the central complex is decoration and the report says so).

Seeds: CI 3; pre-release verdict 10+ on the synthetic/plasticity bench;
LongMemEval as many as cost allows, distribution reported.

Larva runs in CI. FlyWire runs locally once before release.

## 8. Tests (larva fixture, CI)

1. **bit-for-bit**: same conversation under `CINDERPAW_BRAIN=0`, pack missing,
   and seam off → identical inference request JSON (params, messages, recall
   list). Compares requests, not model replies.
2. **pack-roundtrip**: build larva → load → neuron/edge counts, signs,
   populations equal the source; a single flipped byte is refused by sha256.
3. **atomic-install**: simulated crash at each of the five install steps → next
   boot finds the previous pack intact or no pack, never a partial one.
4. **state-binding**: learned state with a different `packSha256` or
   `plasticitySchemaVersion` → not loaded, reason on screen, file untouched.
5. **sim-sanity**, in two layers: (a) generic, on a small hand-built fixture
   circuit: no input → quiet; a pulse propagates along a known path in a known
   time and dies out; same seed → identical spike trains. (b) pack-specific,
   run only for roles the pack declares: on larva, a `sensory` pulse reaches
   `kc` within 20 ms simulated. A future pack that lacks a role skips (b) for it.
6. **plasticity-bounds**: 10,000 positive turns → every plastic edge within
   `maxDelta`; every non-plastic edge delta exactly 0.
7. **dial-clamp**: any brain state → temperature and recall within limits;
   Δ = 0 when the seam is off; UI override always wins.
8. **bench-smoke**: `brain:bench` on larva, 3 seeds, 2 shuffles, completes and
   writes the report.

## 9. Delivery order (each step stands alone; the project can stop at any of them)

1. `pack/` + larva adapter + tests 2, 4 → a pack that loads.
2. `sim/` + test 5 → a brain that runs.
3. `plasticity/` + test 6 + the synthetic plasticity benchmark. **Kill gate**:
   if `real` does not beat `shuffled` here, stop integrating into the agent and
   investigate (topology, sensory mapping, plasticity rule, or the larva fixture
   not being representative). This is a pause to discuss, not a verdict on
   FlyWire.
4. `seams/memory-rerank` + test 1 + LongMemEval over the `w` grid.
5. `seams/control-dial` + test 7 + the five genome fields.
6. FlyWire adapter + `build-pack` + atomic download + UI status + ATTRIBUTION.
7. Pre-release run on FlyWire, 10+ seeds, 5 shuffles, report in
   `bench-results/brain/`; only then decide what stays on by default.

## 10. Sources

- Shiu et al. 2024, "A Drosophila computational brain model reveals sensorimotor processing", Nature, doi:10.1038/s41586-024-07763-9
- Dorkenwald et al. 2024, "Neuronal wiring diagram of an adult brain", Nature, doi:10.1038/s41586-024-07558-y (CC BY 4.0); data: Zenodo doi:10.5281/zenodo.10676866 (CC BY 4.0)
- Schlegel et al. 2024, "Whole-brain annotation and multi-connectome cell typing of Drosophila", Nature, doi:10.1038/s41586-024-07686-5 (CC BY 4.0); annotations mirrored at github.com/flyconnectome/flywire_annotations
- Eckstein et al. 2024, "Neurotransmitter classification from electron microscopy images at synaptic sites in Drosophila melanogaster", Cell
- Lappalainen et al. 2024, connectome-constrained visual model (`flyvis`), Nature (basis for the reserved `sensory-visual` role)
- flypoke, github.com/vshapenko/flypoke (MIT): laptop-speed LIF over FlyWire v783, parameter source
- Winding et al. 2023, "The connectome of an insect brain", Science (larva fixture; data license to verify)
