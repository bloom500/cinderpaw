#!/usr/bin/env node
// Feral launcher — SP0. npm guarantees node (not bun), so this thin shim
// (node) execs the bundled Rust `feral` binary, which in turn spawns the
// TS sidecar beside it. The user only ever types `feral ...`; Rust/Bun/
// sidecar/gateway are internal. See docs/superpowers/specs/2026-07-03-sp0-*.
//
// ESM (package.json has "type": "module").
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Windows-first. macOS/Linux ship later (per-platform packages).
if (process.platform !== "win32") {
  process.stderr.write(
    "Feral is Windows-only for now — macOS and Linux are coming.\n",
  );
  process.exit(1);
}

const exe = join(here, "..", "vendor", "feral-cli.exe");
if (!existsSync(exe)) {
  process.stderr.write(
    `Feral runtime binary not found at ${exe}\n` +
      "Try reinstalling: npm install -g feral-agent\n",
  );
  process.exit(1);
}

// Report a single coherent version: the npm package version is the source of
// truth (spec §6). The Rust `version` command prefers FERAL_VERSION.
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
