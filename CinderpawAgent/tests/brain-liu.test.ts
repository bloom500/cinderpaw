import { describe, expect, it } from "bun:test";
import { LIU_VM7, liuInitial, liuSteadyState, liuStep } from "../src/brain-substrate/al-rate/liu2021.ts";

describe("Liu et al. 2021 glomerulus", () => {
  it("settles on Equation 12 for a constant input", () => {
    let s = liuInitial();
    for (let i = 0; i < 60000; i++) s = liuStep(s, LIU_VM7, 50, 150, 1e-4);
    expect(Math.abs(s.rPN - liuSteadyState(LIU_VM7, 50, 150)) / liuSteadyState(LIU_VM7, 50, 150)).toBeLessThan(0.01);
  });
  it("more public input means a weaker PN response (divisive normalization)", () => {
    expect(liuSteadyState(LIU_VM7, 50, 550)).toBeLessThan(liuSteadyState(LIU_VM7, 50, 50));
  });
});
