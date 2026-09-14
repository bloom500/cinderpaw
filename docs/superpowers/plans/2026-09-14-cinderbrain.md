# CinderBrain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A spiking simulation of a real connectome, loaded from a replaceable brain pack, wired into the agent through two kill-switched seams, kept only where the real wiring measurably beats a shuffled one.

**Architecture:** `CinderpawAgent/src/brain-substrate/{pack,sim,plasticity,seams}` in the Bun sidecar. `pack/` owns the on-disk format and adapters; `sim/` is a LIF over a `BrainPack` with sparse spike propagation; `plasticity/` is a compartment-gated KC→MBON depression rule with state stored apart from the pack; `seams/` re-ranks FMS candidates and adds a bounded delta on top of the champion's temperature/recall budget. Larva pack for CI, FlyWire pack for users.

**Tech Stack:** Bun + TypeScript, typed arrays, `bun:test`; `apache-arrow` as a devDependency for the one-time FlyWire build; the existing FMS (`src/memory/fractal/`), BRSI genome (`src/rsi/l1-config/`), receipts (`src/core/run-receipt.ts`), and host protocol (`src/protocol.ts`, `crates/cinderpaw-core/src/sidecar_protocol.rs`).

**Spec:** `docs/superpowers/specs/2026-09-14-cinderbrain-design.md` (read it first; every task below cites its sections).

## Global Constraints

- Sequential tasks. Each depends on the one before; do not parallelise.
- Task 3 ends in a **kill gate**. If `real` does not beat the shuffled median on the synthetic plasticity benchmark, stop after Task 3 and report; Tasks 4 to 7 do not start without an explicit go.
- No features beyond the spec: no STDP, no optic lobe, no third seam, no UI beyond one status line, one toggle and one "Reset brain" button.
- The brain never sees text, tool names, tool results or the system prompt (spec §5.3).
- Bit-for-bit: with `CINDERPAW_CINDERBRAIN=0`, with no pack, or with a seam off, the inference request JSON is identical to today's (spec §8.1). `CINDERPAW_BRAIN` is the Brain Stack's switch; never reuse it.
- Plasticity touches only the edge positions in `plastic.bin`; `learned_delta[e] ∈ [−min(maxDelta, |base|), 0]` (spec §4).
- Precedence in the loop: UI override wins outright; otherwise `clamp(champion ?? default + brainDelta)` (spec §5.2).
- Every "brain off" state has its reason on screen (spec §2.5).
- All numerics in binary typed arrays; no JSON for large arrays.
- Tests live in `CinderpawAgent/tests/brain-*.test.ts` and run with `bun test tests/brain-` from `CinderpawAgent/`. `bunx tsc --noEmit` must stay green after every task.
- Commit after every green step; commit messages end with the attribution lines the session provides.
- Each task ends with a short report: what passed (with the command output), what remains risky.
- Prose in commits and code stays English; no em-dashes anywhere.

---

## File map

```
CinderpawAgent/src/brain-substrate/
  pack/types.ts            BrainPack, Manifest, Role, SimParams, Compartment, PlasticEdges
  pack/load.ts             loadPack(dir): BrainPack; validateManifest; validateCsr; sha256 check
  pack/learned-state.ts    readLearnedState / writeLearnedState bound to packSha256 + schema version
  pack/install.ts          installPack(url|file, packsDir): atomic download, verify, unpack, rename
  pack/adapters/larva.ts   buildLarvaPack(srcDir): PackFiles
  pack/adapters/flywire.ts buildFlyWirePack(srcDir): PackFiles
  pack/write.ts            writePackFiles(dir, PackFiles) (csr.bin, plastic.bin, manifest.json)
  sim/lif.ts               LifSim
  sim/fixture-circuit.ts   a 40-neuron hand-built circuit with every role
  sim/dense-reference.ts   DenseLif (O(N²), correctness oracle only)
  sim/shuffle.ts           degreeSignPreservingShuffle(pack, seed): BrainPack
  plasticity/rule.ts       applyReinforcement(pack, sim, state, valence, opts): number
  plasticity/state.ts      PlasticState { delta: Float32Array }, reset, effective weights
  seams/pattern.ts         embeddingToCurrent(vec, projection): Float32Array
  seams/memory-rerank.ts   BrainReranker (Reranker for FractalRecallEngine)
  seams/control-dial.ts    ControlDial
  seams/status.ts          BrainStatus type + emitter (host event "brain_status")
  bench/synthetic.ts       plasticity + rerank synthetic benches (real / shuffled / dense)
  bench/run.ts             `bun run brain:bench` entry
  index.ts                 startCinderBrain(opts): { reranker, dial, status } | null
CinderpawAgent/tests/fixtures/brain/larva/   manifest.json, csr.bin, plastic.bin, ATTRIBUTION.md
CinderpawAgent/tests/brain-pack.test.ts, brain-sim.test.ts, brain-plasticity.test.ts,
  brain-rerank.test.ts, brain-dial.test.ts, brain-install.test.ts, brain-bitforbit.test.ts,
  brain-bench-smoke.test.ts, brain-l3-wall.test.ts
scripts/brain/build-pack.ts                   --adapter larva|flywire --src <dir> --out <dir>
Modified:
  src/memory/fractal/fractal-recall.ts        optional `reranker` dep, applied at the end of #rankedHits
  src/memory/fractal/fractal-memory.ts        setReranker() pass-through
  src/core/agent-loop.ts                      #brainDelta, applied in #complete; setBrainDelta()
  src/rsi/l1-config/genome.ts, mutation.ts, champion.ts, crossover.ts, taste.ts, sidecar.ts,
    dispatch.ts, rsi/infra/invoke-agent.ts, escape-time.ts, l4-modules/seam-catalog.ts,
    seam-runtime.ts                           two new genome fields (grep decompositionDepth)
  src/boot.ts                                 startCinderBrain, wire reranker + dial, receipt hook
  src/config.ts                               CINDERPAW_CINDERBRAIN, CINDERPAW_CINDERBRAIN_PACK
  src/types.ts, src/protocol.ts, crates/cinderpaw-core/src/sidecar_protocol.rs   brain_status event
  frontend-react/src/hooks/useCinderpaw.ts, stores/cinderpaw.ts, one status component, i18n
  THIRD-PARTY-NOTICES.md, package.json (brain:bench script, apache-arrow devDependency)
```

---

### Task 1: Brain pack format, loader, larva adapter, learned-state binding

Spec: §2.1, §2.2, §2.3 (larva), §8.2, §8.4.

**Files:**
- Create: `src/brain-substrate/pack/types.ts`, `pack/load.ts`, `pack/write.ts`, `pack/learned-state.ts`, `pack/adapters/larva.ts`
- Create: `scripts/brain/build-pack.ts` (larva branch only; FlyWire branch in Task 6)
- Create: `tests/fixtures/brain/larva/{manifest.json,csr.bin,plastic.bin,ATTRIBUTION.md}`
- Test: `tests/brain-pack.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Role = "sensory" | "kc" | "mbon" | "dan" | "persistent-state" | "neuromodulator" | "sensory-visual";
  export interface SimParams { vRest: number; vThresh: number; tauM: number; tauS: number; refractoryMs: number; delayMs: number; wSyn: number; dtMs: number }
  export const SHIU_2024: SimParams = { vRest: -52, vThresh: -45, tauM: 20, tauS: 5, refractoryMs: 2.2, delayMs: 1.8, wSyn: 0.275, dtMs: 0.1 };
  export interface Compartment { id: string; mbonValence: "approach" | "avoidance"; danIds: number[] }
  export interface Manifest {
    packId: string; species: string;
    source: { name: string; doi: string; release: string };
    completeness: "whole-brain" | "region";
    packFormatVersion: 1; simulatorAbiVersion: 1;
    license: string; attributionFile: string;
    neurons: number; edges: number; plasticEdges: number;
    simParams: SimParams; seed: number;
    populations: Partial<Record<Role, number[]>>;
    compartments: Compartment[];
    plasticity: { rule: "kc-mbon-depression-v1"; eta: number; maxDelta: number | null };
    sha256: { "csr.bin": string; "plastic.bin": string };
  }
  export interface BrainPack {
    manifest: Manifest; dir: string; csrSha256: string;
    rowPtr: Int32Array; colIdx: Int32Array; weight: Float32Array;   // weight = sign * synCount * wSyn
    plastic: { edgeIdx: Int32Array; src: Int32Array; compartment: Int8Array };
    populations: Partial<Record<Role, Int32Array>>;
  }
  export interface PackFiles { manifest: Omit<Manifest, "sha256">; rowPtr: Int32Array; colIdx: Int32Array; weight: Float32Array; plastic: BrainPack["plastic"] }
  export function loadPack(dir: string): BrainPack;            // throws PackError with a human sentence
  export function writePackFiles(dir: string, files: PackFiles): Manifest;
  export interface LearnedMeta { packSha256: string; plasticitySchemaVersion: 1; updatedAt: number }
  export function readLearnedState(stateDir: string, pack: BrainPack): { delta: Float32Array; meta: LearnedMeta } | { refused: string };
  export function writeLearnedState(stateDir: string, pack: BrainPack, delta: Float32Array): void;
  export function buildLarvaPack(srcDir: string): PackFiles;
  ```

- [ ] **Step 1: Fetch the larva source once, into the gitignored `data/`**

