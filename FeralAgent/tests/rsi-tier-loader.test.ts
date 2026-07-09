/**
 * Faza 1 — runEval real: the Tier 1/2 on-disk spec loader.
 *
 * Tier 0 is frozen in Rust; Tier 1 and Tier 2 live as one JSON file per
 * task under `eval/tier1/` and `eval/tier2/`, loaded at boot. The loader
 * is strict: a malformed spec on disk is a boot-time error, never a
 * silently-dropped task, because a missing eval would inflate scores.
 * Results are returned id-sorted so an eval run is reproducible.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTierSpecs } from "../src/rsi/infra/tier-loader.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rsi-tier-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, body: unknown) =>
  writeFileSync(join(dir, name), JSON.stringify(body));

const valid = {
  id: "tier1/capital_germany",
  tier: 1,
  name: "Capital of Germany",
  description: "Agent names Berlin.",
  prompt: "What is the capital of Germany? Answer with the city name.",
  kind: "fact_lookup",
  expected: { type: "fact_lookup", answer: "berlin" },
};

describe("loadTierSpecs", () => {
  test("loads every *.json spec in the directory", () => {
    write("a.json", { ...valid, id: "tier1/a" });
    write("b.json", { ...valid, id: "tier1/b" });
    const specs = loadTierSpecs(dir);
    expect(specs.map((s) => s.id)).toEqual(["tier1/a", "tier1/b"]);
  });

  test("returns specs id-sorted regardless of filename order", () => {
    write("z.json", { ...valid, id: "tier1/zeta" });
    write("a.json", { ...valid, id: "tier1/alpha" });
    expect(loadTierSpecs(dir).map((s) => s.id)).toEqual([
      "tier1/alpha",
      "tier1/zeta",
    ]);
  });

  test("ignores non-json files", () => {
    write("spec.json", valid);
    writeFileSync(join(dir, "README.md"), "not a spec");
    expect(loadTierSpecs(dir)).toHaveLength(1);
  });

  test("returns an empty array for a missing directory", () => {
    expect(loadTierSpecs(join(dir, "does-not-exist"))).toEqual([]);
  });

  test("throws on invalid JSON", () => {
    writeFileSync(join(dir, "broken.json"), "{ not json");
    expect(() => loadTierSpecs(dir)).toThrow(/broken\.json/);
  });

  test("throws when a required field is missing", () => {
    const { prompt, ...noPrompt } = valid;
    write("nop.json", noPrompt);
    expect(() => loadTierSpecs(dir)).toThrow(/prompt/);
  });

  test("throws when kind and expected.type disagree", () => {
    write("mismatch.json", {
      ...valid,
      kind: "fact_lookup",
      expected: { type: "latency", max_ms: 100 },
    });
    expect(() => loadTierSpecs(dir)).toThrow(/mismatch\.json/);
  });
});
