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
  appendAttempt,
  readAttempts,
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
