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
 *   --budget  <n|none>     action cap for the whole game (default none: spend is
 *                          the only limit, which is the point — an action cap
 *                          decides the score for the agent instead of measuring
 *                          it, and the number worth comparing against is
 *                          NVIDIA AVO's 6,624 actions over 25 games, ~265 each)
 *   --model   <name>       OpenRouter model (default deepseek/deepseek-v4-flash)
 *   --retries <n>          RESET and retry this many times after GAME_OVER (default 0)
 *   --tag     <text>       repeatable, attached to the scorecard
 *   --dry-run              play with a fixed policy, no model calls, no key needed
 *   --no-imagination       disable MCTS rehearsal (run twice to measure its delta)
 *   --no-perception        do not describe the grid as objects in the prompt
 *   --reasoning-effort <e> low | medium | high (default medium)
 *   --provider <name>      pin the OpenRouter upstream (default Z.AI)
 *   --max-spend <usd>      hard per-game spend cap (default 0.15)
 *   --any-provider         let OpenRouter route freely (NOT for a scored run)
 *   --card    <id>         play on a scorecard someone else opened (arc_card.mjs)
 *   --cookie  <header>     that card's session cookie — REQUIRED with --card,
 *                          because the card is pinned to one backend
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
import fs from "node:fs";
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
    // No action cap by default. Money is the real constraint and it is already
    // enforced per process; a press cap on top of it ends the run at a number we
    // chose rather than at one we measured.
    budget: Infinity,
    retries: 0,
    model: "deepseek/deepseek-v4-flash",
    tags: [],
    learnBudgetMs: 20_000,
    // Per-GAME spend cap in USD. Present with a real default rather than
    // optional: an uncapped benchmark loop pointed at a paid API is one bad
    // reply away from spending everything, and the person running it is asleep.
    maxSpend: 0.15,
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
    else if (flag === "--budget") { args.budget = value === "none" ? Infinity : Number(value); i++; }
    else if (flag === "--retries") { args.retries = Number(value); i++; }
    else if (flag === "--no-imagination") args.imagination = false;
    else if (flag === "--no-perception") args.perception = false;
    else if (flag === "--reasoning-effort") { args.reasoningEffort = value; i++; }
    else if (flag === "--provider") { args.provider = value; i++; }
    else if (flag === "--max-spend") { args.maxSpend = Number(value); i++; }
    else if (flag === "--any-provider") { args.provider = null; i++; }
    else if (flag === "--learn-budget") { args.learnBudgetMs = Number(value); i++; }
    else if (flag === "--card") { args.card = value; i++; }
    else if (flag === "--cookie") { args.cookie = value; i++; }
    else throw new Error(`unknown flag "${flag}" — run with no arguments to see usage`);
  }
  if (args.budget !== Infinity && (!Number.isInteger(args.budget) || args.budget < 1)) {
    throw new Error(`--budget must be "none" or an integer >= 1, got ${String(args.budget)}`);
  }
  if (!Number.isInteger(args.retries) || args.retries < 0) {
    throw new Error(`--retries must be an integer >= 0, got ${String(args.retries)}`);
  }
  if (!Number.isFinite(args.maxSpend) || args.maxSpend <= 0) {
    throw new Error(`--max-spend must be a positive number of dollars, got ${String(args.maxSpend)}`);
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
/**
 * What this model costs, from the gateway rather than from memory.
 *
 * A spend cap computed with a guessed price is not a cap. Fetched once, and a
 * model whose price cannot be read is a hard error: refusing to start is the
 * correct failure for a safety limit that would otherwise be decorative.
 */
async function fetchPricing(model) {
  const res = await fetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`cannot read model pricing: HTTP ${res.status}`);
  const found = (await res.json()).data.find((m) => m.id === model);
  if (!found) throw new Error(`model "${model}" is not on OpenRouter — check the slug with --list-models`);
  const inPer = Number(found.pricing?.prompt);
  const outPer = Number(found.pricing?.completion);
  if (!Number.isFinite(inPer) || !Number.isFinite(outPer)) {
    throw new Error(`model "${model}" reports no usable pricing; refusing to run without a real spend cap`);
  }
  return { inPer, outPer };
}

/** Tries after the first, for a model call. */
// Above this share of failed model calls the run is the fallback policy, not
// the model, whatever the scorecard says. A fifth is already far past noise.
const MODEL_FAILURE_LIMIT = 0.2;
const MODEL_RETRIES = 3;

