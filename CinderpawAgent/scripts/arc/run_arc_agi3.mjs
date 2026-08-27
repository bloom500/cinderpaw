/**
 * Play a real ARC-AGI-3 game and record what happened.
 *
 * This is the second consumer the run manifest has been waiting for since
 * Val 1. Nothing here is a self-test and nothing here generates its own maze:
 * every grid comes from three.arcprize.org and every action is billed to a
 * scorecard the server issued.
 *
 * Run:
 *   ARC_API_KEY=...  OPENROUTER_API_KEY=...  \
 *   bun scripts/arc/run_arc_agi3.mjs --game <game_id> --budget 200
 *
 *   --list                 print the available games and exit
 *   --game    <id>         required otherwise; from --list
 *   --budget  <n>          hard action cap for the whole game (default 200)
 *   --model   <name>       OpenRouter model (default deepseek/deepseek-v4-flash)
 *   --retries <n>          RESET and retry this many times after GAME_OVER (default 0)
 *   --tag     <text>       repeatable, attached to the scorecard
 *   --dry-run              play with a fixed policy, no model calls, no key needed
 *   --no-imagination       disable MCTS rehearsal (run twice to measure its delta)
 *   --no-perception        do not describe the grid as objects in the prompt
 *   --reasoning-effort <e> low | medium | high (default medium)
 *   --provider <name>      pin the OpenRouter upstream (default Z.AI)
 *   --any-provider         let OpenRouter route freely (NOT for a scored run)
 *   --learn-budget <ms>    total wall-clock the search may spend (default 20000)
 *
 * NO PROVIDER FALLBACK, DELIBERATELY. The agent's InferenceRouter falls back to
 * another provider when one fails, which is right for a person mid-conversation
 * and wrong for a benchmark: the manifest names ONE model, and a run that
 * quietly finished on a different one is a number that cannot be published. So
 * this talks to a single target and fails loudly instead.
 *
 * BENCHMARK MODE. With CINDERPAW_BENCHMARK_RUN_ID set, three.arcprize.org and the
 * model host must both be in CINDERPAW_BENCHMARK_ALLOW_HOSTS or every request fails
 * closed — correct behaviour that looks exactly like a broken client.
 */

import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openArcGame, openScorecard, closeScorecard, listGames, CookieJar } from "../../src/arc/api-client.ts";
import { playLevel } from "../../src/arc/play-level.ts";
import { createFrugalPolicy } from "../../src/arc/policy.ts";
import { createModelPolicy } from "../../src/arc/model-policy.ts";
import { createRunManifest, writeRunManifest, reportabilityProblems } from "../../src/core/run-manifest.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseArgs(argv) {
  const args = {
    budget: 200,
    retries: 0,
    model: "deepseek/deepseek-v4-flash",
    tags: [],
    learnBudgetMs: 20_000,
    reasoningEffort: "medium",
    // The model's own first-party upstream: fastest of the five observed, and
    // the one that actually honoured `reasoning.effort`.
    provider: "Z.AI",
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--list") args.list = true;
    else if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--game") { args.game = value; i++; }
    else if (flag === "--model") { args.model = value; i++; }
    else if (flag === "--tag") { args.tags.push(value); i++; }
    else if (flag === "--budget") { args.budget = Number(value); i++; }
    else if (flag === "--retries") { args.retries = Number(value); i++; }
    else if (flag === "--no-imagination") args.imagination = false;
    else if (flag === "--no-perception") args.perception = false;
    else if (flag === "--reasoning-effort") { args.reasoningEffort = value; i++; }
    else if (flag === "--provider") { args.provider = value; i++; }
    else if (flag === "--any-provider") { args.provider = null; i++; }
    else if (flag === "--learn-budget") { args.learnBudgetMs = Number(value); i++; }
    else throw new Error(`unknown flag "${flag}" — run with no arguments to see usage`);
  }
  if (!Number.isInteger(args.budget) || args.budget < 1) {
    throw new Error(`--budget must be an integer >= 1, got ${String(args.budget)}`);
  }
  if (!Number.isInteger(args.retries) || args.retries < 0) {
    throw new Error(`--retries must be an integer >= 0, got ${String(args.retries)}`);
  }
  if (!["low", "medium", "high"].includes(args.reasoningEffort)) {
    throw new Error(`--reasoning-effort must be low, medium or high, got ${String(args.reasoningEffort)}`);
  }
  if (!Number.isInteger(args.learnBudgetMs) || args.learnBudgetMs < 0) {
    throw new Error(`--learn-budget must be an integer >= 0 (ms), got ${String(args.learnBudgetMs)}`);
  }
  return args;
}

/**
 * One model, one provider, no fallback. Returns the reply text.
 *
 * The 16k cap is generous for "name one button" and exists only so a model
 * that starts monologuing cannot stall the run.
 */
