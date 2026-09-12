import { describe, it, expect } from "bun:test";
import { collapseIdentical, normaliseForCollapse } from "../src/memory/fractal/cross-session-dedup.ts";

const L = (id: number, text: string) => ({ id, text, ts: id * 1000 });

describe("collapseIdentical", () => {
  it("folds fifteen identical lines into one survivor, the earliest", () => {
    const leaves = Array.from({ length: 15 }, (_, i) => L(15 - i, "tool shell_exec ok: bun test"));
    const r = collapseIdentical(leaves);
    expect(r.survivors.map((l) => l.id)).toEqual([1]);
    expect(r.hitCount.get(1)).toBe(15);
    expect(r.groups.get(1)).toHaveLength(15);
  });
  it("ignores timestamps, long numbers and case, not words", () => {
    expect(normaliseForCollapse("saved at 2026-09-12T10:00:00Z id 123456789"))
      .toBe(normaliseForCollapse("Saved  at 2026-09-13 11:30:00 id 987654321"));
    const r = collapseIdentical([L(1, "deploy to staging"), L(2, "deploy to production")]);
    expect(r.survivors).toHaveLength(2);
  });
  it("uses cosine when vectors are present", () => {
    const a = { id: 1, text: "x", vec: [1, 0] };
    const b = { id: 2, text: "y", vec: [0.999, 0.0447] };
    const c = { id: 3, text: "z", vec: [0, 1] };
    const r = collapseIdentical([a, b, c]);
    expect(r.survivors.map((l) => l.id)).toEqual([1, 3]);
    expect(r.groups.get(1)).toEqual([1, 2]);
  });
  it("leaves an empty list alone", () => {
    expect(collapseIdentical([]).survivors).toEqual([]);
  });
});
