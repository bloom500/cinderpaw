/**
 * Competence plan §3.1, the live `condition`: a refusal reason with its
 * specifics blanked, so rounds that failed the same way share a signature.
 * The inputs are the runner's own strings (code-leaves.ts, contract-stages.ts).
 */
import { describe, expect, test } from "bun:test";
import { conditionFor, failureSignature } from "../src/rsi/l3-code/experiment-selector.ts";

describe("failureSignature", () => {
  test("three worktree test failures with different counts are one signature", () => {
    const sigs = [
      "worktree tests failed: 3 fail (exit 1)",
      "worktree tests failed: 12 fail (exit 1)",
      "worktree tests failed: 1 fail (exit 2)",
    ].map(failureSignature);
    expect(new Set(sigs).size).toBe(1);
    expect(sigs[0]).toBe("worktree tests failed: _ fail (exit _)");
  });

  test("paths, quotes and hashes are blanked; the kind of failure is kept", () => {
    expect(failureSignature('sandbox_apply infra failure: SEARCH block not found in src/rsi/l1-config/x.ts'))
      .toBe("sandbox_apply infra failure: SEARCH block not found in _");
    expect(failureSignature('regression: tsc --noEmit failed (exit 2)'))
      .toBe("regression: tsc --noEmit failed (exit _)");
    expect(failureSignature('policy violation: "fs.rmSync" is banned at a1b2c3d4e5f6'))
      .toBe('policy violation: "_" is banned at _');
  });

  test("different kinds of failure stay different", () => {
    expect(failureSignature("worktree tests failed: 3 fail (exit 1)"))
      .not.toBe(failureSignature("regression: tsc --noEmit failed (exit 1)"));
  });

  test("only the first line counts, and the result is bounded", () => {
    expect(failureSignature("ratchet declined\nstack trace line 1\nline 2")).toBe("ratchet declined");
    expect(failureSignature("x".repeat(500)).length).toBe(160);
  });
});

describe("conditionFor", () => {
  const refused = { verdict: "reject", reason: "worktree tests failed: 3 fail (exit 1)", ts: 10 };
  const accepted = { verdict: "accept", reason: "all contract stages passed", ts: 20 };

  test("a refusal is its own signature", () => {
    expect(conditionFor("reject", refused.reason, [])).toBe("worktree tests failed: _ fail (exit _)");
  });

  test("an accept inherits the last refusal on the same file, the failure it overcame", () => {
    expect(conditionFor("accept", accepted.reason, [refused, accepted])).toBe("worktree tests failed: _ fail (exit _)");
  });

  test("an accept with nothing to overcome is unconditioned", () => {
    expect(conditionFor("accept", accepted.reason, [])).toBeUndefined();
    expect(conditionFor("accept", accepted.reason, [accepted])).toBeUndefined();
  });
});
