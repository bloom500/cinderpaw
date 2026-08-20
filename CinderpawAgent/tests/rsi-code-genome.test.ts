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
  parseUnifiedDiff,
  isDiffParseError,
  type CodeGenome,
  type ParsedDiff,
  type ParsedDiffFile,
} from "../src/rsi/l3-code/code-genome.ts";
import {
  serializeCodeGenome,
  deserializeCodeGenome,
} from "../src/rsi/l3-code/code-genome-io.ts";

function file(over: Partial<ParsedDiffFile> = {}): ParsedDiffFile {
  return {
    oldPath: "src/rsi/l1-config/selection-handler.ts",
    newPath: "src/rsi/l1-config/selection-handler.ts",
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
    v = validateCodePatch(diff(file({ newPath: "src/rsi/l1-config/ratchet-handler.ts" })));
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
        file({ oldPath: "src/rsi/l1-config/taste-miner.ts", newPath: "src/rsi/l1-config/taste-miner.ts", addedLines: 40, removedLines: 20 }),
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

// ─────────────────────────────────────────────────────────────────────────────
// Slice 1 — parseUnifiedDiff (MiniMax leaf, pure string → structure).
// Contract pinned in code-genome.ts above the implementation. Each test
// asserts behaviour the stub (which throws) cannot satisfy.
// ─────────────────────────────────────────────────────────────────────────────

/** Assert the result of `parseUnifiedDiff` is a successful parse and return
 *  the files. Throws a useful assertion error if the parser rejected. */
function expectOk(patch: string): ParsedDiff["files"] {
  const r = parseUnifiedDiff(patch);
  expect(isDiffParseError(r)).toBe(false);
  if (isDiffParseError(r)) throw new Error(`unexpected parse error: ${r.error}`);
  return r.files;
}

function expectErr(patch: string, msgFragment?: string): void {
  const r = parseUnifiedDiff(patch);
  expect(isDiffParseError(r)).toBe(true);
  if (!isDiffParseError(r)) {
    throw new Error(`expected DiffParseError, got ${JSON.stringify(r)}`);
  }
  if (msgFragment !== undefined) {
    expect(r.error.toLowerCase()).toContain(msgFragment.toLowerCase());
  }
}

describe("parseUnifiedDiff — single-file edit", () => {
  test("counts added/removed lines and reads the path with a/ b/ stripped", () => {
    const patch =
      "--- a/src/rsi/foo.ts\n" +
      "+++ b/src/rsi/foo.ts\n" +
      "@@ -1,3 +1,4 @@\n" +
      " line1\n" +
      "-line2\n" +
      "+line2-replaced\n" +
      "+line2b\n" +
      " line3\n";
    const files = expectOk(patch);
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f.oldPath).toBe("src/rsi/foo.ts");
    expect(f.newPath).toBe("src/rsi/foo.ts");
    expect(f.addedLines).toBe(2);
    expect(f.removedLines).toBe(1);
    expect(f.binary).toBe(false);
  });

  test("a plain unified diff without a/ b/ prefixes parses identically", () => {
    const patch =
      "--- src/rsi/foo.ts\t2024-01-01 12:00:00\n" +
      "+++ src/rsi/foo.ts\t2024-01-01 12:00:00\n" +
      "@@ -1,1 +1,1 @@\n" +
      "-old\n" +
      "+new\n";
    const files = expectOk(patch);
    expect(files).toHaveLength(1);
    expect(files[0]!.oldPath).toBe("src/rsi/foo.ts");
    expect(files[0]!.addedLines).toBe(1);
    expect(files[0]!.removedLines).toBe(1);
  });
});

describe("parseUnifiedDiff — multi-file", () => {
  test("two file sections produce two files in order", () => {
    const patch =
      "--- a/src/rsi/foo.ts\n" +
      "+++ b/src/rsi/foo.ts\n" +
      "@@ -1,3 +1,4 @@\n" +
      " a\n" +
      "-b\n" +
      "+b'\n" +
      "+b''\n" +
      " c\n" +
      "--- a/src/rsi/bar.ts\n" +
      "+++ b/src/rsi/bar.ts\n" +
      "@@ -1,1 +1,2 @@\n" +
      " x\n" +
      "+y\n";
    const files = expectOk(patch);
    expect(files).toHaveLength(2);
    expect(files[0]!.newPath).toBe("src/rsi/foo.ts");
    expect(files[0]!.addedLines).toBe(2);
    expect(files[0]!.removedLines).toBe(1);
    expect(files[1]!.newPath).toBe("src/rsi/bar.ts");
    expect(files[1]!.addedLines).toBe(1);
    expect(files[1]!.removedLines).toBe(0);
  });

  test("git extended headers between hunks and files are ignored", () => {
    const patch =
      "diff --git a/src/rsi/foo.ts b/src/rsi/foo.ts\n" +
      "index 1111111..2222222 100644\n" +
      "--- a/src/rsi/foo.ts\n" +
      "+++ b/src/rsi/foo.ts\n" +
      "@@ -1,1 +1,1 @@\n" +
      "-a\n" +
      "+b\n" +
      "diff --git a/src/rsi/bar.ts b/src/rsi/bar.ts\n" +
      "index 3333333..4444444 100644\n" +
      "--- a/src/rsi/bar.ts\n" +
      "+++ b/src/rsi/bar.ts\n" +
      "@@ -1,1 +1,1 @@\n" +
      "-x\n" +
      "+y\n";
    const files = expectOk(patch);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.newPath)).toEqual(["src/rsi/foo.ts", "src/rsi/bar.ts"]);
  });
});