function makeComplete(model, reasoningEffort, providerOnly, pricing) {
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
  let modelFailures = 0;
  const complete = async (messages) => {
    calls++;
    // The model call gets the same treatment the ARC client got, for the same
    // reason: one transient failure was ending a game that had been running for
    // hours. A 429 from the gateway, a dropped socket, an upstream restarting —
    // none of those are a reason to forfeit every level completed so far.
    //
    // And when it truly cannot answer, this returns "" rather than throwing.
    // An empty reply is a case the policy already handles: parseChoice finds no
    // action, `onUnparsed` counts it, and an arbitrary offered action is
    // pressed. That degrades a model outage into a few random presses instead
    // of a dead run — and the unparsed counter is what keeps the two apart
    // afterwards, so a bad score can be read as "the model went away" rather
    // than "the agent played badly".
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(messages);
      } catch (err) {
        if (attempt >= MODEL_RETRIES) {
          modelFailures++;
          console.error(`  model call failed after ${MODEL_RETRIES + 1} tries: ${String(err).slice(0, 160)}`);
          return "";
        }
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt + Math.random() * 500));
      }
    }
  };
  const latenciesMs = [];
  const once = async (messages) => {
    const startedAt = Date.now();
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
    // Where the wall-clock of a run actually goes. Kept per call, not averaged,
    // because the distribution is the interesting part: the same model on the
    // same upstream answered in 3s and in 22s on the same grid.
    latenciesMs.push(Date.now() - startedAt);
    return response.content ?? "";
  };
  complete.usage = () => ({
    calls,
    modelFailures,
    latenciesMs,
    promptTokens,
    completionTokens,
    spend: promptTokens * pricing.inPer + completionTokens * pricing.outPer,
  });
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
  budgets: { actions: args.budget === Infinity ? null : args.budget },
  models: args.dryRun ? {} : { policy: `openrouter/${args.model}` },
});
const problems = reportabilityProblems(manifest);
if (problems.length > 0) {
  // Not fatal: an unreportable run is still worth doing on the public demo,
  // which is unlimited. It just must not be quoted anywhere.
  console.warn(`NOT REPORTABLE — this run may not be published:\n  ${problems.join("\n  ")}\n`);
}

const pricing = args.dryRun ? null : await fetchPricing(args.model);
const complete = args.dryRun
  ? null
  : makeComplete(args.model, args.reasoningEffort, args.provider ? [args.provider] : undefined, pricing);

/**
 * The money stop.
 *
 * Checked between actions through playLevel's `shouldStop`, which already means
 * "the session is over" as distinct from "this level is finished with" — the
 * same seam, and it stops BEFORE paying for the action rather than after.
 *
 * One process is one game, so this is a per-game cap: multiply by the number of
 * games running to get what the wallet is exposed to. Deliberately not a shared
 * counter — that would need coordination between processes, and a cap that can
 * fail to communicate is worse than one that is simply arithmetic.
 */
