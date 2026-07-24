#!/usr/bin/env node
/**
 * Walk-away bench — the missing number.
 *
 * Feral has ~2400 unit tests and zero measurements of the thing it is actually
 * for: give it a complex task, leave, come back to finished work. Every
 * reliability fix so far has been a guess about what matters, including the
 * good ones, because nothing counted how often an unattended run finishes.
 *
 * This runs real tasks end-to-end against the real sidecar in autonomous mode,
 * and reports pass/fail per task with the reason. That is all. It does not fix
 * anything; it tells you what to fix next, which is the part that was missing.
 *
 *   node scripts/walkaway-bench.mjs                     # all tasks
 *   node scripts/walkaway-bench.mjs --task write-cli    # one task
 *   node scripts/walkaway-bench.mjs --timeout 1800      # per-task cap (s)
 *   node scripts/walkaway-bench.mjs --repeat 3          # N runs per task
 *
 * REQUIRES a working model, and will refuse to start without one (see
 * preflight below) rather than burn your afternoon discovering it.
 *
 * The sidecar does NOT read ~/.feral/byok.json — the Rust host resolves the
 * BYOK route and hands the sidecar FERAL_PROVIDER / FERAL_MODEL /
 * FERAL_BASE_URL / FERAL_API_KEY. This script spawns the sidecar directly, so
 * it has to do the same job. It resolves the base URL and model from
 * byok.json (both non-secret), and takes the KEY from the environment:
 *
 *   FERAL_BYOK_PROVIDER=minimax FERAL_API_KEY=sk-... node scripts/walkaway-bench.mjs
 *
 * The key is deliberately NOT read out of the OS keychain. A benchmark script
 * has no business extracting credentials, and one that did would be a fine
 * template for something that is not a benchmark script. Export it for the one
 * command, or set FERAL_BASE_URL / FERAL_MODEL / FERAL_API_KEY yourself and
 * skip byok.json entirely.
 *
 * If inference does not come up the run is reported as HARNESS/INFRA and NOT
 * counted as an agent failure — a number that includes "there was no model"
 * measures nothing.
 *
 * A task passes when its `check` says so. The checks are deliberately
 * mechanical — a file exists and contains X, a command exits 0 — because a
 * pass/fail an LLM judges is a pass/fail you cannot trust to move a number.
 *
 * Results land in bench-results/<timestamp>/: one directory per run holding
 * the workspace, the full event log, and summary.json.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIDECAR_ENTRY = join(ROOT, "FeralAgent", "src", "index.ts");

/**
 * Absolute path to the bun executable.
 *
 * `spawn("bun", …)` without a shell fails with ENOENT on Windows, where the
 * thing on PATH is `bun.cmd` — and it fails at spawn time, which the first
 * version of this script then reported as "the file was never created". A
 * harness that misattributes its own breakage as an agent failure is worse
 * than no harness: it manufactures the number it exists to measure.
 * Override with FERAL_BENCH_BUN if bun lives somewhere unusual.
 */
function resolveBun() {
  if (process.env.FERAL_BENCH_BUN) return process.env.FERAL_BENCH_BUN;
  const probe = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["bun"], {
    encoding: "utf8",
  });
  const hits = (probe.stdout ?? "")
    .split(String.fromCharCode(10))
    .map((l) => l.trim())
    .filter(Boolean);

  // A real executable, so spawn needs no shell. That matters beyond tidiness:
  // `shell: true` on Windows routes argv through cmd.exe, which mangles paths
  // containing spaces and emits a deprecation warning into the run output.
  const exe = hits.find((h) => h.toLowerCase().endsWith(".exe"));
  if (exe) return exe;

  // npm installs bun as a shell script + .cmd shim with no .exe on PATH; the
  // real binary sits next to them under node_modules. Prefer it over shelling
  // out to the shim.
  for (const hit of hits) {
    const real = join(dirname(hit), "node_modules", "bun", "bin", "bun.exe");
    if (existsSync(real)) return real;
  }
  return hits[0] ?? "bun";
}
const BUN = resolveBun();

