#!/usr/bin/env node
// SP0 packaging (Windows-first, manual). Populates FeralAgent/vendor/ with the
// two prebuilt binaries the npm package ships, then you `npm publish`.
//
//   node scripts/package-win.mjs        # build both + stage vendor/
//   node scripts/package-win.mjs --pack # also run `npm pack` to inspect
//
// Publishing is manual from a Windows machine: publish-npm.yml runs on ubuntu
// and can't cross-build the Windows binaries. A CI matrix is deferred until the
// macOS/Linux per-platform packages land (spec §7). See
// docs/superpowers/specs/2026-07-03-sp0-unify-feral-cli-design.md.

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
console.log("── building feral-cli.exe (Rust, release) ──");
run("cargo build --release -p feral-cli", repoRoot);
const targetDir = process.env.CARGO_TARGET_DIR
  ? resolve(process.env.CARGO_TARGET_DIR)
  : join(repoRoot, "target");
const cliSrc = join(targetDir, "release", "feral-cli.exe");
if (!existsSync(cliSrc)) {
  console.error(`\nferal-cli.exe not found at ${cliSrc} — did the build succeed?`);
  process.exit(1);
}
copyFileSync(cliSrc, join(vendor, "feral-cli.exe"));

// 2. TS sidecar (bun --compile). The plain name `feral-agent.exe` is what the
//    Rust find_binary() looks for beside the main executable.
console.log("\n── building feral-agent.exe (sidecar, bun --compile) ──");
run("bun build src/index.ts --compile --outfile vendor/feral-agent.exe", pkgDir);
const sidecar = join(vendor, "feral-agent.exe");
if (!existsSync(sidecar)) {
  console.error(`\nferal-agent.exe not found at ${sidecar} — did bun --compile succeed?`);
  process.exit(1);
}

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(1);
console.log(
  `\n✓ vendor staged:\n` +
    `    feral-cli.exe    ${mb(join(vendor, "feral-cli.exe"))} MB\n` +
    `    feral-agent.exe  ${mb(sidecar)} MB`,
);

if (process.argv.includes("--pack")) {
  run("npm pack", pkgDir);
}

console.log("\nNext: `npm publish` from FeralAgent/ (needs NPM_TOKEN in env).");
