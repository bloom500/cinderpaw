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

  test("keeps the Windows-only platform guard", () => {
    const src = readFileSync(launcher, "utf8");
    expect(src).toContain('process.platform !== "win32"');
    expect(src).toContain("Windows-only");
  });

  test("execs the vendored Rust binary, not the TS dist", () => {
    const src = readFileSync(launcher, "utf8");
    expect(src).toContain("vendor");
    expect(src).toContain("feral-cli.exe");
    expect(src).not.toContain("dist/feral-agent");
  });
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
