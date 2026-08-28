/**
 * A hundred games through the REAL ARC stack, with the server faked and
 * nothing else faked.
 *
 * WHY THIS EXISTS. `--dry-run` on run_arc_agi3.mjs skips the MODEL, not the
 * SERVER: it still opens a real scorecard and spends real actions against
 * three.arcprize.org. So "the dry run passed" was never evidence that could be
 * gathered for free, and it was never gathered a hundred times. This replaces
 * the network — one `fetchImpl` standing in for the API — and leaves every
 * other seam exactly as the paid run will use it: openScorecard, openArcGame,
 * the cookie jar, the retry ladder, playLevel, createFrugalPolicy,
 * createModelPolicy, parseAction, withClickTarget.
 *
 * WHAT MAKES IT MORE THAN A SMOKE TEST is that the fake server is the AUDITOR,
 * not a stub. It refuses any action that was not in the frame it just sent,
 * any action after a terminal state, a bare ACTION6, a guid it never issued,
 * and any request carrying the wrong session cookie. Each refusal is recorded
 * as a violation. A leak a client-side assertion would have to guess at
 * becomes a 4xx from the only party that knows the truth.
 *
 *   bun scripts/arc/stress_100.mjs [--games 100] [--seed 1] [--shared-policy]
 *
 * `--shared-policy` runs one frugal policy across ALL games instead of one per
 * game. That is not the production shape — run_arc_agi3.mjs is one process per
 * game — and it exists to MEASURE the leak rather than assume it: the transition
 * table is keyed by exact grid, so the claim in policy.ts is that sharing is
 * inert rather than wrong. This is where that claim is checked.
 */
import process from "node:process";

import { openArcGame, openScorecard, closeScorecard, CookieJar } from "../../src/arc/api-client.ts";
import { playLevel } from "../../src/arc/play-level.ts";
import { createFrugalPolicy } from "../../src/arc/policy.ts";
import { createModelPolicy } from "../../src/arc/model-policy.ts";

const args = { games: 100, seed: 1, sharedPolicy: false };
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (flag === "--games") args.games = Number(process.argv[++i]);
  else if (flag === "--seed") args.seed = Number(process.argv[++i]);
  else if (flag === "--shared-policy") args.sharedPolicy = true;
  else throw new Error(`unknown flag ${flag}`);
}

import { lcg, makeGame, makeServer, GRID } from "./fake-arc-api.mjs";

/**
 * The stand-in for the model. Deterministic, and badly behaved on a schedule:
 * one reply in eleven names no button at all and one in seventeen is a bare
 * "ACTION6" — both happen with real models, and the second one killed a real
 * game nine presses in.
 */
function makeComplete(counter) {
  return async (messages) => {
    counter.calls++;
    const text = messages[messages.length - 1].content;
    const offered = /Buttons available now: (.+)/.exec(text)[1].split(", ");
    if (counter.calls % 11 === 0) return "Hmm. I really am not sure what to do here.";
    if (counter.calls % 17 === 0 && offered.includes("ACTION6")) return "ACTION6";
    const rows = text.split("\n").filter((l) => new RegExp(`^[0-9a-f]{${GRID}}$`).test(l));
    let r = -1, c = -1;
    rows.forEach((row, i) => {
      const j = row.indexOf("3");
      if (j >= 0) { r = i; c = j; }
    });
    if (r < 0) return offered[0];
    const want = c < GRID - 1 ? "ACTION4" : "ACTION2";
    return offered.includes(want) ? want : offered[0];
  };
}

// ------------------------------------------------------------------ the run

const violations = [];
const rnd = lcg(args.seed);
const games = new Map();
const gameList = [];
for (let i = 0; i < args.games; i++) {
  const g = makeGame(i, rnd);
  gameList.push(g);
  games.set(g.id, g);
}

const fetchImpl = makeServer(games, violations);
const jar = new CookieJar();
const apiKey = "stress-key";
const counter = { calls: 0 };

let unparsed = 0, vetoes = 0, coordGuesses = 0, exceptions = 0, retriedGames = 0;
const listenersBefore = process.listenerCount("SIGINT");
const startedAt = Date.now();

const cardId = await openScorecard({ apiKey, jar, fetchImpl, tags: ["stress"], competitionMode: true });

