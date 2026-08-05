/**
 * Full shell access, bounded blast radius.
 *
 * The agent has real shell access by design — the shells are on the default
 * whitelist, so `sh -c "<anything>"` runs. The existing denylist catches the
 * seven ways to destroy the machine (`rm -rf /`, `mkfs`, `dd of=/dev/sda`, …)
 * and nothing else, which leaves the mistake that actually happens on a
 * developer's laptop: a destructive command aimed at a real path that simply
 * is not the workspace. `rm -rf ~/Documents` is not catastrophic to the OS and
 * is catastrophic to the person.
 *
 * The rule here is narrow on purpose: a destructive verb PLUS an absolute path
 * that lies outside every workspace root (and outside the scratch dirs the
 * agent legitimately uses). Destructive work inside the workspace stays
 * allowed — that is what the safety point exists to undo — and every
 * non-destructive command is untouched, however far it reads.
 */

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { destructiveOutsideRoots } from "../src/tools/builtin/shell-exec.ts";

const ROOTS = [join(tmpdir(), "feral-blast-workspace"), join(tmpdir(), "feral-blast-second")];
const outside = process.platform === "win32" ? "C:\\Users\\Someone\\Documents" : "/home/someone/Documents";

describe("destructive commands outside the workspace", () => {
  test("deleting a path outside every root is refused", () => {
    expect(destructiveOutsideRoots(["rm", "-rf", outside], ROOTS)).toBe(outside);
  });

  test("the same payload hidden in a shell string is still caught", () => {
    // argv[0] is a shell, so the whole command is one opaque token. Scanning
    // only argv positions would see nothing at all here.
    expect(destructiveOutsideRoots(["sh", "-c", `rm -rf ${outside}`], ROOTS)).toBe(outside);
  });

  test("a relative target is left alone — it resolves inside the cwd", () => {
    expect(destructiveOutsideRoots(["rm", "-rf", "node_modules"], ROOTS)).toBeNull();
  });

  test("destructive work inside a workspace root is allowed", () => {
    // The safety point covers this, so blocking it would trade a recoverable
    // action for a blocked agent.
    expect(destructiveOutsideRoots(["rm", "-rf", join(ROOTS[0]!, "build")], ROOTS)).toBeNull();
  });

  test("a second root counts as much as the first", () => {
    expect(destructiveOutsideRoots(["rm", "-rf", join(ROOTS[1]!, "dist")], ROOTS)).toBeNull();
  });

  test("reading outside the workspace is not destruction", () => {
    expect(destructiveOutsideRoots(["cat", outside], ROOTS)).toBeNull();
    expect(destructiveOutsideRoots(["grep", "-r", "token", outside], ROOTS)).toBeNull();
  });

  test("the system temp dir is scratch space, not somebody's work", () => {
    expect(destructiveOutsideRoots(["rm", "-rf", join(tmpdir(), "scratch-123")], ROOTS)).toBeNull();
  });

  test("Windows spellings are covered too", () => {
    expect(destructiveOutsideRoots(["cmd", "/c", `del C:\\Users\\Someone\\notes.txt`], ROOTS))
      .toBe("C:\\Users\\Someone\\notes.txt");
    expect(
      destructiveOutsideRoots(
        ["powershell", "-c", `Remove-Item -Recurse C:\\Users\\Someone\\src`],
        ROOTS,
      ),
    ).toBe("C:\\Users\\Someone\\src");
  });

  test("no roots configured means no claim either way", () => {
    // Refusing everything when the workspace is unknown would break the
    // headless setups that never configure a root. Unknown is not unsafe.
    expect(destructiveOutsideRoots(["rm", "-rf", outside], [])).toBeNull();
  });
});

/**
 * The predicate above is only worth as much as its wiring. This runs the real
 * tool, so a refusal that never reaches the execute path would fail here.
 */
describe("the tool refuses before it spawns anything", () => {
  test("a destructive command aimed outside the workspace never reaches the sandbox", async () => {
    const { createShellExecTool } = await import("../src/tools/builtin/shell-exec.ts");
    const root = join(tmpdir(), "feral-blast-workspace");
    const tool = createShellExecTool([root]);
    let spawned = false;

    const result = await tool.execute(
      { argv: ["rm", "-rf", outside] },
      {
        sessionId: "test",
        manifest: tool.manifest,
        // Any call here means the guard let it through.
        process: {
          run: async () => {
            spawned = true;
            return {
              exitCode: 0, stdout: "", stderr: "", durationMs: 1,
              timedOut: false, outputTruncated: false,
            };
          },
        },
      } as never,
    );

    expect(spawned).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("destructive_outside_workspace");
  });

  test("the same command inside the workspace does reach the sandbox", async () => {
    const { createShellExecTool } = await import("../src/tools/builtin/shell-exec.ts");
    const root = join(tmpdir(), "feral-blast-workspace");
    const tool = createShellExecTool([root]);
    let spawned = false;

    // Through a shell, because a bare `rm` is not on the binary whitelist and
    // would be refused one gate later for an unrelated reason — which would
    // make this test pass while proving nothing about the blast-radius gate.
    await tool.execute(
      { argv: ["sh", "-c", `rm -rf ${join(root, "build")}`] },
      {
        sessionId: "test",
        manifest: tool.manifest,
        process: {
          run: async () => {
            spawned = true;
            return {
              exitCode: 0, stdout: "", stderr: "", durationMs: 1,
              timedOut: false, outputTruncated: false,
            };
          },
        },
      } as never,
    );

    expect(spawned).toBe(true);
  });
});