const overSpend = () => !args.dryRun && complete.usage().spend >= args.maxSpend;

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
      onCoordinateGuess: () => { guessedCoords++; },
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
//
// An official run is one card for all 25 games, opened by `arc_card.mjs` and
// handed to every player with its cookie — competition mode scores against
// every environment, so games spread over 25 separate cards cannot be one
// result. With no --card this opens its own, which is the right thing for
// measuring ourselves and the wrong thing to publish.
const joining = args.card !== undefined;
if (joining && !args.cookie) {
  throw new Error(
    "--card needs --cookie: the scorecard is pinned to one backend by its session " +
      "cookie, and without it the server refuses an id it issued itself.",
  );
}
const jar = joining ? CookieJar.fromHeader(args.cookie) : new CookieJar();
const cardId = joining
  ? args.card
  : await openScorecard({
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
  if (joining) {
    // Someone else owns this card and other games are still playing on it.
    // Closing it here would end their run as well as ours.
    console.error(`${signal} - leaving scorecard ${cardId} open; its owner closes it.`);
  } else {
    console.error(`${signal} - closing scorecard ${cardId} so the run still counts...`);
    await closeScorecard(cardId, { jar }).catch((err) => console.error(`close failed: ${String(err)}`));
  }
  console.error("closed. Scores: https://three.arcprize.org");
  process.exit(130);
};
process.on("SIGINT", () => void closeAndExit("SIGINT"));
process.on("SIGTERM", () => void closeAndExit("SIGTERM"));
const budgetLabel = args.budget === Infinity ? `none (spend cap $${args.maxSpend.toFixed(2)})` : String(args.budget);
console.log(`scorecard ${cardId}  game ${args.game}  budget ${budgetLabel}\n`);

const attempts = [];
/** Every press, in order, with the level counter and the clock. Evidence. */
const trace = [];

// THE BOARD, WRITTEN DOWN AS IT IS PLAYED.
//
// The grid only ever existed inside this process, so a run could be watched as
// a list of button names and nothing else — and a benchmark whose whole subject
// is a picture is the wrong thing to watch blind. One line per press: the
// action, the state, and the grid as one hex character a cell (colours are
// 0..15), which is ~4KB a frame instead of ~8KB of JSON numbers.
//
// Written as it happens, not at the end, so it can be tailed live and so a
// crashed game still leaves every frame it reached.
const frameDir = path.join(REPO_ROOT, "runs", manifest.runId);
fs.mkdirSync(frameDir, { recursive: true });
const framesPath = path.join(frameDir, "frames.jsonl");
const frames = fs.createWriteStream(framesPath, { flags: "a" });
// Printed HERE, not only in the summary: a live viewer needs the path while the
// game is playing, and the summary lands after the game it was meant to watch.
console.log(`frames      ${framesPath}`);
const encodeGrid = (grid) =>
  grid.map((row) => row.map((c) => (c & 15).toString(16)).join("")).join("\n");
let spent = 0;
let scenes = 0;
let guessedCoords = 0;
let learnPasses = 0;
let learnMs = 0;
let trustedRules = 0;
let imagined = 0;
// ONE session for every attempt. Re-opening the game per retry is what the
// server refuses: the second openArcGame RESETs a game id the card has already
// finished with, and answers 400 "game <id> not found" — so --retries never
// bought a single extra attempt, it crashed the run at the first GAME_OVER.
// A retry is a RESET on the session we already hold, which competition mode
// treats as a level reset — the levels already cleared stay cleared.
// ONE ERROR MUST NOT COST THE WHOLE GAME.
//
// Everything below can throw: the model call (an OpenRouter 403 or a timeout),
// parseAction (the model writes the action strings, and a bare ACTION6 or an
// out-of-range coordinate is a throw), and every HTTP call once its retries are
// spent. None of it was caught — the single catch on this path guarded the
// telemetry callback. So one bad response killed the process, and the game lost
// every level it had cleared.
//
// Caught HERE, around the whole attempt, because this is the one seam all of it
// routes through: a failed attempt is recorded and the next retry starts from a
// RESET, instead of the run ending. The frames and the manifest are already on
// disk, and the scorecard still closes in the finally below.
let env;
try {
  env = await openArcGame({ gameId: args.game, cardId, jar });
  for (let attempt = 0; attempt <= args.retries; attempt++) {
    const remaining = args.budget - spent;
    if (remaining <= 0) break;
    try {
      if (attempt > 0) await env.reset();

      // KEEP PLAYING AFTER A WIN UNTIL THE GAME SAYS IT IS OVER.
      //
      // `playLevel` returns on any terminal state, and WIN is terminal. What WIN
      // means is the one thing the docs never say: the whole game, or the level
      // just cleared? The pages that would answer it 404, and no run has reached
      // one yet to find out.
      //
      // Guessing either way is a bad trade. If WIN is per-level and we stop, we
      // forfeit levels 2..N of every game we play well — and the game score is
      // the weighted average over ALL levels, with the late ones weighted
      // highest, so a clean level-1 win would score about 1/28th of what it
      // should on a 7-level game. If WIN is the game and we keep going, the
      // second call returns immediately on the same terminal state and costs
      // nothing.
      //
      // So do not guess: ask the server. It reports `levelsCompleted` and
      // `winLevels` on every frame, and "won but not all levels done" is exactly
      // the case where play continues. Same env, same guid, same policy — the
      // policy carrying over IS the point, that is the memory across levels.
      let result;
      for (;;) {
        result = await playLevel({
          env,
          policy,
          maxActions: args.budget - spent,
          shouldStop: overSpend,
          onAction: (action, observation, index) => {
            frames.write(
              JSON.stringify({
                n: spent + index,
                action,
                state: observation.state,
                levels: `${env.last.levelsCompleted}/${env.last.winLevels}`,
                atMs: Date.now() - cardOpenedAt,
                grid: encodeGrid(observation.grid),
              }) + "\n",
            );
            trace.push({
              n: spent + index,
              action,
              state: observation.state,
              levelsCompleted: env.last.levelsCompleted,
              winLevels: env.last.winLevels,
              atMs: Date.now() - cardOpenedAt,
            });
            console.log(
              `  ${String(spent + index).padStart(4)}  ${action.padEnd(14)} ${observation.state}` +
                `  levels=${env.last.levelsCompleted}/${env.last.winLevels}`,
            );
          },
        });
        spent += result.actions.length;
        const more =
          result.state === "WIN" &&
          env.last.winLevels > 0 &&
          env.last.levelsCompleted < env.last.winLevels &&
          args.budget - spent > 0 &&
          !overSpend() &&
          // A pass that spent nothing made no progress, and the state it saw is
          // the state the next pass will see. Without this, a server that reports
          // WIN without advancing the level counter spins here forever at zero
          // cost, which is the worst kind of hang: it looks like a working run.
          result.actions.length > 0;
        if (!more) break;
        console.log(
          `  -- level ${env.last.levelsCompleted}/${env.last.winLevels} cleared, continuing --`,
        );
      }
      attempts.push({
        attempt,
        state: result.state,
        actions: result.actions.length,
        stoppedBecause: result.stoppedBecause,
        levelsCompleted: env.last.levelsCompleted,
        winLevels: env.last.winLevels,
      });
      if (result.state === "WIN" || result.stoppedBecause === "budget") break;
      // Out of money is out of money; a retry would only spend past the cap.
      if (result.stoppedBecause === "deadline") break;
    } catch (err) {
      console.error(`  !! attempt ${attempt} failed: ${String(err)}`);
      attempts.push({ attempt, state: "ERROR", actions: 0, stoppedBecause: "error", error: String(err) });
    }
  }
} finally {
  // Always close the card THIS process opened: an open scorecard holds the run
  // and the numbers never land. A shared card is closed by whoever opened it,
  // once every game on it has finished — closing it from here would cut off
  // the games still playing.
  if (!joining) {
    await closeScorecard(cardId, { jar }).catch((err) => console.error(`close failed: ${String(err)}`));
  }
}

const outDir = path.join(REPO_ROOT, "runs", manifest.runId);
const manifestPath = writeRunManifest(manifest, outDir);

console.log(`\nscorecard   ${cardId}`);
console.log(`actions     ${spent} of ${budgetLabel}`);
console.log(`card open   ${Math.round((Date.now() - cardOpenedAt) / 1000)}s`);
console.log(`attempts    ${JSON.stringify(attempts)}`);
console.log(`vetoed      ${vetoes} presses the frugal policy refused to pay for`);
if (args.imagination !== false) {
  console.log(
    `imagination ${learnPasses} learning passes in ${(learnMs / 1000).toFixed(1)}s, ` +
      `${trustedRules} rules held, ${imagined} presses demoted by a prediction`,
  );
}
if (!args.dryRun) {
  const usage = complete.usage();
  console.log(
    `spend       $${usage.spend.toFixed(4)} of $${args.maxSpend.toFixed(2)} cap` +
      (overSpend() ? "  (STOPPED ON THE CAP)" : ""),
  );
  console.log(
    `model       ${args.model} — ${usage.calls} completions, ${usage.promptTokens} prompt / ` +
      `${usage.completionTokens} completion tokens` +
      `, reasoning effort ${args.reasoningEffort}, no token cap, upstream ${args.provider ?? "UNPINNED"}`,
  );
  console.log(
    `unparsed    ${unparsed} replies named no available button` +
      (usage.modelFailures > 0
        ? `  (${usage.modelFailures} of them because the model call failed outright)`
        : ""),
  );
  // A MODEL THAT NEVER ANSWERED MUST NOT LOOK LIKE A RESULT.
  //
  // A failed model call degrades to an arbitrary press on purpose, so an
  // outage costs a few presses instead of the game. But that makes a dead key
  // and a real run print the same summary shape: with a 401 on every call this
  // still reported 20 completions, a full attempts list and a scorecard, and
  // the only tell was `0 prompt / 0 completion tokens` in a line nobody reads.
  // Whoever reads the score is not the person who read the log, so the warning
  // has to be ON the result, not in the scrollback.
  const failureShare = usage.calls > 0 ? usage.modelFailures / usage.calls : 0;
  if (failureShare >= MODEL_FAILURE_LIMIT) {
    console.warn(
      `
NOT REPORTABLE — this run may not be published:
` +
        `  the model failed on ${usage.modelFailures} of ${usage.calls} calls ` +
        `(${Math.round(failureShare * 100)}%); those presses were arbitrary, not played
`,
    );
  }
  console.log(`clicks      ${guessedCoords} ACTION6 presses whose coordinates we chose`);
  // Denominator is COMPLETIONS, not actions: a prompt is built per model call,
  // and the last call of a run can be built and then cut by the budget before
  // its action lands. Against `spent` that printed "2 of 1", which reads as a
  // bug in the counter rather than as the ordinary end of a run.
  console.log(
    `perception  ${scenes} of ${usage.calls} prompts carried a scene description` +
      (args.perception === false ? " (disabled)" : ""),
  );
}
console.log(`manifest    ${manifestPath}`);

// EVERYTHING THIS RUN KNOWS, IN ONE MACHINE-READABLE FILE.
//
// The console summary is for a person watching; this is for the chart, the
// paper and anyone who asks to see the run. It carries the scorecard id, which
// is the only part of it three.arcprize.org can independently confirm, and the
// full press-by-press trace, so a claim about how a level was cleared can be
// checked rather than trusted.
const usage = args.dryRun ? null : complete.usage();
const resultPath = path.join(outDir, "result.json");
fs.writeFileSync(
  resultPath,
  JSON.stringify(
    {
      runId: manifest.runId,
      benchmark: "arc-agi-3",
      game: args.game,
      scorecardId: cardId,
      scorecardUrl: `https://three.arcprize.org/scorecards/${cardId}`,
      startedAt: new Date(cardOpenedAt).toISOString(),
      endedAt: new Date().toISOString(),
      wallClockSeconds: Math.round((Date.now() - cardOpenedAt) / 1000),
      code: manifest.code,
      config: {
        model: args.model,
        provider: args.provider ?? null,
        reasoningEffort: args.reasoningEffort,
        budget: args.budget === Infinity ? null : args.budget,
        maxSpend: args.maxSpend,
        retries: args.retries,
        imagination: args.imagination !== false,
        perception: args.perception !== false,
        dryRun: !!args.dryRun,
        learnBudgetMs: args.learnBudgetMs ?? null,
      },
      outcome: {
        actionsSpent: spent,
        attempts,
        levelsCompleted: attempts.at(-1)?.levelsCompleted ?? 0,
        winLevels: attempts.at(-1)?.winLevels ?? 0,
        finalState: attempts.at(-1)?.state ?? null,
        stoppedOnSpendCap: !args.dryRun && overSpend(),
      },
      policy: {
        vetoes,
        unparsed,
        // Machine-readable twin of the NOT REPORTABLE banner above, so a chart
        // or a script can refuse this run without re-reading the console.
        // `usage` is null on a dry run, which has no model to fail.
        modelFailures: usage ? usage.modelFailures : null,
        modelFailureShare: usage && usage.calls > 0 ? usage.modelFailures / usage.calls : null,
        reportable: usage
          ? (usage.calls > 0 ? usage.modelFailures / usage.calls : 0) < MODEL_FAILURE_LIMIT
          : false,
        guessedCoordinateClicks: guessedCoords,
        promptsWithScene: scenes,
        imagination: { passes: learnPasses, ms: learnMs, trustedRules, demotedPresses: imagined },
      },
      model: usage && {
        name: args.model,
        upstream: args.provider ?? null,
        calls: usage.calls,
        failures: usage.modelFailures,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        spendUsd: usage.spend,
        latenciesMs: usage.latenciesMs,
      },
      trace,
      reportability: problems,
    },
    null,
    2,
  ),
);
console.log(`result      ${resultPath}`);
frames.end();
console.log(`frames      ${framesPath}`);
console.log(`\nScores come from the scorecard, not from here: https://three.arcprize.org`);
