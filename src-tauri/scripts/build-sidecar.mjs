#!/usr/bin/env node
/**
 * build-sidecar.mjs — rebuild the Feral Agent sidecar and copy it to
 * src-tauri/binaries/ for the Tauri dev/build step to pick up.
 *
 * D1 fix: previously every TypeScript change in FeralAgent/ required a
 * manual `bun run build` + cp to `src-tauri/binaries/`. `cargo tauri dev`
 * did not rebuild it, so first-day contributors lost hours to stale
 * binaries. This script is wired into `tauri.conf.json`'s
 * `beforeDevCommand` and `beforeBuildCommand` so cargo tauri dev/build
 * "just works" — no manual step.
 *
 * Cross-platform (Windows / macOS / Linux) — uses node:fs and node:child_process
 * only, no shell-specific syntax. The Tauri `externalBin` config expects
 * the binary to be named `feral-agent-<target-triple>.<ext>`, where the
 * triple is derived from process.platform / process.arch.
 *
 * Usage (invoked by Tauri's beforeDevCommand / beforeBuildCommand):
 *     node scripts/build-sidecar.mjs
 *
 * Env overrides:
 *     FERAL_SKIP_SIDECAR_BUILD=1   Skip the build entirely (CI cache step, etc.)
 *     FERAL_FORCE_SIDECAR_BUILD=1  Always rebuild, even if dist binary is newer
 */

import { existsSync, mkdirSync, statSync, copyFileSync, chmodSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// src-tauri/scripts → src-tauri/ (then ../FeralAgent)
const TAURI_DIR = resolve(__dirname, "..");
const REPO_ROOT = resolve(TAURI_DIR, "..");
const FERAL_AGENT_DIR = join(REPO_ROOT, "FeralAgent");
const DIST_DIR = join(FERAL_AGENT_DIR, "dist");
const BINARIES_DIR = join(TAURI_DIR, "binaries");

/** Map (platform, arch) → externalBin suffix used by Tauri. */
function targetTriple() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "win32") {
    return "x86_64-pc-windows-msvc.exe";
  }
  if (platform === "darwin" && arch === "arm64") {
    return "aarch64-apple-darwin";
  }
  if (platform === "darwin") {
    return "x86_64-apple-darwin";
  }
  if (arch === "arm64") {
    return "aarch64-unknown-linux-gnu";
  }
  return "x86_64-unknown-linux-gnu";
}

const suffix = targetTriple();
const sidecarName = `feral-agent-${suffix}`;

const distBinaryName =
  process.platform === "win32" ? "feral-agent.exe" : "feral-agent";
const distBinaryPath = join(DIST_DIR, distBinaryName);
const targetBinaryPath = join(BINARIES_DIR, sidecarName);

function log(...args) {
  // Single-line prefix keeps beforeDevCommand output scannable in the
  // Tauri dev console.
  process.stderr.write(`[build-sidecar] ${args.join(" ")}\n`);
}

function run(cmd, args, cwd) {
  log(`$ ${cmd} ${args.join(" ")} (cwd=${cwd})`);
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.status !== 0) {
    process.stderr.write(
      `[build-sidecar] ${cmd} exited with status ${res.status}\n`,
    );
    process.exit(res.status ?? 1);
  }
}

function newerThan(a, b) {
  // True when a's mtime is strictly after b's mtime.
  return statSync(a).mtimeMs > statSync(b).mtimeMs;
}

