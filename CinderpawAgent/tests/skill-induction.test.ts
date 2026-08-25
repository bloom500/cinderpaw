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

import { defaultSinkPath, induceReusableSkill, JsonlSkillSink } from "../src/memory/fractal/skill-induction.ts";

const GOOD_PROGRAM = "(g) => rotate(g, 90)";
const DESCRIPTION = "Rotate grid 90 degrees clockwise";

function tmpSink(): JsonlSkillSink {
  return new JsonlSkillSink(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "skills-")), "raptor-skills.jsonl"));
}

describe("induceReusableSkill", () => {
  test("converts a verified DSL program into a persisted reusable skill", async () => {
    const sink = tmpSink();
    const { skill, savedTo, duplicated } = await induceReusableSkill(GOOD_PROGRAM, DESCRIPTION, {
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
    expect(skill.verificationStatus).toBe("fully-verified");

    const lines = fs.readFileSync(savedTo, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).id).toBe(skill.id);
  }, 15000);

  test("deterministic content-hash id; same induction deduplicates without rewriting", async () => {
    const sink = tmpSink();
    const first = await induceReusableSkill(GOOD_PROGRAM, DESCRIPTION, { sink });
    const second = await induceReusableSkill(GOOD_PROGRAM, DESCRIPTION, { sink });
    expect(first.skill.id).toBe(second.skill.id);
    expect(first.duplicated).toBe(false);
    expect(second.duplicated).toBe(true);
    const lines = fs.readFileSync(first.savedTo, "utf8").trim().split("\n");
    expect(lines.length).toBe(1); // never written twice
  }, 15000);

  test("different descriptions → different skills (code alone does not decide identity)", async () => {
    const sink = tmpSink();
    const a = await induceReusableSkill(GOOD_PROGRAM, "Task A", { sink });
    const b = await induceReusableSkill(GOOD_PROGRAM, "Task B", { sink });
    expect(a.skill.id).not.toBe(b.skill.id);
    expect(b.duplicated).toBe(false);
  }, 15000);

  test("refuses code that does not compile against the DSL scope", async () => {
    const sink = tmpSink();
    await expect(induceReusableSkill("(g => broken", "bad task", { sink })).rejects.toThrow(
      /refusing to induce a non-runnable skill/,
    );
    expect(fs.existsSync(sink.filePath)).toBe(false);
  }, 15000);

  test("loud on empty inputs", async () => {
    const sink = tmpSink();
    await expect(induceReusableSkill("", "desc", { sink })).rejects.toThrow(
      /verifiedProgramCode must be a non-empty string/,
    );
    await expect(induceReusableSkill(GOOD_PROGRAM, "", { sink })).rejects.toThrow(
      /taskDescription must be a non-empty string/,
    );
  }, 15000);

  test("works with a minimal custom sink that has no has()/describe()", async () => {
    const stored = [];
    const { savedTo, duplicated } = await induceReusableSkill(GOOD_PROGRAM, "minimal sink task", {
      sink: { append: async (skill) => void stored.push(skill) },
    });
    expect(stored.length).toBe(1);
    expect(duplicated).toBe(false);
    expect(savedTo).toBe("<custom-sink>");
  }, 15000);

  test("default sink path follows the ~/.cinderpaw fractal convention", () => {
    const p = defaultSinkPath();
    expect(p.endsWith(path.join(".cinderpaw", "agent", "raptor-skills.jsonl"))).toBe(true);
  });

  test("tolerates a torn line in the sink file during dedup scan", async () => {
    const sink = tmpSink();
    fs.writeFileSync(sink.filePath, "{corrupt json\n", "utf8");
    const { duplicated } = await induceReusableSkill(GOOD_PROGRAM, "torn-line task", { sink });
    expect(duplicated).toBe(false);
  }, 15000);
});
