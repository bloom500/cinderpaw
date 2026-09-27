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
  it("ignores timestamps and case, not words", () => {
    expect(normaliseForCollapse("saved at 2026-09-12T10:00:00Z at 1790000000000"))
      .toBe(normaliseForCollapse("Saved  at 2026-09-13 11:30:00 at 1790000123456"));
    const r = collapseIdentical([L(1, "deploy to staging"), L(2, "deploy to production")]);
    expect(r.survivors).toHaveLength(2);
  });
  // An order number, an amount, a port: the number IS the memory, and an
  // embedding barely sees it. Folding it merged two orders into one leaf and
  // the second order number was gone from the semantic path.
  it("keeps two lines that differ only in a number apart", () => {
    const r = collapseIdentical([L(1, "order 123456 shipped"), L(2, "order 654321 shipped")]);
    expect(r.survivors).toHaveLength(2);
  });
  it("does not let near-identical vectors merge different numbers", () => {
    const a = { id: 1, text: "I paid 50 lei for parking", vec: [1, 0] };
    const b = { id: 2, text: "I paid 80 lei for parking", vec: [0.999, 0.0447] };
    expect(collapseIdentical([a, b]).survivors).toHaveLength(2);
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
