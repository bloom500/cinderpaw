/**
 * Does a scorecard survive as long as the official run needs it to?
 *
 * THE ONE ASSUMPTION THE PREFLIGHT COULD NOT MEASURE. The docs say a scorecard
 * "auto closes after 15 minutes". That was already contradicted twice — 220
 * actions over 17 minutes all recorded, and a card still accepting play after
 * 18 — but the official run is ONE card shared by 25 games running in parallel,
 * each bounded by a spend cap that works out to roughly 25-50 minutes. Nothing
 * has ever been measured past 18. If the card dies at 30, the run produces
 * nothing and the money is gone.
 *
 * So: hold a card open for an hour and press a button every so often.
 *
 * FREE. It makes ZERO model calls — there is no policy here, just `env.act` on
 * whatever the frame offers — and the ARC API costs nothing. The whole probe
 * spends about six actions on a practice card.
 *
 * PRACTICE, NOT COMPETITION, deliberately. Card lifetime is a property of the
 * load balancer and the scorecard service, not of the scoring mode, and opening
 * a competition card to press five buttons would put a junk result on the board
 * we are about to publish a real one to.
 *
 *   ARC_API_KEY=... bun scripts/arc/card_lifetime_probe.mjs [--minutes 60]
 *
 * Exit 0 means the card was alive and accepting actions for the whole window,
 * with a coherent frame every time. Anything else is a RED and the paid run
 * must not start.
 */
import process from "node:process";

import { openArcGame, openScorecard, closeScorecard, CookieJar } from "../../src/arc/api-client.ts";

const args = { minutes: 60, game: null };
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (flag === "--minutes") args.minutes = Number(process.argv[++i]);
  else if (flag === "--game") args.game = process.argv[++i];
  else throw new Error(`unknown flag ${flag}`);
}
if (!Number.isFinite(args.minutes) || args.minutes <= 0) {
  throw new Error(`--minutes must be a positive number, got ${String(args.minutes)}`);
}

/**
 * When to press, in minutes from open. The 18-minute mark is where the previous
 * evidence stopped, so it is checked explicitly rather than skipped over: if the
 * card dies somewhere after it, the probe should say between which two presses.
 */
const CHECKPOINTS = [0, 5, 18, 30, 45, args.minutes].filter((m, i, a) => m <= args.minutes && a.indexOf(m) === i);

const stamp = () => new Date().toISOString();
const log = (line) => console.log(`${stamp()}  ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jar = new CookieJar();
const openedAt = Date.now();
const failures = [];

log(`opening a PRACTICE card; probing for ${args.minutes} minutes at +${CHECKPOINTS.join(", +")} min`);
const cardId = await openScorecard({
  jar,
  tags: ["cinderpaw", "card-lifetime-probe"],
  competitionMode: false,
});
log(`card ${cardId} open`);

// The card must be closed on every exit path or its results never appear — the
// same rule the real runner follows, and a probe that leaks a card is a probe
// that was not testing the thing it claimed to.
let closing = false;
const closeOnce = async (why) => {
  if (closing) return;
  closing = true;
  log(`${why}: closing card ${cardId}`);
  await closeScorecard(cardId, { jar }).catch((err) => log(`close failed: ${String(err)}`));
};
process.on("SIGINT", async () => { await closeOnce("SIGINT"); process.exit(130); });
process.on("SIGTERM", async () => { await closeOnce("SIGTERM"); process.exit(143); });

let closed = null;
try {
  const gameId = args.game ?? (await import("node:fs/promises")
    .then((fs) => fs.readFile(new URL("../../../runs-arc/games.txt", import.meta.url), "utf8"))
    .then((t) => t.split(/\r?\n/).find((l) => l.trim())));
  if (!gameId) throw new Error("no game id: pass --game, or fill runs-arc/games.txt");
  log(`game ${gameId}`);

  const env = await openArcGame({ gameId, cardId, jar });
  log(`RESET ok  guid=${env.guid}  state=${env.last.state}  actions=[${env.actions.join(",")}]`);

  for (const minute of CHECKPOINTS) {
    const dueAt = openedAt + minute * 60_000;
    const waitMs = dueAt - Date.now();
    if (waitMs > 0) {
      log(`waiting ${(waitMs / 60_000).toFixed(1)} min for the +${minute} min press...`);
      await sleep(waitMs);
    }
    const elapsedMin = ((Date.now() - openedAt) / 60_000).toFixed(1);

    // Whatever the frame offers right now. Re-read every time on purpose:
    // available_actions changes per frame, and a probe that reused the first
    // list would be testing its own cache instead of the card.
    const offered = env.actions;
    if (offered.length === 0) {
      failures.push(`+${elapsedMin} min: the frame offered no actions at all`);
      log(`FAIL at +${elapsedMin} min: no available_actions`);
      break;
    }
    // ACTION6 needs coordinates and the client fills them, but prefer a plain
    // button when one is offered: fewer moving parts in a liveness check.
    const action = offered.find((a) => a !== "ACTION6") ?? offered[0];

    try {
      const observation = await env.act(action);
      const rows = observation.grid.length;
      const cols = observation.grid[0]?.length ?? 0;
      const coherent = rows > 0 && cols > 0 && typeof observation.state === "string";
      log(
        `+${elapsedMin} min  ${action} -> ${observation.state}  grid ${rows}x${cols}  ` +
          `levels=${env.last.levelsCompleted}/${env.last.winLevels}  actions=[${env.actions.join(",")}]`,
      );
      if (!coherent) failures.push(`+${elapsedMin} min: incoherent frame (${rows}x${cols}, state ${observation.state})`);
      // A terminal state ends the probe legitimately — but it also means the
      // remaining checkpoints cannot be pressed, so say so rather than
      // reporting a short probe as a pass.
      if (observation.state === "WIN" || observation.state === "GAME_OVER") {
        log(`the game reached ${observation.state}; RESET to keep pressing`);
        await env.reset();
      }
    } catch (err) {
      failures.push(`+${elapsedMin} min: action refused — ${String(err).slice(0, 300)}`);
      log(`FAIL at +${elapsedMin} min: ${String(err).slice(0, 300)}`);
      break;
    }
  }

  closed = await closeScorecard(cardId, { jar });
  closing = true;
  log(`close ok`);
} catch (err) {
  failures.push(`probe threw: ${String(err)}`);
  log(`THREW: ${String(err)}`);
  await closeOnce("error");
}

const heldMin = ((Date.now() - openedAt) / 60_000).toFixed(1);
console.log("\n" + "=".repeat(62));
console.log(`card            ${cardId}`);
console.log(`held open       ${heldMin} minutes`);
console.log(`presses         ${CHECKPOINTS.length} attempted at +${CHECKPOINTS.join(", +")} min`);
if (closed) console.log(`scorecard       ${JSON.stringify(closed).slice(0, 600)}`);
console.log(`failures        ${failures.length}`);
for (const f of failures) console.log(`  ! ${f}`);
const green = failures.length === 0 && Number(heldMin) >= args.minutes - 1;
console.log(`\nCARD_LIFETIME = ${green ? "GREEN" : "RED"}`);
process.exit(green ? 0 : 1);
