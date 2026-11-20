/**
 * Spill (4 Nov, DeepSeek Harness comparison): a result too big for the context
 * goes to a file; the model keeps the start, the end and the path.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPILL_AT, spillIfLarge } from "../src/core/spill.ts";

describe("spill", () => {
  it("leaves a normal result alone", () => {
    expect(spillIfLarge("read_file", "short")).toBe("short");
  });

  it("saves a huge one whole and hands the model its start, end and path", () => {
    const dir = mkdtempSync(join(tmpdir(), "spill-"));
    try {
      const big = "START " + "x".repeat(SPILL_AT * 2) + " END";
      const out = spillIfLarge("fetch_url", big, dir);
      expect(out.length).toBeLessThan(SPILL_AT);
      expect(out.startsWith("START")).toBe(true);
      expect(out.endsWith("END")).toBe(true);
      const path = /saved in (.+?): grep/.exec(out)?.[1];
      expect(path).toBeTruthy();
      expect(readFileSync(path!, "utf8")).toBe(big);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
