/**
 * SP0 launcher + packaging guards.
 *
 * The launcher (bin/feral.js) is glue, but it has two failure modes worth a
 * cheap net: (1) shipping a syntactically broken ESM file (the require/
 * "type":"module" trap), and (2) losing the Windows-only guard. Plus a
 * pack-manifest check so we never leak src/ or forget the binaries.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pkgDir = resolve(import.meta.dir, "..");
const launcher = resolve(pkgDir, "bin", "feral.js");

describe("launcher bin/feral.js", () => {
  test("is valid ESM node can parse (guards the require/type:module trap)", () => {
    const r = spawnSync("node", ["--check", launcher], { encoding: "utf8" });
    expect(r.status).toBe(0);
  });

  test("resolves the host's per-platform binary (cross-platform, no win-only guard)", () => {
    const src = readFileSync(launcher, "utf8");
    // The launcher resolves the matching per-platform optionalDependency by
    // host os/arch and computes the exe extension conditionally — it no longer
    // hard-guards to Windows.
    expect(src).toContain("@bloommedia/feral-agent-");
    expect(src).toContain("process.platform");
    expect(src).toContain("process.arch");
    expect(src).toContain('process.platform === "win32" ? ".exe" : ""');
    expect(src).not.toContain("Windows-only");
  });

  test("execs the vendored Rust binary, not the TS dist", () => {
    const src = readFileSync(launcher, "utf8");
    expect(src).toContain("vendor");
    // Extension is computed (feral-cli${ext}), so match the base name, not a
    // hardcoded .exe.
    expect(src).toContain("feral-cli");
    expect(src).not.toContain("dist/feral-agent");
  });
});

describe("feral update", () => {
  // The whole point of handling `update` in the shim is that it runs when the
  // Rust binary can't: Windows won't overwrite a running .exe, and a
  // half-installed machine has no binary at all. So the branch MUST sit above
  // the "could not find its runtime" bail, and it must drive npm.
  test("is intercepted by the shim, above the missing-runtime bail", () => {
    const src = readFileSync(launcher, "utf8");
    const update = src.indexOf('process.argv[2] === "update"');
    const bail = src.indexOf("could not find its runtime");
    expect(update).toBeGreaterThan(-1);
    expect(bail).toBeGreaterThan(update);
    // Updating the files on disk changes nothing for a running Discord/Slack
    // connector — the restart is the half that makes the update take effect.
    expect(src).toContain("feral-agent@latest");
    expect(src).toContain('"gateway", "restart"');
  });

  test("fails loudly with a manual fallback when npm is unreachable", () => {
    // Empty PATH ⇒ npm (and cmd.exe) cannot be spawned, which exercises the
    // failure branch without installing anything globally.
    // Absolute node path: an empty PATH would otherwise stop us launching the
    // shim at all, and the test would pass for the wrong reason.
    const r = spawnSync(process.execPath, [launcher, "update"], {
      encoding: "utf8",
      env: { ...process.env, PATH: "", Path: "" },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("npm install -g feral-agent@latest");
    expect(r.stderr).not.toContain("could not find its runtime");
  }, 30_000);
});

describe("npm pack manifest (files whitelist)", () => {
  test("ships bin, excludes src/ and dist/", () => {
    const r = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: pkgDir,
      encoding: "utf8",
      shell: true, // npm is npm.cmd on Windows
    });
    // If npm isn't available in this environment, don't fail the suite.
    if (r.status !== 0 || !r.stdout.trim().startsWith("[")) return;
    const parsed = JSON.parse(r.stdout) as Array<{ files: Array<{ path: string }> }>;
    const paths = parsed[0]!.files.map((f) => f.path);
    expect(paths.some((p) => p === "bin/feral.js")).toBe(true);
    expect(paths.some((p) => p.startsWith("src/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("dist/"))).toBe(false);
  }, 30_000); // npm pack shells out to npm.cmd — slow on Windows, well past the 5s default
});