/**
 * Base URLs per BYOK provider id. Mirrors `Provider::base_url` in
 * crates/feral-core/src/byok.rs — the sidecar never sees byok.json, so
 * whichever process spawns it owns this mapping. Kept short on purpose: add a
 * row when you actually bench against that provider.
 */
const PROVIDER_BASE_URL = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  minimax: "https://api.minimax.io/v1",
  groq: "https://api.groq.com/openai/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com/v1",
  mistral: "https://api.mistral.ai/v1",
};

/**
 * Work out which model the bench should run against.
 *
 * Explicit env always wins. Otherwise: read byok.json (base URL + default
 * model only — never a secret) for the provider named by FERAL_BYOK_PROVIDER.
 * Returns the env block to hand the sidecar, or a string explaining what is
 * missing.
 */
/**
 * Strip a trailing `/v1` (and slash) from a base URL.
 *
 * The sidecar builds `${baseUrl}/v1/chat/completions` itself
 * (egress/inference-providers.ts), while every provider documents its base
 * URL WITH the /v1 — byok.rs returns "https://api.minimax.io/v1". Handing that
 * through unchanged produces /v1/v1/chat/completions and a 404 on every turn.
 * crates/feral-core/src/feral_agent.rs does exactly this trim before spawning
 * the sidecar; this script spawns it directly, so it owns the same job.
 *
 * Caught by pointing the bench at a local stub and reading its access log:
 * the preflight hit /v1/chat/completions and the sidecar hit
 * /v1/v1/chat/completions, two lines apart.
 */
function sidecarBaseUrl(url) {
  return url.replace(new RegExp("/+$"), "").replace(new RegExp("/v1$"), "");
}

function resolveRoute() {
  const explicit = {
    FERAL_BASE_URL: process.env.FERAL_BASE_URL,
    FERAL_MODEL: process.env.FERAL_MODEL,
    FERAL_API_KEY: process.env.FERAL_API_KEY,
    FERAL_PROVIDER: process.env.FERAL_PROVIDER ?? "openai_compatible",
  };
  if (explicit.FERAL_BASE_URL && explicit.FERAL_MODEL) {
    return { env: { ...explicit, FERAL_BASE_URL: sidecarBaseUrl(explicit.FERAL_BASE_URL) } };
  }

  const id = process.env.FERAL_BYOK_PROVIDER;
  if (!id) {
    return {
      error: [
        "no model configured. Either set FERAL_BASE_URL + FERAL_MODEL (+ FERAL_API_KEY),",
        "  or set FERAL_BYOK_PROVIDER=<id> to read the route from ~/.feral/byok.json.",
        `  known providers: ${Object.keys(PROVIDER_BASE_URL).join(", ")}`,
      ].join(String.fromCharCode(10)),
    };
  }
  const file = join(homedir(), ".feral", "byok.json");
  if (!existsSync(file)) return { error: `FERAL_BYOK_PROVIDER=${id} but ${file} does not exist` };
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { error: `could not parse ${file}: ${String(e).slice(0, 120)}` };
  }
  const entry = cfg?.providers?.[id];
  if (!entry) return { error: `byok.json has no provider "${id}"` };
  const baseUrl = entry.base_url ?? PROVIDER_BASE_URL[id];
  if (!baseUrl) return { error: `no base URL known for provider "${id}" — set FERAL_BASE_URL` };
  const model = explicit.FERAL_MODEL ?? entry.default_model;
  if (!model) return { error: `provider "${id}" has no default_model — set FERAL_MODEL` };
  // byok.json does NOT hold the key (it lives in the OS keychain), so the key
  // still has to come from the environment. This is the common stumble, so the
  // message says exactly that rather than letting the first task 401.
  const apiKey = explicit.FERAL_API_KEY;
  if (!apiKey) {
    return {
      error: [
        `found the "${id}" route in byok.json (${baseUrl}, ${model}) but no API key.`,
        "  byok.json never stores keys — they live in the OS keychain, and this script",
        "  deliberately does not read credentials. Export it for this one command:",
        `    FERAL_API_KEY=... FERAL_BYOK_PROVIDER=${id} node scripts/walkaway-bench.mjs`,
      ].join(String.fromCharCode(10)),
    };
  }
  return {
    env: {
      FERAL_PROVIDER: "openai_compatible",
      FERAL_BASE_URL: sidecarBaseUrl(baseUrl),
      FERAL_MODEL: model,
      FERAL_API_KEY: apiKey,
    },
  };
}

