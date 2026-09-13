/**
 * The M0 experiment selector: the first hand-written learner of the
 * recursive-learning spec (S3). It replaces `rng()` as the thing that decides
 * what L3 tries next, using nothing but the ledger of past attempts.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_STRIKES,
  RECEIPT_TAG,
  appendAttempt,
  attemptsFromEpisodes,
  mergeAttempts,
  readAttempts,
  receiptLine,
  selectExperiment,
  type Attempt,
} from "../src/rsi/l3-code/experiment-selector.ts";

const at = (file: string, verdict: Attempt["verdict"], ts: number, rationale = "r"): Attempt => ({
  file,
  rationale,
  verdict,
  reason: verdict === "accept" ? "ok" : "suite failed",
  ts,
});

const FILES = ["l1-config/mutation.ts", "l1-config/fitness-shim.ts", "l4-modules/seam-adapter.ts"];

describe("selectExperiment (M0)", () => {
  test("a file never tried goes first, ties broken by rng", () => {
    const attempts = [at("l1-config/mutation.ts", "reject", 10)];
    const pick = selectExperiment(FILES, attempts, () => 0);
    expect(pick?.target).toBe("l1-config/fitness-shim.ts");
    const pick2 = selectExperiment(FILES, attempts, () => 0.99);
    expect(pick2?.target).toBe("l4-modules/seam-adapter.ts");
  });

  test("when every file was tried, the least recently tried one is next", () => {
    const attempts = [
      at("l1-config/mutation.ts", "reject", 30),
      at("l1-config/fitness-shim.ts", "accept", 10),
      at("l4-modules/seam-adapter.ts", "reject", 20),
    ];
    expect(selectExperiment(FILES, attempts, () => 0)?.target).toBe("l1-config/fitness-shim.ts");
  });

  test(`${MAX_STRIKES} rejections in a row take a file out of the pool; one accept resets it`, () => {
    const struck = Array.from({ length: MAX_STRIKES }, (_, i) => at("l1-config/mutation.ts", "reject", i + 1));
    const others = [at("l1-config/fitness-shim.ts", "reject", 50), at("l4-modules/seam-adapter.ts", "reject", 60)];
    // mutation.ts is the least recently tried, but it is struck out.
    expect(selectExperiment(FILES, [...struck, ...others], () => 0)?.target).toBe("l1-config/fitness-shim.ts");
    // An accept after the strikes clears them: with the other two struck
    // out too, mutation.ts is offered again instead of null.
    const othersStruck = FILES.slice(1).flatMap((f) =>
      Array.from({ length: MAX_STRIKES }, (_, i) => at(f, "reject", 50 + i)),
    );
    const reset = [...struck, at("l1-config/mutation.ts", "accept", 4), ...othersStruck];
    expect(selectExperiment(FILES, reset, () => 0)?.target).toBe("l1-config/mutation.ts");
  });

  test("returns null when every file is struck out", () => {
    const struck = FILES.flatMap((f) => Array.from({ length: MAX_STRIKES }, (_, i) => at(f, "halt", i)));
    expect(selectExperiment(FILES, struck, () => 0)).toBeNull();
  });

  test("the brief names the rejected rationales on the chosen file, newest first", () => {
    const attempts = [
      at("l1-config/mutation.ts", "reject", 1, "inline the helper"),
      at("l1-config/mutation.ts", "reject", 2, "drop the clamp"),
      at("l1-config/fitness-shim.ts", "reject", 3, "unrelated"),
      at("l1-config/fitness-shim.ts", "reject", 5, "unrelated"),
      at("l4-modules/seam-adapter.ts", "reject", 4, "unrelated"),
      at("l4-modules/seam-adapter.ts", "reject", 6, "unrelated"),
    ];
    // Same rounds everywhere, mutation.ts least recently tried.
    const pick = selectExperiment(FILES, attempts, () => 0);
    expect(pick?.target).toBe("l1-config/mutation.ts");
    expect(pick?.brief).toContain("drop the clamp");
    expect(pick?.brief).toContain("inline the helper");
    expect(pick?.brief.indexOf("drop the clamp")).toBeLessThan(pick!.brief.indexOf("inline the helper"));
    expect(pick?.brief).not.toContain("unrelated");
  });
});

describe("attempt ledger", () => {
  test("round-trips, tolerates a missing file and a torn line", () => {
    const dir = mkdtempSync(join(tmpdir(), "rsi-attempts-"));
    try {
      const path = join(dir, "code-attempts.jsonl");
      expect(readAttempts(path)).toEqual([]);
      appendAttempt(path, at("a.ts", "reject", 1));
      appendAttempt(path, at("b.ts", "accept", 2));
      require("node:fs").appendFileSync(path, '{"file":"c.ts","torn":');
      expect(readAttempts(path).map((a) => a.file)).toEqual(["a.ts", "b.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("receipts in FMS (BRSI reads FMS)", () => {
  const full = (file: string, verdict: Attempt["verdict"], ts: number): Attempt => ({
    ...at(file, verdict, ts, "idea"),
    predicted: { pAccept: 0.4, expectedEffect: 1, expectedCost: 10, failureClass: null, missing: null },
    observed: { accepted: verdict === "accept", effect: null, cost: 12, failureClass: null },
  });

  test("a receipt round-trips through an episode line, human half intact", () => {
    const a = full("l1-config/mutation.ts", "reject", 5);
    const line = receiptLine(a);
    expect(line.split("\n")[0]).toBe('[rsi-l3] reject on l1-config/mutation.ts: "idea" (suite failed)');
    expect(attemptsFromEpisodes([{ content: line }])).toEqual([a]);
  });

  test("lines from before receipts, and a torn tail, are skipped without throwing", () => {
    const rows = [
      { content: '[rsi-l3] reject on x.ts: "old" (suite failed)' },
      { content: `${RECEIPT_TAG} {"file":"x.ts","verdict":"rej` },
      { content: receiptLine(full("y.ts", "accept", 9)) },
    ];
    expect(attemptsFromEpisodes(rows).map((a) => a.file)).toEqual(["y.ts"]);
  });

  test("with the jsonl gone, M0 still knows what was refused, from FMS alone", () => {
    const fromFms = attemptsFromEpisodes([
      { content: receiptLine(full("l1-config/mutation.ts", "reject", 1)) },
      { content: receiptLine(full("l1-config/mutation.ts", "reject", 2)) },
      { content: receiptLine(full("l1-config/mutation.ts", "reject", 3)) },
    ]);
    const merged = mergeAttempts(fromFms, readAttempts(join(tmpdir(), "does-not-exist.jsonl")));
    // Three strikes from FMS alone take the file out of the pool.
    expect(selectExperiment(["l1-config/mutation.ts"], merged, () => 0)).toBeNull();
  });

  test("the same round in both sources is one row", () => {
    const a = full("a.ts", "reject", 7);
    expect(mergeAttempts([a], [structuredClone(a)])).toHaveLength(1);
  });

  test("a verdict with no observation is shown to the proposer as a claim", () => {
    const claim = at("l1-config/mutation.ts", "reject", 1, "unverified idea");
    const verified = full("l1-config/mutation.ts", "reject", 2);
    const pick = selectExperiment(["l1-config/mutation.ts"], [claim, verified], () => 0);
    expect(pick?.brief).toContain('"unverified idea" (reject: suite failed) [claimed, not verified]');
    expect(pick?.brief).toContain('"idea" (reject: suite failed)\n');
    expect(pick?.brief).not.toContain('"idea" (reject: suite failed) [claimed');
  });
});
