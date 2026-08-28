/**
 * Run the whole ARC-AGI-3 benchmark: every game in `games.txt`, in parallel, on
 * ONE scorecard, as one command.
 *
 *   bun scripts/arc/sweep.mjs --arm cinderpaw --max-spend-total 3.20
 *
 * WHY THIS EXISTS. Every part of a full run already worked and was tested —
 * `arc_card.mjs` opens the card, `run_arc_agi3.mjs --card --cookie` plays one
 * game on it, `games.txt` holds the 25 ids — and there was no script that put
 * the three together. Nine sessions of harness work produced no benchmark
 * number because the assembly was the missing piece, not the parts.
 *
 * SUBPROCESSES, NOT IMPORTS. One child per game, deliberately:
 *
 *  - A game that throws cannot take the other 24 with it. The official harness
 *    gets the same isolation from threads; processes are stronger and free.
 *  - `run_arc_agi3.mjs` already owns the whole per-game story — manifest,
 *    frames, spend cap, retries, forensic trace. Re-implementing any of that
 *    here would be a second place for it to be wrong.
 *  - The dirty-tree gate lives in `arc_card.mjs`. Spawning it means the gate
 *    applies to a sweep for free, rather than being copied and drifting.
 *
 * THE CARD MUST BE CLOSED. A card abandoned by a SIGKILL auto-finalises as
 * abandoned and the run is gone. SIGINT/SIGTERM here stop the children and
 * close the card; there is nothing to be done about SIGKILL except not to send
 * one. Do not `TaskStop` this script.
 */
import process from "node:process";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const GAMES_FILE = path.resolve(REPO_ROOT, "..", "runs-arc", "games.txt");

/**
 * What each arm turns off. The point of a benchmark run in two arms is to find
 * out whether the harness helps at all, so BARE has to be a real control: the
 * model, the grid, the buttons and answer parsing, and nothing else. If BARE
 * wins, that is the most valuable result available and it costs the same.
 */
const ARMS = {
  bare: ["--no-frugal", "--no-perception", "--no-click-candidates", "--no-imagination"],
  cinderpaw: [],
};

const args = {
  arm: "cinderpaw",
  games: null,
  concurrency: 25,
  budget: 80,
  maxSpendTotal: 3.2,
  model: "meta/muse-spark-1.2-contributor",
  provider: "Meta",
  competition: true,
  tags: [],
  dryRun: false,
};

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i];
  const value = argv[i + 1];
  if (flag === "--arm") { args.arm = value; i++; }
  else if (flag === "--games") { args.games = value; i++; }
  else if (flag === "--concurrency") { args.concurrency = Number(value); i++; }
  else if (flag === "--budget") { args.budget = value === "none" ? "none" : Number(value); i++; }
  else if (flag === "--max-spend-total") { args.maxSpendTotal = Number(value); i++; }
  else if (flag === "--model") { args.model = value; i++; }
  else if (flag === "--provider") { args.provider = value; i++; }
  else if (flag === "--no-competition") args.competition = false;
  else if (flag === "--tag") { args.tags.push(value); i++; }
  else if (flag === "--dry-run") args.dryRun = true;
  else throw new Error(`unknown flag "${flag}" — see the header of this file`);
}

if (!(args.arm in ARMS)) {
  throw new Error(`--arm must be one of ${Object.keys(ARMS).join(", ")}, got "${String(args.arm)}"`);
}
if (!Number.isInteger(args.concurrency) || args.concurrency < 1) {
  throw new Error(`--concurrency must be an integer >= 1, got ${String(args.concurrency)}`);
}
if (!Number.isFinite(args.maxSpendTotal) || args.maxSpendTotal <= 0) {
  throw new Error(`--max-spend-total must be a positive number of dollars, got ${String(args.maxSpendTotal)}`);
}

const games = (args.games ? args.games.split(",") : fs.readFileSync(GAMES_FILE, "utf8").split("\n"))
  .map((g) => g.trim())
  .filter((g) => g.length > 0 && !g.startsWith("#"));
if (games.length === 0) throw new Error(`no games: ${GAMES_FILE} is empty and --games was not passed`);

/**
 * The per-game cap is the total divided evenly, and it is a CAP, not an
 * allowance: games that finish early hand nothing back. That is deliberate —
 * the alternative is a shared pot where one runaway game eats the budget for
 * the other 24 and the sweep silently becomes a single-game run.
 */
