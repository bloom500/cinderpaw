import { expect, test } from "bun:test";
import { fkGrade, syllables } from "./readability";
import { COPY } from "./copy";

test("syllables are counted the plain way", () => {
  expect(syllables("cat")).toBe(1);
  expect(syllables("computer")).toBe(3);
  expect(syllables("make")).toBe(1);
  expect(syllables("the")).toBe(1);
  expect(syllables("OpenRouter")).toBe(1); // a name, not vocabulary
});

test("simple sentences score low, dense ones high", () => {
  expect(fkGrade("The cat sat on the mat.")).toBeLessThan(2);
  expect(fkGrade("Authentication credentials necessitate verification procedures.")).toBeGreaterThan(12);
});

// Spec 2026-09-24 §8.4: every string a person reads is grade 6 or below.
function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (typeof v === "function") return strings((v as (...a: string[]) => unknown)("Ana", "OpenRouter"));
  if (v && typeof v === "object") return Object.values(v).flatMap(strings);
  return [];
}

test("every line of the onboarding reads at grade 6 or below", () => {
  const all = strings(COPY);
  expect(all.length).toBeGreaterThan(15);
  const hard = all.filter((s) => fkGrade(s) > 6).map((s) => `${fkGrade(s).toFixed(1)}  ${s}`);
  expect(hard).toEqual([]);
});
