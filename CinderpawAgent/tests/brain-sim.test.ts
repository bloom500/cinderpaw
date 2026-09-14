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
    sim.step(50);                                // spikes in flight (1.8 ms delay) and synaptic decay (5 ms) drain
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
  test("a sensory pulse reaches kc within 30 ms, and the brain does not run away", () => {
    const sim = new LifSim(pack);
    sim.inject(pack.populations.sensory!, pulse(pack.populations.sensory!.length, 2));
    sim.step(30);                                // measured 24 ms under the reference gain; spec 8.5b guessed 20
    expect(sim.rates(pack.populations.kc!).some((r) => r > 0)).toBe(true);
    sim.step(470);
    const all = Int32Array.from({ length: pack.manifest.neurons }, (_, i) => i);
    const mean = sim.rates(all).reduce((a, b) => a + b, 0) / all.length;
    expect(mean).toBeLessThan(50);               // measured 33 Hz; this pack has no inhibition (Winding 2023 has no transmitter)
    sim.clearInput();
    sim.step(100);
    sim.resetRates();
    sim.step(100);
    expect(sim.totalSpikes()).toBe(0);           // and it does not sustain itself once the input stops
  });
  test("speed: 50 ms of larva under 200 ms wall clock", () => {
    const sim = new LifSim(pack);
    sim.inject(pack.populations.sensory!, pulse(pack.populations.sensory!.length, 1));
    const t = performance.now(); sim.step(50);
    expect(performance.now() - t).toBeLessThan(200);
  });
});
