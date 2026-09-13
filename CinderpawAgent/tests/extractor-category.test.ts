import { describe, it, expect } from "bun:test";
import { sanitizeFact, splitFactLine } from "../src/memory/extractor.ts";

const parse = (line: string) => {
  const l = splitFactLine(line);
  return l ? sanitizeFact(l.rawKey, l.rawValue) : null;
};

describe("fact category", () => {
  it("reads `category | key: value`", () => {
    expect(parse("preference | units: metric")).toEqual({ key: "units", value: "metric", category: "preference" });
  });
  it("keeps reading the old `key: value` form as a fact", () => {
    expect(parse("occupation: nurse")).toMatchObject({ key: "occupation", category: "fact" });
  });
  it("never invents a category", () => {
    expect(parse("vibe | mood: good")!.category).toBe("fact");
  });
  it("does not mistake a pipe inside the value for a category", () => {
    expect(parse("shell: bash | zsh")).toMatchObject({ key: "shell", value: "bash | zsh", category: "fact" });
  });
  it("still drops a line with no colon", () => {
    expect(splitFactLine("just some prose")).toBeNull();
  });
});