Download `Supplementary-Data-S1.zip` from `https://github.com/brain-networks/larval-drosophila-connectome` (mirror of Winding et al. 2023 Science, Supplementary Data S1) into `data/larva/` and unzip. Inspect: it contains adjacency CSVs (`ad` axon→dendrite, `aa`, `dd`, `da`, and `all-all`) and an annotations table with a `celltype` column. Record the exact filenames you find in a comment at the top of `adapters/larva.ts`. Use the `all-all` matrix (or sum the four) so the pack counts every synapse between two neurons, then apply the ≥ 5 synapse floor from spec §2.3.

- [ ] **Step 2: Write the failing pack test**

```ts
// tests/brain-pack.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPack } from "../src/brain-substrate/pack/load.ts";
import { writePackFiles } from "../src/brain-substrate/pack/write.ts";
import { readLearnedState, writeLearnedState } from "../src/brain-substrate/pack/learned-state.ts";
import { SHIU_2024, type PackFiles } from "../src/brain-substrate/pack/types.ts";

const LARVA = join(import.meta.dir, "fixtures/brain/larva");

/** A 4-neuron pack: 0 (sensory) -> 1 (kc) -> 2 (mbon), 3 (dan). */
function tinyFiles(): PackFiles {
  return {
    manifest: {
      packId: "tiny-v1", species: "test", source: { name: "hand", doi: "", release: "" },
      completeness: "region", packFormatVersion: 1, simulatorAbiVersion: 1,
      license: "CC-BY-4.0", attributionFile: "ATTRIBUTION.md",
      neurons: 4, edges: 2, plasticEdges: 1, simParams: SHIU_2024, seed: 7,
      populations: { sensory: [0], kc: [1], mbon: [2], dan: [3] },
      compartments: [{ id: "c0", mbonValence: "approach", danIds: [3] }],
      plasticity: { rule: "kc-mbon-depression-v1", eta: 0.1, maxDelta: null },
    },
    rowPtr: Int32Array.from([0, 1, 2, 2, 2]),
    colIdx: Int32Array.from([1, 2]),
    weight: Float32Array.from([5 * 0.275, 8 * 0.275]),
    plastic: { edgeIdx: Int32Array.from([1]), src: Int32Array.from([1]), compartment: Int8Array.from([0]) },
  };
}

describe("brain pack", () => {
  test("round-trips a hand-built pack", () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    writeFileSync(join(dir, "ATTRIBUTION.md"), "hand-built\n");
    writePackFiles(dir, tinyFiles());
    const pack = loadPack(dir);
    expect(pack.manifest.neurons).toBe(4);
    expect(Array.from(pack.colIdx)).toEqual([1, 2]);
    expect(pack.weight[1]).toBeCloseTo(8 * 0.275, 5);
    expect(Array.from(pack.populations.kc!)).toEqual([1]);
    expect(Array.from(pack.plastic.edgeIdx)).toEqual([1]);
  });

  test("a single flipped byte in csr.bin is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    writeFileSync(join(dir, "ATTRIBUTION.md"), "x\n");
    writePackFiles(dir, tinyFiles());
    const buf = readFileSync(join(dir, "csr.bin"));
    buf[buf.length - 1] ^= 0xff;
    writeFileSync(join(dir, "csr.bin"), buf);
    expect(() => loadPack(dir)).toThrow(/sha256/);
  });

  test("a pack without an attribution file is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    writePackFiles(dir, tinyFiles());
    expect(() => loadPack(dir)).toThrow(/ATTRIBUTION/);
  });

  test("structural validation: row pointers, indices, populations, plastic positions", () => {
    const bad = tinyFiles();
    bad.plastic.edgeIdx = Int32Array.from([9]);
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    writeFileSync(join(dir, "ATTRIBUTION.md"), "x\n");
    writePackFiles(dir, bad);
    expect(() => loadPack(dir)).toThrow(/plastic/);
  });

  test("the larva fixture loads with the roles the spec names, and no persistent-state", () => {
    const pack = loadPack(LARVA);
    expect(pack.manifest.species).toBe("Drosophila melanogaster (L1 larva)");
    expect(pack.manifest.neurons).toBeGreaterThan(2500);
    expect(pack.rowPtr.length).toBe(pack.manifest.neurons + 1);
    expect(pack.rowPtr[pack.manifest.neurons]).toBe(pack.manifest.edges);
    for (const role of ["sensory", "kc", "mbon", "dan", "neuromodulator"] as const) {
      expect(pack.populations[role]!.length).toBeGreaterThan(0);
    }
    expect(pack.populations["persistent-state"]).toBeUndefined();
    // Every plastic edge really is KC -> MBON.
    const kc = new Set(pack.populations.kc!), mbon = new Set(pack.populations.mbon!);
    for (let i = 0; i < pack.plastic.edgeIdx.length; i++) {
      expect(kc.has(pack.plastic.src[i]!)).toBe(true);
      expect(mbon.has(pack.colIdx[pack.plastic.edgeIdx[i]!]!)).toBe(true);
    }
  });

  test("learned state is bound to the pack hash and the schema version", () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    writeFileSync(join(dir, "ATTRIBUTION.md"), "x\n");
    writePackFiles(dir, tinyFiles());
    const pack = loadPack(dir);
    const state = mkdtempSync(join(tmpdir(), "state-"));
    writeLearnedState(state, pack, Float32Array.from([-0.1]));
    const ok = readLearnedState(state, pack);
    expect("delta" in ok && ok.delta[0]).toBeCloseTo(-0.1, 6);
    // Same id, different topology: refused, file untouched.
    const other = { ...pack, csrSha256: "0".repeat(64) };
    const refused = readLearnedState(state, other);
    expect("refused" in refused && refused.refused).toMatch(/different connectome/);
    expect(readFileSync(join(state, "learned_delta.bin")).length).toBe(4);
  });
});
```

- [ ] **Step 3: Run it, expect failure on missing modules**

Run: `cd CinderpawAgent && bun test tests/brain-pack.test.ts`
Expected: FAIL, cannot resolve `../src/brain-substrate/pack/load.ts`.

- [ ] **Step 4: Implement `types.ts`, `write.ts`, `load.ts`, `learned-state.ts`**

`write.ts`: `csr.bin` = the three arrays back to back, little-endian, preceded by a 16-byte header `[magic "CBRC", version 1, N, E]` as Int32; `plastic.bin` = header `[magic "CBRP", 1, P, 0]` then `edgeIdx`, `src`, `compartment` (Int8 padded to 4-byte boundary). Compute sha256 with `node:crypto`, write `manifest.json` with `sha256` filled, return the manifest.

`load.ts`: read `manifest.json`; refuse when `packFormatVersion !== 1` or `simulatorAbiVersion !== 1` ("this pack needs a newer Cinderpaw"); refuse when `attributionFile` is missing on disk; verify both sha256 before parsing; validate: `rowPtr[0] === 0`, monotone non-decreasing, `rowPtr[N] === E`, every `colIdx < N`, every population index `< N`, every `plastic.edgeIdx < E`, every `plastic.src < N`, every `compartment < compartments.length`. Each failure throws `PackError` whose message is one plain sentence (they go on screen in Task 6).

`learned-state.ts`: `meta.json` + `learned_delta.bin` (raw Float32). `readLearnedState` returns `{refused: "learned state belongs to a different connectome (…)"}` on hash mismatch, `{refused: "learned state uses plasticity schema N, this build reads 1"}` on version mismatch, `{refused: "no learned state yet"}` when absent. Never deletes.

- [ ] **Step 5: Implement `adapters/larva.ts` and the build script; generate the fixture**

Role mapping from the annotations `celltype` column: `KC` → `kc`; `MBON` → `mbon`; `MBIN`/`DAN` (dopaminergic MBINs) → `dan`; `sensory` (all sensory classes) → `sensory`; `dan` ∪ octopaminergic MBINs → `neuromodulator`. Sign: −1 where the annotation names GABA or glutamate, else +1. Winding provides no neurotransmitter prediction for most neurons, so the fixture's `ATTRIBUTION.md` states this assumption. MBON valence: `approach` for MBONs whose annotation is GABAergic/cholinergic, `avoidance` for glutamatergic, `approach` when unknown (Aso et al. 2014 convention). Compartments: one per MBON, `danIds` = all `dan` neurons that synapse onto that MBON's KC inputs (a DAN with ≥ 1 synapse onto ≥ 1 KC presynaptic to the MBON); if empty, all `dan`. Plastic edges: every CSR position whose source is in `kc` and target in `mbon`.

`scripts/brain/build-pack.ts --adapter larva --src data/larva --out CinderpawAgent/tests/fixtures/brain/larva` writes the files plus a generated `ATTRIBUTION.md` (Winding et al. 2023, Science, doi:10.1126/science.add9330; author manuscript PMC7614541, CC BY 4.0; "modified derivative: synapse floor 5, signs assumed +1 unless annotated inhibitory").

Constraint: the fixture must stay under 3 MB so it can live in git. If it exceeds that, raise the synapse floor for the larva pack (record the floor in `manifest.source.release`, e.g. `"S1, floor 5"`).

- [ ] **Step 6: Run the tests, expect pass; typecheck**

Run: `bun test tests/brain-pack.test.ts && bunx tsc --noEmit`
Expected: 6 pass, tsc clean.

- [ ] **Step 7: Commit**

```bash
git add CinderpawAgent/src/brain-substrate/pack CinderpawAgent/tests/brain-pack.test.ts CinderpawAgent/tests/fixtures/brain/larva scripts/brain/build-pack.ts
git commit -m "feat(cinderbrain): brain pack format, loader, learned-state binding, larva fixture"
```

**Exit criteria:** 6 tests green; fixture ≤ 3 MB; `loadPack(LARVA)` prints neuron and edge counts in the report; report lists the exact larva source filenames and the sign assumption.

---

