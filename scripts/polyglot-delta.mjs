#!/usr/bin/env node
/**
 * Polyglot delta harness — does the runtime make the model better, or not?
 *
 * The question this exists to answer is NOT "what does Cinderpaw score on
 * Aider Polyglot". It is:
 *
 *     Same model, same tasks, same budget — what changes when the runtime's
 *     memory is on versus off?
 *
 * So every run is a PAIR. Both arms use the same agent loop, the same tools,
 * the same model, the same prompt and the same exercises in the same order.
 * One thing differs:
 *
 *   bare — every task gets a fresh profile directory. The agent finishes task 3
 *          and starts task 4 having never seen task 3. This is the control.
 *   full — one profile for the whole arm. Memory, notes and recall carry from
 *          task to task, which is what the runtime claims to be for.
 *
 * That is the honest ON/OFF available today. It is deliberately NOT "Cinderpaw
 * vs the Aider harness": comparing against a published leaderboard number would
 * compare two different harnesses, two different prompts and two different
 * scaffolds, and would attribute all of the difference to the runtime.
 *
 * WHAT IT MEASURES. Pass rate is reported, but with 5 exercises it is not
 * evidence — 2/5 -> 3/5 is one exercise. The metrics that carry signal at this
 * sample size are the continuous ones: tokens, tool calls, turns and wall time
 * per task. Read those first.
 *
 * SCORING is mechanical and ours, never the agent's word for it: after the run
 * we execute the exercise's own pytest file. We also hash the test file before
 * and after — an agent that "passes" by editing the tests is scored as a
 * failure, not a pass.
 *
 *   node scripts/polyglot-delta.mjs --n 5
 *   node scripts/polyglot-delta.mjs --n 5 --arms bare,full --minutes 12
 *   node scripts/polyglot-delta.mjs --exercises bowling,acronym --arms full
 *   node scripts/polyglot-delta.mjs --n 5 --price-in 0.10 --price-out 0.30
 *
 * The route is resolved exactly like walkaway-bench (which this imports), e.g.
 *
 *   CINDERPAW_BYOK_PROVIDER=openrouter CINDERPAW_API_KEY=sk-or-...
 *   CINDERPAW_MODEL=z-ai/glm-5.3-flash node scripts/polyglot-delta.mjs --n 5
 *
 * Results land in bench-results/polyglot-<timestamp>/.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRoute, preflight, runTask } from "./walkaway-bench.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUITE = join(ROOT, "data", "polyglot-benchmark", "python", "exercises", "practice");

// ────────────────────────────────────────────────────────────────────── args

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const N = Number(arg("n", 5));
const ARMS = String(arg("arms", "bare,full")).split(",").map((a) => a.trim()).filter(Boolean);
const MINUTES = Number(arg("minutes", 12));
const ONLY = arg("exercises", null);
const PYTHON = arg("python", process.env.CINDERPAW_BENCH_PYTHON ?? (process.platform === "win32" ? "python" : "python3"));
// Per-million-token prices. Left unset on purpose: a cost column filled with a
// guessed price is a number that looks measured and is not. Unset prints a dash
// and says why, on screen, rather than in this comment.
const PRICE_IN = arg("price-in", null) === null ? null : Number(arg("price-in", null));
const PRICE_OUT = arg("price-out", null) === null ? null : Number(arg("price-out", null));

/**
 * What actually differs between the arms.
 *
 * READ THIS BEFORE QUOTING A NUMBER FROM THIS HARNESS. "full" does not mean
 * every subsystem in the product is switched on. What is on in BOTH arms,
 * because it is on by default and cannot be turned off by a flag: the agent
 * loop, the tool registry, the fractal memory store (FMS) and the brain-stack
 * model routing. What is off in BOTH arms: the dream cycle, the proactive /
 * inner-thoughts loop, and the BRSI/RSI self-improvement engine — that last one
 * only ever starts on an explicit `rsi_start` message, which this harness never
 * sends.
 *
 * So the delta between `bare` and `full` measures exactly one thing: whether
 * carrying a profile across tasks helps. That is a narrow claim and it is the
 * only one these two arms support.
 *
 * `full-plus` exists for the wider question. Be aware of what it is buying: the
 * dream cycle and the proactive loop are IDLE-TIME loops. On a task that runs
 * for twelve minutes and then ends, there is little idle for them to work in,
 * so the honest expectation is that they cost tokens and change nothing. To
 * measure them properly you need repeated tasks with real gaps between them,
 * not five one-shot exercises.
 */
