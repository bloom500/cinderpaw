/**
 * Faza 2 — Extinction: the Hall of Fame.
 *
 * Hall-of-Fame genomes are immune to extinction (PLAN.md "Ratchet" /
 * "Extinction"). They are auto-inducted when a genome sets a new
 * best-all-time score, and inducted manually at Tier 2 breakthroughs by
 * the extinction handler (which has the per-tier outcome data the
 * PopulationManager does not). Membership survives a genome's death —
 * the Hall of Fame is a permanent record, not a live-set view.
 */

import { describe, expect, test } from "bun:test";
import { PopulationManager } from "../src/rsi/population-manager.ts";

describe("PopulationManager Hall of Fame", () => {
  test("nothing is immune before any induction", () => {
    const pop = new PopulationManager();
    pop.add({ id: "g1", generation: 0, lineage: [] });
    expect(pop.isImmune("g1")).toBe(false);
    expect(pop.hallOfFame()).toEqual([]);
  });

  test("a new best-all-time genome is auto-inducted", () => {
    const pop = new PopulationManager();
    pop.add({ id: "g1", generation: 0, lineage: [] });
    pop.add({ id: "g2", generation: 0, lineage: [] });

    pop.recordEval("g1", { fitnessScore: 40, behavioralFingerprint: [1, 0] });
    expect(pop.isImmune("g1")).toBe(true);

    // g2 does not beat g1 → not inducted
    pop.recordEval("g2", { fitnessScore: 30, behavioralFingerprint: [0, 1] });
    expect(pop.isImmune("g2")).toBe(false);

    // g2 later beats the record → inducted
    pop.recordEval("g2", { fitnessScore: 99, behavioralFingerprint: [0, 1] });
    expect(pop.isImmune("g2")).toBe(true);
  });

  test("manual induct marks a known genome immune", () => {
    const pop = new PopulationManager();
    pop.add({ id: "g1", generation: 0, lineage: [] });
    pop.induct("g1");
    expect(pop.isImmune("g1")).toBe(true);
    expect(pop.hallOfFame()).toEqual(["g1"]);
  });

  test("induct throws on an unknown genome", () => {
    const pop = new PopulationManager();
    expect(() => pop.induct("ghost")).toThrow(/ghost/);
  });

  test("immunity survives the genome's death", () => {
    const pop = new PopulationManager();
    pop.add({ id: "g1", generation: 0, lineage: [] });
    pop.recordEval("g1", { fitnessScore: 40, behavioralFingerprint: [1, 0] });
    pop.kill("g1");
    expect(pop.isImmune("g1")).toBe(true);
  });

  test("induction is idempotent", () => {
    const pop = new PopulationManager();
    pop.add({ id: "g1", generation: 0, lineage: [] });
    pop.induct("g1");
    pop.induct("g1");
    expect(pop.hallOfFame()).toEqual(["g1"]);
  });
});