function makeComplete(model, reasoningEffort, providerOnly) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "no OPENROUTER_API_KEY. Set it, or pass --dry-run to exercise the harness without a model.",
    );
  }
  const provider = new OpenAICompatibleProvider();
  // NO TRAILING /v1. `OpenAICompatibleProvider` appends `/v1/chat/completions`
  // itself, so the documented base URL — which is what OpenRouter prints, what
  // BYOK stores, and what anyone would paste here — doubles into
  // `/api/v1/v1/chat/completions` and comes back as a 404 page of HTML. The
  // desktop host strips the same suffix for the same reason
  // (crates/cinderpaw-core/src/cinderpaw_agent.rs). Normalised rather than
  // written short, so pasting either form works.
  const baseUrl = "https://openrouter.ai/api/v1".replace(/\/+$/, "").replace(/\/v1$/, "");
  const target = { provider: "openrouter", model, baseUrl, apiKey };
  let calls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  const complete = async (messages) => {
    calls++;
    const response = await provider.complete(target, {
      sessionId: "arc-agi-3",
      messages,
      // NO max_tokens, on purpose. A cap on a reasoning model bounds the whole
      // reply and the thinking is spent first, so a cap does not shorten the
      // monologue — it deletes the answer after it. Measured on
      // z-ai/glm-5.3-flash: max_tokens 2000 came back with 2,000 tokens of
      // thinking and an empty `content`. `effort` is the honest lever, and it
      // is the only one here.
      //
      // Empty `content` is survivable in any case: the provider folds
      // `reasoning` back in as <think>...</think>, and parseChoice reads the
      // last action named anywhere in the reply.
      reasoningEffort,
      // Same upstream for all 25 games. Unpinned, OpenRouter served this one
      // model from five different upstreams with a 158x latency spread and a
      // coin flip on whether an answer came back — variance that would land in
      // the score as if it were the agent's.
      providerOnly,
      temperature: 0,
    });
    promptTokens += response.promptTokens ?? 0;
    completionTokens += response.completionTokens ?? 0;
    return response.content ?? "";
  };
  complete.usage = () => ({ calls, promptTokens, completionTokens });
  return complete;
}

const args = parseArgs(process.argv.slice(2));

// The provider aborts a cloud call after 60s (CLOUD_IDLE_MS), and with no token
// cap a reasoning model thinks for longer than that on a real 64x64 grid —
// measured at 191s — with the abort surfacing as a bare AbortError that reads
// like a network fault rather than "it was still thinking".
//
// CINDERPAW_CLOUD_IDLE_TIMEOUT_MS raises it, and it has to be set in the
// ENVIRONMENT, not here: `config.ts` snapshots the environment when it is first
// imported and `run-manifest.ts` imports it statically, so an assignment in
// this file is already too late however early it sits. It lives in .env, which
// bun loads before the script runs — the only point early enough. Setting it
// from here was tried and silently did nothing, which cost a pilot run.
const { OpenAICompatibleProvider } = await import("../../src/egress/inference-providers.ts");

if (args.list) {
  const games = await listGames();
  for (const game of games) console.log(`${game.game_id}\t${game.title ?? ""}`);
  process.exit(0);
}

if (!args.game) {
  console.error("--game is required. Run with --list to see the available games.");
  process.exit(2);
}