const KNOWN_ARMS = {
  // Fresh profile per task — runTask's own default. The control.
  bare: { shareHome: false, env: {} },
  // One profile for the whole arm: memory, notes and recall carry over.
  full: { shareHome: true, env: {} },
  // Everything above, plus the background loops that are off by default.
  "full-plus": {
    shareHome: true,
    env: { CINDERPAW_DREAMS_ENABLED: "true", CINDERPAW_PROACTIVE_ENABLED: "true" },
  },
};

// ─────────────────────────────────────────────────────────────── exercises

/**
 * Pick the exercises. Sorted then sliced, never shuffled: both arms MUST get
 * the same list in the same order, and a seeded shuffle is one more thing that
 * can silently differ between two runs you meant to compare.
 */
function pickExercises() {
  if (!existsSync(SUITE)) {
    return {
      error: [
        `exercise suite not found at ${SUITE}`,
        "  get it with:",
        "    git clone --depth 1 --filter=blob:none --sparse https://github.com/Aider-AI/polyglot-benchmark data/polyglot-benchmark",
        "    cd data/polyglot-benchmark && git sparse-checkout set python",
      ].join("\n"),
    };
  }
  const all = readdirSync(SUITE, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  if (ONLY) {
    const want = ONLY.split(",").map((s) => s.trim()).filter(Boolean);
    const missing = want.filter((w) => !all.includes(w));
    if (missing.length) return { error: `unknown exercise(s): ${missing.join(", ")}` };
    return { slugs: want };
  }
  return { slugs: all.slice(0, N) };
}

/** Exercism names the stub and the test file after the slug, with dashes as underscores. */
const moduleName = (slug) => slug.replace(/-/g, "_");

/**
 * Lay one exercise out in a fresh workspace.
 *
 * `.meta/` is EXCLUDED and that exclusion is the single most important line in
 * this file: it holds `example.py`, the reference solution. Copying the whole
 * directory would hand the agent the answer key and produce a 100% that means
 * nothing.
 */
function materialise(slug, ws) {
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  cpSync(join(SUITE, slug), ws, {
    recursive: true,
    filter: (src) => !src.split(/[\\/]/).includes(".meta"),
  });
  if (existsSync(join(ws, ".meta"))) throw new Error(`.meta leaked into ${ws} — would leak the solution`);
}

function instructionsFor(slug) {
  const parts = [];
  for (const f of ["instructions.md", "instructions.append.md"]) {
    const p = join(SUITE, slug, ".docs", f);
    if (existsSync(p)) parts.push(readFileSync(p, "utf8"));
  }
  return parts.join("\n\n");
}

function promptFor(slug) {
  const mod = moduleName(slug);
  return [
    instructionsFor(slug),
    "",
    "---",
    "",
    `Implement this in ${mod}.py, which is in your current working directory as an`,
    `unimplemented stub. The tests are in ${mod}_test.py.`,
    "",
    `Run them with: python -m pytest ${mod}_test.py`,
    "",
    "Keep going until every test passes. Do NOT edit the test file — a solution that",
    "changes the tests is scored as a failure. Do not create new files beyond what the",
    "implementation needs.",
  ].join("\n");
}

// ──────────────────────────────────────────────────────────────── scoring

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/**
 * Did it actually work? We run the tests ourselves. Two ways to fail that the
 * agent's own report would never show us: it edited the tests, or it said it
 * was done and it was not.
 */
function score(slug, ws, testHashBefore) {
  const mod = moduleName(slug);
  const testFile = join(ws, `${mod}_test.py`);
  if (!existsSync(testFile)) return { passed: false, reason: "the test file was deleted" };
  if (sha(testFile) !== testHashBefore) return { passed: false, reason: "the test file was modified" };
  if (!existsSync(join(ws, `${mod}.py`))) return { passed: false, reason: `${mod}.py is missing` };

  const r = spawnSync(PYTHON, ["-m", "pytest", "-q", `${mod}_test.py`], {
    cwd: ws,
    encoding: "utf8",
    timeout: 120_000,
    // A solution that imports something unavailable must fail as a solution,
    // not hang the harness waiting on a pip prompt.
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PIP_NO_INPUT: "1" },
  });
  const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split(/\r?\n/).slice(-3).join(" | ");
  return r.status === 0
    ? { passed: true, reason: null }
    : { passed: false, reason: `pytest exit ${r.status ?? "killed"}: ${tail.slice(0, 300)}` };
}