### Task 2: LIF simulator with sparse propagation, fixture circuit, dense oracle

Spec: §3, §8.5.

**Files:**
- Create: `src/brain-substrate/sim/lif.ts`, `sim/dense-reference.ts`, `sim/fixture-circuit.ts`
- Test: `tests/brain-sim.test.ts`

**Interfaces:**
- Consumes: `BrainPack`, `SimParams` (Task 1).
- Produces:
  ```ts
  export class LifSim {
    constructor(pack: BrainPack, opts?: { seed?: number; effectiveWeight?: Float32Array });
    /** External input, mV of depolarisation per ms, held until cleared. */
    inject(neurons: Int32Array, current: Float32Array): void;
    clearInput(): void;
    step(ms: number): void;                        // advances by round(ms / dt) steps
    rates(neurons: Int32Array): Float32Array;      // spikes / s since the last resetRates()
    resetRates(): void;
    resetState(): void;                            // v = vRest, g = 0, pending spikes cleared, rates cleared
    exportState(neurons: Int32Array): Float32Array;   // v for those neurons
    importState(neurons: Int32Array, v: Float32Array): void;
    setEffectiveWeight(w: Float32Array): void;     // plasticity swaps in base + delta
    totalSpikes(): number;
  }
  export class DenseLif { /* same public surface, O(N^2), no active set */ }
  export function fixtureCircuit(): BrainPack;     // 40 neurons, all six roles, in-memory (dir = "")
  ```

- [ ] **Step 1: Write the failing sim test**

```ts
// tests/brain-sim.test.ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LifSim } from "../src/brain-substrate/sim/lif.ts";
import { DenseLif } from "../src/brain-substrate/sim/dense-reference.ts";
import { fixtureCircuit } from "../src/brain-substrate/sim/fixture-circuit.ts";
import { loadPack } from "../src/brain-substrate/pack/load.ts";

const LARVA = join(import.meta.dir, "fixtures/brain/larva");
const pulse = (n: number, mV = 2) => Float32Array.from({ length: n }, () => mV);

describe("LifSim on the fixture circuit (generic, every pack)", () => {
  test("no input, no spikes", () => {
    const sim = new LifSim(fixtureCircuit());
    sim.step(200);
    expect(sim.totalSpikes()).toBe(0);
  });

  test("a sensory pulse reaches kc then mbon along the known path, and dies out", () => {
    const pack = fixtureCircuit();
    const sim = new LifSim(pack);
    sim.inject(pack.populations.sensory!, pulse(pack.populations.sensory!.length));
    sim.step(30);
    expect(sim.rates(pack.populations.kc!).some((r) => r > 0)).toBe(true);
    expect(sim.rates(pack.populations.mbon!).some((r) => r > 0)).toBe(true);
    sim.clearInput();
    sim.resetRates();
    sim.step(100);
    expect(sim.totalSpikes()).toBe(0);           // nothing after the input stops
  });

  test("same seed, identical spike trains; sparse sim equals the dense oracle", () => {
    const pack = fixtureCircuit();
    const a = new LifSim(pack, { seed: 3 }), b = new LifSim(pack, { seed: 3 }), d = new DenseLif(pack, { seed: 3 });
    for (const s of [a, b, d]) s.inject(pack.populations.sensory!, pulse(pack.populations.sensory!.length, 1.5));
    for (const s of [a, b, d]) s.step(60);
    const all = Int32Array.from({ length: pack.manifest.neurons }, (_, i) => i);
    expect(Array.from(a.rates(all))).toEqual(Array.from(b.rates(all)));
    const ra = a.rates(all), rd = d.rates(all);
    for (let i = 0; i < ra.length; i++) expect(ra[i]).toBeCloseTo(rd[i]!, 3);
    const va = a.exportState(all), vd = d.exportState(all);
    for (let i = 0; i < va.length; i++) expect(va[i]).toBeCloseTo(vd[i]!, 3);
  });

  test("the effective weight can be swapped without touching the pack", () => {
    const pack = fixtureCircuit();
    const sim = new LifSim(pack);
    const silenced = pack.weight.slice(); silenced.fill(0);
    sim.setEffectiveWeight(silenced);
    sim.inject(pack.populations.sensory!, pulse(pack.populations.sensory!.length));
    sim.step(30);
    expect(sim.rates(pack.populations.kc!).every((r) => r === 0)).toBe(true);
    expect(pack.weight.some((w) => w !== 0)).toBe(true);
  });
});

describe("LifSim on the larva pack (pack-specific, only for declared roles)", () => {
  const pack = loadPack(LARVA);
  test("quiet at rest: mean rate under 1 Hz over 500 ms", () => {
    const sim = new LifSim(pack);
    sim.step(500);
    const all = Int32Array.from({ length: pack.manifest.neurons }, (_, i) => i);
    const mean = sim.rates(all).reduce((a, b) => a + b, 0) / all.length;
    expect(mean).toBeLessThan(1);
  });
  test("a sensory pulse reaches kc within 20 ms, and the brain does not run away", () => {
    const sim = new LifSim(pack);
    sim.inject(pack.populations.sensory!, pulse(pack.populations.sensory!.length, 1));
    sim.step(20);
    expect(sim.rates(pack.populations.kc!).some((r) => r > 0)).toBe(true);
    sim.step(480);
    const all = Int32Array.from({ length: pack.manifest.neurons }, (_, i) => i);
    const mean = sim.rates(all).reduce((a, b) => a + b, 0) / all.length;
    expect(mean).toBeLessThan(50);              // calibration: lower wSyn in the larva manifest if this fails
  });
  test("speed: 50 ms of larva under 200 ms wall clock", () => {
    const sim = new LifSim(pack);
    sim.inject(pack.populations.sensory!, pulse(pack.populations.sensory!.length, 1));
    const t = performance.now(); sim.step(50);
    expect(performance.now() - t).toBeLessThan(200);
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `bun test tests/brain-sim.test.ts`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement `dense-reference.ts` first (the oracle), then `lif.ts`**

Dynamics per step, for every neuron (dense) or every neuron in the active set (sparse), with `dt = simParams.dtMs`:

```ts
// alpha synapse as two exponentials: x is the rising state, g the conductance-like drive (mV/ms)
const eS = Math.exp(-dt / p.tauS), eM = Math.exp(-dt / p.tauM);
g[i] = g[i] * eS + x[i] * (dt / p.tauS);
x[i] = x[i] * eS;
if (refr[i] > 0) { refr[i] -= 1; v[i] = p.vRest; }
else {
  // exponential Euler on dv/dt = -(v - vRest)/tauM + g + I_ext
  const drive = g[i] + iExt[i];
  v[i] = p.vRest + (v[i] - p.vRest) * eM + drive * p.tauM * (1 - eM);
  if (v[i] >= p.vThresh) { v[i] = p.vRest; refr[i] = refrSteps; fire(i); }
}
```

`fire(i)`: `spikes[i] += 1`; push `i` into `pending[(t + delaySteps) % ringLen]`. At the start of every step, for each `j` in `pending[t % ringLen]`: for `e` in `rowPtr[j]..rowPtr[j+1]`: `x[colIdx[e]] += wEff[e]` (mV), and in the sparse sim mark `colIdx[e]` active. `refrSteps = round(refractoryMs / dt)`, `delaySteps = round(delayMs / dt)`, `ringLen = delaySteps + 1`.

Active set (sparse sim only): a neuron is active while `refr > 0`, or `|v − vRest| > 1e-4`, or `g > 1e-6`, or `x > 1e-6`, or it has non-zero `iExt`. Keep an `Int32Array` list plus a `Uint8Array` membership flag; sweep out inactive entries every 100 steps. The dense oracle updates all `N` every step. The third test is what proves the active set skips nothing that matters.

Seed: `mulberry32(seed)` from `src/memory/fractal/prng.ts` is imported for any future noise term; with no noise the sim is deterministic anyway. Do not add noise now.

- [ ] **Step 4: Implement `fixture-circuit.ts`**

40 neurons, in-memory `BrainPack` (`dir: ""`, `csrSha256: "fixture"`): 8 `sensory` → 12 `kc` (each sensory to 3 KCs, 6 synapses each, +) → 4 `mbon` (each KC to 2 MBONs, 5 synapses, +) with 2 MBONs `approach` and 2 `avoidance`; 4 `dan` (2 per valence) each projecting to its compartment's MBON (3 synapses, +); 8 `persistent-state` neurons in a ring (each to its two neighbours, 7 synapses, +; each to the opposite neuron, 6 synapses, −), 4 `neuromodulator` each → 2 ring neurons (5 synapses, +). Compartments: 4, one per MBON, `danIds` = the two DANs of that valence. Plastic edges: all KC→MBON positions. `simParams: SHIU_2024`. Write it as plain arrays first, then CSR; keep a comment table of the wiring so the second test's expectations are readable.

- [ ] **Step 5: Run the tests; calibrate the larva if it runs away**

Run: `bun test tests/brain-sim.test.ts`
Expected: all pass. If the larva "does not run away" test fails, lower `simParams.wSyn` in the larva manifest (rebuild with `--wsyn`) until mean rate < 50 Hz and the 20 ms KC test still passes; record the value chosen in the report. Do not change `SHIU_2024`.

- [ ] **Step 6: Typecheck and commit**

```bash
bunx tsc --noEmit
git add CinderpawAgent/src/brain-substrate/sim CinderpawAgent/tests/brain-sim.test.ts CinderpawAgent/tests/fixtures/brain/larva
git commit -m "feat(cinderbrain): LIF with sparse propagation, dense oracle, fixture circuit"
```

**Exit criteria:** 7 tests green; sparse equals dense to 1e-3 on the fixture; larva 50 ms in < 200 ms; report states the larva wSyn in force and the measured ms per 50 ms of larva.

---

### Task 3: Plasticity, shuffle control, the synthetic benchmark, and the KILL GATE

Spec: §4, §7 (plasticity row), §8.6, §8.8, §9 step 3.

**Files:**
- Create: `src/brain-substrate/plasticity/rule.ts`, `plasticity/state.ts`, `sim/shuffle.ts`, `seams/pattern.ts`, `bench/synthetic.ts`, `bench/run.ts`
- Modify: `package.json` scripts: `"brain:bench": "bun run src/brain-substrate/bench/run.ts"`
- Test: `tests/brain-plasticity.test.ts`, `tests/brain-bench-smoke.test.ts`

**Interfaces:**
- Consumes: `BrainPack`, `LifSim`, `readLearnedState`/`writeLearnedState`.
- Produces:
  ```ts
  export interface PlasticState { delta: Float32Array }          // parallel to pack.plastic.edgeIdx
  export function newPlasticState(pack: BrainPack): PlasticState;
  export function effectiveWeight(pack: BrainPack, s: PlasticState): Float32Array;   // base + delta at plastic positions
  export type Valence = "reward" | "punishment";
  /** Drives the compartments' DANs for 20 ms, then depresses KC->MBON edges in the gated compartments. Returns edges changed. */
  export function applyReinforcement(pack: BrainPack, sim: LifSim, s: PlasticState, valence: Valence, kcRates: Float32Array, opts?: { eta?: number; maxDelta?: number | null }): number;
  export function degreeSignPreservingShuffle(pack: BrainPack, seed: number): BrainPack;
  export function makeProjection(dims: number, targets: number, seed: number): Float32Array;   // dims x targets, N(0,1)
  export function embeddingToCurrent(vec: Float32Array, proj: Float32Array, targets: number, topFrac?: number): Float32Array;  // top 5% get 2 mV/ms, rest 0
  export function readoutFromRest(pack: BrainPack, sim: LifSim, current: Float32Array, ms?: number): { mbon: Float32Array; kc: Float32Array };
  ```

- [ ] **Step 1: Write the failing plasticity tests**

```ts
// tests/brain-plasticity.test.ts
import { describe, expect, test } from "bun:test";
import { fixtureCircuit } from "../src/brain-substrate/sim/fixture-circuit.ts";
import { LifSim } from "../src/brain-substrate/sim/lif.ts";
import { applyReinforcement, newPlasticState, effectiveWeight } from "../src/brain-substrate/plasticity/rule.ts";
import { degreeSignPreservingShuffle } from "../src/brain-substrate/sim/shuffle.ts";