// The manifest first, so a run that crashes on request one still leaves a
// record of exactly what was attempted.
const version = JSON.parse(
  await import("node:fs/promises").then((fs) => fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8")),
).version;
const manifest = createRunManifest({
  runId: process.env.CINDERPAW_BENCHMARK_RUN_ID ?? `arc-${Date.now()}`,
  harness: { name: "cinderpaw-arc-agi-3", version },
  repoRoot: REPO_ROOT,
  config: { benchmark: "arc-agi-3", game: args.game, retries: args.retries, dryRun: !!args.dryRun },
  budgets: { actions: args.budget },
  models: args.dryRun ? {} : { policy: `openrouter/${args.model}` },
});
const problems = reportabilityProblems(manifest);
if (problems.length > 0) {
  // Not fatal: an unreportable run is still worth doing on the public demo,
  // which is unlimited. It just must not be quoted anywhere.
  console.warn(`NOT REPORTABLE — this run may not be published:\n  ${problems.join("\n  ")}\n`);
}

const complete = args.dryRun ? null : makeComplete(args.model, args.reasoningEffort, args.provider ? [args.provider] : undefined);

let vetoes = 0;
let unparsed = 0;
// The dry run needs an inner policy that is not a model. First offered action:
// it exercises every seam (client, loop, frugal wrapper, scorecard) and proves
// nothing about play, which is the honest division of labour for a smoke test.
const inner = args.dryRun
  ? (_observation, ctx) => ctx.actions[0] ?? null
  : createModelPolicy({
      complete,
      onUnparsed: () => { unparsed++; },
      // Objects alongside the raw cells. Free in keypresses, and the same
      // reading the DSL and the rehearsal already work in.
      scene: args.perception === false ? false : {},
      onScene: () => { scenes++; },
    });
// MCTS rehearsal. Free in keypresses, NOT free in wall-clock — and the
// scorecard closes 15 minutes after it opens — so the search gets a hard total
// budget and the run reports what it bought. Off with --no-imagination, so the
// delta it is responsible for can be measured by running the same game twice.
const policy = createFrugalPolicy({
  inner,
  onVeto: () => { vetoes++; },
  imagination: args.imagination === false ? undefined : { learnBudgetMs: args.learnBudgetMs },
  onLearn: (info) => {
    learnPasses++;
    learnMs += info.elapsedMs;
    trustedRules = info.trusted;
    if (info.budgetSpent) console.log("  (imagination: time budget spent, playing on the table alone)");
  },
  onImagined: () => { imagined++; },
});

// ONE jar for the whole session: open, every game, and close. The load
// balancer pins the card to a backend and everything after has to reach the
// same one — a second jar makes the server deny an id it issued itself.
const jar = new CookieJar();
const cardId = await openScorecard({
  jar,
  tags: ["cinderpaw", ...args.tags],
  opaque: { manifest },
});
const cardOpenedAt = Date.now();

// NO DEADLINE. The docs say "scorecards auto close after 15 minutes" and this
// runner used to stop 45s short of that, which would have cut every game off
// at roughly fifty presses.
//
// Measured instead of believed: one card, 220 actions over 17 minutes, every
// one returning 200, and the close response reported `actions: 220` with
// `level_actions: [220,0,0,0,0,0,0]`. The card recorded everything after minute
// fifteen. The auto-close finalises an ABANDONED card so its results appear —
// it is not a clock on play, which is also the only reading compatible with
// anyone running thousands of actions on one game.

// Close the card on the way out of a signal too.
//
// The `finally` below covers finishing and throwing. It does NOT cover Ctrl-C:
// Node's default SIGINT handler exits the process without unwinding, so the
// `finally` never runs, the card is never closed, and the docs are explicit
// that a card left open shows no results. Every way this process can end has to
// pass through closeScorecard, or the run produces nothing at all.
let closing = false;
const closeAndExit = async (signal) => {
  if (closing) return;
  closing = true;
  console.error(`${signal} - closing scorecard ${cardId} so the run still counts...`);
  await closeScorecard(cardId, { jar }).catch((err) => console.error(`close failed: ${String(err)}`));
  console.error("closed. Scores: https://three.arcprize.org");
  process.exit(130);
};
process.on("SIGINT", () => void closeAndExit("SIGINT"));
process.on("SIGTERM", () => void closeAndExit("SIGTERM"));
console.log(`scorecard ${cardId}  game ${args.game}  budget ${args.budget}\n`);

const attempts = [];
let spent = 0;
let scenes = 0;
let learnPasses = 0;
let learnMs = 0;
let trustedRules = 0;
let imagined = 0;
try {
  for (let attempt = 0; attempt <= args.retries; attempt++) {
    const remaining = args.budget - spent;
    if (remaining <= 0) break;
    const env = await openArcGame({ gameId: args.game, cardId, jar });
    if (attempt > 0) await env.reset();
    const result = await playLevel({
      env,
      policy,
      maxActions: remaining,
      onAction: (action, observation, index) => {
        console.log(
          `  ${String(spent + index).padStart(4)}  ${action.padEnd(14)} ${observation.state}` +
            `  levels=${env.last.levelsCompleted}`,
        );
      },
    });
    spent += result.actions.length;
    attempts.push({
      attempt,
      state: result.state,
      actions: result.actions.length,
      stoppedBecause: result.stoppedBecause,
      levelsCompleted: env.last.levelsCompleted,
      winLevels: env.last.winLevels,
    });
    if (result.state === "WIN" || result.stoppedBecause === "budget") break;
  }
} finally {
  // Always close: an open scorecard holds the run and the numbers never land.
  await closeScorecard(cardId, { jar }).catch((err) => console.error(`close failed: ${String(err)}`));
}

const outDir = path.join(REPO_ROOT, "runs", manifest.runId);
const manifestPath = writeRunManifest(manifest, outDir);

console.log(`\nscorecard   ${cardId}`);
console.log(`actions     ${spent} of ${args.budget}`);
console.log(`card open   ${Math.round((Date.now() - cardOpenedAt) / 1000)}s`);
console.log(`attempts    ${JSON.stringify(attempts)}`);
console.log(`vetoed      ${vetoes} presses the frugal policy refused to pay for`);
if (args.imagination !== false) {
  console.log(
    `imagination ${learnPasses} MCTS passes in ${(learnMs / 1000).toFixed(1)}s, ` +
      `${trustedRules} trusted rules, ${imagined} presses demoted by a prediction`,
  );
}
if (!args.dryRun) {
  const usage = complete.usage();
  console.log(
    `model       ${args.model} — ${usage.calls} completions, ${usage.promptTokens} prompt / ` +
      `${usage.completionTokens} completion tokens` +
      `, reasoning effort ${args.reasoningEffort}, no token cap, upstream ${args.provider ?? "UNPINNED"}`,
  );
  console.log(`unparsed    ${unparsed} replies named no available button`);
  console.log(
    `perception  ${scenes} of ${spent} prompts carried a scene description` +
      (args.perception === false ? " (disabled)" : ""),
  );
}
console.log(`manifest    ${manifestPath}`);
console.log(`\nScores come from the scorecard, not from here: https://three.arcprize.org`);