// ──────────────────────────────────────────────────────────────── metrics

/** What the run cost, read off the event stream rather than off the agent's word. */
function metrics(events) {
  let promptTokens = 0;
  let completionTokens = 0;
  let toolCalls = 0;
  let turns = 0;
  const tools = {};
  for (const e of events) {
    if (e.type === "usage") {
      promptTokens += e.promptTokens ?? 0;
      completionTokens += e.completionTokens ?? 0;
    } else if (e.type === "tool_start") {
      toolCalls++;
      tools[e.tool] = (tools[e.tool] ?? 0) + 1;
    } else if (e.type === "done" && !e.runSummary && !e.incomplete) {
      turns++;
    }
  }
  return { promptTokens, completionTokens, toolCalls, turns, tools };
}

function usd(promptTokens, completionTokens) {
  if (PRICE_IN === null || PRICE_OUT === null) return null;
  return (promptTokens / 1e6) * PRICE_IN + (completionTokens / 1e6) * PRICE_OUT;
}

const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ──────────────────────────────────────────────────────────── self-check

/**
 * `node scripts/polyglot-delta.mjs --self-check` — no model, no money.
 *
 * It checks the two things that would silently invalidate every number this
 * harness ever produces: the reference solution leaking into the agent's
 * workspace (every task passes, the run means nothing), and the scorer
 * accepting a workspace where the tests were edited (a cheat scores as a pass).
 */
function selfCheck() {
  const slug = readdirSync(SUITE, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()[0];
  const mod = moduleName(slug);
  const ws = join(ROOT, "bench-results", "_self-check");
  const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1; };

  materialise(slug, ws);
  const testHash = sha(join(ws, `${mod}_test.py`));

  // 1. The answer key must not be reachable from the workspace, under any name.
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
  const leaked = walk(ws).filter((f) => f.includes(".meta") || f.endsWith("example.py"));
  if (leaked.length) fail(`the reference solution leaked into the workspace: ${leaked.join(", ")}`);

  // 2. The stub alone must NOT pass. If it does, the exercise proves nothing.
  if (score(slug, ws, testHash).passed) fail(`${slug} passes with the stub untouched — it cannot measure anything`);

  // 3. The reference solution MUST pass. If it does not, the scorer is broken
  //    (wrong python, wrong file name, wrong cwd) and would score every real
  //    attempt as a failure.
  cpSync(join(SUITE, slug, ".meta", "example.py"), join(ws, `${mod}.py`));
  const solved = score(slug, ws, testHash);
  if (!solved.passed) fail(`the reference solution does not pass the scorer: ${solved.reason}`);

  // 4. Editing the tests must be a failure, not a pass.
  writeFileSync(join(ws, `${mod}_test.py`), "def test_nothing():\n    assert True\n", "utf8");
  const cheated = score(slug, ws, testHash);
  if (cheated.passed) fail("a workspace with rewritten tests scored as a PASS");
  if (cheated.reason !== "the test file was modified") fail(`wrong reason for edited tests: ${cheated.reason}`);

  rmSync(ws, { recursive: true, force: true });
  if (!process.exitCode) console.log(`self-check ok (${slug}): no solution leak, stub fails, reference passes, edited tests rejected`);
}

// ─────────────────────────────────────────────────────────────────── main

if (argv.includes("--self-check")) {
  selfCheck();
  process.exit(process.exitCode ?? 0);
}

