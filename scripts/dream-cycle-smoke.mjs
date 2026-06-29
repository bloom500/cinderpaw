#!/usr/bin/env node
/**
 * scripts/dream-cycle-smoke.mjs
 *
 * D2 — Dream Cycle LIVE smoke test against the real sidecar binary.
 *
 * The dream-cycle-e2e unit test exercises the in-process wiring (real
 * RsiSidecar, real DreamScheduler, real telemetry JSONL), but never
 * boots the actual binary. This script does:
 *
 *   1. Spawns the just-built sidecar .exe with the documented live-smoke
 *      env knobs (idle=5s, poll=1s, cooldown=1s).
 *   2. Drives the binary over its real newline-delimited-JSON transport
 *      (what Tauri's externalBin piping looks like).
 *   3. Watches for: "rsi dream: arming event-driven scheduler" on stderr
 *      and {type:"dream_cycle", phase:"started"|"ended"} on stdout.
 *   4. Reads the per-episode telemetry JSONL the sidecar wrote.
 *   5. Verifies started, ended, and the JSONL record landed.
 *
 * The engine won't reach a real RSI host (no Tauri / Rust rsi_response),
 * so it bails out quickly with stopReason="error" — that's fine: a
 * fast-failing idle trigger still proves the scheduler → started →
 * engine → onIdle → ended → telemetry path is intact on the LIVE
 * binary, not just in the unit test.
 *
 * Exit 0 = pass. Non-zero = something didn't happen in time.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
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
  console.error(
    `✗ sidecar binary not found at ${binaryPath}\n` +
      `  Run: cd FeralAgent && bun run build && cp dist/feral-agent.exe ` +
      `${binaryPath}`,
  );
  process.exit(2);
}

const workDir = mkdtempSync(join(tmpdir(), "feral-d2-smoke-"));
const telemetryPath = join(workDir, "dream.jsonl");
const dbPath = ":memory:";

console.log(`[d2-smoke] binary:      ${binaryPath}`);
console.log(`[d2-smoke] work dir:    ${workDir}`);
console.log(`[d2-smoke] telemetry:   ${telemetryPath}`);
console.log(`[d2-smoke] db:          ${dbPath}`);
console.log("");

const child = spawn(
  binaryPath,
  [], // the sidecar reads env, not argv; no flag to pass
  {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      // Redirect the sidecar's os.homedir() to our temp dir so we don't
      // pollute the real ~/.feral. Node's `os.homedir()` reads USERPROFILE
      // on Windows; HOME is unset here to avoid surprises.
      USERPROFILE: workDir,
      HOME: workDir,
      FERAL_DB: dbPath,
      FERAL_WORKSPACE: workDir,
      FERAL_RSI_TELEMETRY: telemetryPath,
      // Fast dream cycle so the test takes ~10s, not the 3-min default.
      FERAL_RSI_IDLE_MS: "5000",
      FERAL_RSI_POLL_MS: "1000",
      FERAL_RSI_COOLDOWN_MS: "1000",
      // Real model name so shouldAutostartPassive() doesn't bail.
      // The endpoint may not exist; an HTTP failure to 127.0.0.1:11435
      // makes the engine fail fast and emit "ended" with stopReason="error".
      FERAL_MODEL: "qwen2.5:7b",
      FERAL_BASE_URL: "http://127.0.0.1:11435",
      // Disable the inner-thoughts / heartbeat side loops that the smoke
      // doesn't need; quiet stderr makes the asserts cleaner.
      FERAL_PROACTIVE_ENABLED: "false",
      // No benchmarks / no fractal rebuild.
      FERAL_RUN_FRACTAL_BENCH: "",
    },
  },
);

const startedEvents = [];
const endedEvents = [];
const stderrLines = [];
let stdoutBuf = "";

const armingLineRe = /rsi dream: arming event-driven scheduler/;
const rsiEngineEvents = [];

/** Default response payloads for an RSI method. Mirrors the in-process
 *  FakeBridge used by the dream-cycle-e2e unit test so the LIVE binary
 *  sees responses that drive a single full idle-triggered episode to
 *  completion (without needing a real Rust host or a real model). */
