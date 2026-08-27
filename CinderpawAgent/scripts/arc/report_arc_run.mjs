/**
 * Turn a directory of ARC-AGI-3 game logs into one report: every number the
 * run produced, per game and per arm, plus the A-vs-B delta.
 *
 * Usage:  bun CinderpawAgent/scripts/arc/report_arc_run.mjs runs-arc/<stamp>
 *
 * The arms are the subdirectories (A, B, …). Each game log ends with a
 * `result      <path>` line naming the result.json the runner wrote; that is
 * the tie between an arm and its data, so nothing here has to guess from
 * timestamps. A log without that line is reported as a crash rather than
 * quietly dropped — a game that died is evidence too, and the run summary is
 * wrong without it.
 *
 * Writes report.json (for charts) and report.md (for reading) into the run dir.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const runDir = process.argv[2];
if (!runDir) {
  console.error("usage: bun report_arc_run.mjs runs-arc/<stamp>");
  process.exit(2);
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Human baselines, so a score can be computed instead of asserted. */
async function baselines() {
  const key = process.env.ARC_API_KEY;
  if (!key) return {};
  try {
    const games = await fetch("https://three.arcprize.org/api/games", {
      headers: { "X-API-Key": key },
    }).then((r) => r.json());
    return Object.fromEntries(games.map((g) => [g.game_id, g.baseline_actions ?? []]));
  } catch {
    return {};
  }
}

/**
 * The official formula: a level scores (human/ai)^2 capped at 1.15, a game is
 * the average of its levels weighted by 1-indexed level number, and levels
 * never reached score zero and still count in the denominator. Computed here
 * as a PREDICTION only — the authoritative number is the scorecard's. Both go
 * in the report so a discrepancy is visible instead of averaged away.
 */
function predictedScore(base, levelsCompleted, actions) {
  if (!base || base.length === 0) return null;
  const perLevel = actions / Math.max(1, levelsCompleted);
  let num = 0;
  let den = 0;
  base.forEach((humanActions, i) => {
    const w = i + 1;
    den += w;
    if (i < levelsCompleted) num += w * Math.min(1.15, (humanActions / Math.max(1, perLevel)) ** 2);
  });
  return den === 0 ? null : num / den;
}

const arms = fs
  .readdirSync(runDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const humanBaselines = await baselines();
const report = { runDir, generatedAt: new Date().toISOString(), arms: {} };

for (const arm of arms) {
  const dir = path.join(runDir, arm);
  const games = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".log"))) {
    const game = file.replace(/\.log$/, "");
    const log = fs.readFileSync(path.join(dir, file), "utf8");
    const m = log.match(/^result {6}(.+)$/m);
    if (!m) {
      const err = log.match(/^error: .*$/m);
      games.push({ game, crashed: true, error: err?.[0] ?? "no result.json and no error line", logBytes: log.length });
      continue;
    }
    const r = JSON.parse(fs.readFileSync(m[1].trim(), "utf8"));
    const base = humanBaselines[game];
    games.push({
      ...r,
      humanBaseline: base ?? null,
      humanTotalActions: base ? sum(base) : null,
      predictedScore: predictedScore(base, r.outcome.levelsCompleted, r.outcome.actionsSpent),
      logPath: path.join(dir, file),
    });
  }
  const played = games.filter((g) => !g.crashed);
  const lat = played.flatMap((g) => g.model?.latenciesMs ?? []);
  report.arms[arm] = {
    games: games.sort((a, b) => a.game.localeCompare(b.game)),
    totals: {
      gamesLaunched: games.length,
      gamesCrashed: games.length - played.length,
      levelsCompleted: sum(played.map((g) => g.outcome.levelsCompleted)),
      levelsAvailable: sum(played.map((g) => g.outcome.winLevels)),
      actionsSpent: sum(played.map((g) => g.outcome.actionsSpent)),
      spendUsd: sum(played.map((g) => g.model?.spendUsd ?? 0)),
      promptTokens: sum(played.map((g) => g.model?.promptTokens ?? 0)),
      completionTokens: sum(played.map((g) => g.model?.completionTokens ?? 0)),
      modelCalls: sum(played.map((g) => g.model?.calls ?? 0)),
      modelFailures: sum(played.map((g) => g.model?.failures ?? 0)),
      unparsedReplies: sum(played.map((g) => g.policy.unparsed)),
      medianCallLatencyMs: median(lat),
      p90CallLatencyMs: lat.length ? [...lat].sort((a, b) => a - b)[Math.floor(lat.length * 0.9)] : null,
      wallClockSeconds: Math.max(0, ...played.map((g) => g.wallClockSeconds)),
      meanPredictedScore:
        played.length === 0
          ? null
          : sum(played.map((g) => g.predictedScore ?? 0)) / played.length,
    },
  };
}