const picked = pickExercises();
if (picked.error) {
  console.error(`polyglot-delta cannot start — ${picked.error}`);
  process.exitCode = 2;
} else {
  const unknownArm = ARMS.find((a) => !KNOWN_ARMS[a]);
  if (unknownArm) {
    console.error(`unknown arm "${unknownArm}". Known: ${Object.keys(KNOWN_ARMS).join(", ")}`);
    process.exitCode = 2;
  } else {
    const pytestProbe = spawnSync(PYTHON, ["-m", "pytest", "--version"], { encoding: "utf8", timeout: 30_000 });
    if (pytestProbe.status !== 0) {
      console.error(
        `polyglot-delta cannot start — "${PYTHON} -m pytest" does not run here.\n` +
          "  Scoring is done by running the exercise's own tests, so without pytest every\n" +
          "  task would score as a failure for a reason that has nothing to do with the agent.\n" +
          `  Fix: ${PYTHON} -m pip install pytest   (or pass --python <path>)`,
      );
      process.exitCode = 2;
    } else {
      const route = resolveRoute();
      if (route.error) {
        console.error(`polyglot-delta cannot start — ${route.error}`);
        process.exitCode = 2;
      } else {
        process.stdout.write(`preflight: ${route.env.CINDERPAW_MODEL} @ ${route.env.CINDERPAW_BASE_URL} ... `);
        const preflightError = await preflight(route.env);
        if (preflightError) {
          console.error(`FAILED\n\n  ${preflightError}\n\nNothing was run.`);
          process.exitCode = 2;
        } else {
          console.log("ok");
          await run(picked.slugs, route.env);
        }
      }
    }
  }
}

async function run(slugs, routeEnv) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(ROOT, "bench-results", `polyglot-${stamp}`);
  mkdirSync(outDir, { recursive: true });

  console.log(`polyglot delta — ${slugs.length} exercise(s) x ${ARMS.length} arm(s)`);
  console.log(`exercises: ${slugs.join(", ")}`);
  console.log(`results:   ${outDir}\n`);

  const rows = [];
  for (const arm of ARMS) {
    const spec = KNOWN_ARMS[arm];
    // One profile for the whole arm when the arm is meant to remember. Created
    // once, before the first task, and never cleared between them.
    const sharedHome = spec.shareHome ? join(outDir, arm, "_home") : null;
    if (sharedHome) mkdirSync(sharedHome, { recursive: true });

    for (const slug of slugs) {
      const ws = join(outDir, arm, slug);
      materialise(slug, ws);
      const testHash = sha(join(ws, `${moduleName(slug)}_test.py`));

      // Both arms get an EXPLICIT home outside the workspace. runTask's default
      // puts the profile at <workspace>/.cinderpaw, which the agent can then see
      // and read in its own working directory — present in one arm and not the
      // other, which is a difference between the arms that has nothing to do
      // with what we are measuring.
      const home = sharedHome ?? join(outDir, arm, "_homes", slug);
      mkdirSync(home, { recursive: true });

      // CINDERPAW_DB defaults to the RELATIVE path "data/cinderpaw.db", which
      // resolves against the process cwd — the task workspace — not against
      // CINDERPAW_HOME. Without this line the memory database is recreated
      // empty for every task in BOTH arms, the shared profile holds no memory
      // at all, and the arms are identical while appearing to differ. That is
      // exactly the shape of bug that produces a confident number measuring
      // nothing, so the path is pinned here rather than inherited.
      const db = join(home, "data", "cinderpaw.db");

      // The cloud perf profile caps ONE completion at 120s (perf-policy.ts
      // DEFAULTS.cloud.totalDeadlineMs). That killed a real run today —
      // `bare/bowling`, the hardest of the five, was still streaming tokens
      // ("Frame 10 at i=9 needs…") when the deadline cut it, and the harness
      // could only record it as an infrastructure failure. A benchmark that
      // scores a thinking model as broken because a clock ran out measures the
      // clock. 300s here matches the LOCAL profile's existing budget, so this
      // is the product's own number for "a long generation", not one invented
      // for the benchmark. Applies to both arms equally.
      const totalDeadlineMs = process.env.CINDERPAW_TOTAL_DEADLINE_MS ?? "300000";

      const task = { id: `${arm}-${slug}`, prompt: promptFor(slug) };
      process.stdout.write(`  ${arm}/${slug} ... `);
      const started = Date.now();
      const res = await runTask(
        task,
        ws,
        join(ws, "events.jsonl"),
        MINUTES * 60_000,
        routeEnv,
        false,
        { home, env: { CINDERPAW_DB: db, CINDERPAW_TOTAL_DEADLINE_MS: totalDeadlineMs, ...spec.env } },
      );
      const wallMs = Date.now() - started;

      const m = metrics(res.events);
      // An outcome of spawn_error / agent_error means we never got a fair
      // attempt. It is reported as INFRA and kept out of the pass rate: a
      // number that counts "there was no model" as an agent failure measures
      // the network, not the runtime.
      const infra = res.outcome === "spawn_error" || res.outcome === "agent_error";
      const s = infra ? { passed: false, reason: `INFRA: ${res.detail}` } : score(slug, ws, testHash);

      rows.push({
        arm, exercise: slug, infra,
        passed: s.passed, reason: s.reason,
        outcome: res.outcome, detail: res.detail,
        wallMs, ...m, usd: usd(m.promptTokens, m.completionTokens),
      });
      console.log(
        `${infra ? "INFRA" : s.passed ? "PASS" : "FAIL"}  ` +
          `${Math.round(wallMs / 1000)}s  ${m.promptTokens + m.completionTokens} tok  ${m.toolCalls} tools` +
          (s.passed || infra ? "" : `  (${s.reason})`),
      );
    }
  }

  report(rows, outDir, routeEnv);
}

