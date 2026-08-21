#!/usr/bin/env node
// Local Windows dev helper. Populates CinderpawAgent/vendor/ with the two prebuilt
// binaries so `node bin/cinderpaw.js ...` works from a source checkout (bin/cinderpaw.js
// falls back to vendor/ when no per-platform package is installed).
//
// ⚠️ This is NO LONGER the publish path. npm distribution is cross-platform and
// runs in CI (.github/workflows/publish-npm.yml): it builds all four
// per-platform packages and the umbrella `cinderpaw-agent`. Do NOT `npm publish`
// from here — `vendor/` is not in the package `files` anymore, so a manual
// publish would ship an umbrella with no binaries. Cut a `cinderpaw-agent-v*` tag
// (or run the workflow) instead.
//
//   node scripts/package-win.mjs        # build both + stage vendor/ (local dev)
//   node scripts/package-win.mjs --pack # also run `npm pack` to inspect
//
// Publishing is manual from a Windows machine: publish-npm.yml runs on ubuntu
// and can't cross-build the Windows binaries. A CI matrix is deferred until the
// macOS/Linux per-platform packages land (spec §7). See
// docs/superpowers/specs/2026-07-03-sp0-unify-cinderpaw-cli-design.md.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pkgDir, "..");
const vendor = join(pkgDir, "vendor");

if (process.platform !== "win32") {
  console.error("package-win.mjs builds the Windows binaries — run it on Windows.");
  process.exit(1);
}

const run = (cmd, cwd) => {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
};

mkdirSync(vendor, { recursive: true });

// 1. Rust CLI (release). Honor CARGO_TARGET_DIR if set (path-length workaround),
//    else the default workspace target/.
console.log("── building cinderpaw-cli.exe (Rust, release) ──");
run("cargo build --release -p cinderpaw-cli", repoRoot);
const targetDir = process.env.CARGO_TARGET_DIR
  ? resolve(process.env.CARGO_TARGET_DIR)
  : join(repoRoot, "target");
const cliSrc = join(targetDir, "release", "cinderpaw-cli.exe");
if (!existsSync(cliSrc)) {
  console.error(`\ncinderpaw-cli.exe not found at ${cliSrc} — did the build succeed?`);
  process.exit(1);
}
copyFileSync(cliSrc, join(vendor, "cinderpaw-cli.exe"));

// 2. TS sidecar (bun --compile). The plain name `cinderpaw-agent.exe` is what the
//    Rust find_binary() looks for beside the main executable.
console.log("\n── building cinderpaw-agent.exe (sidecar, bun --compile) ──");
run("bun build src/index.ts --compile --outfile vendor/cinderpaw-agent.exe", pkgDir);
const sidecar = join(vendor, "cinderpaw-agent.exe");
if (!existsSync(sidecar)) {
  console.error(`\ncinderpaw-agent.exe not found at ${sidecar} — did bun --compile succeed?`);
  process.exit(1);
}

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(1);
console.log(
  `\n✓ vendor staged:\n` +
    `    cinderpaw-cli.exe    ${mb(join(vendor, "cinderpaw-cli.exe"))} MB\n` +
    `    cinderpaw-agent.exe  ${mb(sidecar)} MB`,
);

if (process.argv.includes("--pack")) {
  run("npm pack", pkgDir);
}

console.log("\nNext: `npm publish` from CinderpawAgent/ (needs NPM_TOKEN in env).");
