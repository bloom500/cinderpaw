import { describe, expect, it } from "bun:test";
import { alnLabel, nullJaccard, typeConsensus } from "../src/brain-substrate/bench/labels.ts";

describe("G2 ALLN label rule", () => {
  it("literature beats prediction, first named transmitter wins", () => {
    expect(alnLabel("acetylcholine", "serotonin", 0.29)).toBe(1);
    expect(alnLabel("gaba, MIP; acetylcholine-negative", "acetylcholine", 0.9)).toBe(-1);
  });
  it("a confident prediction is kept, an unconfident one is uncertain", () => {
    expect(alnLabel("", "glutamate", 0.5)).toBe(-1);
    expect(alnLabel("", "dopamine", 0.8)).toBe(1);
    expect(alnLabel("", "gaba", 0.49)).toBe("uncertain");
    expect(alnLabel("", "gaba", Number.NaN)).toBe("uncertain");
  });
  it("null Jaccard of full-population sets is 1, of tiny sets from a big population near 0", () => {
    expect(nullJaccard([5, 5], [0, 1, 2, 3, 4], 10, 1)).toBe(1);
    expect(nullJaccard([2, 2, 2], Array.from({ length: 1000 }, (_, i) => i), 50, 1)).toBeLessThan(0.02);
  });
});

describe("G2-X type consensus", () => {
  const c = (type: string, top: string, conf = 0.3, known = "") => ({ type, top, conf, known });
  it("majority of the type decides an uncertain cell, confident cells keep their own label", () => {
    expect(typeConsensus([c("A", "gaba"), c("A", "gaba"), c("A", "acetylcholine"), c("A", "gaba"), c("A", "acetylcholine", 0.9)])).toEqual([-1, -1, -1, -1, 1]);
  });
  it("a literature label anywhere in the type wins, ties and untyped cells stay uncertain", () => {
    expect(typeConsensus([c("B", "serotonin"), c("B", "gaba", 0.2, "acetylcholine")])).toEqual([1, 1]);
    expect(typeConsensus([c("C", "gaba"), c("C", "dopamine"), c("", "gaba")])).toEqual(["uncertain", "uncertain", "uncertain"]);
  });
});