describe("parseUnifiedDiff — create and delete", () => {
  test("--- /dev/null means the file is created (oldPath = null)", () => {
    const patch =
      "--- /dev/null\n" +
      "+++ b/src/rsi/new-file.ts\n" +
      "@@ -0,0 +1,3 @@\n" +
      "+line1\n" +
      "+line2\n" +
      "+line3\n";
    const files = expectOk(patch);
    expect(files).toHaveLength(1);
    expect(files[0]!.oldPath).toBeNull();
    expect(files[0]!.newPath).toBe("src/rsi/new-file.ts");
    expect(files[0]!.addedLines).toBe(3);
    expect(files[0]!.removedLines).toBe(0);
  });

  test("+++ /dev/null means the file is deleted (newPath = null)", () => {
    const patch =
      "--- a/src/rsi/old-file.ts\n" +
      "+++ /dev/null\n" +
      "@@ -1,3 +0,0 @@\n" +
      "-line1\n" +
      "-line2\n" +
      "-line3\n";
    const files = expectOk(patch);
    expect(files).toHaveLength(1);
    expect(files[0]!.oldPath).toBe("src/rsi/old-file.ts");
    expect(files[0]!.newPath).toBeNull();
    expect(files[0]!.addedLines).toBe(0);
    expect(files[0]!.removedLines).toBe(3);
  });
});

describe("parseUnifiedDiff — rename via header pair", () => {
  test("a/old-path vs b/new-path yields a file with both sides populated", () => {
    const patch =
      "diff --git a/src/rsi/old-handler.ts b/src/rsi/new-handler.ts\n" +
      "similarity index 95%\n" +
      "rename from src/rsi/old-handler.ts\n" +
      "rename to src/rsi/new-handler.ts\n" +
      "index abc1234..def5678 100644\n" +
      "--- a/src/rsi/old-handler.ts\n" +
      "+++ b/src/rsi/new-handler.ts\n" +
      "@@ -1,3 +1,3 @@\n" +
      " context\n" +
      "-old implementation\n" +
      "+new implementation\n" +
      " context\n";
    const files = expectOk(patch);
    expect(files).toHaveLength(1);
    expect(files[0]!.oldPath).toBe("src/rsi/old-handler.ts");
    expect(files[0]!.newPath).toBe("src/rsi/new-handler.ts");
    expect(files[0]!.addedLines).toBe(1);
    expect(files[0]!.removedLines).toBe(1);
    expect(files[0]!.binary).toBe(false);
  });
});

describe("parseUnifiedDiff — binary marker", () => {
  test("`Binary files a/X and b/Y differ` → binary: true, zero line counts", () => {
    const patch =
      "diff --git a/src/rsi/img.png b/src/rsi/img.png\n" +
      "index abc1234..def5678 100644\n" +
      "Binary files a/src/rsi/img.png and b/src/rsi/img.png differ\n";
    const files = expectOk(patch);
    expect(files).toHaveLength(1);
    expect(files[0]!.oldPath).toBe("src/rsi/img.png");
    expect(files[0]!.newPath).toBe("src/rsi/img.png");
    expect(files[0]!.addedLines).toBe(0);
    expect(files[0]!.removedLines).toBe(0);
    expect(files[0]!.binary).toBe(true);
  });

  test("`GIT binary patch` block sets binary: true and skips the literal body", () => {
    const patch =
      "diff --git a/src/rsi/img.png b/src/rsi/img.png\n" +
      "index abc1234..def5678 100644\n" +
      "--- a/src/rsi/img.png\n" +
      "+++ b/src/rsi/img.png\n" +
      "GIT binary patch\n" +
      "literal 4\n" +
      "{cmVu\n" +
      "\n" +
      "diff --git a/src/rsi/other.ts b/src/rsi/other.ts\n" +
      "--- a/src/rsi/other.ts\n" +
      "+++ b/src/rsi/other.ts\n" +
      "@@ -1,1 +1,1 @@\n" +
      "-x\n" +
      "+y\n";
    const files = expectOk(patch);
    expect(files).toHaveLength(2);
    expect(files[0]!.binary).toBe(true);
    expect(files[0]!.addedLines).toBe(0);
    expect(files[0]!.removedLines).toBe(0);
    expect(files[1]!.binary).toBe(false);
    expect(files[1]!.newPath).toBe("src/rsi/other.ts");
    expect(files[1]!.addedLines).toBe(1);
  });
});

