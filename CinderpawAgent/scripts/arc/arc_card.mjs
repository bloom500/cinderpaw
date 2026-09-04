/**
 * Open and close the ONE scorecard an official ARC-AGI-3 run is played on.
 *
 *   bun scripts/arc/arc_card.mjs open  --competition --source-url <url> --tag <t>
 *   bun scripts/arc/arc_card.mjs close --card <id> --cookie <header>
 *
 * WHY THIS EXISTS AS ITS OWN SCRIPT. Until now every game opened its own
 * scorecard, which is fine for measuring ourselves and wrong for a result
 * anyone else is meant to trust:
 *
 *  - Competition mode is REQUIRED to appear on the leaderboard, and in it you
 *    read one scorecard and cannot check scores mid-run.
 *  - Scoring runs against ALL environments whether or not you played them, so
 *    the 25 games have to sit on one card or the ones you left off count as
 *    zeros somebody else has to guess at.
 *  - A card is pinned to a backend by its cookie, so the games that share it
 *    must share that cookie too — `open` prints it, the players take it, and
 *    `close` uses it.
 *
 * The card id and cookie are printed as two shell-assignable lines so a
 * launcher can eval them; everything else goes to stderr.
 */
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openScorecard, closeScorecard, CookieJar } from "../../src/arc/api-client.ts";
import { createRunManifest, reportabilityProblems } from "../../src/core/run-manifest.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const argv = process.argv.slice(2);
const mode = argv[0];
const args = { tags: [], competition: false, sourceUrl: undefined, card: undefined, cookie: undefined };
for (let i = 1; i < argv.length; i++) {
  const flag = argv[i];
  const value = argv[i + 1];
  if (flag === "--tag") { args.tags.push(value); i++; }
  else if (flag === "--source-url") { args.sourceUrl = value; i++; }
  else if (flag === "--card") { args.card = value; i++; }
  else if (flag === "--cookie") { args.cookie = value; i++; }
  else if (flag === "--competition") args.competition = true;
  else throw new Error(`unknown flag ${flag}`);
}

if (mode === "open") {
  const jar = new CookieJar();
  const version = JSON.parse(
    await import("node:fs/promises").then((fs) => fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8")),
  ).version;
  // The manifest rides along on the card itself, so the run's provenance is
  // stored by the scorer rather than only on the machine that played it.
  const manifest = createRunManifest({
    runId: `arc-card-${Date.now()}`,
    harness: { name: "cinderpaw-arc-agi-3", version },
    repoRoot: REPO_ROOT,
    config: { benchmark: "arc-agi-3", competitionMode: args.competition },
    models: { policy: "see per-game manifests" },
    seed: 0,
  });
  // THERE IS NO SUCH THING AS A PRACTICE CARD. This gate used to apply only
  // when --competition was passed, on the reasoning that a practice card is how
  // you find out whether the code works at all and refusing to open one on a
  // dirty tree makes the safe path the annoying path.
  //
  // The premise was false, and the server said so. Measured against the live
  // API, three ways:
  //
  //     sent competition_mode=false     -> server reports competition_mode=true
  //     sent competition_mode=true      -> server reports competition_mode=true
  //     sent nothing                    -> field absent from the close response
  //
  // The server ignores `false`. Every card this repo opens is a competition
  // card, so the gate that was meant to protect the leaderboard had a hole
  // exactly the width of "leave the flag off" — a card opened from a dirty tree,
  // unrecoverable from any commit, landing on the board anyway.
  //
  // So it refuses on ANY card now. The flag still selects what we ASK for, and
  // it is still worth sending, but it no longer decides whether the tree has to
  // be committed. It always does.
  const problems = reportabilityProblems(manifest).filter((p) => !p.includes("seed"));
  if (problems.length > 0) {
    console.error(`REFUSING TO OPEN A SCORECARD:\n  ${problems.join("\n  ")}`);
    console.error(
      "Every card the server issues is a competition card — it ignores competition_mode=false —\n" +
        "so any card can reach the leaderboard and must be recoverable from its commit. Commit first.",
    );
    process.exit(1);
  }
  const cardId = await openScorecard({
    jar,
    tags: ["cinderpaw", ...args.tags],
    sourceUrl: args.sourceUrl,
    competitionMode: args.competition,
    opaque: { manifest },
  });
  console.error(
    `opened ${args.competition ? "COMPETITION" : "practice"} card ${cardId}` +
      `  commit ${manifest.code.commit?.slice(0, 7)}${manifest.code.dirty ? " (DIRTY)" : ""}`,
  );
  // stdout is for the launcher: two lines it can eval.
  console.log(`ARC_CARD_ID=${cardId}`);
  console.log(`ARC_CARD_COOKIE='${jar.header() ?? ""}'`);
} else if (mode === "close") {
  if (!args.card) throw new Error("close needs --card <id>");
  const jar = CookieJar.fromHeader(args.cookie);
  const result = await closeScorecard(args.card, { jar });
  console.error(`closed ${args.card}`);
  console.log(JSON.stringify(result, null, 2));
} else {
  console.error("usage: arc_card.mjs open [--competition] [--source-url u] [--tag t] | close --card id --cookie h");
  process.exit(2);
}
