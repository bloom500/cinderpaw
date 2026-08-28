/**
 * The auditing fake ARC server, over HTTP, so more than one process can share
 * one card.
 *
 *   bun scripts/arc/fake-arc-server.mjs --port 8787
 *
 * WHY. `fake-arc-preload.mjs` swaps `fetch` inside ONE process, which is right
 * for one runner and wrong for a sweep: every game is its own process, so each
 * child gets its own empty server and the card the parent opened does not
 * exist for any of them. The first free rehearsal of a sweep failed exactly
 * that way — 25 games, then `close of unknown card`.
 *
 * Same `makeServer` as the in-process fake, so it audits identically: it still
 * refuses stale actions, actions after terminal, bare ACTION6, unknown guids
 * and wrong cookies, and it still cross-checks its own action tally. The
 * violations it collects are printed on exit, and the exit code is non-zero if
 * there were any — so a rehearsal that fails is a failed command, not a wall
 * of text somebody has to read.
 */
import process from "node:process";

import { lcg, makeGame, makeServer } from "./fake-arc-api.mjs";

const args = { port: 8787, games: 25, seed: 1 };
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  const value = process.argv[i + 1];
  if (flag === "--port") { args.port = Number(value); i++; }
  else if (flag === "--games") { args.games = Number(value); i++; }
  else if (flag === "--seed") { args.seed = Number(value); i++; }
  else throw new Error(`unknown flag "${flag}"`);
}

const rnd = lcg(args.seed);
// The real game ids, when they are on disk, so a rehearsal exercises the same
// `games.txt` the paid run will read rather than a parallel set of fake names.
const real = await import("node:fs/promises")
  .then((fs) => fs.readFile(new URL("../../../runs-arc/games.txt", import.meta.url), "utf8"))
  .then((text) => text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")))
  .catch(() => []);
const ids = real.length > 0 ? real : Array.from({ length: args.games }, (_, i) => `game-${i}`);

const violations = [];
const games = ids.map((id) => makeGame(id, rnd));
const handler = makeServer(games, violations);

const server = Bun.serve({
  port: args.port,
  idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);
    // HTTP lowercases header names; `makeServer` reads the exact spellings the
    // client writes, because in-process it is handed the client's own object.
    // Restoring them here keeps the fake auditing the same thing over the wire
    // as it does in memory, instead of failing every request for "no key".
    const headers = Object.fromEntries(request.headers);
    if (headers["x-api-key"] !== undefined) headers["X-API-Key"] = headers["x-api-key"];
    if (headers["cookie"] !== undefined) headers.Cookie = headers["cookie"];
    const init = {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
    };
    return handler(`https://three.arcprize.org${url.pathname}${url.search}`, init);
  },
});

console.error(`fake ARC on http://127.0.0.1:${server.port}  ${games.length} games, seed ${args.seed}`);
console.error(`point runners at it with FAKE_ARC_URL=http://127.0.0.1:${server.port}`);

function report() {
  if (violations.length === 0) {
    console.error(`\n[fake ARC] ${games.length} games available, 0 protocol violations.`);
    process.exit(0);
  }
  console.error(`\n[fake ARC] ${violations.length} PROTOCOL VIOLATIONS:`);
  for (const v of violations) console.error(`  ! ${v}`);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, report);
