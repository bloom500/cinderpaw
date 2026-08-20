#!/usr/bin/env node
/**
 * build-sidecar.mjs — rebuild the Feral Agent sidecar and copy it to
 * src-tauri/binaries/ for the Tauri dev/build step to pick up.
 *
 * D1 fix: previously every TypeScript change in CinderpawAgent/ required a
 * manual `bun run build` + cp to `src-tauri/binaries/`. `cargo tauri dev`
 * did not rebuild it, so first-day contributors lost hours to stale
 * binaries. This script is wired into `tauri.conf.json`'s
 * `beforeDevCommand` and `beforeBuildCommand` so cargo tauri dev/build
 * "just works" — no manual step.
 *
 * Cross-platform (Windows / macOS / Linux) — uses node:fs and node:child_process
 * only, no shell-specific syntax. The Tauri `externalBin` config expects
 * the binary to be named `cinderpaw-agent-<target-triple>.<ext>`, where the
 * triple is derived from process.platform / process.arch.
 *
 * Usage (invoked by Tauri's beforeDevCommand / beforeBuildCommand):
 *     node scripts/build-sidecar.mjs
 *
 * Env overrides:
 *     FERAL_SKIP_SIDECAR_BUILD=1   Skip the build entirely (CI cache step, etc.)
 *     FERAL_FORCE_SIDECAR_BUILD=1  Always rebuild, even if dist binary is newer
 *     FERAL_SIDECAR_TARGET=<rust-triple>
 *         Build the sidecar FOR that target instead of for this machine.
 *         Needed by the macOS Intel release build, which cross-compiles
 *         x86_64 from an Apple Silicon runner because GitHub no longer
 *         provisions Intel macOS runners. Without it the sidecar would be
 *         named for the host triple (so Tauri's externalBin lookup misses it)
 *         AND be the host's architecture (so it could not run on the machine
 *         the app is built for). Bun cross-compiles standalone binaries, so
 *         both halves are fixable; we just have to ask it to.
 */

import { existsSync, mkdirSync, statSync, copyFileSync, chmodSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// src-tauri/scripts → src-tauri/ (then ../CinderpawAgent)
const TAURI_DIR = resolve(__dirname, "..");
const REPO_ROOT = resolve(TAURI_DIR, "..");
const FERAL_AGENT_DIR = join(REPO_ROOT, "CinderpawAgent");
const DIST_DIR = join(FERAL_AGENT_DIR, "dist");
const BINARIES_DIR = join(TAURI_DIR, "binaries");

/** Map (platform, arch) → the Rust target triple of THIS machine. */
function hostTriple() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "win32") {
    return "x86_64-pc-windows-msvc";
  }
  if (platform === "darwin") {
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  return arch === "arm64"
    ? "aarch64-unknown-linux-gnu"
    : "x86_64-unknown-linux-gnu";
}

/** Rust target triple → the `bun build --compile --target` name. */
function bunTargetFor(triple) {
  const map = {
    "x86_64-pc-windows-msvc": "bun-windows-x64",
    "x86_64-apple-darwin": "bun-darwin-x64",
    "aarch64-apple-darwin": "bun-darwin-arm64",
    "x86_64-unknown-linux-gnu": "bun-linux-x64",
    "aarch64-unknown-linux-gnu": "bun-linux-arm64",
  };
  const t = map[triple];
  if (!t) {
    process.stderr.write(
      `[build-sidecar] FATAL: no bun target known for "${triple}"\n`,
    );
    process.exit(1);
  }
  return t;
}

const HOST_TRIPLE = hostTriple();
const TRIPLE = process.env.FERAL_SIDECAR_TARGET || HOST_TRIPLE;
const CROSS = TRIPLE !== HOST_TRIPLE;
const BUN_TARGET = bunTargetFor(TRIPLE);
const IS_WINDOWS_TARGET = TRIPLE.includes("windows");

// Tauri's externalBin appends the triple, and `.exe` on Windows.
const suffix = IS_WINDOWS_TARGET ? `${TRIPLE}.exe` : TRIPLE;
const sidecarName = `cinderpaw-agent-${suffix}`;

const distBinaryName = IS_WINDOWS_TARGET ? "cinderpaw-agent.exe" : "cinderpaw-agent";
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
    log(`FATAL: CinderpawAgent/ not found at ${FERAL_AGENT_DIR}`);
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
  // CinderpawAgent source file. `FERAL_FORCE_SIDECAR_BUILD=1` overrides.
  //
  // A cross-build always rebuilds: a dist binary left over from a native build
  // is the WRONG ARCHITECTURE, and mtime cannot see that. Shipping it would
  // produce an app whose sidecar cannot execute on the machine it was built
  // for — and the failure would only show up on a user's Intel Mac.
  let needBuild = process.env.FERAL_FORCE_SIDECAR_BUILD === "1" || CROSS;
  if (!needBuild && existsSync(distBinaryPath)) {
    // Cheap heuristic: if CinderpawAgent/src has any .ts file newer than the
    // dist binary, rebuild. We only walk one level deep — this is good
    // enough for the typical "I just edited a TS file" trigger.
    const distMtime = statSync(distBinaryPath).mtimeMs;
    // Glob the CinderpawAgent source tree via a tiny shell-free walk.
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
    if (CROSS) {
      log(`cross-compiling sidecar: ${HOST_TRIPLE} → ${TRIPLE} (${BUN_TARGET})`);
    }
    // Spelled out rather than `bun run build` so the target can be passed. The
    // flags mirror CinderpawAgent/package.json's "build" script; keep them in step.
    run(
      "bun",
      [
        "build",
        "src/index.ts",
        "--compile",
        `--target=${BUN_TARGET}`,
        "--outfile",
        join("dist", distBinaryName),
      ],
      FERAL_AGENT_DIR,
    );
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
  // builds (`cargo build -p cinderpaw-cli` from the repo root, or
  // `cargo tauri dev`) don't get stuck on a stale sidecar sitting there.
  // `find_binary()` probes next to `current_exe` FIRST and matches the
  // plain name `cinderpaw-agent.exe` over the triple-suffixed copy under
  // `src-tauri/binaries/`, so any stale plain-named copy wins and
  // shadows the fresh build. Keeping the target dir in sync on every
  // rebuild closes that gap. See the B7 smoke
  // (docs/2026-07-09-l4-b7-smoke.md, "stale sidecar shadowing").
  // Dev-only hygiene, and actively wrong on a cross build: it would drop a
  // foreign-architecture binary where `find_binary()` probes first, shadowing
  // the real one for anything run on THIS machine afterwards.
  if (CROSS) {
    log("cross build — skipping the dev target-dir copies");
    return;
  }

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
