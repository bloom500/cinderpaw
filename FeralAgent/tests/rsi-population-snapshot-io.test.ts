/**
 * Dream Cycle — population snapshot persistence (disk layer).
 *
 * Writes the PopulationSnapshot atomically and reads it back, degrading
 * to null (never throwing) on a missing, corrupt, or version-mismatched
 * file so the caller's resume cascade can fall through to the champion
 * fallback. Mirrors the soft-layer discipline of champion.ts.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PopulationManager } from "../src/rsi/l1-config/population-manager.ts";
import {
  readPopulationSnapshot,
  writePopulationSnapshot,
} from "../src/rsi/l1-config/population-snapshot.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "feral-snap-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seededSnapshot() {
  const pop = new PopulationManager();
  pop.add({ id: "g1", generation: 0, lineage: [] });
  pop.recordEval("g1", { fitnessScore: 55, behavioralFingerprint: [1, 0] });
  return pop.snapshot();
}

describe("population snapshot disk I/O", () => {
  test("round-trips a snapshot through disk", () => {
    const path = join(tmp(), "population.json");
    const snap = seededSnapshot();
    expect(writePopulationSnapshot(path, snap)).toBe(true);

    const read = readPopulationSnapshot(path);
    expect(read).not.toBeNull();
    expect(read!.bestRecord).toEqual({ genomeId: "g1", score: 55 });
    expect(read!.genomes.map((g) => g.id)).toEqual(["g1"]);
  });

  test("a restored manager from a disk snapshot matches the original best", () => {
    const path = join(tmp(), "population.json");
    writePopulationSnapshot(path, seededSnapshot());

    const pop = new PopulationManager();
    pop.restore(readPopulationSnapshot(path)!);
    expect(pop.best()).toEqual({ genomeId: "g1", score: 55 });
  });

  test("reads null for a missing file", () => {
    expect(readPopulationSnapshot(join(tmp(), "nope.json"))).toBeNull();
  });

  test("reads null for corrupt JSON (never throws)", () => {
    const path = join(tmp(), "population.json");
    writeFileSync(path, "{ not json", "utf8");
    expect(readPopulationSnapshot(path)).toBeNull();
  });

  test("reads null for a version mismatch", () => {
    const path = join(tmp(), "population.json");
    const snap = seededSnapshot();
    writeFileSync(path, JSON.stringify({ ...snap, version: 999 }), "utf8");
    expect(readPopulationSnapshot(path)).toBeNull();
  });

  test("write creates the parent directory and never throws on a bad path", () => {
    const path = join(tmp(), "nested", "deep", "population.json");
    expect(writePopulationSnapshot(path, seededSnapshot())).toBe(true);
    expect(readPopulationSnapshot(path)).not.toBeNull();
  });
});