const jsonPath = path.join(runDir, "report.json");
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

// A table a person can read and a chart can be built from, in that order.
const lines = [`# ARC-AGI-3 run — ${runDir}`, "", `Generated ${report.generatedAt}`, ""];
for (const [arm, data] of Object.entries(report.arms)) {
  const t = data.totals;
  lines.push(
    `## Arm ${arm}`,
    "",
    `- games: ${t.gamesLaunched} launched, ${t.gamesCrashed} crashed`,
    `- levels: ${t.levelsCompleted} of ${t.levelsAvailable} reached`,
    `- actions: ${t.actionsSpent}`,
    `- spend: $${t.spendUsd.toFixed(4)} over ${t.modelCalls} model calls (${t.modelFailures} failed)`,
    `- tokens: ${t.promptTokens} prompt / ${t.completionTokens} completion`,
    `- model latency: median ${t.medianCallLatencyMs}ms, p90 ${t.p90CallLatencyMs}ms`,
    `- unparsed replies: ${t.unparsedReplies}`,
    `- predicted mean score: ${t.meanPredictedScore === null ? "n/a" : t.meanPredictedScore.toFixed(4)} (scorecard is authoritative)`,
    "",
    "| game | levels | actions | human | spend | calls | unparsed | stopped | scorecard |",
    "|---|---|---|---|---|---|---|---|---|",
  );
  for (const g of data.games) {
    if (g.crashed) {
      lines.push(`| ${g.game} | CRASHED | | | | | | ${g.error.slice(0, 60)} | |`);
      continue;
    }
    lines.push(
      `| ${g.game} | ${g.outcome.levelsCompleted}/${g.outcome.winLevels} | ${g.outcome.actionsSpent} | ` +
        `${g.humanTotalActions ?? "?"} | $${(g.model?.spendUsd ?? 0).toFixed(4)} | ${g.model?.calls ?? 0} | ` +
        `${g.policy.unparsed} | ${g.outcome.attempts.at(-1)?.stoppedBecause ?? "?"} | ${g.scorecardId} |`,
    );
  }
  lines.push("");
}
if (report.arms.A && report.arms.B) {
  const a = report.arms.A.totals;
  const b = report.arms.B.totals;
  lines.push(
    "## A vs B — the matched ablation",
    "",
    "| metric | A (bare) | B (full) | delta |",
    "|---|---|---|---|",
    `| levels completed | ${a.levelsCompleted} | ${b.levelsCompleted} | ${b.levelsCompleted - a.levelsCompleted} |`,
    `| actions spent | ${a.actionsSpent} | ${b.actionsSpent} | ${b.actionsSpent - a.actionsSpent} |`,
    `| spend USD | ${a.spendUsd.toFixed(4)} | ${b.spendUsd.toFixed(4)} | ${(b.spendUsd - a.spendUsd).toFixed(4)} |`,
    `| prompt tokens | ${a.promptTokens} | ${b.promptTokens} | ${b.promptTokens - a.promptTokens} |`,
    `| games crashed | ${a.gamesCrashed} | ${b.gamesCrashed} | ${b.gamesCrashed - a.gamesCrashed} |`,
    "",
    "Same games, same budget, same pinned upstream. The only difference is MCTS",
    "rehearsal and the scene description in the prompt.",
    "",
  );
}
const mdPath = path.join(runDir, "report.md");
fs.writeFileSync(mdPath, lines.join("\n"));
console.log(`wrote ${jsonPath}\nwrote ${mdPath}`);
