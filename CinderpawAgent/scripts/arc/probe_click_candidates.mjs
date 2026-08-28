/**
 * One model call. One ACTION6. The cheapest experiment that can settle it.
 *
 * THE QUESTION. GLM 5.3 Flash spends 14-45 tokens choosing between named
 * buttons and 27,163 (effort medium) / 31,557 (effort low) choosing an x,y on
 * the same grid, one press apart. Two readings, and they lead opposite ways:
 *
 *   - the MODEL cannot do spatial selection cheaply  -> change the model;
 *   - the PROBLEM was posed as a 4,096-cell search   -> change the prompt.
 *
 * So pose it the other way once, on the exact frame that cost 31,557 tokens,
 * and read the number.
 *
 * WHAT IT DOES NOT DO. It opens no scorecard, spends no ARC action and plays no
 * game — it replays a frame this repo already recorded and asks the model what
 * it would press. The environment is not involved, so the only cost is one
 * completion, and the only thing being measured is what the prompt does to the
 * model's token spend.
 *
 * The prompt is the PRODUCTION prompt: this drives `createModelPolicy`, not a
 * copy of it, so a result here transfers to the runner without a second
 * argument about whether the two prompts match.
 *
 *   bun scripts/arc/probe_click_candidates.mjs \
 *       --frames runs/arc-.../frames.jsonl --line 3 [--raw] [--effort low]
 *
 *   --line n    1-based line of frames.jsonl. Its grid is what the NEXT press
 *               saw, which is why line 3 is the frame press 4 paid for.
 *   --raw       no candidate list — the old prompt, for a same-session control.
 *   --both      run raw first, then candidates, and print the delta.
 */
import process from "node:process";
import fs from "node:fs";

import { createModelPolicy } from "../../src/arc/model-policy.ts";
import { OpenAICompatibleProvider } from "../../src/egress/inference-providers.ts";

const args = {
  frames: null, line: 3, raw: false, both: false, effort: "medium",
  model: "z-ai/glm-5.3-flash", provider: "Z.AI",
  /**
   * A CEILING ON THE ANSWER, which a scored run must not have and a shootout
   * must. The question here is "does this model explode", and a model that hits
   * the cap has already answered it — paying for the other 22,000 tokens buys
   * nothing. Truncation is safe to spend now that it is READ correctly: a reply
   * with no answer comes back unparsed instead of being mined for a button name.
   */
  maxTokens: null,
};
for (let i = 2; i < process.argv.length; i++) {
  const f = process.argv[i];
  if (f === "--frames") args.frames = process.argv[++i];
  else if (f === "--line") args.line = Number(process.argv[++i]);
  else if (f === "--raw") args.raw = true;
  else if (f === "--both") args.both = true;
  else if (f === "--effort") args.effort = process.argv[++i];
  else if (f === "--model") args.model = process.argv[++i];
  else if (f === "--provider") args.provider = process.argv[++i];
  else if (f === "--any-provider") args.provider = null;
  else if (f === "--max-tokens") args.maxTokens = Number(process.argv[++i]);
  else throw new Error(`unknown flag ${f}`);
}
if (!args.frames) throw new Error("--frames <path to frames.jsonl> is required");

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error("no OPENROUTER_API_KEY");

const lines = fs.readFileSync(args.frames, "utf8").trim().split("\n");
const record = JSON.parse(lines[args.line - 1]);
// THE BASELINE IS THE NEXT LINE, NOT THIS ONE. A frame line carries the grid its
// press PRODUCED, so line N's grid is what press N+1 was looking at when it
// decided — and press N+1 is the one whose token bill this replay reproduces.
// Comparing against line N's own cost compared the replay to the press BEFORE
// the one it stands in for, which made a 45-token button press look like the
// expensive case it is supposed to be measured against.
const baseline = args.line < lines.length ? JSON.parse(lines[args.line]) : null;
const grid = record.grid.split("\n").map((row) => [...row].map((c) => parseInt(c, 16)));
// The action set that frame offered, taken from the record rather than invented:
// the whole point is to reproduce the decision the runner actually faced.
const offered = (record.offered ?? "ACTION3, ACTION4, ACTION6, ACTION7").split(", ");

console.log(`frame       ${args.frames} line ${args.line}  (grid ${grid.length}x${grid[0].length})`);
console.log(
  baseline
    ? `baseline    ${baseline.action} — the press that SAW this grid — cost ` +
      `${baseline.cost?.completionTokens} completion tokens in ` +
      `${Math.round((baseline.cost?.latencyMs ?? 0) / 1000)}s`
    : "baseline    none — this is the last line, so no recorded press saw this grid",
);
console.log(`offered     ${offered.join(", ")}`);
console.log(
  `model       ${args.model} via ${args.provider ?? "ANY (unpinned: tokens comparable, latency not)"}, ` +
    `effort ${args.effort}${args.maxTokens ? `, max_tokens ${args.maxTokens}` : ""}\n`,
);