describe("kc-mbon-depression-v1", () => {
  test("reward depresses only avoidance compartments; punishment only approach; nothing else moves", () => {
    const pack = fixtureCircuit();
    const sim = new LifSim(pack);
    const s = newPlasticState(pack);
    const kcRates = new Float32Array(pack.manifest.neurons);
    for (const k of pack.populations.kc!) kcRates[k] = 50;
    const changed = applyReinforcement(pack, sim, s, "reward", kcRates);
    expect(changed).toBeGreaterThan(0);
    for (let i = 0; i < s.delta.length; i++) {
      const comp = pack.manifest.compartments[pack.plastic.compartment[i]!]!;
      if (comp.mbonValence === "avoidance") expect(s.delta[i]).toBeLessThan(0);
      else expect(s.delta[i]).toBe(0);
    }
    const w = effectiveWeight(pack, s);
    let touched = 0;
    for (let e = 0; e < w.length; e++) if (w[e] !== pack.weight[e]) touched++;
    expect(touched).toBe(changed);
  });

  test("10,000 rewards stay within the clamp and never flip a sign", () => {
    const pack = fixtureCircuit();
    const sim = new LifSim(pack);
    const s = newPlasticState(pack);
    const kcRates = new Float32Array(pack.manifest.neurons);
    for (const k of pack.populations.kc!) kcRates[k] = 100;
    for (let i = 0; i < 10_000; i++) applyReinforcement(pack, sim, s, "reward", kcRates);
    for (let i = 0; i < s.delta.length; i++) {
      const base = pack.weight[pack.plastic.edgeIdx[i]!]!;
      expect(s.delta[i]).toBeGreaterThanOrEqual(-Math.abs(base));
      expect(s.delta[i]).toBeLessThanOrEqual(0);
      expect(Math.sign(base + s.delta[i]!) === Math.sign(base) || base + s.delta[i]! === 0).toBe(true);
    }
  });

  test("a shuffle keeps every in-degree, out-degree and sign, and changes the wiring", () => {
    const pack = fixtureCircuit();
    const sh = degreeSignPreservingShuffle(pack, 11);
    const N = pack.manifest.neurons;
    const outDeg = (p: typeof pack) => Array.from({ length: N }, (_, i) => p.rowPtr[i + 1]! - p.rowPtr[i]!);
    const inDeg = (p: typeof pack) => { const d = new Array(N).fill(0); for (const c of p.colIdx) d[c]++; return d; };
    expect(outDeg(sh)).toEqual(outDeg(pack));
    expect(inDeg(sh)).toEqual(inDeg(pack));
    expect(Array.from(sh.weight).map(Math.sign).sort()).toEqual(Array.from(pack.weight).map(Math.sign).sort());
    expect(Array.from(sh.colIdx)).not.toEqual(Array.from(pack.colIdx));
    expect(sh.plastic.edgeIdx.length).toBe(pack.plastic.edgeIdx.length);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `bun test tests/brain-plasticity.test.ts`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement `plasticity/state.ts` and `plasticity/rule.ts`**

Rule `kc-mbon-depression-v1` (Aso et al. 2014 compartment logic; Hige et al. 2015 depression): reward gates compartments with `mbonValence === "avoidance"`, punishment gates `"approach"`. For the gated compartments, inject 2 mV/ms onto their `danIds` for 20 ms from the sim's current state and read `danRate[c]` = mean rate of the compartment's DANs (`resetRates` before, `clearInput` after). Then for each plastic edge `i` in a gated compartment `c` with `pre = kcRates[src[i]]`:

```ts
const base = pack.weight[edgeIdx[i]];
const floor = -Math.min(opts.maxDelta ?? Math.abs(base), Math.abs(base));
const gate = danRate[c] > 0 ? 1 : 0;   // the DAN has to have fired; valence alone is not enough
delta[i] = Math.max(floor, delta[i] - eta * (pre / 100) * gate * Math.abs(base));
```

`eta` defaults to `manifest.plasticity.eta`. Return the number of edges whose delta changed. `effectiveWeight` copies `pack.weight` and adds `delta` at `edgeIdx`; callers hand the result to `sim.setEffectiveWeight`.

- [ ] **Step 4: Implement `sim/shuffle.ts`**

Group edges by sign. Within each sign group, take the multiset of sources (with repetition = out-degree in that group) and the multiset of targets (in-degree in that group), shuffle the target list with `mulberry32(seed)`, pair them in order, then reject self-loops and duplicate (src, tgt) pairs by swapping with a later position (up to 10 passes; leave the rare leftovers, report their count in the manifest `source.release` as `"shuffled seed=N leftovers=K"`). Rebuild CSR, keep `weight` magnitudes attached to their source row (so per-row strength distributions are preserved), recompute `plastic.edgeIdx` as the KC→MBON positions of the new wiring (the same KC and MBON sets; the count may differ by a few, that is expected and reported). `populations` and `compartments` are copied unchanged. `csrSha256 = "shuffled:" + seed`.

- [ ] **Step 5: Implement `seams/pattern.ts` and `readoutFromRest`**

`makeProjection`: `Float32Array(dims * targets)` from `mulberry32(seed)` with Box-Muller. `embeddingToCurrent`: `proj^T · vec`, take the top `ceil(targets * 0.05)` by value, set 2 mV/ms there, 0 elsewhere. `readoutFromRest`: `sim.resetState(); sim.inject(sensory, current); sim.step(ms ?? 50); return { mbon: sim.rates(mbon), kc: sim.rates(kc) }` and `clearInput`.

- [ ] **Step 6: Run the plasticity tests, expect pass; commit**

```bash
bun test tests/brain-plasticity.test.ts && bunx tsc --noEmit
git add CinderpawAgent/src/brain-substrate/plasticity CinderpawAgent/src/brain-substrate/sim/shuffle.ts CinderpawAgent/src/brain-substrate/seams/pattern.ts CinderpawAgent/tests/brain-plasticity.test.ts
git commit -m "feat(cinderbrain): compartment-gated KC->MBON depression, degree/sign shuffle, embedding patterns"
```

- [ ] **Step 7: Write the synthetic benchmark (`bench/synthetic.ts`)**

```ts
export interface SyntheticResult {
  condition: "real" | "shuffled" | "dense";
  seed: number; shuffleSeed?: number;
  pairs: number; interference: number;
  /** Fraction of the 200 keys whose top-1 MBON readout after interference is still their own value's readout. */
  recallAt1: number;
  recallAt5: number;
}
export function runPlasticityBench(pack: BrainPack, opts: { seed: number; pairs?: number; interference?: number; plasticity: boolean }): SyntheticResult;
```

Protocol (spec §7, plasticity row):
1. Deterministic 384-dim "embeddings": `pairs` (default 200) random unit vectors for keys and `pairs` for values, from `mulberry32(seed)`.
2. Learning phase: for each pair `(k, v)`: `readoutFromRest(k)` → `kcRates`; `readoutFromRest(v)` → `mbonV`; `applyReinforcement(pack, sim, s, "reward", kcRates)` when `plasticity`; store `mbonV` as the target readout for `k`. Swap in `effectiveWeight` after every reinforcement.
3. Interference: `interference` (default 500) random unit vectors, each reinforced with `"reward"` too (that is the interference: other associations pushed through the same synapses).
4. Recall: for each key, `readoutFromRest(k).mbon` vs every stored `mbonV`; rank by cosine; `recallAt1` / `recallAt5` = fraction of keys whose own value ranks first / in the top 5.
5. The **dense** condition: a pack whose plastic block is replaced by a fully connected KC→MBON block (every KC to every MBON, `|weight| = median |base|`, +), same everything else, same rule. That is "Hebbian somewhere, no topology".
6. `shuffled`: `degreeSignPreservingShuffle(pack, shuffleSeed)`.

- [ ] **Step 8: Write `bench/run.ts` and the smoke test**

`bun run brain:bench --pack tests/fixtures/brain/larva --seeds 3 --shuffles 2 --out ../bench-results/brain/` runs `real × seeds`, `shuffled × shuffles × seeds`, `dense × seeds`, with plasticity on, plus `real` with plasticity off, and writes `<out>/<iso>-synthetic.json` (every row) and `<out>/<iso>-synthetic.md`: a table with median and min/max per condition, and one verdict line:

```
real (median recall@1 0.xx) vs shuffled median 0.yy vs dense 0.zz  ->  REAL > SHUFFLED: yes/no (margin, spread)
```

`"yes"` requires `median(real) > median(shuffled) + max(spread(real), spread(shuffled))`, where spread is max minus min over seeds.

```ts
// tests/brain-bench-smoke.test.ts
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("brain:bench on the larva completes and writes a report", async () => {
  const out = mkdtempSync(join(tmpdir(), "brain-bench-"));
  const proc = Bun.spawn(["bun", "run", "src/brain-substrate/bench/run.ts", "--pack", "tests/fixtures/brain/larva", "--seeds", "3", "--shuffles", "2", "--pairs", "40", "--interference", "80", "--out", out], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  expect(await proc.exited).toBe(0);
  const files = readdirSync(out);
  expect(files.some((f) => f.endsWith("-synthetic.md"))).toBe(true);
  expect(files.some((f) => f.endsWith("-synthetic.json"))).toBe(true);
}, 120_000);
```

- [ ] **Step 9: Run the smoke test and the real bench; commit**

```bash
bun test tests/brain-bench-smoke.test.ts
bun run brain:bench --pack tests/fixtures/brain/larva --seeds 10 --shuffles 5 --out ../bench-results/brain/
bunx tsc --noEmit
git add CinderpawAgent/src/brain-substrate/bench CinderpawAgent/tests/brain-bench-smoke.test.ts CinderpawAgent/package.json bench-results/brain/
git commit -m "bench(cinderbrain): synthetic plasticity benchmark, real vs shuffled vs dense"
```

- [ ] **Step 10: KILL GATE. Report and stop.**

Paste the verdict table into the task report. Then:
- `REAL > SHUFFLED: yes` → Task 4 may start after the user's go.
- `no` → do NOT start Task 4. Report which of the four suspects the numbers point at (topology, sensory projection, rule, larva fixture not representative), with one number per suspect (e.g. `real` vs `dense` gap; recall with plasticity off; KC sparsity, i.e. fraction of KCs that fire per pattern, which should be 5 to 10%). Wait for a decision. This is a pause, not a verdict on FlyWire (spec §9.3).

**Exit criteria:** 3 plasticity tests + smoke test green; a 10-seed, 5-shuffle larva run in `bench-results/brain/`; a report with the verdict line and the suspects if it is "no".

---

### Task 4: `memory-rerank` seam, bit-for-bit test, LongMemEval over the w grid

Spec: §5.1, §5.3, §7 (rerank row), §8.1. **Starts only after the Task 3 go.**

**Files:**
- Create: `src/brain-substrate/seams/memory-rerank.ts`, `src/brain-substrate/index.ts`
- Modify: `src/memory/fractal/fractal-recall.ts` (deps + end of `#rankedHits`), `src/memory/fractal/fractal-memory.ts` (`setReranker`), `src/boot.ts` (start + wire), `src/config.ts` (two env rows), `scripts/longmemeval.ts` (`--brain-w` flag and `--brain-pack`)
- Test: `tests/brain-rerank.test.ts`, `tests/brain-bitforbit.test.ts`

**Interfaces:**
- Consumes: `readoutFromRest`, `embeddingToCurrent`, `makeProjection`, `PlasticState`, `applyReinforcement`.
- Produces:
  ```ts
  // fractal-recall.ts
  export interface RerankCandidate { id: number; score: number; vec: Float32Array }
  export interface Reranker { rerank(queryVec: Float32Array, candidates: RerankCandidate[]): Map<number, number> /* id -> final score */ }
  // FractalRecallDeps gains `reranker?: Reranker | null`; FractalMemory gains setReranker(r: Reranker | null): void
  // memory-rerank.ts
  export class BrainReranker implements Reranker {
    constructor(pack: BrainPack, sim: LifSim, state: PlasticState, opts: { w: number; dims: number });
    setWeight(w: number): void;
    rerank(queryVec: Float32Array, candidates: RerankCandidate[]): Map<number, number>;
    /** Called by boot after a settled receipt: reinforce the last query with the candidates that were used. */
    reinforce(valence: "reward" | "punishment"): number;
    invalidateReadouts(): void;
  }
  // index.ts
  export interface CinderBrain { pack: BrainPack; sim: LifSim; state: PlasticState; reranker: BrainReranker | null; status: BrainStatus }
  export type BrainStatus = { status: "active"; packId: string; neurons: number } | { status: "off"; reason: string } | { status: "downloading"; packId: string; bytes: number };
  export function startCinderBrain(opts: { home: string; enabled: boolean; packId: string; dims: number }): CinderBrain | { status: "off"; reason: string };
  ```

- [ ] **Step 1: Write the failing bit-for-bit test**

Find how existing agent-loop tests capture inference requests (`tests/agent-loop-*.test.ts` build an `AgentLoop` with a fake `InferenceRouter`; copy the smallest one's setup verbatim). The test:

```ts
// tests/brain-bitforbit.test.ts
// Setup copied from tests/agent-loop-brain.test.ts (fake router that records every request body).
import { describe, expect, test } from "bun:test";
// ...imports identical to that file...

async function requestsFor(env: Record<string, string | undefined>): Promise<unknown[]> {
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const { loop, recorded } = makeLoopWithRecordingRouter();   // helper lifted from the existing test
  await loop.handleMessage({ sessionId: "s1", content: "what did we decide about the mascot?" });
  return recorded.map((r) => JSON.parse(JSON.stringify(r)));
}

describe("bit-for-bit", () => {
  test("brain off, pack missing, seam off: identical inference requests", async () => {
    const off = await requestsFor({ CINDERPAW_CINDERBRAIN: "0" });
    const missing = await requestsFor({ CINDERPAW_CINDERBRAIN: undefined, CINDERPAW_CINDERBRAIN_PACK: "does-not-exist" });
    const seamOff = await requestsFor({ CINDERPAW_CINDERBRAIN: undefined, CINDERPAW_CINDERBRAIN_PACK: "tests/fixtures/brain/larva", CINDERPAW_CINDERBRAIN_RERANK: "0", CINDERPAW_CINDERBRAIN_DIAL: "0" });
    expect(missing).toEqual(off);
    expect(seamOff).toEqual(off);
  });
});
```

If the loop's fake router does not record the recall block, extend `makeLoopWithRecordingRouter` to also record `memory.setRecall` calls (the recall list is part of "the request").

- [ ] **Step 2: Write the failing rerank test**

```ts
// tests/brain-rerank.test.ts
import { describe, expect, test } from "bun:test";
import { fixtureCircuit } from "../src/brain-substrate/sim/fixture-circuit.ts";
import { LifSim } from "../src/brain-substrate/sim/lif.ts";
import { newPlasticState } from "../src/brain-substrate/plasticity/rule.ts";
import { BrainReranker } from "../src/brain-substrate/seams/memory-rerank.ts";
import { mulberry32 } from "../src/memory/fractal/prng.ts";

function unit(rng: () => number, d = 384): Float32Array {
  const v = Float32Array.from({ length: d }, () => rng() - 0.5);
  const n = Math.hypot(...v); return v.map((x) => x / n);
}

describe("BrainReranker", () => {
  test("w = 0 returns FMS scores unchanged; w > 0 changes at least one order; ids are never added or dropped", () => {
    const pack = fixtureCircuit();
    const rng = mulberry32(5);
    const q = unit(rng);
    const cands = Array.from({ length: 6 }, (_, i) => ({ id: 100 + i, score: 1 - i * 0.1, vec: unit(rng) }));
    const r0 = new BrainReranker(pack, new LifSim(pack), newPlasticState(pack), { w: 0, dims: 384 });
    const m0 = r0.rerank(q, cands);
    for (const c of cands) expect(m0.get(c.id)).toBeCloseTo(c.score, 6);
    const r1 = new BrainReranker(pack, new LifSim(pack), newPlasticState(pack), { w: 0.5, dims: 384 });
    const m1 = r1.rerank(q, cands);
    expect([...m1.keys()].sort()).toEqual(cands.map((c) => c.id).sort());
    expect(cands.some((c) => Math.abs(m1.get(c.id)! - c.score) > 1e-6)).toBe(true);
  });

  test("the same text gives the same pattern: rerank is deterministic", () => {
    const pack = fixtureCircuit();
    const rng = mulberry32(9);
    const q = unit(rng); const cands = [{ id: 1, score: 0.5, vec: unit(rng) }, { id: 2, score: 0.4, vec: unit(rng) }];
    const a = new BrainReranker(pack, new LifSim(pack), newPlasticState(pack), { w: 0.3, dims: 384 }).rerank(q, cands);
    const b = new BrainReranker(pack, new LifSim(pack), newPlasticState(pack), { w: 0.3, dims: 384 }).rerank(q, cands);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });
});
```

- [ ] **Step 3: Run both, expect failure**

Run: `bun test tests/brain-rerank.test.ts tests/brain-bitforbit.test.ts`
Expected: FAIL (missing module; the bit-for-bit may pass trivially today, that is fine, it must keep passing).

- [ ] **Step 4: Implement `memory-rerank.ts`**

- `projection = makeProjection(dims, sensory.length, manifest.seed)`.
- `readoutFor(vec)`: `readoutFromRest(pack, sim, embeddingToCurrent(vec, projection, sensory.length)).mbon`, cached by candidate id in a `Map<number, Float32Array>` (query readouts are not cached). `invalidateReadouts()` clears it; `reinforce` calls it.
- `rerank`: `brainScore = cosine(mbonQ, mbonC)` (0 when either is all-zero); `final = (1 − w) · score + w · brainScore`. Remember `lastQueryKc` (from the query readout) and the candidate ids passed in.
- `reinforce(valence)`: `applyReinforcement(pack, sim, state, valence, lastQueryKc)`; then `sim.setEffectiveWeight(effectiveWeight(pack, state))`, `invalidateReadouts()`, `writeLearnedState(...)`; return edges changed.

- [ ] **Step 5: Hook into FMS**

`fractal-recall.ts`: add `reranker?: Reranker | null` to `FractalRecallDeps`; at the end of `#rankedHits`, after the existing sort:

```ts
if (this.#reranker && ranked.length > 1 && qVec) {
  const cands = ranked.flatMap((h) => { const leaf = this.#leavesById.get(h.id); return leaf ? [{ id: h.id, score: h.score + (h.fts ? FTS_BOOST : 0), vec: leaf.vec }] : []; });
  const finals = this.#reranker.rerank(qVec, cands);
  ranked.sort((a, b) => (finals.get(b.id) ?? -Infinity) - (finals.get(a.id) ?? -Infinity));
}
return ranked;
```

(where `ranked` is the array the method currently returns). `fractal-memory.ts`: hold `#reranker`, pass it into both `FractalRecallEngine` constructions, expose `setReranker`.

- [ ] **Step 6: `index.ts`, config rows, boot wiring**

`config.ts` rows (same table as `CINDERPAW_BRAIN`, new "CinderBrain" section):
- `CINDERPAW_CINDERBRAIN` bool default `true`: "CinderBrain on/off. Off, or no pack, or a corrupt pack = today's agent, bit for bit."
- `CINDERPAW_CINDERBRAIN_PACK` string default `"flywire-783-v1"`: "Pack id under <home>/brain/packs, or a path to a pack directory (tests)."
- `CINDERPAW_CINDERBRAIN_RERANK` bool default `true`, `CINDERPAW_CINDERBRAIN_DIAL` bool default `true`: seam kill switches.
- `CINDERPAW_CINDERBRAIN_W` string default `"0.3"`: "Seed value of the rerank weight until a champion carries one."

`startCinderBrain`: resolve the pack dir (path if it exists as a directory, else `<home>/brain/packs/<id>`); `loadPack`; `readLearnedState(<home>/brain/state/<id>)` (a refusal becomes part of the status reason but the brain still starts with a fresh delta); require roles `sensory, kc, mbon, dan` for the reranker or set `reranker: null` with reason "pack declares no <role>"; return `{status:"off", reason}` on any `PackError` with the error's sentence. In `boot.ts`, after `fractalMemory` is built: `const brain = startCinderBrain(...)`; if it has a reranker and `CINDERPAW_CINDERBRAIN_RERANK` is on, `fractalMemory.setReranker(brain.reranker)`; log one line `[cinderbrain] active: <packId>, <neurons> neurons` or `[cinderbrain] off: <reason>`. In `settleVerdict` (boot.ts, next to `runReceipt`): `brain?.reranker?.reinforce(verified ? "reward" : "punishment")`.

- [ ] **Step 7: Run all brain tests + the two hooked suites; commit**

```bash
bun test tests/brain- tests/fractal-recall tests/fractal-bench && bunx tsc --noEmit
git add CinderpawAgent/src/brain-substrate CinderpawAgent/src/memory/fractal/fractal-recall.ts CinderpawAgent/src/memory/fractal/fractal-memory.ts CinderpawAgent/src/boot.ts CinderpawAgent/src/config.ts CinderpawAgent/tests/brain-rerank.test.ts CinderpawAgent/tests/brain-bitforbit.test.ts
git commit -m "feat(cinderbrain): memory-rerank seam into FMS, bit-for-bit guard"
```

- [ ] **Step 8: LongMemEval over the w grid**

Add to `scripts/longmemeval.ts`: `--brain-pack <dir>` and `--brain-w <n>` (default: no brain). When given, build a `BrainReranker` over that pack and pass it as `reranker` to the engine the script constructs. Then run (the embedding server must be up, see the script header):

```bash
for w in 0 0.1 0.3 0.5; do bun scripts/longmemeval.ts --instances 50 --brain-pack CinderpawAgent/tests/fixtures/brain/larva --brain-w $w; done
```

plus the same grid with `--brain-shuffle-seed 1..5` (add the flag: shuffles the pack before use) for `w = 0.3`. Collect recall@10 per run into `bench-results/brain/<iso>-longmemeval.md` with the distribution (min, median, max over the 50 instances), the 12 Sep FMS baseline number next to it, and the verdict per spec §7: kept only if `real` beats both the shuffled median and `w = 0` on at least one `w` by more than the spread. Commit the report.

**Exit criteria:** bit-for-bit green; rerank tests green; existing fractal suites still green; LongMemEval table with a verdict line; report says whether the rerank seam stays on by default (`CINDERPAW_CINDERBRAIN_RERANK` default flips to `false` in `config.ts` if the verdict is "no", with the reason in the description).

---

### Task 5: `control-dial` seam and the five genome fields

Spec: §5.2, §5.3, §6, §8.7.

**Files:**
- Create: `src/brain-substrate/seams/control-dial.ts`
- Modify: `src/core/agent-loop.ts` (`#brainDelta`, `setBrainDelta`, `#complete` precedence), `src/brain-substrate/index.ts` (dial), `src/boot.ts` (observe after each turn; champion → brain coefficients), `src/rsi/l1-config/genome.ts`, `mutation.ts`, `champion.ts`, and every other file `grep -rn decompositionDepth src --include=*.ts -l | grep -v test` lists
- Test: `tests/brain-dial.test.ts`, `tests/brain-l3-wall.test.ts`, extend `tests/brain-bitforbit.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class ControlDial {
    constructor(pack: BrainPack, sim: LifSim, opts: { coeffs: [number, number, number, number]; stateFile: string | null });
    setCoeffs(c: [number, number, number, number]): void;
    observe(outcome: { receipt: "positive" | "negative" | null; toolError: boolean; replyChars: number }): void;
    delta(): { temperature: number; recallChars: number };   // already within [-0.3, 0.3] and [-2000, 2000]
    stateHash(): string;
  }
  // agent-loop.ts
  setBrainDelta(d: { temperature: number; recallChars: number } | null): void;
  // genome.ts
  brainRerankWeight: number;          // [0, 0.6]
  brainDial: [number, number, number, number];   // each [-0.3, 0.3]
  // champion.ts AgentChampionParams gains brainRerankWeight?: number; brainDial?: [number, number, number, number]
  ```

- [ ] **Step 1: Write the failing dial test**

```ts
// tests/brain-dial.test.ts
import { describe, expect, test } from "bun:test";
import { fixtureCircuit } from "../src/brain-substrate/sim/fixture-circuit.ts";
import { LifSim } from "../src/brain-substrate/sim/lif.ts";
import { ControlDial } from "../src/brain-substrate/seams/control-dial.ts";

const mk = (coeffs: [number, number, number, number] = [0.3, 0.3, 2000, 2000]) =>
  new ControlDial(fixtureCircuit(), new LifSim(fixtureCircuit()), { coeffs, stateFile: null });

describe("ControlDial", () => {
  test("deltas never leave the clamp, whatever the history", () => {
    const d = mk();
    for (let i = 0; i < 300; i++) d.observe({ receipt: i % 3 === 0 ? "positive" : "negative", toolError: i % 7 === 0, replyChars: 5000 });
    const { temperature, recallChars } = d.delta();
    expect(Math.abs(temperature)).toBeLessThanOrEqual(0.3);
    expect(Math.abs(recallChars)).toBeLessThanOrEqual(2000);
  });
  test("state persists across turns: the delta after 20 positives is not the delta after 20 negatives", () => {
    const a = mk(), b = mk();
    for (let i = 0; i < 20; i++) { a.observe({ receipt: "positive", toolError: false, replyChars: 100 }); b.observe({ receipt: "negative", toolError: false, replyChars: 100 }); }
    expect(a.delta().temperature).not.toBeCloseTo(b.delta().temperature, 3);
    expect(a.stateHash()).not.toBe(b.stateHash());
  });
  test("zero coefficients give a zero delta", () => {
    const d = mk([0, 0, 0, 0]);
    d.observe({ receipt: "positive", toolError: false, replyChars: 10 });
    expect(d.delta()).toEqual({ temperature: 0, recallChars: 0 });
  });
});
```

And, in `tests/brain-bitforbit.test.ts`, a second test: with the larva pack on and both seams on, and a UI override `{temperature: 0.2}` set on the session, the recorded request's temperature is exactly `0.2` (UI wins outright).

- [ ] **Step 2: Write the failing L3 wall test**

```ts
// tests/brain-l3-wall.test.ts
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
// L3's proposer only ever reads `src/rsi` (code-proposer.ts). This pins that the
// brain substrate is not under it, so a code patch can never reach it.
test("brain-substrate is outside the L3 proposal root", () => {
  expect(readdirSync(join(import.meta.dir, "../src/rsi"))).not.toContain("brain-substrate");
  expect(readdirSync(join(import.meta.dir, "../src"))).toContain("brain-substrate");
});
```

- [ ] **Step 3: Run, expect failure**

Run: `bun test tests/brain-dial.test.ts tests/brain-l3-wall.test.ts`
Expected: dial FAIL (module missing); wall may already pass.

- [ ] **Step 4: Implement `control-dial.ts`**

`observe`: current on `neuromodulator`: positive receipt → 2 mV/ms on the `dan` subset of `neuromodulator` (neurons in both sets; if the pack has no `dan`, the first half of `neuromodulator`); negative receipt or `toolError` → 2 mV/ms on the other half; `null` and no error → nothing. Step 50 ms with that input, `clearInput`, then step 200 ms with no input (the persistent population runs on). `delta()`: `rPS = mean rates(persistent-state)`, `rNM = mean rates(neuromodulator)` over the last observe window, normalised by 100 Hz; `temperature = clamp(c0 · rPS + c1 · rNM, −0.3, 0.3)`, `recallChars = clamp(c2 · rPS + c3 · rNM, −2000, 2000)`; both exactly `0` when all coefficients are 0. `stateHash`: sha256 of `exportState(persistent-state)`. Persist that state to `stateFile` (`<home>/brain/state/<packId>/cx_state.bin`) after every observe when `stateFile` is set; load it in the constructor if present and the length matches. Requires roles `persistent-state` and `neuromodulator`; `index.ts` sets `dial: null` with a reason otherwise (the larva gets no dial; the report says so).

- [ ] **Step 5: Agent loop precedence**

In `agent-loop.ts` add `#brainDelta: { temperature: number; recallChars: number } | null = null` and `setBrainDelta(d)`. At the temperature line in `#complete` (today `overrides?.temperature ?? this.#championParams.temperature`):

```ts
const brainT = this.#brainDelta?.temperature ?? 0;
const temperature = overrides?.temperature !== undefined
  ? overrides.temperature
  : brainT === 0
    ? this.#championParams.temperature
    : clamp((this.#championParams.temperature ?? DEFAULT_BRAIN_BASE_TEMPERATURE) + brainT, 0.3, 1.0);
```

with `const DEFAULT_BRAIN_BASE_TEMPERATURE = 0.7` and a comment: a fresh install has no champion, so the dial rides on the documented cloud default. When `brainT === 0` the expression is today's expression, which is what bit-for-bit checks. Same shape at `memory.setRecall(recalled.context, recallInjectionMaxChars())`: `clamp(recallInjectionMaxChars() + (this.#brainDelta?.recallChars ?? 0), 0, recallInjectionMaxChars())`.

- [ ] **Step 6: Genome fields**

`genome.ts`: add the two fields to `GenomeConfig` and `LIVE_REACH` (`"applied"`). `mutation.ts`: `brainRerankWeight` via `mutateBoundedReal` in `[0, 0.6]` with sigma `0.05`; `brainDial` mutates one random component via `mutateBoundedReal` in `[−0.3, 0.3]`, sigma `0.03`. `champion.ts`: `mapGenomeToAgentConfig` copies both when finite and in range. Then `grep -rn decompositionDepth src --include=*.ts -l | grep -v test` and, in every file listed, add the two fields wherever a full `GenomeConfig` literal or per-field enumeration exists (defaults: `brainRerankWeight: 0.3`, `brainDial: [0, 0, 0, 0]`; crossover: average; taste: clamp). `bunx tsc --noEmit` is the checklist: the exhaustive `LIVE_REACH` type makes a missed site a type error. In `boot.ts`, where `agent.applyChampionParams(...)` runs, also call `brain.reranker?.setWeight(params.brainRerankWeight ?? envW)` and `brain.dial?.setCoeffs(params.brainDial ?? [0,0,0,0])`. After each turn's `settleVerdict`, and on tool errors, call `dial.observe(...)` then `agent.setBrainDelta(dial.delta())`. Each receipt gets `brain: { packId, w, dialDelta, stateHash }` appended (extend the receipt type in `run-receipt.ts` with an optional `brain` field).

- [ ] **Step 7: Run everything touched; commit**

```bash
bun test tests/brain- tests/rsi tests/genome tests/champion tests/mutation tests/agent-loop && bunx tsc --noEmit
git add -A CinderpawAgent/src CinderpawAgent/tests
git commit -m "feat(cinderbrain): control-dial seam as a bounded delta over the champion; five genome fields"
```

**Exit criteria:** dial + wall + bit-for-bit (both tests) green; RSI suites green; tsc clean; report lists every genome site touched and states plainly that the dial is unconfirmed (spec §5.2) and that the larva has no dial.

---

### Task 6: FlyWire adapter, pack build, atomic install and download, status on screen

Spec: §2.3 (flywire), §2.4, §2.5, §8.3.

**Files:**
- Create: `src/brain-substrate/pack/adapters/flywire.ts`, `pack/install.ts`, `seams/status.ts`
- Modify: `scripts/brain/build-pack.ts` (flywire branch), `package.json` (`apache-arrow` devDependency), `src/types.ts` + `src/protocol.ts` + `crates/cinderpaw-core/src/sidecar_protocol.rs` (`brain_status`), `src/boot.ts` (download + emit), `frontend-react/src/hooks/useCinderpaw.ts`, `frontend-react/src/stores/cinderpaw.ts`, the status bar component that shows model downloads (find it via `model_download_progress` in `frontend-react/src`), `frontend-react/src/lib/i18n.ts`, a Settings toggle + "Reset brain" button next to the existing memory settings, `THIRD-PARTY-NOTICES.md`
- Test: `tests/brain-install.test.ts`, `tests/protocol.test.ts` (existing, must stay green)

**Interfaces:**
- Produces:
  ```ts
  export function buildFlyWirePack(srcDir: string, opts?: { synapseFloor?: number }): PackFiles;
  export type InstallStep = "download" | "verify" | "unpack" | "validate" | "rename";
  export function installPack(opts: { source: string /* URL or local .tar.zst */; packsDir: string; packId: string; expectedSha256: string; onProgress?: (bytes: number) => void; crashAt?: InstallStep /* tests only */ }): Promise<void>;
  // OutboundEvent gains:
  | { type: "brain_status"; status: "active" | "off" | "downloading"; packId?: string; neurons?: number; bytes?: number; reason?: string }
  ```

- [ ] **Step 1: Write the failing install test**

```ts
// tests/brain-install.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPack, type InstallStep } from "../src/brain-substrate/pack/install.ts";
import { loadPack } from "../src/brain-substrate/pack/load.ts";
import { packLarvaAsArchive } from "./helpers/brain-archive.ts";   // tars + zstd the larva fixture into a temp file, returns {file, sha256}

describe("atomic install", () => {
  for (const step of ["download", "verify", "unpack", "validate", "rename"] as InstallStep[]) {
    test(`a crash during ${step} leaves no partial pack`, async () => {
      const packs = mkdtempSync(join(tmpdir(), "packs-"));
      const { file, sha256 } = await packLarvaAsArchive();
      await expect(installPack({ source: file, packsDir: packs, packId: "larva", expectedSha256: sha256, crashAt: step })).rejects.toThrow();
      expect(existsSync(join(packs, "larva"))).toBe(false);
      // Nothing but scratch under a dotted name may remain, and the next install must succeed.
      expect(readdirSync(packs).filter((f) => !f.startsWith("."))).toEqual([]);
      await installPack({ source: file, packsDir: packs, packId: "larva", expectedSha256: sha256 });
      expect(loadPack(join(packs, "larva")).manifest.packId).toBe("larva-s1-v1");
    });
  }
  test("a wrong hash is refused before unpacking", async () => {
    const packs = mkdtempSync(join(tmpdir(), "packs-"));
    const { file } = await packLarvaAsArchive();
    await expect(installPack({ source: file, packsDir: packs, packId: "larva", expectedSha256: "0".repeat(64) })).rejects.toThrow(/sha256/);
    expect(readdirSync(packs).filter((f) => !f.startsWith("."))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `bun test tests/brain-install.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement `install.ts`**

Steps, each guarded by `if (crashAt === step) throw new Error("simulated crash at " + step)` placed after the step's side effect begins and before it completes:
1. `download`: stream `source` (fetch for http(s), copy for a path) to `<packsDir>/.<packId>.partial`; on failure delete it.
2. `verify`: sha256 of `.partial`; mismatch → delete, throw `PackError("pack sha256 does not match the release manifest")`.
3. `unpack`: `Bun.spawn(["tar", "--zstd", "-xf", partial, "-C", tmp])` into `<packsDir>/.<packId>.tmp-<random>` (Windows 11 tar supports `--zstd`; if it fails, throw with the tar stderr in the message). 
4. `validate`: `loadPack(tmp)`.
5. `rename`: if `<packsDir>/<packId>` exists, rename it to `.<packId>.old-<random>`; `renameSync(tmp, <packsDir>/<packId>)`; delete `.old` and `.partial`. On any failure after the old pack was moved, move it back.
Startup sweep (in `startCinderBrain`): delete any `.*.partial` / `.*.tmp-*` / `.*.old-*` older than one hour.

- [ ] **Step 4: Implement `adapters/flywire.ts` and the build**

Add `apache-arrow` to `devDependencies` (exact version). `buildFlyWirePack(srcDir)` reads `proofread_connections_783.feather` (columns `pre_root_id`, `post_root_id`, `syn_count`, plus `neuropil`; sum `syn_count` over neuropils per (pre, post)), keeps `syn_count >= 5`, and the annotations TSV (`Supplemental_file1_neuron_annotations.tsv`, columns `root_id`, `super_class`, `cell_class`, `cell_type`, `top_nt`). Neurons = the union of ids present in the annotations (v783, 139,255); connections whose endpoints are not annotated are dropped and counted in the report. Sign from `top_nt`: `acetylcholine`, `dopamine`, `serotonin`, `octopamine` → +1; `gaba`, `glutamate` → −1. Weight `= sign × syn_count × 0.275`. Roles: `kc` = `cell_class == "Kenyon_Cell"`; `mbon` = `cell_class == "MBON"`; `dan` = `cell_class == "DAN"`; `neuromodulator` = `dan` ∪ `cell_class == "OAN"` (octopaminergic) ; `persistent-state` = `cell_type` starting with `EPG`, `PEN`, `PEG`, `Delta7`; `sensory` = `super_class == "sensory"` ∪ `cell_class` antennal-lobe projection neurons (`ALPN`) so the projection lands on second-order neurons too. MBON valence by `top_nt`: `glutamate` → `avoidance`, `gaba`/`acetylcholine` → `approach` (Aso et al. 2014). Compartments: one per MBON; `danIds` = all `dan` whose `cell_type` starts with `PAM` for `avoidance` compartments and with `PPL1` for `approach` (the reward and punishment DAN families); if either family is empty, all `dan`. If any column name differs from the above, print the real header, fix the constant at the top of the adapter, and note it in the report; do not guess silently.

`scripts/brain/build-pack.ts --adapter flywire --src data/flywire --out build/cinderbrain-flywire-783-v1` then `tar --zstd -cf cinderbrain-flywire-783-v1.tar.zst -C build cinderbrain-flywire-783-v1` and print the archive sha256 and size. Generate `ATTRIBUTION.md` with the citations from spec §2.4 and the derived-work sentence. Add the same block to `THIRD-PARTY-NOTICES.md`. Record the archive sha256 as `CINDERBRAIN_PACK_SHA256` next to the download URL in `boot.ts`'s pack table (`{ id: "flywire-783-v1", url: "https://github.com/bloom500/cinderpaw/releases/download/<tag>/cinderbrain-flywire-783-v1.tar.zst", sha256 }`). The archive itself is uploaded to the release by hand; the report must state the size and hash.

- [ ] **Step 5: Status event, download at boot, UI**

`types.ts`: add the `brain_status` variant; `protocol.ts` and `sidecar_protocol.rs`: add `"brain_status"` to `OUTBOUND_TYPES` (both; `tests/protocol.test.ts` and the Rust mirror test keep them in sync). `boot.ts`: at start, if enabled and the pack dir is missing → emit `{type:"brain_status", status:"downloading", packId, bytes: 0}`, run `installPack` in the background with progress events at most once per second and three retries with backoff, then `startCinderBrain` and emit `active` (with `neurons` from the loaded manifest, after `loadPack`) or `off` with the reason; any `PackError` at load → delete the pack dir, emit `off` with `"corrupt pack, retrying"`, retry once. No network → `off`, `"no connection; the agent works normally"`. Kill switch → `off`, `"disabled (CINDERPAW_CINDERBRAIN=0)"`.

Frontend: in `useCinderpaw.ts`'s event switch add `brain_status` → `useCinderpawStore.setBrainStatus(parsed)`; store field `brainStatus`; render one line in the same status surface that shows model downloads: `CinderBrain: downloading the FlyWire pack (42 MB)` / `CinderBrain: active · 139,255 neurons` / `CinderBrain: off, <reason>`; i18n keys `brain.downloading`, `brain.active`, `brain.off` in every locale file the repo has (English text for now, same as other new keys). Settings: a toggle bound to `CINDERPAW_CINDERBRAIN` through the same mechanism the memory-mode toggle uses (`memory_mode_changed` is the precedent), and a "Reset brain" button that sends the existing admin request path with `action: "brain_reset"` → sidecar deletes `<home>/brain/state/<packId>/` and re-creates a fresh `PlasticState`, then emits `brain_status active`.

- [ ] **Step 6: Run tests; typecheck TS, Rust, React; commit**

```bash
cd CinderpawAgent && bun test tests/brain-install.test.ts tests/protocol.test.ts && bunx tsc --noEmit
cd ../frontend-react && npx tsc --noEmit
# Rust: verify from the dev build log per the repo's convention, do not run a bare cargo check (it deadlocks target/).
git add -A
git commit -m "feat(cinderbrain): FlyWire adapter and pack build, atomic install, brain_status on screen"
```

**Exit criteria:** 6 install tests green; protocol test green in TS and Rust; UI shows the three states (screenshot of each in the report); archive built with its size and sha256 in the report; `THIRD-PARTY-NOTICES.md` updated. If the FlyWire column names differ, the report says which.

---

### Task 7: Pre-release verdict on FlyWire

Spec: §7 (seeds and shuffles), §9 step 7.

**Files:**
- Create: `bench-results/brain/<iso>-flywire-verdict.md`
- Modify: `src/config.ts` defaults for `CINDERPAW_CINDERBRAIN_RERANK` / `_DIAL` per the verdict; `CHANGELOG.md`

- [ ] **Step 1: Install the built pack locally**

`bun run src/brain-substrate/bench/run.ts --install build/cinderbrain-flywire-783-v1.tar.zst` (add this small `--install` path to `run.ts`: it calls `installPack` into `<home>/brain/packs`). Then `loadPack` prints neurons/edges; note wall-clock for `readoutFromRest` on FlyWire (one pattern, 50 ms).

- [ ] **Step 2: Synthetic plasticity, 10 seeds, 5 shuffles, in the background**

```bash
bun run brain:bench --pack ~/.cinderpaw/brain/packs/flywire-783-v1 --seeds 10 --shuffles 5 --out ../bench-results/brain/
```

Run it detached (it can take an hour); do not block the session on it.

- [ ] **Step 3: LongMemEval on FlyWire, the w grid, as many instances as cost allows**

Same loop as Task 4 Step 8 with `--brain-pack ~/.cinderpaw/brain/packs/flywire-783-v1`, 50 instances, `w ∈ {0, 0.1, 0.3, 0.5}`, plus 5 shuffles at the best `w`. Distribution, not only the mean.

- [ ] **Step 4: Dial diagnostics**

On FlyWire, run `ControlDial` for 200 observes of positives and 200 of negatives, real and 5 shuffles: report whether real separates the two (difference in `delta().temperature` beyond the spread of the shuffles). No pass/fail: it is diagnostic, and the seam stays "unconfirmed" either way (spec §5.2).

- [ ] **Step 5: Write the verdict and set the defaults**

`bench-results/brain/<iso>-flywire-verdict.md`: three tables (plasticity, rerank, dial), the three possible outcomes named in the spec for each (real ≫ shuffled / real ≈ shuffled > baseline / all equal), and the decision: `CINDERPAW_CINDERBRAIN_RERANK` default `true` only if the rerank gate passed; `_DIAL` default stays `true` only as a small documented delta (coefficients default to 0 until a champion carries non-zero ones, so a fresh install's dial is inert by construction). Update `config.ts` descriptions to say what was measured. Add the CHANGELOG entry with the numbers, the word "unconfirmed" on the dial, and the FlyWire attribution.

- [ ] **Step 6: Commit and report**

```bash
git add bench-results/brain CinderpawAgent/src/config.ts CHANGELOG.md
git commit -m "bench(cinderbrain): FlyWire pre-release verdict, defaults set from the measurements"
```

**Exit criteria:** the verdict file exists with all three tables; defaults match it; the report states the one-line claim that is safe to publish and the one that is not.

---

## Self-review

- **Spec coverage:** §1 (Task 1 to 5 file layout), §2.1/2.2 (Task 1), §2.3 larva (Task 1), §2.3 flywire + §2.4 + §2.5 (Task 6), §3 (Task 2), §4 (Task 3), §5.1 (Task 4), §5.2 + §5.3 receipt audit field (Task 5), §6 (Task 5; the L3 wall is a test because the proposer's root already excludes it), §7 (Tasks 3, 4, 7), §8.1 (Task 4 and 5), §8.2/8.4 (Task 1), §8.3 (Task 6), §8.5 (Task 2), §8.6 (Task 3), §8.7 (Task 5), §8.8 (Task 3), §9 (task order; kill gate at Task 3 Step 10), §2.4 logo (not a code task; noted in Task 7's report as a release item).
- **Placeholders:** none; the two "find and copy" instructions (agent-loop test setup, model-download status component) name the file to copy from.
- **Type consistency:** `BrainPack.plastic.{edgeIdx,src,compartment}` (Task 1) is what Task 3 and 4 index; `Reranker.rerank` returns `Map<number, number>` in Task 4 and `fractal-recall.ts` sorts by it; `ControlDial.delta()` shape equals `setBrainDelta`'s parameter; `PackFiles` is what both adapters return and `writePackFiles` takes.
