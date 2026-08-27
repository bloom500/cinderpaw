/**
 * skill-induction.test.ts — verified DSL program → RAPTOR skill layer.
 * Runner-agnostic (bun:test → vitest fallback).
 */

interface RunnerLike {
  describe: (name: string, fn: () => void) => void;
  test: (name: string, fn: () => void | Promise<void>) => void;
  // biome-ignore lint/suspicious/noExplicitAny: structural runner typing
  expect: any;
}

async function loadRunner(): Promise<RunnerLike> {
  try {
    const mod = await import("bun:test");
    return { describe: mod.describe, test: mod.test, expect: mod.expect };
  } catch {
    const mod = await import("./_runner-vitest.ts");
    return { describe: mod.describe, test: mod.test ?? mod.it, expect: mod.expect };
  }
}

const { describe, test, expect } = await loadRunner();

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertUsableEvidence, assertValidRunId, defaultSinkPath, induceReusableSkill, JsonlSkillSink } from "../src/memory/fractal/skill-induction.ts";
import { feralHome } from "../src/config.ts";

const GOOD_PROGRAM = "(g) => rotate(g, 90)";
const DESCRIPTION = "Rotate grid 90 degrees clockwise";

function tmpSink(): JsonlSkillSink {
  return new JsonlSkillSink(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "skills-")), "raptor-skills.jsonl"));
}

const RUN = "test-run";
const EV = { trainPairs: 2, heldOutPairs: 1, heldOutPassed: true };

describe("induceReusableSkill", () => {
  test("converts a verified DSL program into a persisted reusable skill", async () => {
    const sink = tmpSink();
    const { skill, savedTo, duplicated } = await induceReusableSkill(GOOD_PROGRAM, DESCRIPTION, {
      runId: RUN,
      evidence: EV,
      sink,
      now: new Date("2026-08-25T00:00:00Z"),
    });
    expect(duplicated).toBe(false);
    expect(savedTo).toContain("raptor-skills.jsonl");
    expect(skill.id).toMatch(/^skill-[0-9a-f]{8}$/);
    expect(skill.name).toBe("rotate-grid-90-degrees-clockwise");
    expect(skill.programCode).toBe(GOOD_PROGRAM);
    expect(skill.description).toBe(DESCRIPTION);
    expect(skill.inducedAt).toBe("2026-08-25T00:00:00.000Z");
    expect(skill.source).toBe("mcts-verifier");
    expect(skill.verificationStatus).toBe("held-out-verified");
    expect(skill.runId).toBe(RUN);

    const lines = fs.readFileSync(savedTo, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).id).toBe(skill.id);
  }, 15000);

  test("deterministic content-hash id; same induction deduplicates without rewriting", async () => {
    const sink = tmpSink();
    const first = await induceReusableSkill(GOOD_PROGRAM, DESCRIPTION, { sink, runId: RUN, evidence: EV });
    const second = await induceReusableSkill(GOOD_PROGRAM, DESCRIPTION, { sink, runId: RUN, evidence: EV });
    expect(first.skill.id).toBe(second.skill.id);
    expect(first.duplicated).toBe(false);
    expect(second.duplicated).toBe(true);
    const lines = fs.readFileSync(first.savedTo, "utf8").trim().split("\n");
    expect(lines.length).toBe(1); // never written twice
  }, 15000);

  test("different descriptions → different skills (code alone does not decide identity)", async () => {
    const sink = tmpSink();
    const a = await induceReusableSkill(GOOD_PROGRAM, "Task A", { sink, runId: RUN, evidence: EV });
    const b = await induceReusableSkill(GOOD_PROGRAM, "Task B", { sink, runId: RUN, evidence: EV });
    expect(a.skill.id).not.toBe(b.skill.id);
    expect(b.duplicated).toBe(false);
  }, 15000);

  test("refuses code that does not compile against the DSL scope", async () => {
    const sink = tmpSink();
    await expect(induceReusableSkill("(g => broken", "bad task", { sink, runId: RUN, evidence: EV })).rejects.toThrow(
      /refusing to induce a non-runnable skill/,
    );
    expect(fs.existsSync(sink.filePath)).toBe(false);
  }, 15000);

  test("loud on empty inputs", async () => {
    const sink = tmpSink();
    await expect(induceReusableSkill("", "desc", { sink, runId: RUN, evidence: EV })).rejects.toThrow(
      /verifiedProgramCode must be a non-empty string/,
    );
    await expect(induceReusableSkill(GOOD_PROGRAM, "", { sink, runId: RUN, evidence: EV })).rejects.toThrow(
      /taskDescription must be a non-empty string/,
    );
  }, 15000);

  test("works with a minimal custom sink that has no has()/describe()", async () => {
    const stored = [];
    const { savedTo, duplicated } = await induceReusableSkill(GOOD_PROGRAM, "minimal sink task", {
      runId: RUN,
      evidence: EV,
      sink: { append: async (skill) => void stored.push(skill) },
    });
    expect(stored.length).toBe(1);
    expect(duplicated).toBe(false);
    expect(savedTo).toBe("<custom-sink>");
  }, 15000);

  test("default sink path is scoped to the run, inside the agent's own home", () => {
    const p = defaultSinkPath(RUN);
    expect(p.endsWith(path.join("agent", "runs", RUN, "raptor-skills.jsonl"))).toBe(true);
    // Not homedir() directly: an isolated profile (CINDERPAW_HOME) must not write
    // its induced skills into the real profile's directory.
    expect(p.startsWith(feralHome())).toBe(true);
    // Two runs must never resolve to the same file — that IS the isolation.
    expect(defaultSinkPath("run-a")).not.toBe(defaultSinkPath("run-b"));
  });

  // ---- ISOLATION CONTRACT (INV-F) ----------------------------------------
  // These are the regression tests for the contamination channel: a skill
  // induced in one episode must not be reachable from the next by default.

  test("refuses to induce without a runId — there is no unscoped default", async () => {
    const sink = tmpSink();
    // @ts-expect-error deliberately omitting the required runId
    await expect(induceReusableSkill(GOOD_PROGRAM, DESCRIPTION, { sink, evidence: EV })).rejects.toThrow(
      /runId/,
    );
    // and nothing was written on the way to failing
    expect(fs.existsSync(sink.filePath)).toBe(false);
  }, 15000);

  test("refuses a runId that would escape the run directory", () => {
    expect(() => assertValidRunId("../../etc")).toThrow(/path-safe/);
    expect(() => assertValidRunId("run/nested")).toThrow(/path-safe/);
    expect(() => assertValidRunId("..")).toThrow(/path-safe/);
    expect(() => assertValidRunId("")).toThrow(/non-empty/);
    expect(() => assertValidRunId(undefined)).toThrow(/non-empty/);
    // the shapes a real run id takes must keep working
    expect(() => assertValidRunId("arc_2026-08-26.run-3")).not.toThrow();
  });

  test("the same skill in two runs lands in two files and carries its runId", async () => {
    const a = new JsonlSkillSink(
      path.join(fs.mkdtempSync(path.join(os.tmpdir(), "skills-a-")), "raptor-skills.jsonl"),
    );
    const b = new JsonlSkillSink(
      path.join(fs.mkdtempSync(path.join(os.tmpdir(), "skills-b-")), "raptor-skills.jsonl"),
    );
    const first = await induceReusableSkill(GOOD_PROGRAM, DESCRIPTION, { sink: a, runId: "ep-1", evidence: EV });
    const second = await induceReusableSkill(GOOD_PROGRAM, DESCRIPTION, { sink: b, runId: "ep-2", evidence: EV });
    // Same content ⇒ same identity, but episode 2 did NOT see episode 1's
    // file, so it is not a duplicate — no carry-over happened.
    expect(second.skill.id).toBe(first.skill.id);
    expect(second.duplicated).toBe(false);
    expect(first.skill.runId).toBe("ep-1");
    expect(second.skill.runId).toBe("ep-2");
  }, 15000);

  test("tolerates a torn line in the sink file during dedup scan", async () => {
    const sink = tmpSink();
    fs.writeFileSync(sink.filePath, "{corrupt json\n", "utf8");
    const { duplicated } = await induceReusableSkill(GOOD_PROGRAM, "torn-line task", { sink, runId: RUN, evidence: EV });
    expect(duplicated).toBe(false);
  }, 15000);
});

