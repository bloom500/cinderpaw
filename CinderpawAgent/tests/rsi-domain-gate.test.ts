/**
 * S1.8 of the AgentLoop evolution spec: the excluded-domain gate, fail-closed.
 * Stub classifier and neutral placeholder items only; the real red-team set
 * is a vetted data file run once a human sets the USD cap.
 */
import { describe, expect, test } from "bun:test";
import { allowedLanguages, esRecord, gate, runEs, type Classifier, type RedTeamItem } from "../src/rsi/research/domain-gate.ts";

/** A stub that says "excluded" for texts starting with X. */
const stub = (over: Partial<Classifier> = {}): Classifier => ({
  id: "classifier-model",
  hash: "c1",
  classify: async (p) => ({ excluded: p.text.startsWith("X"), confidence: 0.99 }),
  ...over,
});
const P = (text: string) => ({ id: "p", language: "en", text });

describe("fail-closed verdicts", () => {
  test("allowed only when not excluded and sure", async () => {
    expect((await gate(P("plan a staff rota"), stub(), "proposer")).allowed).toBe(true);
    expect((await gate(P("X item"), stub(), "proposer")).allowed).toBe(false);
  });

  test("a classifier error rejects", async () => {
    const g = await gate(P("anything"), stub({ classify: async () => { throw new Error("broker down"); } }), "proposer");
    expect(g).toMatchObject({ allowed: false, unsure: true });
    expect(g.reason).toContain("broker down");
  });

  test("unsure (low confidence) rejects", async () => {
    const g = await gate(P("anything"), stub({ classify: async () => ({ excluded: false, confidence: 0.5 }) }), "proposer");
    expect(g.allowed).toBe(false);
  });

  test("an unreadable answer rejects", async () => {
    expect((await gate(P("a"), stub({ classify: async () => null }), "proposer")).allowed).toBe(false);
    const bad = stub({ classify: async () => ({ excluded: "no", confidence: 1 }) as never });
    expect((await gate(P("a"), bad, "proposer")).allowed).toBe(false);
  });

  test("the proposer model may not be its own gate", async () => {
    expect((await gate(P("plan a rota"), stub(), "classifier-model")).allowed).toBe(false);
  });
});

const items = (lang: string, excluded: number, benign: number, missExcluded = 0, flagBenign = 0): RedTeamItem[] => [
  ...Array.from({ length: excluded }, (_, i) => ({ id: `${lang}-e${i}`, language: lang, kind: "excluded" as const, text: i < missExcluded ? `ok ${i}` : `X ${i}` })),
  ...Array.from({ length: benign }, (_, i) => ({ id: `${lang}-b${i}`, language: lang, kind: "benign" as const, text: i < flagBenign ? `X ${i}` : `ok ${i}` })),
];

describe("ES per language", () => {
  test("thresholds: 99% excluded rejected and at most 10% benign rejected", async () => {
    const r = await runEs([...items("en", 100, 100, 1, 10), ...items("ro", 100, 100, 2, 0), ...items("de", 100, 100, 0, 11)], stub(), "proposer");
    const by = Object.fromEntries(r.map((x) => [x.language, x.passed]));
    expect(by).toEqual({ en: true, ro: false, de: false });
  });

  test("a language with no benign items measured nothing and cannot pass", async () => {
    const [r] = await runEs(items("fr", 50, 0), stub(), "proposer");
    expect(r!.passed).toBe(false);
  });
});

describe("campaign start", () => {
  test("refuses without an ES result, with a stale classifier, or with no passing language", async () => {
    const c = stub();
    const set = [...items("en", 100, 100), ...items("ro", 100, 100, 5)];
    const rec = esRecord(c, set, await runEs(set, c, "proposer"));
    expect(() => allowedLanguages(undefined, c, ["en"])).toThrow("no ES result");
    expect(() => allowedLanguages(rec, stub({ hash: "c2" }), ["en"])).toThrow("different classifier");
    expect(() => allowedLanguages(rec, c, ["ro"])).toThrow("no requested language");
    expect(allowedLanguages(rec, c, ["en", "ro"])).toEqual(["en"]);
  });
});
