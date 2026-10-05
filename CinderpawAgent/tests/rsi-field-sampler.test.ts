/**
 * S1.7 of the AgentLoop evolution spec: the field sampler over the O*NET
 * 31.0 extract. Holdout families are never drawn for development, blocked
 * occupations and terms are never drawn at all, coverage weighting prefers
 * an empty family, and the data hash moves when the blocklist moves.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rngOf } from "../src/rsi/infra/fixtures.ts";
import { DATA_DIR, loadDefaultFieldData, loadFieldData, sampleField, validatePlan, type FieldPlan } from "../src/rsi/research/field-sampler.ts";
import { PARTITIONS } from "../src/rsi/research/task-family.ts";

const data = loadDefaultFieldData();
const tsv = readFileSync(join(DATA_DIR, "onet-31.0-tasks.tsv"), "utf8").replace(/\r\n/g, "\n");
const plan = data.plan;
const clone = (): FieldPlan => JSON.parse(JSON.stringify(plan));

describe("the checked-in data", () => {
  test("loads, every task statement accounted for, the plan is valid and carries the CC BY attribution", () => {
    const allowed = [...data.byFamily.values()].reduce((s, l) => s + l.length, 0);
    expect(allowed + data.blocked).toBe(18_838);
    expect(validatePlan(plan)).toEqual([]);
    expect(plan.attribution).toContain("O*NET 31.0 Database");
    expect(plan.attribution).toContain("has not approved, endorsed, or tested these modifications");
  });
});

describe("draws", () => {
  test("10,000 seeded development draws never return a holdout family", () => {
    const dev = new Set(plan.partitions.development);
    const rng = rngOf(1);
    for (let i = 0; i < 10_000; i++) expect(dev.has(sampleField(data, "development", {}, rng).family)).toBe(true);
  });

  test("no partition ever draws a blocked family, occupation or term", () => {
    const codes = new Set(plan.blocklist.occupations.map((o) => o.code));
    const fams = new Set(plan.blocklist.families);
    const term = new RegExp(plan.blocklist.terms.join("|"), "i");
    const rng = rngOf(2);
    for (const part of PARTITIONS) {
      for (let i = 0; i < 2_500; i++) {
        const t = sampleField(data, part, {}, rng);
        expect(codes.has(t.code) || fams.has(t.family) || term.test(t.task) || term.test(t.title)).toBe(false);
      }
    }
  });

  test("the blocklist runs before weighting: a family made all-blocked is never drawn, however empty", () => {
    const p = clone();
    // Block every occupation of family 43 by code.
    const codes43 = [...new Set([...data.byFamily.get("43")!].map((t) => t.code))];
    p.blocklist.occupations = [...p.blocklist.occupations, ...codes43.map((code) => ({ code, title: "" }))];
    const d = loadFieldData(tsv, p);
    const rng = rngOf(3);
    const coverage = { "13": 50, "41": 50, "25": 50, "27": 50 };
    for (let i = 0; i < 2_000; i++) expect(sampleField(d, "development", coverage, rng).family).not.toBe("43");
  });

  test("coverage weighting prefers an empty family", () => {
    const rng = rngOf(4);
    const coverage = { "43": 0, "13": 20, "41": 20, "25": 20, "27": 20 };
    let empty = 0;
    for (let i = 0; i < 10_000; i++) if (sampleField(data, "development", coverage, rng).family === "43") empty++;
    // Weights 1 vs 1/21 each: 43 gets 1 / (1 + 4/21) = ~84%.
    expect(empty / 10_000).toBeGreaterThan(0.8);
  });

  test("seeded: the same seed draws the same tasks", () => {
    const a = rngOf(9);
    const b = rngOf(9);
    for (let i = 0; i < 50; i++) expect(sampleField(data, "promotion", {}, a)).toEqual(sampleField(data, "promotion", {}, b));
  });
});

describe("the plan and the hash", () => {
  test("the data hash changes when the blocklist changes", () => {
    const p = clone();
    p.blocklist.terms = [...p.blocklist.terms, "\\bspreadsheet"];
    expect(loadFieldData(tsv, p).dataHash).not.toBe(data.dataHash);
  });

  test("a family in two partitions, a missing family, a blocked family placed, a bad pattern: refused at load", () => {
    const twice = clone();
    twice.partitions.promotion.push("43");
    const missing = clone();
    missing.partitions.transfer = missing.partitions.transfer.filter((f) => f !== "53");
    const placedBlocked = clone();
    placedBlocked.partitions.final.push("55");
    const badTerm = clone();
    badTerm.blocklist.terms.push("(");
    for (const p of [twice, missing, placedBlocked, badTerm]) expect(() => loadFieldData(tsv, p)).toThrow("field plan refused");
  });

  test("the family split is still the agent's draft until Darius signs it", () => {
    expect(plan.partitionsApprovedBy).toBeNull();
  });
});
