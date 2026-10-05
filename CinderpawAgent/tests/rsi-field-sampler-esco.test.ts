/**
 * The European source of the field sampler: ESCO v1.2.0, all languages.
 * Blocks hold in every language (they are on the occupation id), what the
 * owner allowed stays sampleable, the longest ISCO prefix decides the
 * partition, and an unplaced ISCO group refuses the load.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rngOf } from "../src/rsi/infra/fixtures.ts";
import { DATA_DIR, loadEscoData, readEscoExtract, sampleField, type FieldPlan } from "../src/rsi/research/field-sampler.ts";
import { PARTITIONS } from "../src/rsi/research/task-family.ts";

const tsv = readEscoExtract();
const plan = JSON.parse(readFileSync(join(DATA_DIR, "field-plan.json"), "utf8")) as FieldPlan;
const clone = (): FieldPlan => JSON.parse(JSON.stringify(plan));
const enRows = tsv
  .split("\n")
  .slice(1)
  .filter(Boolean)
  .map((r) => r.split("\t"))
  .filter((r) => r[2] === "en");
const idOf = (label: string) => enRows.find((r) => r[3] === label)![0]!;
const allIds = (d: ReturnType<typeof loadEscoData>) => new Set([...d.byFamily.values()].flat().map((t) => t.taskId));

const ro = loadEscoData(tsv, plan, ["ro"]);
const en = loadEscoData(tsv, plan, ["en"]);

describe("ESCO loads", () => {
  test("all 28 languages, every occupation placed or blocked", () => {
    const langs = [...new Set(tsv.split("\n").slice(1).filter(Boolean).map((r) => r.split("\t")[2]!))];
    expect(langs.length).toBe(28);
    const all = loadEscoData(tsv, plan, langs);
    const kept = [...all.byFamily.values()].reduce((s, l) => s + l.length, 0);
    expect(kept + all.blocked).toBe(3039 * 28);
  });

  test("a Romanian draw is in Romanian", () => {
    const t = sampleField(ro, "development", {}, rngOf(1));
    expect(t.language).toBe("ro");
    const enLabel = enRows.find((r) => r[0] === t.taskId)![3];
    expect(t.title).not.toBe(enLabel);
  });
});

describe("blocks hold in every language", () => {
  test("a label-blocked occupation, an id-blocked one and armed forces are absent in Romanian too", () => {
    const ids = allIds(ro);
    expect(ids.has(idOf("ethical hacker"))).toBe(false);
    expect(ids.has(idOf("gunsmith"))).toBe(false);
    expect([...ro.byFamily.values()].flat().some((t) => t.code.startsWith("0"))).toBe(false);
  });

  test("no partition draws a blocked occupation over 2,000 Romanian draws each", () => {
    const blocked = new Set([...plan.esco!.blockedOccupations.map((o) => o.id), idOf("ethical hacker"), idOf("microbiologist")]);
    const rng = rngOf(2);
    for (const part of PARTITIONS) {
      for (let i = 0; i < 2_000; i++) expect(blocked.has(sampleField(ro, part, {}, rng).taskId)).toBe(false);
    }
  });

  test("what the owner allowed stays: a school science teacher and an animal feed nutritionist", () => {
    const ids = allIds(en);
    expect(ids.has(idOf("science teacher secondary school"))).toBe(true);
    expect(ids.has(idOf("animal feed nutritionist"))).toBe(true);
  });
});

describe("the ESCO split", () => {
  test("the longest ISCO prefix decides: mathematicians (212) in promotion, not science (21) in final", () => {
    const math = [...en.byFamily.get("212")!];
    expect(math.length).toBeGreaterThan(0);
    expect(plan.esco!.partitions.promotion).toContain("212");
    expect([...(en.byFamily.get("21") ?? [])].some((t) => t.code.startsWith("212"))).toBe(false);
  });

  test("an ISCO group in no partition refuses the load", () => {
    const p = clone();
    p.esco!.partitions.transfer = p.esco!.partitions.transfer.filter((x) => x !== "9");
    expect(() => loadEscoData(tsv, p, ["en"])).toThrow("in no partition");
  });

  test("a language with no rows refuses the load; the hash moves with the languages", () => {
    expect(() => loadEscoData(tsv, plan, ["xx"])).toThrow("no rows");
    expect(loadEscoData(tsv, plan, ["en", "ro"]).dataHash).not.toBe(en.dataHash);
  });

  test("the ESCO split is signed by Darius (5 Oct 2026)", () => {
    expect(plan.esco!.partitionsApprovedBy).toEqual({ by: "Darius", date: "2026-10-05" });
  });
});
