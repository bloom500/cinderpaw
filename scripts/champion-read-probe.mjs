#!/usr/bin/env node
/**
 * Champion read-probe — does the BRSI genome actually change the live agent?
 *
 * BRSI's L1 loop ends at `champion.json`. Everything upstream of that file
 * (taste vector, mutation, selection, ratchet) is only worth building if the
 * file itself changes what the user's agent does. Three subsystems in this
 * repo already write state nobody reads; this script exists so the champion
 * bridge is not judged by reading the code.
 *
 * It runs the SAME prompt through the SAME model N times per arm. The arms
 * differ in exactly one thing: the `rsi/champion.json` planted in the arm's
 * profile dir before the sidecar starts. Nothing else — same workspace shape,
 * same route, same turn budget.
 *
 *   control   the champion on this machine today (temp 0.2, prompt style 0)
 *   style     prompt style 1 ("be maximally concise"), same temperature
 *   hot       temperature 2.0, same prompt style
 *   taste     temp 0.2417 — the value an EXTREME taste vector actually
 *             produces at the taste weight this machine can reach
 *             (tasteWeight(pop=4, history=20) = 0.0417). This is the arm
 *             that matters: it is the taste layer's real blast radius, not
 *             a hypothetical one.
 *
 * Reported per arm: whether boot logged the champion load at all, answer
 * length in characters, and the answers themselves. A bridge that works
 * shows a length collapse on `style` and word-salad on `hot`. A `taste` arm
 * indistinguishable from `control` means the taste layer cannot reach the
 * user through this path even when set to an extreme.
 *
 *   node scripts/champion-read-probe.mjs
 *   node scripts/champion-read-probe.mjs --arms control,style --repeat 3
 *
 * Route resolution is walkaway-bench's, e.g.
 *   CINDERPAW_BYOK_PROVIDER=openrouter CINDERPAW_MODEL=z-ai/glm-5.3-flash
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRoute, preflight, runTask } from "./walkaway-bench.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Read the repo's `.env` the way the tau2 and TAC runners do, so this probe
 * needs no extra setup on the machine that already runs those. Anything
 * already exported wins. A machine without a `.env` is not broken: it just
 * has to pass the route in the environment, and resolveRoute says so.
 *
 * `CINDERPAW_OPENROUTER_PROVIDER` is carried through deliberately. Unpinned
 * OpenRouter routing swung identical tau2 runs by 40 points, and this probe
 * compares arms that differ by one number in a JSON file — a provider swap
 * between arms would drown the effect it is trying to measure.
 */