function main() {
  if (process.env.FERAL_SKIP_SIDECAR_BUILD === "1") {
    log("FERAL_SKIP_SIDECAR_BUILD=1 — skipping sidecar build");
    return;
  }

  if (!existsSync(FERAL_AGENT_DIR)) {
    log(`FATAL: FeralAgent/ not found at ${FERAL_AGENT_DIR}`);
    process.exit(1);
  }

  // Ensure output directories exist (src-tauri/binaries/ may be empty on
  // a fresh checkout; .gitkeep is not present by default).
  if (!existsSync(DIST_DIR)) {
    mkdirSync(DIST_DIR, { recursive: true });
  }
  if (!existsSync(BINARIES_DIR)) {
    mkdirSync(BINARIES_DIR, { recursive: true });
  }

  // Skip the bun build if the dist binary is already newer than every
  // FeralAgent source file. `FERAL_FORCE_SIDECAR_BUILD=1` overrides.
  let needBuild = process.env.FERAL_FORCE_SIDECAR_BUILD === "1";
  if (!needBuild && existsSync(distBinaryPath)) {
    // Cheap heuristic: if FeralAgent/src has any .ts file newer than the
    // dist binary, rebuild. We only walk one level deep — this is good
    // enough for the typical "I just edited a TS file" trigger.
    const distMtime = statSync(distBinaryPath).mtimeMs;
    // Glob the FeralAgent source tree via a tiny shell-free walk.
    const srcRoot = join(FERAL_AGENT_DIR, "src");
    const isStale = walkIsStale(srcRoot, distMtime);
    if (isStale) {
      needBuild = true;
    } else {
      log(`dist binary is up to date (${distBinaryPath}); skipping build`);
    }
  } else {
    needBuild = true;
  }

  if (needBuild) {
    run("bun", ["run", "build"], FERAL_AGENT_DIR);
  }

  if (!existsSync(distBinaryPath)) {
    log(
      `FATAL: expected dist binary at ${distBinaryPath} after build, but it does not exist.`,
    );
    process.exit(1);
  }

  copyFileSync(distBinaryPath, targetBinaryPath);
  // POSIX needs the executable bit set; Windows ignores it but it's
  // harmless. Tauri copies externalBin into the resource dir at install
  // time on Windows, where ACLs handle the executable bit.
  if (process.platform !== "win32") {
    try {
      chmodSync(targetBinaryPath, 0o755);
    } catch {
      // best effort
    }
  }
  log(`copied → ${targetBinaryPath}`);

  // Also copy next to the gateway exe (target/{release,debug}/) so dev
  // builds (`cargo build -p feral-cli` from the repo root, or
  // `cargo tauri dev`) don't get stuck on a stale sidecar sitting there.
  // `find_binary()` probes next to `current_exe` FIRST and matches the
  // plain name `feral-agent.exe` over the triple-suffixed copy under
  // `src-tauri/binaries/`, so any stale plain-named copy wins and
  // shadows the fresh build. Keeping the target dir in sync on every
  // rebuild closes that gap. See the B7 smoke
  // (docs/2026-07-09-l4-b7-smoke.md, "stale sidecar shadowing").
  const sidecarTargetDirs = [];
  if (process.env.CARGO_TARGET_DIR) {
    const ct = resolve(process.env.CARGO_TARGET_DIR);
    sidecarTargetDirs.push(join(ct, "release"), join(ct, "debug"));
  } else {
    sidecarTargetDirs.push(
      join(REPO_ROOT, "target", "release"),
      join(REPO_ROOT, "target", "debug"),
      join(TAURI_DIR, "target", "release"),
      join(TAURI_DIR, "target", "debug"),
    );
  }
  for (const dir of sidecarTargetDirs) {
    if (!existsSync(dir)) continue;
    const dest = join(dir, distBinaryName);
    try {
      copyFileSync(distBinaryPath, dest);
      if (process.platform !== "win32") {
        try {
          chmodSync(dest, 0o755);
        } catch {
          // best effort
        }
      }
      log(`copied → ${dest}`);
    } catch (e) {
      // best effort — the target-dir copy is dev-only hygiene; the
      // canonical copy under src-tauri/binaries/ is what Tauri bundles.
      log(`warn: could not copy to ${dest}: ${e.message}`);
    }
  }
}

function walkIsStale(dir, cutoffMtime) {
  // Tiny iterative walker — avoids pulling in fast-glob / fs-extra.
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) {
        // Skip dist and node_modules — they are outputs / vendored deps.
        if (e.name === "dist" || e.name === "node_modules" || e.name === ".git") continue;
        stack.push(p);
      } else if (e.isFile()) {
        // .md matters too: SOUL/IDENTITY/AGENTS.md are compile-time text
        // imports embedded into the binary (soul-loader.ts).
        if (!e.name.endsWith(".ts") && !e.name.endsWith(".json") && !e.name.endsWith(".md")) continue;
        // package.json + tsconfig.json + every .ts/.md file in src/
        try {
          if (statSync(p).mtimeMs > cutoffMtime) return true;
        } catch {
          // ignore unreadable files
        }
      }
    }
  }
  return false;
}

main();
