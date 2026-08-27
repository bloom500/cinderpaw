#!/usr/bin/env node
/**
 * scripts/boot-stability-observation.mjs
 *
 * Boots the sidecar binary in a clean isolated homedir for N seconds and
 * logs every line it emits on stderr. The goal is to see whether the
 * binary reaches a steady state without panics, retries, repeated
 * errors, or stack traces. Used for the pre-release stability audit;
 * not a test, not part of CI — exit-0 means "observed for N seconds".
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(__filename, "..", "..");
const binaryPath = join(
  repoRoot,
  "src-tauri",
  "binaries",
  "feral-agent-x86_64-pc-windows-msvc.exe",
);

if (!existsSync(binaryPath)) {
  console.error(`✗ sidecar binary missing at ${binaryPath}`);
  process.exit(2);
}

const workDir = mkdtempSync(join(tmpdir(), "feral-boot-obs-"));
const observeMs = 8_000;

const child = spawn(binaryPath, [], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    USERPROFILE: workDir,
    HOME: workDir,
    CINDERPAW_DB: ":memory:",
    CINDERPAW_WORKSPACE: workDir,
    // Keep RSI passive off; nothing should fire during the window.
    CINDERPAW_RSI_PASSIVE: "false",
    CINDERPAW_RSI_IDLE_MS: "180000",
    CINDERPAW_PROACTIVE_ENABLED: "false",
    CINDERPAW_RUN_FRACTAL_BENCH: "",
    CINDERPAW_MODEL: "",
  },
});

const stderrLines = [];
const stdoutLines = [];
const stdoutBuf = "";

child.stdout.on("data", (chunk) => {
  const txt = chunk.toString("utf8");
  for (const l of txt.split(/\r?\n/)) if (l.trim()) stdoutLines.push(l.trim());
});

child.stderr.on("data", (chunk) => {
  const txt = chunk.toString("utf8");
  process.stderr.write(`  [stderr] ${txt.trimEnd()}\n`);
  for (const l of txt.split(/\r?\n/)) if (l.trim()) stderrLines.push(l.trim());
});

console.log(
  `[boot-obs] binary=${binaryPath}\n` +
    `[boot-obs] workdir=${workDir}\n` +
    `[boot-obs] observing for ${observeMs}ms\n`,
);

const timer = setTimeout(() => {
  try {
    child.stdin.write(JSON.stringify({ type: "shutdown" }) + "\n");
  } catch {
    // already closed
  }
  const kill = setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }, 2_000);
  child.on("exit", () => clearTimeout(kill));
}, observeMs);

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  const errorishLines = stderrLines.filter(
    (l) =>
      /panic|stack.?trace|unhandled|error|exception|abort/i.test(l) &&
      !/no error/i.test(l),
  );
  const readyRegex = /transport=tauri.*model=.*workspace=/;
  const readySeen = stderrLines.some((l) => readyRegex.test(l));

  console.log("");
  console.log(`[boot-obs] process exited code=${code} signal=${signal}`);
  console.log(`[boot-obs] stderr lines total : ${stderrLines.length}`);
  console.log(`[boot-obs] stdout lines total : ${stdoutLines.length}`);
  console.log(`[boot-obs] saw "ready" line   : ${readySeen ? "yes" : "no"}`);
  console.log(
    `[boot-obs] error-shaped lines  : ${errorishLines.length}` +
      (errorishLines.length > 0
        ? `\n  ${errorishLines.slice(0, 8).join("\n  ")}`
        : ""),
  );
  if (stdoutLines.length > 0) {
    console.log(`[boot-obs] stdout (first 4):`);
    for (const l of stdoutLines.slice(0, 4)) console.log(`  ${l}`);
  }
  console.log("");
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
  process.exit(0);
});
