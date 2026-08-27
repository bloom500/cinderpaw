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

import { openArcGame, openScorecard, closeScorecard, listGames } from "../../src/arc/api-client.ts";
import { playLevel } from "../../src/arc/play-level.ts";
import { createFrugalPolicy } from "../../src/arc/policy.ts";
import { createModelPolicy } from "../../src/arc/model-policy.ts";
import { OpenAICompatibleProvider } from "../../src/egress/inference-providers.ts";
import { createRunManifest, writeRunManifest, reportabilityProblems } from "../../src/core/run-manifest.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseArgs(argv) {
  const args = { budget: 200, retries: 0, model: "deepseek/deepseek-v4-flash", tags: [] };
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
    else throw new Error(`unknown flag "${flag}" — run with no arguments to see usage`);
  }
  if (!Number.isInteger(args.budget) || args.budget < 1) {
    throw new Error(`--budget must be an integer >= 1, got ${String(args.budget)}`);
  }
  if (!Number.isInteger(args.retries) || args.retries < 0) {
    throw new Error(`--retries must be an integer >= 0, got ${String(args.retries)}`);
  }
  return args;
}

/**
 * One model, one provider, no fallback. Returns the reply text.
 *
 * The 16k cap is generous for "name one button" and exists only so a model
 * that starts monologuing cannot stall the run.
 */
function makeComplete(model) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "no OPENROUTER_API_KEY. Set it, or pass --dry-run to exercise the harness without a model.",
    );
  }
  const provider = new OpenAICompatibleProvider();
  const target = { provider: "openrouter", model, baseUrl: "https://openrouter.ai/api/v1", apiKey };
  let calls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  const complete = async (messages) => {
    calls++;
    const response = await provider.complete(target, {
      sessionId: "arc-agi-3",
      messages,
      maxTokens: 16_000,
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

const complete = args.dryRun ? null : makeComplete(args.model);

let vetoes = 0;
let unparsed = 0;
// The dry run needs an inner policy that is not a model. First offered action:
// it exercises every seam (client, loop, frugal wrapper, scorecard) and proves
// nothing about play, which is the honest division of labour for a smoke test.
const inner = args.dryRun
  ? (_observation, ctx) => ctx.actions[0] ?? null
  : createModelPolicy({ complete, onUnparsed: () => { unparsed++; } });
const policy = createFrugalPolicy({ inner, onVeto: () => { vetoes++; } });

const cardId = await openScorecard({
  tags: ["cinderpaw", ...args.tags],
  opaque: { manifest },
});
console.log(`scorecard ${cardId}  game ${args.game}  budget ${args.budget}\n`);

const attempts = [];
let spent = 0;
try {
  for (let attempt = 0; attempt <= args.retries; attempt++) {
    const remaining = args.budget - spent;
    if (remaining <= 0) break;
    const env = await openArcGame({ gameId: args.game, cardId });
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
  await closeScorecard(cardId).catch((err) => console.error(`close failed: ${String(err)}`));
}

const outDir = path.join(REPO_ROOT, "runs", manifest.runId);
const manifestPath = writeRunManifest(manifest, outDir);

console.log(`\nscorecard   ${cardId}`);
console.log(`actions     ${spent} of ${args.budget}`);
console.log(`attempts    ${JSON.stringify(attempts)}`);
console.log(`vetoed      ${vetoes} presses the frugal policy refused to pay for`);
if (!args.dryRun) {
  const usage = complete.usage();
  console.log(`model       ${args.model} — ${usage.calls} completions, ${usage.promptTokens} prompt / ${usage.completionTokens} completion tokens`);
  console.log(`unparsed    ${unparsed} replies named no available button`);
}
console.log(`manifest    ${manifestPath}`);
console.log(`\nScores come from the scorecard, not from here: https://three.arcprize.org`);
