/**
 * The skill library (competence plan §3.1): a procedure is induced from the
 * receipts of ONE condition, checked on held-out receipts of that condition,
 * refused otherwise, and retired (not deleted) when a counterexample comes.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillLibrary, induceProcedure } from "../src/memory/fractal/skill-library.ts";
import type { Attempt } from "../src/rsi/l3-code/experiment-selector.ts";

let clock = 0;
const r = (tool: string, condition: string, ok: boolean): Attempt => ({
  file: tool,
  rationale: condition,
  condition,
  verdict: ok ? "accept" : "reject",
  reason: ok ? "verified" : "verifier failed",
  ts: ++clock,
  observed: { accepted: ok, effect: ok ? 1 : null, cost: 1, failureClass: null },
});

const SIG = 'import "_" not found';

describe("induceProcedure", () => {
  test("the verified step becomes a procedure with its conditions and evidence", () => {
    // Two training tasks: the first cost 3 attempts, the second 1.
    const train = [r("bump-engine", SIG, false), r("add-missing-dep", SIG, false), r("fix-import-paths", SIG, true), r("fix-import-paths", SIG, true)];
    const heldOut = [r("fix-import-paths", SIG, true)];
    const out = induceProcedure({ train, heldOut, verifiedBy: "checkRepo", methodVersion: "m0.2" });
    expect(out.skill).not.toBeNull();
    const s = out.skill!;
    expect(s.steps).toEqual([{ tool: "fix-import-paths" }]);
    expect(s.conditions.condition).toBe(SIG);
    expect(s.evidence.supporting).toHaveLength(2);
    expect(s.evidence.heldOut).toHaveLength(1);
    expect(s.costBefore).toBe(2); // (3 + 1) / 2
  });

  test("refused: no held-out, nothing verified, a held-out counterexample, mixed conditions", () => {
    const ok = [r("fix-import-paths", SIG, true)];
    expect(induceProcedure({ train: ok, heldOut: [], verifiedBy: "v", methodVersion: "m" }).skill).toBeNull();
    expect(
      induceProcedure({ train: [r("bump-engine", SIG, false)], heldOut: ok, verifiedBy: "v", methodVersion: "m" }).skill,
    ).toBeNull();
    const counter = induceProcedure({ train: ok, heldOut: [r("fix-import-paths", SIG, false)], verifiedBy: "v", methodVersion: "m" });
    expect(counter.skill).toBeNull();
    expect((counter as { reason: string }).reason).toContain("refused on a held-out task");
    const mixed = induceProcedure({ train: ok, heldOut: [r("fix-import-paths", "other", true)], verifiedBy: "v", methodVersion: "m" });
    expect((mixed as { reason: string }).reason).toContain("one condition");
  });
});

describe("SkillLibrary", () => {
  test("survives a restart, looks up by exact condition, and retires without deleting", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-"));
    try {
      const file = join(dir, "learned.jsonl");
      const { skill } = induceProcedure({
        train: [r("fix-import-paths", SIG, true)],
        heldOut: [r("fix-import-paths", SIG, true)],
        verifiedBy: "checkRepo",
        methodVersion: "m0.2",
      }) as { skill: NonNullable<ReturnType<typeof induceProcedure>["skill"]> };

      const a = new SkillLibrary(file);
      expect(a.add(skill).added).toBe(true);
      expect(a.add(skill).added).toBe(false);
      expect(a.lookup(SIG)?.steps[0]?.tool).toBe("fix-import-paths");
      expect(a.lookup("something else")).toBeNull();

      const b = new SkillLibrary(file);
      expect(b.lookup(SIG)?.id).toBe(skill.id);
      expect(b.retire(skill.id, "verifier failed on a new repo", "fix-import-paths@99")).toBe(true);
      expect(b.lookup(SIG)).toBeNull();
      // Two lines on disk: the skill and its retirement. Nothing removed.
      expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
      expect(new SkillLibrary(file).list()[0]?.retired?.reason).toContain("verifier failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
