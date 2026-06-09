/**
 * Process sandbox — security regression tests.
 *
 * These tests exercise the most dangerous scenarios for the process sandbox:
 *   - allowlist enforcement (an executable not on the list must be rejected)
 *   - cwd containment (a cwd outside allowedPaths must be rejected)
 *   - happy path with a whitelisted command (must run to completion)
 *   - non-zero exit code is propagated to the result (not thrown unless asked)
 *
 * The tests use Bun.spawn under the hood; on Windows the whitelisted
 * command is `cmd /c`, on POSIX it's `sh -c`. The integration is kept
 * deliberately small so the suite runs on CI without external services.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RealProcessSandbox } from "../src/sandbox/process-sandbox.ts";
import type { AuditEntry, AuditLogger, ToolManifest } from "../src/types.ts";
import { ManifestError, validateManifest } from "../src/sandbox/tool-permissions.ts";

function noopAudit(): AuditLogger {
  return () => {};
}

function captureAudit(): { log: AuditLogger; entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return { entries, log: (e) => entries.push(e) };
}

const isWin = process.platform === "win32";

/** Build a manifest that whitelists the platform echo command. */
function makeEchoManifest(allowedPaths: string[] = []): ToolManifest {
  return {
    name: "echo_test",
    description: "test manifest that whitelists an echo command",
    permissions: ["process:spawn", "fs:read"],
    networkAccess: false,
    allowedExecutables: isWin ? ["cmd", "sh"] : ["sh"],
    allowedPaths,
  };
}

describe("validateManifest — process:spawn gate", () => {
  it("rejects process:spawn without allowedExecutables", () => {
    expect(() =>
      validateManifest({
        name: "bad",
        description: "no allowlist",
        permissions: ["process:spawn"],
        networkAccess: false,
      }),
    ).toThrow(ManifestError);
  });

  it("rejects process:spawn with an empty allowedExecutables", () => {
    expect(() =>
      validateManifest({
        name: "bad",
        description: "empty allowlist",
        permissions: ["process:spawn"],
        networkAccess: false,
        allowedExecutables: [],
      }),
    ).toThrow(ManifestError);
  });

  it("accepts process:spawn with a non-empty allowedExecutables", () => {
    expect(() =>
      validateManifest({
        name: "good",
        description: "ok",
        permissions: ["process:spawn"],
        networkAccess: false,
        allowedExecutables: ["node"],
      }),
    ).not.toThrow();
  });
});

describe("RealProcessSandbox", () => {
  let sandbox: RealProcessSandbox;
  let tmpDir: string;

  beforeEach(() => {
    sandbox = new RealProcessSandbox(noopAudit());
    tmpDir = mkdtempSync(join(tmpdir(), "feral-procsbx-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs an allowlisted echo command and captures stdout", async () => {
    const manifest = makeEchoManifest([tmpDir]);
    const result = isWin
      ? await sandbox.run(manifest, "sess-1", {
          executable: "cmd",
          args: ["/c", "echo", "hello-feral"],
        })
      : await sandbox.run(manifest, "sess-1", {
          executable: "sh",
          args: ["-c", "echo hello-feral"],
        });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello-feral");
    expect(result.timedOut).toBe(false);
    expect(result.outputTruncated).toBe(false);
  });

  it("throws (and audits as blocked) when the executable is not on the allowlist", async () => {
    const manifest = makeEchoManifest([tmpDir]);
    const { entries, log } = captureAudit();
    const sb = new RealProcessSandbox(log);

    let caught: Error | null = null;
    try {
      await sb.run(manifest, "sess-2", {
        executable: isWin ? "powershell" : "python3",
        args: [],
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(String(caught)).toMatch(/not in allowedExecutables/);

    // The blocked attempt must be audited.
    const blocked = entries.find(
      (e) => e.actionType === "blocked" && e.toolName === manifest.name,
    );
    expect(blocked).toBeDefined();
    expect(blocked?.result).toBe("blocked");
  });

  it("throws when the requested cwd escapes allowedPaths", async () => {
    const manifest = makeEchoManifest([tmpDir]); // allowedPaths is just tmp
    const { entries, log } = captureAudit();
    const sb = new RealProcessSandbox(log);

    let caught: Error | null = null;
    try {
      await sb.run(manifest, "sess-3", {
        executable: isWin ? "cmd" : "sh",
        args: isWin ? ["/c", "echo", "x"] : ["-c", "echo x"],
        cwd: isWin ? "C:\\Windows" : "/etc",
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(String(caught)).toMatch(/outside allowedPaths/);

    const blocked = entries.find(
      (e) => e.actionType === "blocked" && e.toolName === manifest.name,
    );
    expect(blocked).toBeDefined();
  });

  it("accepts a cwd that is inside allowedPaths", async () => {
    const manifest = makeEchoManifest([tmpDir]);
    // Create a small file inside the allowed path; the echo command will
    // just print its name so we don't need it to actually exist for `ls`.
    const inner = join(tmpDir, "inside.txt");
    writeFileSync(inner, "x");

    const result = isWin
      ? await sandbox.run(manifest, "sess-4", {
          executable: "cmd",
          args: ["/c", "echo", inner],
          cwd: tmpDir,
        })
      : await sandbox.run(manifest, "sess-4", {
          executable: "sh",
          args: ["-c", `echo ${JSON.stringify(inner)}`],
          cwd: tmpDir,
        });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("inside.txt");
  });

  it("propagates non-zero exit codes into the result", async () => {
    const manifest = makeEchoManifest([tmpDir]);
    const result = isWin
      ? await sandbox.run(manifest, "sess-5", {
          executable: "cmd",
          args: ["/c", "exit", "7"],
        })
      : await sandbox.run(manifest, "sess-5", {
          executable: "sh",
          args: ["-c", "exit 7"],
        });
    expect(result.exitCode).toBe(7);
  });

  it("kills the process when timeoutMs is exceeded", async () => {
    const manifest = makeEchoManifest([tmpDir]);
    // The test wants the smallest legal timeout (1s) but waits 5s inside
    // the child, so the process must be killed at ~1s.
    const result = isWin
      ? await sandbox.run(manifest, "sess-6", {
          executable: "cmd",
          args: ["/c", "ping", "-n", "5", "127.0.0.1", ">", "nul"],
          timeoutMs: 1_000,
        })
      : await sandbox.run(manifest, "sess-6", {
          executable: "sh",
          args: ["-c", "sleep 5"],
          timeoutMs: 1_000,
        });
    expect(result.timedOut).toBe(true);
    // exitCode -2 is the sentinel value the sandbox uses for timed-out procs.
    expect(result.exitCode).toBe(-2);
  });

  it("clamps timeoutMs to the configured ceiling", async () => {
    const sb = new RealProcessSandbox(noopAudit(), {
      maxTimeoutMs: 5_000,
      defaultTimeoutMs: 2_000,
    });
    const manifest = makeEchoManifest([tmpDir]);
    // We can't directly observe the clamped value, but the call should
    // complete (or time out) without throwing — the important property
    // is that the clamp is applied silently and not surfaced as an error.
    const result = await sb.run(manifest, "sess-7", {
      executable: isWin ? "cmd" : "sh",
      args: isWin ? ["/c", "echo", "ok"] : ["-c", "echo ok"],
      timeoutMs: 10_000_000, // way over the 5s ceiling
    });
    expect(result.exitCode).toBe(0);
  });
});