const pricingRes = await fetch("https://openrouter.ai/api/v1/models");
const found = (await pricingRes.json()).data.find((m) => m.id === args.model);
if (!found) throw new Error(`model ${args.model} is not on OpenRouter`);
const inPer = Number(found.pricing.prompt);
const outPer = Number(found.pricing.completion);

const provider = new OpenAICompatibleProvider();
const target = { provider: "openrouter", model: args.model, baseUrl: "https://openrouter.ai/api", apiKey };

/** One completion, and everything it cost. */
async function askOnce(withCandidates) {
  let usage = null;
  let latencyMs = 0;
  const complete = async (messages) => {
    const startedAt = Date.now();
    const response = await provider.complete(target, {
      sessionId: "arc-click-probe",
      messages,
      reasoningEffort: args.effort,
      ...(args.provider ? { providerOnly: [args.provider] } : {}),
      ...(args.maxTokens ? { maxTokens: args.maxTokens } : {}),
      temperature: 0,
    });
    latencyMs = Date.now() - startedAt;
    usage = {
      promptTokens: response.promptTokens ?? 0,
      completionTokens: response.completionTokens ?? 0,
    };
    return response.content ?? "";
  };

  let promptChars = 0;
  // PARSED OR FALLBACK — without this the result is unreadable. A model that
  // ran to the token ceiling answers nothing, and `createModelPolicy` then
  // presses the FIRST offered action so the level is not conceded. That
  // fallback and a genuine choice of the first action print identically, and
  // two of the first four models in this shootout landed on exactly that
  // ambiguity: "chose ACTION3" where ACTION3 is offered[0].
  let unparsed = false;
  let replyTail = "";
  const policy = createModelPolicy({
    complete,
    clickCandidates: withCandidates,
    onUnparsed: () => { unparsed = true; },
    onExchange: (messages, reply) => {
      promptChars = messages.map((m) => m.content).join("").length;
      replyTail = typeof reply === "string" ? reply.slice(-160) : "";
    },
  });
  const chosen = await policy(
    { grid, state: "NOT_FINISHED" },
    { actions: offered, remaining: Infinity, taken: [record.action] },
  );
  const spend = usage.promptTokens * inPer + usage.completionTokens * outPer;
  return { chosen, ...usage, latencyMs, spend, promptChars, unparsed, replyTail };
}

const runs = args.both ? [false, true] : [!args.raw];
const results = [];
for (const withCandidates of runs) {
  const label = withCandidates ? "CANDIDATES" : "RAW GRID";
  process.stdout.write(`${label.padEnd(12)} asking...`);
  const r = await askOnce(withCandidates);
  results.push({ label, ...r });
  console.log(
    `\r${label.padEnd(12)} ${String(r.completionTokens).padStart(7)} completion tokens  ` +
      `${String(Math.round(r.latencyMs / 1000)).padStart(4)}s  $${r.spend.toFixed(5)}  -> ` +
      (r.unparsed ? `NO ANSWER (fallback pressed ${r.chosen})` : `chose ${r.chosen}`),
  );
}

console.log("\n" + "=".repeat(70));
for (const r of results) {
  console.log(
    `${r.label.padEnd(12)} prompt ${r.promptTokens} tok (${r.promptChars} chars), ` +
      `completion ${r.completionTokens} tok, ${Math.round(r.latencyMs / 1000)}s, $${r.spend.toFixed(5)}, ` +
      (r.unparsed ? `NO ANSWER -> fallback ${r.chosen}` : `chose ${r.chosen}`),
  );
  if (r.replyTail) console.log(`  reply tail: ${JSON.stringify(r.replyTail)}`);
}
// The comparison that matters is against the RECORDED press, because that one
// was paid for in a real game rather than in a replay.
const recorded = baseline?.cost?.completionTokens;
const best = results.at(-1);
if (recorded && best) {
  const factor = recorded / Math.max(1, best.completionTokens);
  console.log(
    `\nrecorded ${baseline.action} ${recorded} tok  ->  this run ${best.completionTokens} tok  ` +
      `= ${factor >= 1 ? `${factor.toFixed(1)}x cheaper` : `${(1 / factor).toFixed(1)}x MORE expensive`}`,
  );
}
console.log(`total spent here $${results.reduce((a, r) => a + r.spend, 0).toFixed(5)}`);