const perGameSpend = args.maxSpendTotal / games.length;
if (perGameSpend < 0.01) {
  throw new Error(
    `$${args.maxSpendTotal.toFixed(2)} over ${games.length} games is $${perGameSpend.toFixed(4)} each — ` +
      "below the price of a few presses. Raise --max-spend-total or cut --games.",
  );
}

const sweepId = `sweep-${Date.now()}`;
const outDir = path.join(REPO_ROOT, "runs", sweepId);
fs.mkdirSync(outDir, { recursive: true });

const say = (line) => console.error(line);

say(`${sweepId}`);
say(`arm            ${args.arm}${ARMS[args.arm].length ? "  (" + ARMS[args.arm].join(" ") + ")" : ""}`);
say(`games          ${games.length}, ${args.concurrency} at a time`);
say(`model          ${args.model} via ${args.provider}`);
say(`budget         ${args.budget} actions/game, $${perGameSpend.toFixed(4)}/game, $${args.maxSpendTotal.toFixed(2)} total`);
say(`logs           ${outDir}`);
say("");

// ---------------------------------------------------------------- the card

/**
 * Runs a child to completion, capturing stdout. Never rejects: one game's crash
 * is a result to report, not an exception that takes the sweep down with it.
 */
function run(command, argv, { cwd = REPO_ROOT, log = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, argv, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const sink = log ? fs.createWriteStream(log) : null;
    child.stdout.on("data", (d) => {
      out += d;
      sink?.write(d);
    });
    child.stderr.on("data", (d) => {
      err += d;
      sink?.write(d);
    });
    child.on("error", (e) => resolve({ code: -1, out, err: String(e), child }));
    child.on("close", (code) => {
      sink?.end();
      resolve({ code, out, err, child });
    });
    running.add(child);
    child.on("close", () => running.delete(child));
  });
}

/** Every live child, so a signal can stop them before the card is closed. */
const running = new Set();

/**
 * A preload only applies to the process that was started with it, and every
 * game here is a separate process. So the free end-to-end harness would be
 * silently bypassed by a sweep — it would open a REAL card and spend REAL
 * money while looking like a rehearsal. `ARC_SWEEP_PRELOAD` passes it down:
 *
 *   FAKE=./scripts/arc/fake-arc-preload.mjs
 *   ARC_API_KEY=fake OPENROUTER_API_KEY=fake FAKE_ARC_MODEL=1 ARC_SWEEP_PRELOAD=$FAKE \
 *     bun --preload $FAKE scripts/arc/sweep.mjs --arm bare
 */
const preload = process.env.ARC_SWEEP_PRELOAD ? ["--preload", process.env.ARC_SWEEP_PRELOAD] : [];
if (preload.length > 0) say(`preload        ${process.env.ARC_SWEEP_PRELOAD}  (children are faked too)`);

const cardArgv = [...preload, "scripts/arc/arc_card.mjs", "open", ...(args.competition ? ["--competition"] : [])];
for (const tag of [args.arm, sweepId, ...args.tags]) cardArgv.push("--tag", tag);

const opened = await run("bun", cardArgv);
if (opened.code !== 0) {
  process.stderr.write(opened.err);
  say("\ncould not open a scorecard — nothing was played, nothing was spent.");
  process.exit(1);
}
process.stderr.write(opened.err);

const cardId = /^ARC_CARD_ID=(.+)$/m.exec(opened.out)?.[1];
const cardCookie = /^ARC_CARD_COOKIE='(.*)'$/m.exec(opened.out)?.[1];
if (!cardId) {
  say(`arc_card.mjs printed no card id:\n${opened.out}`);
  process.exit(1);
}

let closed = false;
async function closeCard(why) {
  if (closed) return;
  closed = true;
  say(`\nclosing card ${cardId} (${why})`);
  const res = await run("bun", [
    ...preload, "scripts/arc/arc_card.mjs", "close", "--card", cardId, "--cookie", cardCookie ?? "",
  ]);
  process.stderr.write(res.err);
  if (res.code === 0) {
    fs.writeFileSync(path.join(outDir, "scorecard.json"), res.out);
    say(`scorecard      ${path.join(outDir, "scorecard.json")}`);
  } else {
    // Worth shouting about: the run happened, the money was spent, and the
    // number is on the server. It can still be read from the URL by hand.
    say(`COULD NOT CLOSE THE CARD. Read it at https://three.arcprize.org/scorecards/${cardId}`);
    say(`Or: bun scripts/arc/arc_card.mjs close --card ${cardId} --cookie '<the cookie above>'`);
  }
  say(`scorecard url  https://three.arcprize.org/scorecards/${cardId}`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    say(`\n${signal} — stopping ${running.size} game(s), then closing the card.`);
    for (const child of running) child.kill("SIGINT");
    closeCard(signal).finally(() => process.exit(130));
  });
}

