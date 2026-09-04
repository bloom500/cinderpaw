#!/usr/bin/env bun
/**
 * Champion wire-probe — what the champion actually puts on the request.
 *
 * The live probe (`champion-read-probe.mjs`) answers "did the answer change".
 * That question has two ways to come out negative and they need different
 * fixes: the champion never reached the request, or it reached it and the
 * model ignored it. Judging a bridge by the model's compliance cannot tell
 * those apart, and the wrong one gets fixed.
 *
 * So this probe removes the model. It stands up a stub on loopback that
 * speaks just enough of the OpenAI chat-completions shape to satisfy one
 * turn, records the request body verbatim, and answers with a fixed string.
 * Then, per arm, it plants an `rsi/champion.json`, boots the sidecar against
 * the stub, and reports what came over the wire:
 *
 *   temperature   the number the request carried (or absent)
 *   style         whether the champion's prompt-style text is in the system
 *                 message the agent sent
 *
 * Deterministic, free, and it fails loudly rather than quietly: an arm whose
 * planted temperature does not show up on the wire is a broken bridge, no
 * matter how the prose reads.
 *
 *   bun scripts/champion-wire-probe.mjs   (bun, not node: it imports the TS
 *                                          prompt pool rather than restating it)
 */

import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runTask } from "./walkaway-bench.mjs";
import { PROMPT_STYLE_POOL } from "../CinderpawAgent/src/rsi/l1-config/prompt-pool.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.WIRE_PROBE_PORT ?? 8791);
const OUT = join(ROOT, "bench-results", `champion-wire-${new Date().toISOString().replace(/[:.]/g, "-")}`);

/** The arms. Each is one champion.json, differing in one field at a time. */
const ARMS = [
  { name: "control", temperature: 0.2, systemPromptId: 0 },
  { name: "style", temperature: 0.2, systemPromptId: 1 },
  { name: "hot", temperature: 2.0, systemPromptId: 0 },
  // What an EXTREME taste vector really produces at this machine's reachable
  // taste weight, tasteWeight(pop=4, history=20) = 0.0417.
  { name: "taste", temperature: 0.2417, systemPromptId: 0 },
  // No champion file at all — the floor. Anything the other arms share with
  // this one did not come from the champion.
  { name: "none", champion: null },
];

const PROMPT = "Say the single word: ok";

function plantChampion(home, arm) {
  mkdirSync(join(home, "rsi"), { recursive: true });
  if (arm.champion === null) return;
  writeFileSync(
    join(home, "rsi", "champion.json"),
    JSON.stringify(
      {
        genomeId: `wire-${arm.name}`,
        score: 99,
        config: {
          promptTemplateId: 0,
          temperature: arm.temperature,
          systemPromptId: arm.systemPromptId,
          retrievalStrategy: "episodic",
          contextWindowUsage: 0.4,
          toolPreferenceWeights: [0.25, 0.25, 0.25, 0.25],
          decompositionDepth: 0,
        },
        updatedAt: Date.now(),
      },
      null,
      2,
    ),
    "utf8",
  );
}

/** Captured request bodies, newest last. Reset per arm. */
let captured = [];

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* record the raw text below */ }
    captured.push({ url: req.url, body: parsed, raw: parsed ? null : body.slice(0, 500) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "wire-probe",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "wire-probe-stub",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
});

/** The system message the agent sent, if any. */
function systemTextOf(body) {
  const msgs = body?.messages;
  if (!Array.isArray(msgs)) return null;
  const sys = msgs.filter((m) => m?.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
  return sys.length ? sys.join("\n") : null;
}

async function main() {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  mkdirSync(OUT, { recursive: true });
  console.log(`champion wire-probe — stub on http://127.0.0.1:${PORT}`);
  console.log(`results: ${OUT}\n`);
  console.log(`  ${"arm".padEnd(10)} ${"temperature".padEnd(13)} ${"style on wire".padEnd(15)} calls`);

  const rows = [];
  for (const arm of ARMS) {
    captured = [];
    const ws = join(OUT, arm.name);
    rmSync(ws, { recursive: true, force: true });
    mkdirSync(ws, { recursive: true });
    const home = join(ws, ".cinderpaw");
    plantChampion(home, arm);

    await runTask(
      { id: `wire-${arm.name}`, prompt: PROMPT },
      ws,
      join(ws, "events.jsonl"),
      90_000,
      {
        CINDERPAW_PROVIDER: "openai_compatible",
        CINDERPAW_BASE_URL: `http://127.0.0.1:${PORT}`,
        CINDERPAW_MODEL: "wire-probe-stub",
        CINDERPAW_API_KEY: "wire-probe",
      },
      false,
      {
        home,
        env: {
          // The stub is on loopback, which the egress guard blocks by default
          // and should. Declared explicitly, exact origin only.
          CINDERPAW_TRUSTED_LOCAL_ORIGINS: `http://127.0.0.1:${PORT}`,
          CINDERPAW_HTTP_DOMAINS: "127.0.0.1",
        },
      },
    );

    const first = captured.find((c) => c.body?.messages);
    const temp = first?.body?.temperature;
    const sys = first ? systemTextOf(first.body) : null;
    const expectedStyle = arm.champion === null ? "" : PROMPT_STYLE_POOL[arm.systemPromptId] ?? "";
    const styleOnWire = expectedStyle === "" ? "n/a (neutral)" : sys?.includes(expectedStyle) ? "YES" : "NO";

    writeFileSync(join(ws, "captured.json"), JSON.stringify(captured, null, 2), "utf8");
    if (sys) writeFileSync(join(ws, "system-prompt.txt"), sys, "utf8");

    console.log(
      `  ${arm.name.padEnd(10)} ${String(temp ?? "(absent)").padEnd(13)} ${styleOnWire.padEnd(15)} ${captured.length}`,
    );
    rows.push({ arm: arm.name, planted: arm.champion === null ? null : { temperature: arm.temperature, systemPromptId: arm.systemPromptId }, wireTemperature: temp ?? null, styleOnWire, calls: captured.length, systemPromptChars: sys?.length ?? 0 });
  }

  writeFileSync(join(OUT, "summary.json"), JSON.stringify({ prompt: PROMPT, rows }, null, 2), "utf8");
  console.log(`\nsummary: ${join(OUT, "summary.json")}`);
  server.close();
}

main().catch((e) => {
  console.error(e);
  server.close();
  process.exit(1);
});