function loadDotEnv() {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(String.fromCharCode(10))) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!v) continue;
    if (k === "OPENROUTER_API_KEY") {
      if (!process.env.CINDERPAW_API_KEY) process.env.CINDERPAW_API_KEY = v;
      if (!process.env.CINDERPAW_BASE_URL) process.env.CINDERPAW_BASE_URL = "https://openrouter.ai/api/v1";
      if (!process.env.CINDERPAW_PROVIDER) process.env.CINDERPAW_PROVIDER = "openai_compatible";
      continue;
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

// One question, no tools, length-sensitive. Short enough that four arms cost
// less than a single benchmark task.
const PROMPT =
  "Explain what a hash map is and why average-case lookup is O(1). " +
  "Do not use any tools — just answer.";

const ARMS = {
  control: { temperature: 0.2, systemPromptId: 0 },
  style: { temperature: 0.2, systemPromptId: 1 },
  hot: { temperature: 2.0, systemPromptId: 0 },
  taste: { temperature: 0.2417, systemPromptId: 0 },
};

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const armNames = String(arg("arms", Object.keys(ARMS).join(","))).split(",").filter(Boolean);
const repeat = Number(arg("repeat", 1));
const timeoutMs = Number(arg("timeout", 180)) * 1000;

for (const a of armNames) {
  if (!ARMS[a]) {
    console.error(`unknown arm "${a}". Known: ${Object.keys(ARMS).join(", ")}`);
    process.exit(2);
  }
}

/** Write the arm's champion into a profile dir the sidecar will read. */
function plantChampion(home, arm) {
  const { temperature, systemPromptId } = ARMS[arm];
  mkdirSync(join(home, "rsi"), { recursive: true });
  writeFileSync(
    join(home, "rsi", "champion.json"),
    JSON.stringify(
      {
        genomeId: `probe-${arm}`,
        score: 99,
        config: {
          promptTemplateId: 0,
          temperature,
          systemPromptId,
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

/** The answer the caller would have received.
 *
 * The terminal `done` carries it verbatim, so prefer that; the streamed
 * chunks are the fallback for a turn that never got one. `runSummary` and
 * `incomplete` events restate a turn rather than closing it (see the `done`
 * docstring in types.ts) and must not be mistaken for the answer. */
function answerOf(events) {
  const done = [...events].reverse().find(
    (e) => e.type === "done" && !e.runSummary && !e.incomplete && typeof e.content === "string",
  );
  if (done?.content) return done.content;
  return events
    .filter((e) => e.type === "chunk" && typeof e.content === "string")
    .map((e) => e.content)
    .join("");
}

/** Did boot say it read our file? The one line that separates "the bridge
 *  ran" from "the bridge is dead code on this path". */
function championLogLine(events) {
  for (const e of events) {
    if (e.type !== "_stderr" || typeof e.text !== "string") continue;
    const m = e.text.match(/rsi champion: (?:loaded persisted champion|applied genome) [^\n]*/);
    if (m) return m[0].trim();
  }
  return null;
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(ROOT, "bench-results", `champion-probe-${stamp}`);

async function main() {
  loadDotEnv();
  // resolveRoute answers with { env } or { error }.
  const resolved = resolveRoute();
  if (resolved.error) {
    console.error(resolved.error);
    process.exit(2);
  }
  const route = resolved.env;
  // preflight returns null on success, or a string saying what is wrong.
  const pre = await preflight(route);
  if (pre !== null) {
    console.error(`preflight failed: ${pre}`);
    process.exit(2);
  }

  mkdirSync(outDir, { recursive: true });
  console.log(`champion read-probe — ${armNames.length} arm(s) x ${repeat} run(s)`);
  const pin = process.env.CINDERPAW_OPENROUTER_PROVIDER?.trim() || "(unpinned)";
  console.log(`model: ${route.CINDERPAW_MODEL}   openrouter provider: ${pin}`);
  console.log(`results: ${outDir}\n`);

  const rows = [];
  for (const arm of armNames) {
    for (let run = 1; run <= repeat; run++) {
      const label = repeat > 1 ? `${arm}#${run}` : arm;
      const ws = join(outDir, label);
      rmSync(ws, { recursive: true, force: true });
      mkdirSync(ws, { recursive: true });
      const home = join(ws, ".cinderpaw");
      plantChampion(home, arm);

      process.stdout.write(`  ${label.padEnd(14)} `);
      const started = Date.now();
      const res = await runTask(
        { id: `champ-${label}`, prompt: PROMPT },
        ws,
        join(ws, "events.jsonl"),
        timeoutMs,
        route,
        false,
        { home },
      );
      const answer = answerOf(res.events);
      const logLine = championLogLine(res.events);
      writeFileSync(join(ws, "answer.txt"), answer, "utf8");
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(
        `${res.outcome.padEnd(12)} ${String(answer.length).padStart(6)} chars  ${secs}s  ` +
          (logLine ? "champion-log: YES" : "champion-log: MISSING"),
      );
      rows.push({ arm, run, outcome: res.outcome, detail: res.detail, chars: answer.length, logLine, answer });
    }
  }

  writeFileSync(join(outDir, "summary.json"), JSON.stringify({ model: route.CINDERPAW_MODEL, providerPin: pin, prompt: PROMPT, arms: ARMS, rows }, null, 2), "utf8");

  console.log("\n── answers (first 300 chars) ─────────────────────────────");
  for (const r of rows) {
    console.log(`\n[${r.arm}#${r.run}] ${r.chars} chars`);
    console.log(r.answer.slice(0, 300).replace(/\n/g, " "));
  }
  console.log(`\nsummary: ${join(outDir, "summary.json")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
