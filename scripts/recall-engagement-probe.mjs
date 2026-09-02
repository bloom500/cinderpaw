#!/usr/bin/env node
/**
 * Recall engagement probe — does memory answer, on a second turn, unasked?
 *
 * The unit tests prove the loop calls the recaller and that the block reaches
 * the request. This proves the whole chain on the real binary path: sidecar
 * boot, the live FractalMemory (not a stub recaller), episodic writes from
 * turn one, and the injected block on turn two.
 *
 * It matters because the failure it guards against was invisible for months.
 * The agent loop held a memory handle and only ever wrote to it, so a run
 * accumulated memory and never read any: on TheAgentCompany that showed up as
 * 12 leaf-write pulses and zero recalls, and the "memory ON" arm of a
 * benchmark measured nothing but its own overhead.
 *
 * No model and no money: the sidecar talks to a loopback stub that returns a
 * fixed completion and records every request body. What is asserted is what
 * the agent SENT, which is the only thing the model could have read.
 *
 *   node scripts/recall-engagement-probe.mjs
 *
 * Exit 0 = memory engaged. Non-zero = it did not, and the message says which
 * link broke.
 */

import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIDECAR_ENTRY = join(ROOT, "CinderpawAgent", "src", "index.ts");
const PORT = Number(process.env.RECALL_PROBE_PORT ?? 8793);

// Turn one plants a fact. Turn two asks about it from a DIFFERENT session.
//
// The different session is the whole design. Asking again inside one session
// proves nothing: the transcript already carries turn one, so the fact appears
// in the request whether memory works or not. The first draft of this probe
// did exactly that and printed OK against a prompt containing no recalled
// block at all — the same false positive the runtime had been living with.
// Across sessions the transcript is empty, so the fact can only arrive through
// memory. That is also the case that matters: TheAgentCompany runs each task
// in its own session, which is where cross-task carry was measured at nil.
const FACT = "The staging database password is kept in vault/staging/db.";
const TURN_ONE = `Remember this for later: ${FACT} Just acknowledge it.`;
const TURN_TWO = "Where is the staging database password kept?";
const SESSION_ONE = "recall-probe-a";
const SESSION_TWO = "recall-probe-b";

