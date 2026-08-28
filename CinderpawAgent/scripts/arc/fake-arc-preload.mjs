/**
 * Run the REAL runner against a fake server, for nothing.
 *
 *   bun --preload ./scripts/arc/fake-arc-preload.mjs \
 *       scripts/arc/run_arc_agi3.mjs --game game-0 --dry-run
 *
 * WHY. `run_arc_agi3.mjs` is the script that spends the money, and until now
 * there was no way to execute it end to end without spending some: `--dry-run`
 * skips the MODEL but still opens a real scorecard on three.arcprize.org and
 * still bills it real actions. So every change to the runner itself — the
 * scorecard handling, the frame writer, the retry loop, the result file — was
 * first exercised during a paid run. A typo in a telemetry callback would be
 * discovered by losing a game.
 *
 * This replaces the global `fetch` before the runner imports anything. The
 * ARC client calls `init.fetchImpl ?? fetch`, and the runner passes no
 * fetchImpl, so the swap is total and the client's own code is untouched: the
 * cookie jar, the retry ladder and the affinity rules all run exactly as they
 * will against the live API.
 *
 * IT ONLY FAKES three.arcprize.org. Anything else — openrouter.ai included —
 * goes to the real network, so `--dry-run` is still required unless you mean
 * to pay for the model. Requests to any other host are passed through
 * untouched rather than blocked, because a preload that silently ate an
 * unrelated request would be a debugging trap of its own.
 *
 * Violations the fake server catches are printed on exit. A clean run here is
 * not proof the runner will score well; it is proof the runner will not lose a
 * game to its own plumbing.
 */
import process from "node:process";

import { lcg, makeGame, makeServer } from "./fake-arc-api.mjs";

const GAMES = Number(process.env.FAKE_ARC_GAMES ?? 25);
const SEED = Number(process.env.FAKE_ARC_SEED ?? 1);

const violations = [];
const rnd = lcg(SEED);
const games = new Map();
for (let i = 0; i < GAMES; i++) {
  const g = makeGame(i, rnd);
  games.set(g.id, g);
}
const server = makeServer(games, violations);
const realFetch = globalThis.fetch;

/**
 * OpenRouter, faked too — but only when asked for.
 *
 * `--dry-run` proves the harness works and proves NOTHING about the paid path:
 * pricing, the provider pin, usage accounting, the spend cap, the per-press
 * cost record and the model's own reply in the trace are all skipped by it. So
 * FAKE_ARC_MODEL=1 stands in for the gateway as well, and the runner can then
 * be run WITHOUT --dry-run, exercising every line that will handle money.
 *
 * Off by default and gated on an explicit variable, because a preload that
 * silently intercepted a real model call would turn a run someone believed was
 * paid into a fabrication — which is a far worse failure than the one this
 * whole file exists to prevent.
 */
const fakeModel = process.env.FAKE_ARC_MODEL === "1";
let modelCalls = 0;

/** The same greedy walker the stress harness uses, reading the prompt's grid. */
function fakeReply(body) {
  modelCalls++;
  const text = body.messages.at(-1).content;
  const offered = /Buttons available now: (.+)/.exec(text)?.[1]?.split(", ") ?? ["ACTION1"];
  // Badly behaved on a schedule, because real models are: one reply in eleven
  // names no button, one in seventeen forgets ACTION6's coordinates.
  if (modelCalls % 11 === 0) return "I have thought about this at length and I am not sure.";
  if (modelCalls % 17 === 0 && offered.includes("ACTION6")) return "Let me click. ACTION6";
  const rows = text.split("\n").filter((l) => /^[0-9a-f]{6,64}$/.test(l));
  let r = -1, c = -1;
  rows.forEach((row, i) => { const j = row.indexOf("3"); if (j >= 0) { r = i; c = j; } });
  if (r < 0) return offered[0];
  const want = c < (rows[0]?.length ?? 1) - 1 ? "ACTION4" : "ACTION2";
  return `Thinking about the board. I press ${offered.includes(want) ? want : offered[0]}`;
}

const json = (body) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("https://three.arcprize.org")) return server(url, init);
  if (!fakeModel || !url.startsWith("https://openrouter.ai")) return realFetch(input, init);

  if (url.endsWith("/endpoints")) {
    // Every provider the runner might be pinned to, so assertProviderServes
    // passes for any --provider rather than only for the default.
    return json({ data: { endpoints: [{ provider_name: "Z.AI" }, { provider_name: "Novita" }] } });
  }
  if (url.endsWith("/api/v1/models")) {
    // Real GLM 5.3 Flash prices, so the spend cap is exercised against the
    // arithmetic that will actually run rather than against a round number.
    const model = JSON.parse(init.body ?? "{}").model;
    return json({
      data: [
        { id: model ?? "z-ai/glm-5.3-flash", pricing: { prompt: "0.000000075", completion: "0.00000025" } },
        { id: "z-ai/glm-5.3-flash", pricing: { prompt: "0.000000075", completion: "0.00000025" } },
      ],
    });
  }
  if (url.endsWith("/chat/completions")) {
    const body = JSON.parse(init.body);
    const content = fakeReply(body);
    return json({
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2400, completion_tokens: 700, total_tokens: 3100 },
    });
  }
  return realFetch(input, init);
};

// A key the fake server only checks for presence, so a stranger running this
// does not need a real one. Never overwrites a key that is already set.
process.env.ARC_API_KEY ??= "fake-arc-key";

process.on("exit", () => {
  if (violations.length === 0) {
    console.error(`\n[fake ARC] ${GAMES} games available, 0 protocol violations.`);
    return;
  }
  console.error(`\n[fake ARC] ${violations.length} PROTOCOL VIOLATIONS:`);
  for (const v of violations.slice(0, 25)) console.error(`  ! ${v}`);
});
