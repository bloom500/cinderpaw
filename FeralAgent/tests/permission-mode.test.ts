/**
 * One mode, three answers.
 *
 * The two failures these pin down:
 *   - a read-only mode that only stops the shell is a lie, because `write_file`
 *     is right there. It has to hold at the single gate every write routes
 *     through, or it holds nowhere.
 *   - a "warn" that auto-approves itself when nobody is watching is not a gate.
 *     With a human reachable it asks; in walk-away mode it refuses.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createShellExecTool } from "../src/tools/builtin/shell-exec.ts";
import { createWriteFileTool } from "../src/tools/builtin/write-file.ts";
import { permissionMode } from "../src/core/permission-mode.ts";

const saved = { ...process.env };
afterEach(() => {
  process.env.FERAL_PERMISSION_MODE = saved.FERAL_PERMISSION_MODE;
  process.env.FERAL_AUTONOMOUS = saved.FERAL_AUTONOMOUS;
  if (saved.FERAL_PERMISSION_MODE === undefined) delete process.env.FERAL_PERMISSION_MODE;
  if (saved.FERAL_AUTONOMOUS === undefined) delete process.env.FERAL_AUTONOMOUS;
});

/** A tool context whose sandbox records whether anything was ever spawned. */
function ctxFor(tool: { manifest: unknown }, askUser?: unknown) {
  const state = { spawned: false };
  const ctx = {
    sessionId: `s-${Math.random()}`,
    manifest: tool.manifest,
    askUser,
    process: {
      run: async () => {
        state.spawned = true;
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, outputTruncated: false };
      },
    },
  };
  return { ctx: ctx as never, state };
}

describe("resolving the mode", () => {
  test("named explicitly, or inherited from the historical knobs", () => {
    process.env.FERAL_PERMISSION_MODE = "read_only";
    expect(permissionMode()).toBe("read_only");
    delete process.env.FERAL_PERMISSION_MODE;
    // An existing install that took the brakes off keeps its behaviour.
    expect(permissionMode({ FERAL_SHELL_WHITELIST: "*" } as NodeJS.ProcessEnv)).toBe("full_access");
    expect(permissionMode({} as NodeJS.ProcessEnv)).toBe("workspace_write");
  });
});

describe("read-only mode", () => {
  test("reads run, writes do not — and the refusal says which is which", async () => {
    process.env.FERAL_PERMISSION_MODE = "read_only";
    const root = await mkdtemp(join(tmpdir(), "feral-ro-"));
    const tool = createShellExecTool([root]);

    const read = ctxFor(tool);
    await tool.execute({ argv: ["sh", "-c", "ls -la"] }, read.ctx);
    expect(read.state.spawned).toBe(true);

    const write = ctxFor(tool);
    const refused = await tool.execute({ argv: ["sh", "-c", `rm -rf ${join(root, "x")}`] }, write.ctx);
    expect(write.state.spawned).toBe(false);
    expect(refused.error).toBe("permission_mode");
    expect(refused.content).toContain("read-only");
  });

  test("the file tools are covered too, at the shared gate", async () => {
    process.env.FERAL_PERMISSION_MODE = "read_only";
    const root = await mkdtemp(join(tmpdir(), "feral-ro-fs-"));
    const tool = createWriteFileTool([root]);
    const { ctx } = ctxFor(tool);

    // Denials at this gate THROW (PermissionDeniedError) — the same shape an
    // out-of-root path has always produced, so the registry's existing handling
    // covers it and no tool needs to learn about the mode.
    expect(
      tool.execute({ path: join(root, "note.md"), content: "hello" }, ctx),
    ).rejects.toThrow(/read-only/);
  });

  test("an unclassifiable binary is refused rather than assumed harmless", async () => {
    process.env.FERAL_PERMISSION_MODE = "read_only";
    const root = await mkdtemp(join(tmpdir(), "feral-ro-unk-"));
    const tool = createShellExecTool([root]);
    const { ctx, state } = ctxFor(tool);
    const result = await tool.execute({ argv: ["sh", "-c", "some-unknown-tool --go"] }, ctx);
    expect(state.spawned).toBe(false);
    expect(result.error).toBe("permission_mode");
  });
});