function report(rows, outDir, routeEnv) {
  const summary = {};
  for (const arm of ARMS) {
    const all = rows.filter((r) => r.arm === arm);
    const scored = all.filter((r) => !r.infra);
    summary[arm] = {
      tasks: all.length,
      infra: all.length - scored.length,
      passed: scored.filter((r) => r.passed).length,
      scored: scored.length,
      medianTotalTokens: median(scored.map((r) => r.promptTokens + r.completionTokens)),
      medianPromptTokens: median(scored.map((r) => r.promptTokens)),
      medianCompletionTokens: median(scored.map((r) => r.completionTokens)),
      medianToolCalls: median(scored.map((r) => r.toolCalls)),
      medianTurns: median(scored.map((r) => r.turns)),
      medianWallSec: median(scored.map((r) => Math.round(r.wallMs / 1000))),
      medianUsd: median(scored.map((r) => r.usd).filter((x) => x !== null)),
    };
  }

  writeFileSync(
    join(outDir, "summary.json"),
    JSON.stringify(
      { model: routeEnv.CINDERPAW_MODEL, baseUrl: routeEnv.CINDERPAW_BASE_URL, arms: ARMS, summary, rows },
      null,
      2,
    ),
    "utf8",
  );

  const METRICS = [
    ["pass rate", (s) => (s.scored ? `${s.passed}/${s.scored}` : "-"), null],
    ["median tokens", (s) => s.medianTotalTokens ?? "-", "medianTotalTokens"],
    ["median tool calls", (s) => s.medianToolCalls ?? "-", "medianToolCalls"],
    ["median turns", (s) => s.medianTurns ?? "-", "medianTurns"],
    ["median wall (s)", (s) => s.medianWallSec ?? "-", "medianWallSec"],
    ["median $/task", (s) => (s.medianUsd === null ? "-" : `$${s.medianUsd.toFixed(4)}`), "medianUsd"],
  ];

  const pad = (s, w) => String(s).padEnd(w);
  const w0 = 18;
  const w = 14;
  console.log(`\n${pad("", w0)}${ARMS.map((a) => pad(a, w)).join("")}${ARMS.length === 2 ? "delta" : ""}`);
  for (const [label, fmt, key] of METRICS) {
    let delta = "";
    if (ARMS.length === 2 && key) {
      const a = summary[ARMS[0]][key];
      const b = summary[ARMS[1]][key];
      delta = a && b ? `${b > a ? "+" : ""}${Math.round(((b - a) / a) * 100)}%` : "-";
    }
    console.log(`${pad(label, w0)}${ARMS.map((a) => pad(fmt(summary[a]), w)).join("")}${delta}`);
  }

  const infraTotal = ARMS.reduce((n, a) => n + summary[a].infra, 0);
  if (infraTotal) console.log(`\n${infraTotal} run(s) never got a fair attempt (INFRA) and are excluded from the rates above.`);
  if (PRICE_IN === null || PRICE_OUT === null) {
    console.log(
      "\n$/task is blank because no price was given. Token counts above are real;\n" +
        "  pass --price-in <usd per 1M prompt tokens> --price-out <usd per 1M completion tokens>\n" +
        "  to turn them into money. Nothing here guesses a price.",
    );
  }
  console.log(
    `\nWith ${rows.length / ARMS.length} exercises per arm, the pass rate is not evidence — one\n` +
      "  exercise moves it 20 points. Read the token / tool-call / wall-time rows.",
  );
  console.log(`\nsummary: ${join(outDir, "summary.json")}`);

  process.exitCode = 0;
}
