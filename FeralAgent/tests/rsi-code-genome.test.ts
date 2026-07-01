/**
 * Faza 2 Slice 0 — the code-patch policy wall (spec §2 guardrails).
 *
 * These tests pin the WALL over hand-built ParsedDiff fixtures — they must
 * not depend on `parseUnifiedDiff` (a MiniMax leaf, stubbed until Slice 1).
 * When the parser lands, its tests extend this file with raw-diff fixtures.
 */

import { describe, expect, test } from "bun:test";
import {
  validateCodePatch,
  DEFAULT_CODE_PATCH_POLICY,
  type ParsedDiff,
  type ParsedDiffFile,
} from "../src/rsi/code-genome.ts";

function file(over: Partial<ParsedDiffFile> = {}): ParsedDiffFile {
  return {
    oldPath: "src/rsi/selection-handler.ts",
    newPath: "src/rsi/selection-handler.ts",
    addedLines: 5,
    removedLines: 3,
    binary: false,
    ...over,
  };
}

function diff(...files: ParsedDiffFile[]): ParsedDiff {
  return { files };
}

describe("validateCodePatch — the Faza 2 policy wall", () => {
  test("a small edit to an allowed rsi/ file passes", () => {
    expect(validateCodePatch(diff(file()))).toEqual({ ok: true });
  });

  test("an empty patch is rejected", () => {
    expect(validateCodePatch(diff()).ok).toBe(false);
  });

  test("files outside src/rsi/ are rejected", () => {
    const v = validateCodePatch(diff(file({ oldPath: "src/agent-loop.ts", newPath: "src/agent-loop.ts" })));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("outside src/rsi/");
  });

  test("non-.ts files are rejected", () => {
    const v = validateCodePatch(diff(file({ oldPath: "src/rsi/notes.md", newPath: "src/rsi/notes.md" })));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain(".ts");
  });

  test("path traversal and absolute paths are rejected", () => {
    for (const p of ["src/rsi/../agent-loop.ts", "/etc/passwd", "C:/Windows/x.ts", "src/rsi/a/../../x.ts"]) {
      const v = validateCodePatch(diff(file({ oldPath: p, newPath: p })));
      expect(v.ok).toBe(false);
    }
  });

  test("backslash paths are normalised before judging", () => {
    const v = validateCodePatch(diff(file({ oldPath: "src\\rsi\\..\\x.ts", newPath: "src\\rsi\\..\\x.ts" })));
    expect(v.ok).toBe(false);
  });

  test("the enforcement chain is untouchable (denylist)", () => {
    for (const name of DEFAULT_CODE_PATCH_POLICY.denylistBasenames) {
      const p = `src/rsi/${name}`;
      const v = validateCodePatch(diff(file({ oldPath: p, newPath: p })));
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toContain("enforcement file");
    }
  });

  test("a rename escaping the allowed dir is rejected on the offending side", () => {
    // old inside, new outside
    let v = validateCodePatch(diff(file({ newPath: "src/tools/escape.ts" })));
    expect(v.ok).toBe(false);
    // old outside, new inside (smuggling a file in)
    v = validateCodePatch(diff(file({ oldPath: "src/tools/escape.ts" })));
    expect(v.ok).toBe(false);
    // rename onto a denylisted basename
    v = validateCodePatch(diff(file({ newPath: "src/rsi/ratchet-handler.ts" })));
    expect(v.ok).toBe(false);
  });

  test("created and deleted files judge only their non-null side", () => {
    expect(validateCodePatch(diff(file({ oldPath: null }))).ok).toBe(true); // create
    expect(validateCodePatch(diff(file({ newPath: null }))).ok).toBe(true); // delete
  });

  test("binary patches are rejected", () => {
    const v = validateCodePatch(diff(file({ binary: true })));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("binary");
  });

  test("the 200-line cap is enforced across ALL files combined", () => {
    // 150 + 60 = 210 > 200 even though each file alone is fine.
    const v = validateCodePatch(
      diff(
        file({ addedLines: 100, removedLines: 50 }),
        file({ oldPath: "src/rsi/taste-miner.ts", newPath: "src/rsi/taste-miner.ts", addedLines: 40, removedLines: 20 }),
      ),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("too large");
    // Exactly at the cap passes.
    expect(
      validateCodePatch(diff(file({ addedLines: 150, removedLines: 50 }))).ok,
    ).toBe(true);
  });
});