describe("destruction outside the workspace is a human's call", () => {
  const outside = process.platform === "win32" ? "C:\\Users\\Someone\\Docs" : "/home/someone/Docs";

  test("with nobody to ask, it refuses instead of approving itself", async () => {
    process.env.FERAL_PERMISSION_MODE = "workspace_write";
    process.env.FERAL_AUTONOMOUS = "true";
    const root = await mkdtemp(join(tmpdir(), "feral-warn-"));
    const tool = createShellExecTool([root]);
    // A bridge EXISTS — walk-away mode is what makes it unusable for this
    // class of question, which is the case that would otherwise auto-approve.
    const { ctx, state } = ctxFor(tool, { ask: async () => [{ question: "", selected: ["Yes, delete it"] }] });

    const result = await tool.execute({ argv: ["sh", "-c", `rm -rf ${outside}`] }, ctx);
    expect(state.spawned).toBe(false);
    expect(result.error).toBe("destructive_outside_workspace");
    expect(String(result.content)).toContain("Nobody is available");
  });

  test("asked and declined: nothing runs", async () => {
    process.env.FERAL_PERMISSION_MODE = "workspace_write";
    delete process.env.FERAL_AUTONOMOUS;
    const root = await mkdtemp(join(tmpdir(), "feral-warn-no-"));
    const tool = createShellExecTool([root]);
    const { ctx, state } = ctxFor(tool, {
      ask: async () => [{ question: "", selected: ["No, skip it"] }],
    });

    const result = await tool.execute({ argv: ["sh", "-c", `rm -rf ${outside}`] }, ctx);
    expect(state.spawned).toBe(false);
    expect(String(result.content)).toContain("declined");
  });

  test("asked and approved: it runs", async () => {
    process.env.FERAL_PERMISSION_MODE = "workspace_write";
    delete process.env.FERAL_AUTONOMOUS;
    const root = await mkdtemp(join(tmpdir(), "feral-warn-yes-"));
    const tool = createShellExecTool([root]);
    let asked = 0;
    const { ctx, state } = ctxFor(tool, {
      ask: async () => {
        asked++;
        return [{ question: "", selected: ["Yes, delete it"] }];
      },
    });

    await tool.execute({ argv: ["sh", "-c", `rm -rf ${outside}`] }, ctx);
    expect(asked).toBe(1);
    expect(state.spawned).toBe(true);
  });
});

/**
 * The report line. "27 tool calls" tells somebody who walked away nothing;
 * "22 read-only, 4 wrote files" tells them whether to worry.
 */
describe("what the run did, in the report", () => {
  test("the digest counts commands by what they were for", async () => {
    const { recordIntent, intentSummary, clearIntents } = await import(
      "../src/core/command-intent.ts"
    );
    const { renderDigest } = await import("../src/core/digest.ts");
    const session = "digest-session";
    clearIntents(session);
    for (let i = 0; i < 22; i++) recordIntent(session, "read_only");
    recordIntent(session, "write");
    recordIntent(session, "destructive");

    const text = renderDigest(
      { text: "done", outcome: "completed", finished: true, turns: [], stoppedBecause: "completed" },
      { available: true, files: [], insertions: 0, deletions: 0, restoreHint: null },
      { checked: false, passed: true, detail: "no done_when declared" },
      null,
      undefined,
      intentSummary(session),
    );
    expect(text).toContain("22 read-only");
    expect(text).toContain("1 wrote files");
    expect(text).toContain("1 deleted or overwrote");
  });

  test("no commands, no line — an empty count must not read as a claim", async () => {
    const { intentSummary } = await import("../src/core/command-intent.ts");
    const { renderDigest } = await import("../src/core/digest.ts");
    const text = renderDigest(
      { text: "done", outcome: "completed", finished: true, turns: [], stoppedBecause: "completed" },
      { available: true, files: [], insertions: 0, deletions: 0, restoreHint: null },
      { checked: false, passed: true, detail: "no done_when declared" },
      null,
      undefined,
      intentSummary("never-used-session"),
    );
    expect(text).not.toContain("Commands run:");
  });
});