const sharedPolicy = args.sharedPolicy
  ? createFrugalPolicy({
      inner: createModelPolicy({ complete: makeComplete(counter), onUnparsed: () => unparsed++, onCoordinateGuess: () => coordGuesses++, scene: {} }),
      onVeto: () => vetoes++,
      imagination: { learnBudgetMs: 200 },
    })
  : null;

const results = [];
for (const game of gameList) {
  // ONE frugal policy per GAME, which is the shape run_arc_agi3.mjs has: one
  // process per game, so the policy cannot outlive it.
  const policy =
    sharedPolicy ??
    createFrugalPolicy({
      inner: createModelPolicy({
        complete: makeComplete(counter),
        onUnparsed: () => unparsed++,
        onCoordinateGuess: () => coordGuesses++,
        scene: {},
      }),
      onVeto: () => vetoes++,
      imagination: { learnBudgetMs: 200 },
    });

  const attempts = [];
  try {
    const env = await openArcGame({ apiKey, gameId: game.id, cardId, jar, fetchImpl });
    let spent = 0;
    for (let attempt = 0; attempt <= 1; attempt++) {
      if (attempt > 0) { await env.reset(); retriedGames++; }
      let result;
      for (;;) {
        result = await playLevel({
          env,
          policy,
          maxActions: 200 - spent,
          onAction: (_action, observation) => {
            // Every frame is checked for a colour that belongs to another game.
            for (const row of observation.grid) {
              for (const cell of row) {
                if (cell >= 6 && cell !== game.brand) {
                  violations.push(`BRAND LEAK: ${game.id} saw colour ${cell}, its own is ${game.brand}`);
                }
              }
            }
          },
        });
        spent += result.actions.length;
        const more =
          result.state === "WIN" &&
          env.last.winLevels > 0 &&
          env.last.levelsCompleted < env.last.winLevels &&
          200 - spent > 0 &&
          result.actions.length > 0;
        if (!more) break;
      }
      attempts.push({
        attempt,
        state: result.state,
        actions: spent,
        stoppedBecause: result.stoppedBecause,
        levels: env.last.levelsCompleted,
        winLevels: env.last.winLevels,
      });
      if (result.state === "WIN" || result.stoppedBecause === "budget") break;
    }
  } catch (err) {
    exceptions++;
    violations.push(`UNHANDLED on ${game.id}: ${String(err)}`);
  }
  results.push({ game: game.id, attempts });
}

const closed = await closeScorecard(cardId, { apiKey, jar, fetchImpl });
const listenersAfter = process.listenerCount("SIGINT");

// The scorecard is the second auditor: it counted every action itself, so a
// game whose presses landed on another game's tally shows up here and nowhere
// else.
const perGame = closed.per_game ?? {};
for (const r of results) {
  const mine = r.attempts.at(-1)?.actions ?? 0;
  const server = perGame[r.game] ?? 0;
  // The client counts presses it made; the server counts presses it applied.
  // They differ only by a retried 500, which is the one ambiguity api-client.ts
  // documents. More than a couple means something else is spending.
  if (Math.abs(server - mine) > 2) {
    violations.push(`SCORECARD MISMATCH on ${r.game}: client ${mine}, server ${server}`);
  }
}

const completed = results.filter((r) => r.attempts.length > 0).length;
const won = results.filter((r) => r.attempts.at(-1)?.state === "WIN").length;
const totalActions = Object.values(perGame).reduce((a, b) => a + b, 0);

console.log(`\n${completed}/${args.games} completed          ${won} reached WIN`);
console.log(`policy               ${args.sharedPolicy ? "SHARED across games (not production shape)" : "one per game (production shape)"}`);
console.log(`actions (server)     ${totalActions}`);
console.log(`model calls          ${counter.calls}`);
console.log(`unparsed replies     ${unparsed}`);
console.log(`bare-ACTION6 filled  ${coordGuesses}`);
console.log(`vetoes               ${vetoes}`);
console.log(`retried games        ${retriedGames}`);
console.log(`unhandled exceptions ${exceptions}`);
console.log(`SIGINT listeners     ${listenersBefore} -> ${listenersAfter}`);
console.log(`wall clock           ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
console.log(`violations           ${violations.length}`);
for (const v of violations.slice(0, 25)) console.log(`  ! ${v}`);
if (violations.length > 25) console.log(`  ... and ${violations.length - 25} more`);

process.exit(violations.length === 0 && exceptions === 0 ? 0 : 1);