function defaultRsiResponse(method) {
  switch (method) {
    case "rsi_get_tier0_specs":
      return {
        ok: true,
        data: [
          {
            id: "tier0/fake",
            name: "fake",
            description: "fake",
            prompt: "fake?",
            kind: "fact_lookup",
            expected: { type: "fact_lookup", answer: "ok" },
          },
        ],
      };
    case "rsi_score":
      return { ok: true, data: { score: 50 } };
    case "rsi_commit_genome":
      return { ok: true, data: { commitHash: "x".repeat(40) } };
    case "rsi_ratchet_attempt":
      return {
        ok: true,
        data: {
          advanced: false,
          previous_tip: "y".repeat(40),
          new_tip: null,
          candidate_score: 50,
          prior_score: 0,
        },
      };
    case "rsi_lca":
      return { ok: true, data: { lca: null } };
    case "rsi_log":
      return { ok: true, data: [] };
    case "rsi_diff":
      return { ok: true, data: "" };
    default:
      return { ok: true, data: null };
  }
}

function handleLine(line) {
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // non-JSON line; ignore
  }
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "dream_cycle") {
    if (msg.phase === "started") startedEvents.push(msg);
    else if (msg.phase === "ended") endedEvents.push(msg);
  } else if (msg.type === "rsi_request" && typeof msg.method === "string") {
    // Stand-in for the Tauri / Rust host: answer every RSI call so the
    // engine makes progress. Engine then converges on the plateau and
    // ends the episode — emitting the `dream_cycle ended` event the
    // smoke is here to verify.
    const resp = defaultRsiResponse(msg.method);
    const reply = JSON.stringify({
      type: "rsi_response",
      id: msg.id,
      ...resp,
    });
    try {
      child.stdin.write(reply + "\n");
    } catch {
      // pipe may be closed after shutdown
    }
  } else if (msg.type === "rsi_engine_event") {
    rsiEngineEvents.push(msg);
  }

  // Engine emitted the "ended" event — start watching for the telemetry
  // line so we can resolve as soon as both have landed.
  maybeEarlyResolve();
}

child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString("utf8");
  let idx;
  while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    handleLine(line);
  }
});

child.stderr.on("data", (chunk) => {
  const txt = chunk.toString("utf8");
  for (const line of txt.split(/\r?\n/)) {
    if (!line) continue;
    stderrLines.push(line);
  }
});

const timeoutMs = 60_000;
const startedAt = Date.now();
const deadline = startedAt + timeoutMs;

let resolved = false;
let timer = setTimeout(async () => {
  if (resolved) return;
  resolved = true;
  console.error(`[d2-smoke] TIMEOUT after ${timeoutMs}ms without full pipeline`);
  await finish(1);
}, timeoutMs);

/** The smoke PASSES as soon as the binary has emitted both the
 *  `dream_cycle` "ended" event AND written the corresponding telemetry
 *  record to disk. Start polling for that condition once we've seen the
 *  "ended" event. */
let earlyResolveInterval = null;
function maybeEarlyResolve() {
  if (resolved) return;
  if (earlyResolveInterval) return;
  if (endedEvents.length === 0) return;
  // Telemetry file is written synchronously from `onEpisodeEnd` right
  // before the "ended" event is emitted (see dream-cycle.ts onEpisodeEnd
  // — appendDreamTelemetry → send({phase:"ended"})). Give it a tick to
  // flush, then check.
  earlyResolveInterval = setInterval(() => {
    if (resolved) {
      clearInterval(earlyResolveInterval);
      return;
    }
    try {
      if (existsSync(telemetryPath)) {
        const content = readFileSync(telemetryPath, "utf8").trim();
        if (content) {
          // We have it — resolve now.
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          clearInterval(earlyResolveInterval);
          earlyResolveInterval = null;
          resolved = true;
          void finish(0);
        }
      }
    } catch {
      // file may be momentarily locked; just retry next tick
    }
  }, 50);
}