/**
 * One cheap chat completion before any task runs.
 *
 * Without this the first failure mode of an overnight run is "all N tasks
 * failed" with N identical inference errors, discovered hours later. The whole
 * value of the bench is the number it produces, and a run that could never
 * have produced one should refuse to start.
 */
async function preflight(routeEnv) {
  // Built the same way inference-providers.ts builds it, deliberately: a
  // preflight that probes a different URL than the sidecar uses can pass while
  // every task 404s, which is worse than having no preflight.
  const url = `${routeEnv.FERAL_BASE_URL}/v1/chat/completions`;
  // An explicit controller rather than AbortSignal.timeout: the latter leaves a
  // live timer handle, and exiting while it is mid-close trips a libuv
  // assertion that aborts the process with 127 — which automation reads as
  // "command not found" rather than "preflight failed".
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(routeEnv.FERAL_API_KEY ? { authorization: `Bearer ${routeEnv.FERAL_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: routeEnv.FERAL_MODEL,
        messages: [{ role: "user", content: "reply with the single word: ok" }],
        max_tokens: 8,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return `${res.status} ${res.statusText} from ${url} — ${(await res.text()).slice(0, 200)}`;
    }
    const body = await res.json();
    if (!body?.choices?.length) return `no choices in the response from ${url}`;
    return null;
  } catch (e) {
    return `cannot reach ${url}: ${String(e).slice(0, 200)}`;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Give the isolated run a working brain.
 *
 * Each task gets its own FERAL_HOME so memory cannot leak between runs — but
 * FERAL_HOME is also where the provider config and BYOK keys live, so a naive
 * isolation produced "Inference unavailable: primary inference failed and no
 * fallback configured" and measured nothing at all. (That is what the first
 * smoke run of this script actually reported, in two minutes, which is the
 * whole argument for having it.)
 *
 * Copy ONLY the files that describe how to reach a model. Memory, sessions,
 * RSI state and the journal are deliberately left behind.
 */
function seedProviderConfig(benchHome) {
  mkdirSync(benchHome, { recursive: true });
  const real = join(homedir(), ".feral");
  let copied = 0;
  for (const f of ["byok.json", "byok.keys", "brain.json", "onboarding.json"]) {
    const src = join(real, f);
    if (existsSync(src)) {
      copyFileSync(src, join(benchHome, f));
      copied++;
    }
  }
  return copied;
}

// ─────────────────────────────────────────────────────────── task definitions

/**
 * Each task is: a prompt, a per-task timeout, and a `check(workspace)` that
 * returns null on success or a string explaining the failure.
 *
 * They are ordered by how much unattended endurance they need, so a run that
 * degrades tells you WHERE it degrades rather than just that it did.
 */
const TASKS = [
  {
    id: "write-cli",
    minutes: 10,
    prompt:
      "In the current working directory, create a file `wordcount.mjs`: a Node script that " +
      "reads a text file path from argv[2] and prints the number of lines, words and " +
      "characters, one per line, in that order, each as `label: number`. " +
      "Then create `sample.txt` containing exactly three lines of prose, run the script " +
      "against it, and confirm the output is correct. Do not stop until you have run it.",
    check: (ws) => {
      if (!existsSync(join(ws, "wordcount.mjs"))) return "wordcount.mjs was never created";
      if (!existsSync(join(ws, "sample.txt"))) return "sample.txt was never created";
      const out = runNode([join(ws, "wordcount.mjs"), join(ws, "sample.txt")]);
      if (out.code !== 0) return `script exits ${out.code}: ${out.stderr.slice(0, 300)}`;
      const lines = out.stdout.trim().split(/\r?\n/);
      if (lines.length !== 3) return `expected 3 output lines, got ${lines.length}: ${out.stdout.slice(0, 200)}`;
      if (!/^lines:\s*3$/i.test(lines[0].trim())) return `line count wrong: "${lines[0]}"`;
      return null;
    },
  },
  {
    id: "fix-failing-test",
    minutes: 15,
    // Endurance shape: read, understand, edit, verify, repeat. This is the one
    // the read-before-edit gate should visibly help.
    setup: (ws) => {
      writeFileSync(
        join(ws, "math.mjs"),
        "export function median(xs) {\n" +
          "  const s = [...xs].sort();\n" + // bug: lexicographic sort
          "  return s[Math.floor(s.length / 2)];\n" +
          "}\n",
      );
      writeFileSync(
        join(ws, "math.test.mjs"),
        "import { median } from './math.mjs';\n" +
          "import assert from 'node:assert';\n" +
          "assert.strictEqual(median([1, 2, 10]), 2);\n" +
          "assert.strictEqual(median([10, 2, 1]), 2);\n" +
          "assert.strictEqual(median([5, 100, 20]), 20);\n" +
          "console.log('PASS');\n",
      );
    },
    prompt:
      "`math.test.mjs` in the current directory fails when run with `node math.test.mjs`. " +
      "Find out why, fix `math.mjs`, and keep working until `node math.test.mjs` prints PASS. " +
      "Do not change the test file.",
    check: (ws) => {
      const original = "assert.strictEqual(median([1, 2, 10]), 2);";
      if (!readFileSync(join(ws, "math.test.mjs"), "utf8").includes(original)) {
        return "the test file was modified — the task said not to";
      }
      const out = runNode([join(ws, "math.test.mjs")]);
      if (out.code !== 0) return `test still fails: ${out.stderr.slice(0, 300)}`;
      if (!out.stdout.includes("PASS")) return `no PASS in output: ${out.stdout.slice(0, 200)}`;
      return null;
    },
  },
  {
    id: "multi-file-refactor",
    minutes: 25,
    // The long one. Several files, an invariant that spans them, and a
    // verification step — the shape where context loss and stale reads bite.
    setup: (ws) => {
      for (const [name, body] of [
        ["a.mjs", "export const GREETING = 'hello';\nexport function greetA(n) { return GREETING + ' ' + n; }\n"],
        ["b.mjs", "import { GREETING } from './a.mjs';\nexport function greetB(n) { return GREETING + ', ' + n + '!'; }\n"],
        ["c.mjs", "import { greetA } from './a.mjs';\nimport { greetB } from './b.mjs';\nconsole.log(greetA('x'), greetB('y'));\n"],
      ]) {
        writeFileSync(join(ws, name), body);
      }
    },
    prompt:
      "This directory has a.mjs, b.mjs and c.mjs. Rename the exported constant `GREETING` " +
      "to `SALUTATION` everywhere it is used, across all files, without changing any " +
      "behaviour. Then run `node c.mjs` and confirm it still prints the same two greetings " +
      "it printed before. Keep going until that command runs clean.",
    check: (ws) => {
      for (const f of ["a.mjs", "b.mjs", "c.mjs"]) {
        const src = readFileSync(join(ws, f), "utf8");
        if (/\bGREETING\b/.test(src)) return `${f} still references GREETING`;
      }
      if (!/\bSALUTATION\b/.test(readFileSync(join(ws, "a.mjs"), "utf8"))) {
        return "a.mjs does not export SALUTATION";
      }
      const out = runNode([join(ws, "c.mjs")]);
      if (out.code !== 0) return `node c.mjs exits ${out.code}: ${out.stderr.slice(0, 300)}`;
      if (!out.stdout.includes("hello x") || !out.stdout.includes("hello, y!")) {
        return `behaviour changed — output was: ${out.stdout.trim().slice(0, 200)}`;
      }
      return null;
    },
  },
];

// ──────────────────────────────────────────────────────────────────── running

function runNode(args) {
  const r = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 20_000 });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Drive one task: spawn the sidecar, send the prompt, collect events until
 * `done` or the timeout. Returns the transcript and how it ended.
 *
 * The timeout is the point of the whole exercise, so it is a hard kill rather
 * than a polite request: "it was still going after 25 minutes" is a FAILURE,
 * not a longer wait.
 */
function runTask(task, workspace, logPath, timeoutMs, routeEnv) {
  const benchHome = join(workspace, ".feral");
  seedProviderConfig(benchHome);
  return new Promise((done) => {
    const events = [];
    let lastError = null;
    const child = spawn(BUN, [SIDECAR_ENTRY], {
      cwd: workspace,
      env: {
        ...process.env,
        // The whole point: no human to answer ask_user.
        FERAL_AUTONOMOUS: "true",
        // The resolved route. Passed explicitly because the isolated home has
        // no model selection in it, and because the sidecar never reads
        // byok.json — normally the Rust host hands it exactly these four.
        // Missing them was the whole reason the first run reported
        // "Inference unavailable" against a default of qwen2.5:7b.
        ...routeEnv,
        FERAL_WORKSPACE: workspace,
        FERAL_ENABLE_SHELL_EXEC: "true",
        // Isolate state so one task cannot poison the next through memory.
        FERAL_HOME: benchHome,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buf = "";
    let settled = false;
    const finish = (outcome, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      writeFileSync(logPath, events.map((e) => JSON.stringify(e)).join("\n"), "utf8");
      done({ outcome, detail, events, lastError });
    };

    const timer = setTimeout(() => finish("timeout", `still running after ${Math.round(timeoutMs / 60000)} min`), timeoutMs);

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("{")) continue; // sidecar log lines
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        events.push(ev);
        if (ev.type === "done") finish("done", ev.stopped ? "stopped early" : "completed");
        if (ev.type === "error") {
          // Terminal. The first version let the run idle out the full timeout
          // after inference died, turning a 5-second diagnosis into a 25-minute
          // "timeout" that said nothing about why.
          lastError = ev.message;
          finish("agent_error", ev.message);
        }
      }
    });
    child.stderr.on("data", (c) => events.push({ type: "_stderr", text: c.toString().slice(0, 2000) }));
    child.on("error", (e) => finish("spawn_error", String(e)));
    child.on("exit", (code) => finish("exited", `sidecar exited with code ${code} before finishing`));

    child.stdin.write(
      JSON.stringify({ type: "message", id: `bench-${task.id}`, sessionId: `bench-${task.id}`, content: task.prompt }) + "\n",
    );
  });
}

// ─────────────────────────────────────────────────────────────────────── main

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const only = arg("task", null);
const repeat = Number(arg("repeat", 1));
const timeoutOverride = arg("timeout", null);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(ROOT, "bench-results", stamp);
mkdirSync(outDir, { recursive: true });

const selected = only ? TASKS.filter((t) => t.id === only) : TASKS;
if (selected.length === 0) {
  console.error(`no task named "${only}". Known: ${TASKS.map((t) => t.id).join(", ")}`);
  process.exit(2);
}

/** Run every selected task. Only reached once preflight confirmed a model. */
async function runAll(routeEnv) {
  console.log(`walk-away bench — ${selected.length} task(s) x ${repeat} run(s)`);
  console.log(`results: ${outDir}\n`);

  const results = [];
  for (const task of selected) {
    for (let run = 1; run <= repeat; run++) {
      const label = repeat > 1 ? `${task.id}#${run}` : task.id;
      const ws = join(outDir, label);
      rmSync(ws, { recursive: true, force: true });
      mkdirSync(ws, { recursive: true });
      task.setup?.(ws);

      const timeoutMs = (timeoutOverride ? Number(timeoutOverride) * 1000 : task.minutes * 60_000);
      const started = Date.now();
      process.stdout.write(`  ${label.padEnd(28)} `);

      const { outcome, detail, lastError } = await runTask(task, ws, join(ws, "events.jsonl"), timeoutMs, routeEnv);
      const elapsedMin = ((Date.now() - started) / 60_000).toFixed(1);

      // The agent finishing is NOT the same as the work being right — check the
      // artifacts regardless of how the run ended.
      // Infrastructure failures are reported FIRST and never dressed up as an
      // agent failure — if the sidecar could not start, "the file was never
      // created" is true but says nothing about the agent.
      let failure = null;
      if (outcome === "spawn_error" || outcome === "exited") {
        failure = `HARNESS/INFRA — ${outcome}: ${detail}`;
      } else if (lastError && /inference unavailable|no fallback configured/i.test(lastError)) {
        // Not a reliability datapoint: the agent never got a model to think with.
        failure = `HARNESS/INFRA — no working inference: ${lastError.slice(0, 200)}`;
      } else {
        try {
          failure = task.check(ws);
        } catch (e) {
          failure = `check threw: ${String(e).slice(0, 200)}`;
        }
        if (!failure && outcome !== "done") failure = `${outcome}: ${detail}`;
        if (failure && lastError && outcome !== "done") failure += ` | last error: ${lastError.slice(0, 200)}`;
      }

      const passed = failure === null;
      console.log(`${passed ? "PASS" : "FAIL"}  ${elapsedMin}min  ${failure ?? ""}`);
      results.push({ task: task.id, run, passed, elapsedMin: Number(elapsedMin), outcome, detail, failure });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const rate = results.length ? Math.round((passed / results.length) * 100) : 0;
  writeFileSync(
    join(outDir, "summary.json"),
    JSON.stringify({ stamp, passed, total: results.length, rate, results }, null, 2),
    "utf8",
  );

  console.log(`\n${passed}/${results.length} passed (${rate}%)`);
  console.log(`summary: ${join(outDir, "summary.json")}`);
  if (passed < results.length) {
    console.log("\nfailures:");
    for (const r of results.filter((x) => !x.passed)) {
      console.log(`  ${r.task}#${r.run}: ${r.failure}`);
    }
  }

  process.exitCode = passed === results.length ? 0 : 1;
}

/**
 * Stop with a code the caller can branch on.
 *
 * `process.exit()` after a `fetch` trips a libuv assertion on Windows
 * (`UV_HANDLE_CLOSING` in win/async.c) because undici is still tearing its
 * handles down — the process aborts with 127, which reads as "command not
 * found" rather than "preflight failed". Setting `exitCode` and returning lets
 * the loop drain and exits with the code we actually meant.
 */
function stop(code, message) {
  if (message) console.error(message);
  process.exitCode = code;
}

// Refuse to start without a model rather than produce N identical inference
// failures and call it a reliability measurement.
const route = resolveRoute();
if (route.error) {
  stop(2, `walk-away bench cannot start — ${route.error}`);
}
if (!route.error) {
  process.stdout.write(`preflight: ${route.env.FERAL_MODEL} @ ${route.env.FERAL_BASE_URL} ... `);
  const preflightError = await preflight(route.env);
  if (preflightError) {
    stop(2, `FAILED\n\n  ${preflightError}\n\nNothing was run.`);
  } else {
    console.log("ok");
    await runAll(route.env);
  }
}
