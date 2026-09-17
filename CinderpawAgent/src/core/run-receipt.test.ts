import { describe, expect, test } from "bun:test";
import { runReceipt } from "./run-receipt.ts";
import { SkillLibrary, induceFromReceipts, induceProcedure } from "../memory/fractal/skill-library.ts";

const dw = { kind: "file_contains" as const, path: "notes.md", value: "SYN" };

describe("runReceipt", () => {
  test("the 14 Sep run: write then read, verified, 523 tokens", () => {
    const r = runReceipt({ doneWhen: dw, verified: true, tools: ["write_file", "read_file"], tokens: 523, now: 1 });
    expect(r).toMatchObject({
      file: "write_file>read_file",
      verdict: "accept",
      condition: "done_when:file_contains",
      observed: { cost: 523, accepted: true },
    });
  });

  test("a failed verifier is a reject, a run with no tools is no receipt", () => {
    expect(runReceipt({ doneWhen: dw, verified: false, tools: ["write_file"], tokens: 9, now: 1 })?.verdict).toBe("reject");
    expect(runReceipt({ doneWhen: dw, verified: true, tools: [], tokens: 9, now: 1 })).toBeNull();
  });

  test("two verified runs of one kind induce the first real procedure", () => {
    const mk = (now: number) => runReceipt({ doneWhen: dw, verified: true, tools: ["write_file", "read_file"], tokens: 500, now })!;
    const out = induceProcedure({ train: [mk(1), mk(2)], heldOut: [mk(3)], verifiedBy: "done_when", methodVersion: "t" });
    expect(out.skill?.steps).toEqual([{ tool: "write_file" }, { tool: "read_file" }]);
    expect(out.skill?.conditions.condition).toBe("done_when:file_contains");
  });

  test("live: the second verified run of a kind puts a procedure in the library, the first cannot", () => {
    const seq = ["list_directory", "write_file", "read_file"];
    const mk = (now: number) => runReceipt({ doneWhen: dw, verified: true, tools: seq, tokens: 500, now })!;
    const lib = new SkillLibrary();
    expect(induceFromReceipts([mk(1)], lib, { verifiedBy: "done_when", methodVersion: "t" })).toBe(0);
    expect(induceFromReceipts([mk(1), mk(2)], lib, { verifiedBy: "done_when", methodVersion: "t" })).toBe(1);
    expect(lib.lookup("done_when:file_contains")?.name).toBe("list_directory>write_file>read_file");
    // Same receipts again: already known, nothing written twice.
    expect(induceFromReceipts([mk(1), mk(2), mk(3)], lib, { verifiedBy: "done_when", methodVersion: "t" })).toBe(0);
  });
});
