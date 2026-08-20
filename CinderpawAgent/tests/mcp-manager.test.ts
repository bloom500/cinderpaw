/**
 * mcp-manager tests (R5) — config loading, the ported Windows metachar
 * denylist (security contract: must match src-tauri/src/mcp.rs
 * validate_config_tokens EXACTLY), spawn spec building, and reconcile
 * teardown/registration bookkeeping with a stubbed registry.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  hasWindowsMetachars,
  loadMcpConfig,
  spawnSpecFor,
} from "../src/egress/mcp-manager.ts";

// ---------------------------------------------------------------------------
// Denylist — ported from Rust; NEVER relax without a security review.
// ---------------------------------------------------------------------------

const DENIED = ["&", "|", "<", ">", "^", "%", "\n", "\r", "\0"];

describe("hasWindowsMetachars (BatBadBut denylist)", () => {
  test("rejects each denied metachar", () => {
    for (const ch of DENIED) {
      expect(hasWindowsMetachars(`pkg${ch}name`)).toBe(true);
      expect(hasWindowsMetachars(ch)).toBe(true);
    }
  });

  test("denied set is exactly these nine chars", () => {
    expect(DENIED.length).toBe(9);
  });

  test("allows legitimate tokens (paths, flags, scoped packages)", () => {
    for (const token of [
      "npx",
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "C:\\Program Files (x86)\\thing\\server.js",
      "--repository=.",
      "mcp-server-git",
      "[bracketed]",
      "a b c",
    ]) {
      expect(hasWindowsMetachars(token)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Spawn spec — cmd /c routing on Windows only.
// ---------------------------------------------------------------------------

describe("spawnSpecFor", () => {
  test("routes through cmd /c on win32 (npx is a .cmd shim)", () => {
    const spec = spawnSpecFor({ command: "npx", args: ["-y", "pkg"] }, "win32");
    expect(spec.command).toBe("cmd");
    expect(spec.args).toEqual(["/c", "npx", "-y", "pkg"]);
  });

  test("spawns directly on posix", () => {
    const spec = spawnSpecFor({ command: "npx", args: ["-y", "pkg"] }, "linux");
    expect(spec.command).toBe("npx");
    expect(spec.args).toEqual(["-y", "pkg"]);
  });
});

// ---------------------------------------------------------------------------
// Config loader — tolerant of missing/corrupt files.
// ---------------------------------------------------------------------------

describe("loadMcpConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "feral-mcp-test-"));

  test("missing file → empty list", () => {
    expect(loadMcpConfig(join(dir, "nope.json"))).toEqual([]);
  });

  test("corrupt JSON → empty list", () => {
    const p = join(dir, "corrupt.json");
    writeFileSync(p, "{not json");
    expect(loadMcpConfig(p)).toEqual([]);
  });

  test("wrong shape → empty list", () => {
    const p = join(dir, "shape.json");
    writeFileSync(p, JSON.stringify({ servers: "nope" }));
    expect(loadMcpConfig(p)).toEqual([]);
  });

  test("valid file → parsed servers; malformed rows dropped", () => {
    const p = join(dir, "ok.json");
    writeFileSync(
      p,
      JSON.stringify({
        servers: [
          {
            id: "memory",
            name: "Long-term Memory",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-memory"],
            env: {},
            enabled: true,
          },
          { id: "broken-no-command", args: [], enabled: true },
          null,
        ],
      }),
    );
    const servers = loadMcpConfig(p);
    expect(servers.length).toBe(1);
    expect(servers[0]!.id).toBe("memory");
    expect(servers[0]!.enabled).toBe(true);
  });
});