describe("evidence gate (R1 — the claim carries its proof)", () => {
  test("a skill measured against held-out data is labelled held-out-verified", async () => {
    const sink = tmpSink();
    const { skill } = await induceReusableSkill(GOOD_PROGRAM, "generalizing task", {
      sink,
      runId: RUN,
      evidence: { trainPairs: 3, heldOutPairs: 2, heldOutPassed: true },
    });
    expect(skill.verificationStatus).toBe("held-out-verified");
    expect(skill.evidence).toEqual({ trainPairs: 3, heldOutPairs: 2 });
  }, 15000);

  test("no held-out data means train-only, never a verified label", async () => {
    const sink = tmpSink();
    const { skill } = await induceReusableSkill(GOOD_PROGRAM, "unmeasured task", {
      sink,
      runId: RUN,
      evidence: { trainPairs: 3, heldOutPairs: 0, heldOutPassed: false },
    });
    // The old code hardcoded "fully-verified" here. That was the lie.
    expect(skill.verificationStatus).toBe("train-only");
  }, 15000);

  test("REFUSES a program that failed held-out verification", async () => {
    const sink = tmpSink();
    await expect(
      induceReusableSkill(GOOD_PROGRAM, "overfitted task", {
        sink,
        runId: RUN,
        evidence: { trainPairs: 3, heldOutPairs: 2, heldOutPassed: false },
      }),
    ).rejects.toThrow(/FAILED held-out/);
    // and nothing reached the memory tree on the way out
    expect(fs.existsSync(sink.filePath)).toBe(false);
  }, 15000);

  test("loud on missing or nonsensical evidence", () => {
    expect(() => assertUsableEvidence(undefined)).toThrow(/evidence is required/);
    expect(() => assertUsableEvidence({ trainPairs: 0, heldOutPairs: 0, heldOutPassed: false }))
      .toThrow(/trainPairs must be ≥ 1/);
    expect(() => assertUsableEvidence({ trainPairs: 2, heldOutPairs: -1, heldOutPassed: false }))
      .toThrow(/heldOutPairs/);
    expect(() => assertUsableEvidence({ trainPairs: 2, heldOutPairs: 1 }))
      .toThrow(/heldOutPassed/);
  });
});