describe("parseUnifiedDiff — CRLF input", () => {
  test("CRLF line endings produce the same result as LF", () => {
    const lf =
      "--- a/src/rsi/foo.ts\n" +
      "+++ b/src/rsi/foo.ts\n" +
      "@@ -1,3 +1,4 @@\n" +
      " line1\n" +
      "-line2\n" +
      "+line2-replaced\n" +
      "+line2b\n" +
      " line3\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(expectOk(crlf)).toEqual(expectOk(lf));
  });
});

describe("parseUnifiedDiff — error cases", () => {
  test("empty input → DiffParseError", () => {
    expectErr("", "empty");
    expectErr("   \n\n  ", "empty");
  });

  test("hunk counts that don't match the body → DiffParseError", () => {
    // Header says -3 +3 but body only has one `-` and one `+`.
    const patch =
      "--- a/src/rsi/foo.ts\n" +
      "+++ b/src/rsi/foo.ts\n" +
      "@@ -1,3 +1,3 @@\n" +
      " a\n" +
      "-b\n" +
      "+b'\n";
    expectErr(patch, "hunk");
  });

  test("hunk with no body at all → DiffParseError", () => {
    const patch =
      "--- a/src/rsi/foo.ts\n" +
      "+++ b/src/rsi/foo.ts\n" +
      "@@ -1,3 +1,3 @@\n";
    expectErr(patch, "hunk");
  });

  test("file section with no +++/--- pair → DiffParseError", () => {
    const patch =
      "--- a/src/rsi/foo.ts\n" +
      "@@ -1,1 +1,1 @@\n" +
      "-a\n" +
      "+b\n";
    expectErr(patch, "+++");
  });

  test("text after the last hunk that is not a new file header → DiffParseError", () => {
    const patch =
      "--- a/src/rsi/foo.ts\n" +
      "+++ b/src/rsi/foo.ts\n" +
      "@@ -1,1 +1,1 @@\n" +
      "-a\n" +
      "+b\n" +
      "this is not a header\n";
    expectErr(patch, "unexpected");
  });

  test("the parser never throws — every malformed input is a verdict", () => {
    for (const bad of [
      "",
      "garbage",
      "--- a/x.ts\n@@\n",
      "--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\nx",
      "--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,2 @@\n-x\n+y\n", // mismatched counts
    ]) {
      let threw = false;
      try {
        parseUnifiedDiff(bad);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Slice 1 — CodeGenome envelope serializer.
// Discipline mirrors population-snapshot.ts.
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_GENOME: CodeGenome = {
  patch:
    "--- a/src/rsi/foo.ts\n" +
    "+++ b/src/rsi/foo.ts\n" +
    "@@ -1,1 +1,2 @@\n" +
    "+new\n",
  affectedFiles: ["src/rsi/foo.ts"],
  baseCommit: "abc1234",
  proposal: {
    rationale: "fix: handle empty input",
    riskAssessment: "low: covered by tests",
    testPlan: "added unit test for empty input",
  },
};

describe("CodeGenome envelope serializer", () => {
  test("serializeCodeGenome emits a versioned envelope", () => {
    const s = serializeCodeGenome(SAMPLE_GENOME);
    expect(s).toContain('"version":1');
    expect(s).toContain('"genome"');
    expect(s).toContain(SAMPLE_GENOME.patch.slice(0, 20));
  });

  test("round-trip: serialize → deserialize preserves the CodeGenome", () => {
    const s = serializeCodeGenome(SAMPLE_GENOME);
    const r = deserializeCodeGenome(s);
    expect(r).not.toBeNull();
    expect(r).toEqual(SAMPLE_GENOME);
  });

  test("corrupt JSON → null", () => {
    expect(deserializeCodeGenome("not json {{{")).toBeNull();
    expect(deserializeCodeGenome("")).toBeNull();
    expect(deserializeCodeGenome("{")).toBeNull();
  });

  test("wrong version → null", () => {
    const env = { version: 2, genome: SAMPLE_GENOME };
    expect(deserializeCodeGenome(JSON.stringify(env))).toBeNull();
  });

  test("missing or wrong-shape genome → null", () => {
    // missing patch
    expect(
      deserializeCodeGenome(
        JSON.stringify({ version: 1, genome: { affectedFiles: [], baseCommit: "x", proposal: {} } }),
      ),
    ).toBeNull();
    // patch not a string
    expect(
      deserializeCodeGenome(
        JSON.stringify({ version: 1, genome: { patch: 123, affectedFiles: [], baseCommit: "x", proposal: {} } }),
      ),
    ).toBeNull();
    // affectedFiles not an array
    expect(
      deserializeCodeGenome(
        JSON.stringify({ version: 1, genome: { patch: "x", affectedFiles: "nope", baseCommit: "x", proposal: {} } }),
      ),
    ).toBeNull();
    // proposal missing fields
    expect(
      deserializeCodeGenome(
        JSON.stringify({ version: 1, genome: { patch: "x", affectedFiles: [], baseCommit: "x", proposal: { rationale: "r" } } }),
      ),
    ).toBeNull();
  });

  test("deserialize never throws on any input", () => {
    for (const bad of ["", "x", "{}", "[]", '{"version":1}', '{"version":1,"genome":null}', "null", "0"]) {
      let threw = false;
      try {
        deserializeCodeGenome(bad);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    }
  });
});
