/**
 * Faza 1 — runEval real: the production spec combiner.
 *
 * `makeGetSpecs` assembles the full eval suite a run executes:
 *   Tier 0 — fetched from Rust over the bridge (the frozen sanity bar),
 *            mapped into the sidecar `EvalSpec` shape with `tier: 0`;
 *   Tier 1/2 — the embedded defaults, plus any operator-supplied JSON
 *            specs found on disk, where a disk spec OVERRIDES an embedded
 *            default sharing its id (so a bad default can be patched
 *            without a rebuild).
 *
 * The combined suite is ordered by (tier, id) so a run is reproducible.
 */

import { describe, expect, test } from "bun:test";
import { makeGetSpecs } from "../src/rsi/get-specs.ts";
import type { EvalSpec } from "../src/rsi/eval-spec.ts";

/** A Rust Tier0Spec as it arrives over the bridge (no `tier` field). */
const rustTier0 = [
  {
    id: "tier0/fact_capital_france",
    name: "Capital of France",
    description: "names Paris",
    prompt: "Capital of France?",
    kind: "fact_lookup",
    expected: { type: "fact_lookup", answer: "paris" },
  },
];

describe("makeGetSpecs", () => {
  test("maps Tier 0 from the bridge and stamps tier: 0", async () => {
    const getSpecs = makeGetSpecs({
      fetchTier0: async () => rustTier0,
      loadDiskSpecs: () => [],
    });
    const specs = await getSpecs();
    const t0 = specs.find((s) => s.id === "tier0/fact_capital_france")!;
    expect(t0.tier).toBe(0);
    expect(t0.prompt).toBe("Capital of France?");
  });

  test("includes embedded Tier 1 and Tier 2 defaults", async () => {
    const getSpecs = makeGetSpecs({
      fetchTier0: async () => [],
      loadDiskSpecs: () => [],
    });
    const tiers = new Set((await getSpecs()).map((s) => s.tier));
    expect(tiers.has(1)).toBe(true);
    expect(tiers.has(2)).toBe(true);
  });

  test("orders the suite by (tier, id)", async () => {
    const getSpecs = makeGetSpecs({
      fetchTier0: async () => rustTier0,
      loadDiskSpecs: () => [],
    });
    const specs = await getSpecs();
    for (let i = 1; i < specs.length; i++) {
      const a = specs[i - 1]!;
      const b = specs[i]!;
      const ordered = a.tier < b.tier || (a.tier === b.tier && a.id <= b.id);
      expect(ordered).toBe(true);
    }
  });

  test("a disk spec overrides an embedded default with the same id", async () => {
    const override: EvalSpec = {
      id: "tier1/multiply_17_23",
      tier: 1,
      name: "patched",
      description: "patched",
      prompt: "PATCHED PROMPT",
      kind: "fact_lookup",
      expected: { type: "fact_lookup", answer: "391" },
    };
    const getSpecs = makeGetSpecs({
      fetchTier0: async () => [],
      loadDiskSpecs: () => [override],
    });
    const specs = await getSpecs();
    const hits = specs.filter((s) => s.id === "tier1/multiply_17_23");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.prompt).toBe("PATCHED PROMPT");
  });

  test("a disk spec with a new id is added", async () => {
    const extra: EvalSpec = {
      id: "tier2/custom",
      tier: 2,
      name: "custom",
      description: "custom",
      prompt: "custom?",
      kind: "fact_lookup",
      expected: { type: "fact_lookup", answer: "ok" },
    };
    const getSpecs = makeGetSpecs({
      fetchTier0: async () => [],
      loadDiskSpecs: () => [extra],
    });
    expect((await getSpecs()).some((s) => s.id === "tier2/custom")).toBe(true);
  });
});
