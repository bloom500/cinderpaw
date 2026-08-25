import { describe, expect, it } from "vitest";
import { induceReusableSkill } from "../src/memory/fractal/skill-induction.js";

describe("Skill Induction Module for RAPTOR", () => {
  it("induces reusable skill and appends to RAPTOR skills store", () => {
    const code = "function solve(I) { return DSL.rotate(I, 90); }";
    const skill = induceReusableSkill(
      code,
      "Rotate grid 90 degrees clockwise",
      "/tmp/raptor_skills_test.jsonl"
    );

    expect(skill.id).toContain("skill-");
    expect(skill.programCode).toBe(code);
    expect(skill.description).toContain("Rotate grid");
  });

  it("throws error for invalid non-compiling skill code", () => {
    const invalidCode = "function solve(I) { return DSL.rotate(I, ; }";
    expect(() =>
      induceReusableSkill(invalidCode, "Invalid", "/tmp/raptor_skills_test.jsonl")
    ).toThrow("failed to compile");
  });
});