const captured = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      captured.push(JSON.parse(body));
    } catch {
      captured.push({ unparseable: body.slice(0, 300) });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "recall-probe",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "recall-probe-stub",
        choices: [{ index: 0, message: { role: "assistant", content: "noted" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
});

/**
 * Find a real bun executable.
 *
 * Bare "bun" is not spawnable on Windows: npm installs it as a shell script
 * plus a .cmd shim with no .exe on PATH, and node's spawn without a shell
 * cannot run either. Mirrors walkaway-bench's resolver rather than importing
 * it, so this probe stays runnable on its own.
 */
function resolveBun() {
  if (process.env.CINDERPAW_BENCH_BUN) return process.env.CINDERPAW_BENCH_BUN;
  const probe = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["bun"], {
    encoding: "utf8",
  });
  const hits = (probe.stdout ?? "")
    .split(String.fromCharCode(10))
    .map((l) => l.trim())
    .filter(Boolean);
  const exe = hits.find((h) => h.toLowerCase().endsWith(".exe"));
  if (exe) return exe;
  for (const hit of hits) {
    const real = join(dirname(hit), "node_modules", "bun", "bin", "bun.exe");
    if (existsSync(real)) return real;
  }
  return hits[0] ?? "bun";
}

/** Everything the agent sent in request `n`, as one searchable string. */
function requestText(req) {
  if (!req || !Array.isArray(req.messages)) return "";
  return req.messages
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

async function main() {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

  const home = mkdtempSync(join(tmpdir(), "recall-probe-"));
  const workspace = join(home, "ws");
  mkdirSync(workspace, { recursive: true });

  console.log(`recall engagement probe — stub on http://127.0.0.1:${PORT}`);
  console.log(`profile: ${home}`);

  const child = spawn(resolveBun(), [SIDECAR_ENTRY], {
    cwd: workspace,
    env: {
      ...process.env,
      CINDERPAW_HOME: home,
      CINDERPAW_WORKSPACE: workspace,
      CINDERPAW_AUTONOMOUS: "true",
      CINDERPAW_PROVIDER: "openai_compatible",
      CINDERPAW_BASE_URL: `http://127.0.0.1:${PORT}`,
      CINDERPAW_MODEL: "recall-probe-stub",
      CINDERPAW_API_KEY: "recall-probe",
      CINDERPAW_TRUSTED_LOCAL_ORIGINS: `http://127.0.0.1:${PORT}`,
      CINDERPAW_HTTP_DOMAINS: "127.0.0.1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderr = [];
  child.stderr.on("data", (c) => {
    const t = c.toString();
    stderr.push(t);
    if (process.env.RECALL_PROBE_VERBOSE) process.stderr.write(t);
  });

  /** Send one message and resolve on its terminal `done`. */
  const turn = (content, id, sessionId) =>
    new Promise((done, fail) => {
      let buf = "";
      const timer = setTimeout(() => fail(new Error(`turn ${id} timed out`)), 90_000);
      const onData = (chunk) => {
        buf += chunk.toString();
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("{")) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === "done" && !ev.incomplete) {
            clearTimeout(timer);
            child.stdout.off("data", onData);
            done(ev);
            return;
          }
          if (ev.type === "error") {
            clearTimeout(timer);
            child.stdout.off("data", onData);
            fail(new Error(`sidecar error on turn ${id}: ${ev.message}`));
            return;
          }
        }
      };
      child.stdout.on("data", onData);
      child.stdin.write(
        JSON.stringify({ type: "message", id, sessionId, content }) + "\n",
      );
    });

  let failure = null;
  try {
    await turn(TURN_ONE, "t1", SESSION_ONE);
    // Settle before asking. The turn's `done` event is emitted from the agent
    // loop, and the post-turn memory work (the assistant row, the extractor,
    // the fractal leaf) finishes just after it — so a second turn sent the
    // instant `done` arrives can race the write it is about to look for. This
    // probe ran green and red on identical code until the wait went in.
    //
    // A person cannot hit this: nobody types the next message inside a
    // millisecond. A benchmark harness can, which is exactly the setting this
    // probe exists to model, so it is worth naming rather than tuning away.
    await new Promise((r) => setTimeout(r, 2000));

    const beforeTurnTwo = captured.length;
    await turn(TURN_TWO, "t2", SESSION_TWO);

    const turnTwoRequests = captured.slice(beforeTurnTwo);
    const text = turnTwoRequests.map(requestText).join("\n");

    const sawMemoryBlock = text.includes("[Memory context]");
    const sawTheFact = text.includes("vault/staging/db");

    console.log(`\nrequests captured: ${captured.length} (turn two: ${turnTwoRequests.length})`);
    console.log(`  memory block present on turn two: ${sawMemoryBlock ? "YES" : "NO"}`);
    console.log(`  the fact from turn one carried:   ${sawTheFact ? "YES" : "NO"}`);

    // WHERE the fact appears decides which subsystem actually carried it, and
    // that is the difference between a working memory read and a coincidence.
    // A fact reproduced by the notebook drawer, a rehydrated transcript or a
    // tool result is not recall, and reporting it as recall is how a dead
    // read path survives a green check.
    if (sawTheFact) {
      const where = [];
      for (const req of turnTwoRequests) {
        for (const m of req.messages ?? []) {
          const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          if (!content.includes("vault/staging/db")) continue;
          const idx = content.indexOf("vault/staging/db");
          const around = content.slice(Math.max(0, idx - 400), idx);
          const marker = /\[Memory context\][\s\S]*$/.test(around)
            ? "recall block"
            : /## Your notebook[\s\S]*$/.test(around)
              ? "notebook drawer"
              : `${m.role} message`;
          where.push(marker);
        }
      }
      console.log(`  carried by:                       ${[...new Set(where)].join(", ") || "unknown"}`);
    }

    if (process.env.RECALL_PROBE_DUMP) {
      writeFileSync(process.env.RECALL_PROBE_DUMP, JSON.stringify(captured, null, 2), "utf8");
      console.log(`  captured requests written to:     ${process.env.RECALL_PROBE_DUMP}`);
    }

    // BOTH are required, and the header is the strict half.
    //
    // The fact alone is not proof: episodic rehydration also carries content
    // across sessions under one owner scope, so an earlier version of this
    // probe passed with recall switched OFF. `[Memory context]` is written
    // only by the recall engines, so requiring it is what makes this a test of
    // the read path rather than of some other path that happens to work.
    if (!sawTheFact || !sawMemoryBlock) {
      failure =
        "memory did not engage: the new session carried no recalled block. " +
        "Check that CINDERPAW_RECALL_INJECTION is not false, that a Recaller is " +
        "wired into AgentLoop at boot, that episodic writes are landing, and that " +
        "EpisodicMemory.search still falls back to OR — an AND-only match returns " +
        "nothing for a question phrased as a sentence.";
    }
  } catch (err) {
    failure = String(err);
  } finally {
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
    server.close();
  }

  // The killed sidecar can still hold a handle on Windows, and a cleanup
  // failure must never turn a result into a crash.
  const cleanup = () => {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* leaked temp dir */ }
  };

  if (failure) {
    console.error(`\nFAIL — ${failure}`);
    if (stderr.length) console.error(`\nsidecar stderr (tail):\n${stderr.join("").slice(-2000)}`);
    cleanup();
    process.exit(1);
  }
  console.log("\nOK — memory carried into a NEW session, unasked.");
  cleanup();
}

main().catch((e) => {
  console.error(e);
  server.close();
  process.exit(1);
});