async function finish(exitCode) {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!child.killed) {
    try {
      child.stdin.write(JSON.stringify({ type: "shutdown" }) + "\n");
    } catch {
      // stdin may already be closed
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }, 3_000);
    try {
      await new Promise((resolveExit) => {
        child.on("exit", () => resolveExit());
        setTimeout(resolveExit, 4_000);
      });
    } finally {
      clearTimeout(killTimer);
    }
  }
  // Allow trailing stdout to flush.
  await new Promise((r) => setTimeout(r, 250));

  const armingOk = stderrLines.some((l) => armingLineRe.test(l));
  const started = startedEvents[0];
  const ended = endedEvents[0];
  let telemetryOk = false;
  let telemetryRec = null;
  if (existsSync(telemetryPath)) {
    try {
      const content = readFileSync(telemetryPath, "utf8").trim();
      if (content) {
        const lines = content.split("\n").filter(Boolean);
        if (lines.length >= 1) {
          telemetryRec = JSON.parse(lines[0]);
          telemetryOk =
            typeof telemetryRec.startedAt === "number" &&
            typeof telemetryRec.endedAt === "number" &&
            typeof telemetryRec.trigger === "string" &&
            typeof telemetryRec.stopReason === "string";
        }
      }
    } catch (e) {
      console.error(`[d2-smoke] could not read telemetry: ${String(e)}`);
    }
  }

  const startedEvt = rsiEngineEvents.find((e) => e.event === "started");
  const stoppedEvt = rsiEngineEvents.find((e) => e.event === "stopped");

  const checks = [
    ["stderr: arming event-driven scheduler", armingOk],
    [
      `stdout: dream_cycle started (${started ? `trigger=${started.trigger}` : "missing"})`,
      !!started,
    ],
    [
      `stdout: dream_cycle ended (${ended ? `stopReason=${ended.stopReason ?? "(unset)"}` : "missing"})`,
      !!ended,
    ],
    [
      `stdout: rsi_engine_event started (${startedEvt ? `concurrency=${startedEvt.concurrency}` : "missing"})`,
      !!startedEvt,
    ],
    [
      `stdout: rsi_engine_event stopped (${stoppedEvt ? `iterations=${stoppedEvt.iteration} reason=${stoppedEvt.stopReason}` : "missing"})`,
      !!stoppedEvt,
    ],
    [`telemetry: JSONL line recorded`, telemetryOk],
  ];

  console.log("");
  console.log("[d2-smoke] checks:");
  let allPass = true;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? "✓" : "✗"} ${name}`);
    if (!ok) allPass = false;
  }

  if (telemetryRec) {
    console.log("");
    console.log("[d2-smoke] telemetry record:");
    console.log(JSON.stringify(telemetryRec, null, 2));
  }

  // Dump the most recent stderr for diagnosis if anything failed.
  if (!allPass) {
    console.log("");
    console.log("[d2-smoke] recent stderr:");
    for (const l of stderrLines.slice(-30)) {
      console.log(`  ${l}`);
    }
  }

  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
  console.log("");
  console.log(
    allPass
      ? "[d2-smoke] PASS — Dream Cycle live wiring fired end-to-end on the real sidecar binary."
      : `[d2-smoke] FAIL (exit=${exitCode === 0 ? 0 : 1})`,
  );
  process.exit(allPass ? 0 : 1);
}

child.on("exit", (code, signal) => {
  if (resolved) return;
  // The binary exiting on its own (e.g. crash) counts as failure unless
  // we already collected both events before exit.
  const gotBoth = startedEvents.length > 0 && endedEvents.length > 0;
  resolved = true;
  console.error(
    `[d2-smoke] binary exited (code=${code}, signal=${signal}) ` +
      `before pipeline completion; started=${startedEvents.length} ended=${endedEvents.length}`,
  );
  if (gotBoth) {
    void finish(0);
  } else {
    void finish(2);
  }
});

// Helper to make sure the script can complete within the deadline.
void Promise.resolve().then(() => {
  // no-op anchor; the real wait is the setTimeout above.
});
