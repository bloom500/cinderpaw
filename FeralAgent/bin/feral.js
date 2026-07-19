#!/usr/bin/env node
// Feral launcher — cross-platform. npm guarantees node (not bun), so this thin
// shim (node) locates the bundled Rust `feral` binary for the host platform and
// execs it; the Rust binary in turn spawns the TS sidecar sitting NEXT TO it in
// the same package. The user only ever types `feral ...`; Rust/Bun/sidecar/
// gateway are internal.
//
// Distribution model (esbuild/swc-style): the platform binaries do NOT ship in
// this package. They live in per-platform packages — `feral-agent-<os>-<arch>`
// — declared as optionalDependencies. npm installs only the one whose `os`/`cpu`
// matches the host and skips the rest, so a mac user never downloads the Windows
// binary. This shim resolves whichever one got installed.
//
// ESM (package.json has "type": "module").
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ext = process.platform === "win32" ? ".exe" : "";

// 1. Production: the matching per-platform package (an optionalDependency).
const platformPkg = `feral-agent-${process.platform}-${process.arch}`;
let exe = null;
try {
  exe = require.resolve(`${platformPkg}/feral-cli${ext}`);
} catch {
  /* package not installed for this platform — fall through to the dev path */
}

// 2. Dev / manual build: binaries staged in ./vendor next to this shim
//    (what `node scripts/package-win.mjs` produces for a local Windows build).
if (!exe || !existsSync(exe)) {
  const local = join(here, "..", "vendor", `feral-cli${ext}`);
  if (existsSync(local)) exe = local;
}

if (!exe || !existsSync(exe)) {
  process.stderr.write(
    `Feral could not find its runtime for ${process.platform}-${process.arch}.\n` +
      `The matching package \`${platformPkg}\` may have failed to install ` +
      "(a blocked optional dependency, an unsupported platform, or " +
      "`--ignore-optional`).\n" +
      "Reinstall with: npm install -g feral-agent\n" +
      "Report: https://github.com/bloom500/feral/issues\n",
  );
  process.exit(1);
}

// Report a single coherent version: the npm package version is the source of
// truth. The Rust `version` command prefers FERAL_VERSION when set.
let version = "";
try {
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  version = pkg.version || "";
} catch {
  /* keep empty — Rust falls back to its compiled version */
}

const res = spawnSync(exe, process.argv.slice(2), {
  stdio: "inherit",
  env: version ? { ...process.env, FERAL_VERSION: version } : process.env,
});

if (res.error) {
  process.stderr.write(`Feral failed to launch: ${res.error.message}\n`);
  process.exit(1);
}
process.exit(res.status == null ? 1 : res.status);