// ---------------------------------------------------------------- the games

const results = new Map();
const startedAt = Date.now();

async function playOne(game) {
  const log = path.join(outDir, `${game}.log`);
  const argvGame = [
    ...preload,
    "scripts/arc/run_arc_agi3.mjs",
    "--game", game,
    "--card", cardId,
    "--cookie", cardCookie ?? "",
    "--model", args.model,
    "--provider", args.provider,
    "--budget", String(args.budget),
    "--max-spend", perGameSpend.toFixed(4),
    "--tag", args.arm,
    ...ARMS[args.arm],
    ...(args.dryRun ? ["--dry-run"] : []),
  ];
  const res = await run("bun", argvGame, { log });
  // The runner prints `result      <path>`; that line is its contract with any
  // launcher, and reading it beats guessing which run directory was ours.
  const resultPath = /^result\s+(.+)$/m.exec(res.out)?.[1]?.trim();
  let summary = null;
  if (resultPath && fs.existsSync(resultPath)) {
    try {
      const r = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      summary = {
        levels: `${r.outcome.levelsCompleted}/${r.outcome.winLevels}`,
        cleared: r.outcome.levelsCompleted,
        actions: r.outcome.actionsSpent,
        spend: r.model?.spendUsd ?? 0,
        stopped: r.outcome.attempts?.[0]?.stoppedBecause ?? "?",
        unparsed: r.policy?.unparsed ?? 0,
      };
    } catch (e) {
      summary = { error: `unreadable result: ${String(e)}` };
    }
  }
  results.set(game, { code: res.code, log, summary });
  const done = results.size;
  const mark = summary?.cleared > 0 ? "LEVEL" : res.code === 0 ? "ok" : `exit ${res.code}`;
  say(
    `[${String(done).padStart(2)}/${games.length}] ${game.padEnd(16)} ${String(mark).padEnd(7)}` +
      (summary ? ` levels ${summary.levels}  ${summary.actions} actions  $${summary.spend.toFixed(4)}` : " (no result file)"),
  );
}

// A simple worker pool: `concurrency` games in flight, the rest queued. The
// official harness starts every game at once; a pool is the same shape with a
// knob for machines that cannot hold 25 model calls open.
const queue = [...games];
await Promise.all(
  Array.from({ length: Math.min(args.concurrency, queue.length) }, async () => {
    while (queue.length > 0) await playOne(queue.shift());
  }),
);

await closeCard("all games finished");

// ---------------------------------------------------------------- the report

const totalSpend = [...results.values()].reduce((sum, r) => sum + (r.summary?.spend ?? 0), 0);
const totalActions = [...results.values()].reduce((sum, r) => sum + (r.summary?.actions ?? 0), 0);
const cleared = [...results.values()].filter((r) => (r.summary?.cleared ?? 0) > 0);
const failed = [...results.entries()].filter(([, r]) => r.code !== 0);

const report = {
  sweepId,
  arm: args.arm,
  cardId,
  scorecardUrl: `https://three.arcprize.org/scorecards/${cardId}`,
  startedAt: new Date(startedAt).toISOString(),
  wallClockSeconds: Math.round((Date.now() - startedAt) / 1000),
  config: { ...args, perGameSpend, gameCount: games.length },
  games: Object.fromEntries(results),
};
fs.writeFileSync(path.join(outDir, "sweep.json"), JSON.stringify(report, null, 2));

say("");
say(`games            ${results.size}/${games.length} played, ${failed.length} exited non-zero`);
say(`games with a level cleared  ${cleared.length}`);
say(`actions          ${totalActions}`);
say(`spend            $${totalSpend.toFixed(4)} of $${args.maxSpendTotal.toFixed(2)}`);
say(`wall clock       ${(report.wallClockSeconds / 60).toFixed(1)} min`);
if (failed.length > 0) say(`failed games     ${failed.map(([g]) => g).join(", ")}  (see ${outDir})`);
say(`report           ${path.join(outDir, "sweep.json")}`);
say("");
say("The score comes from the scorecard, not from here.");
