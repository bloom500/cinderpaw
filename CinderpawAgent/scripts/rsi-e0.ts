/**
 * E0 with a model (AgentLoop spec §12): is the harness trustworthy? The same
 * executor (the live agent, neutral genome, Muse Spark 1.3 Contributor)
 * against itself, N paired runs on F1's promotion tasks, every task in a
 * Docker cell and graded by the evaluator in its own cell. Pass: the
 * self-run delta interval includes 0 and the canaries pass.
 *
 * RESEARCH ONLY, run by the owner on his machine. Spends real money:
 *
 *   OPENROUTER_API_KEY=... bun scripts/rsi-e0.ts --usd-cap 3 --out e0.md
 *   bun scripts/rsi-e0.ts --dry-run --seeds 1 --out e0-dry.md   (stub, free)
 *
 * Refuses without --usd-cap (unless --dry-run), and before any call checks
 * OpenRouter's public price list (free) against the price the broker
 * charges, so a price change cannot make the ledger under-count.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentLoopArm, agentLoopPlan, type AgentLoopArmRun } from "../src/rsi/infra/arms.ts";
import { runPairedCampaign, type ArmFn, type CampaignManifest } from "../src/rsi/infra/campaign.ts";
import { sha256Canonical } from "../src/rsi/infra/hash-chain.ts";
import { bunExec } from "../src/rsi/l3-code/code-sandbox.ts";
import { DockerIsolation } from "../src/rsi/l3-code/isolation.ts";
import type { Verdict } from "../src/rsi/research/agent-evaluator.ts";
import { runExecutor, type ExecutorRun } from "../src/rsi/research/agent-executor.ts";
import { BUDGET, buildRepairSet, canaries } from "../src/rsi/research/families/build-repair.ts";
import { MUSE_SPARK_CONTRIBUTOR, openRouterModel } from "../src/rsi/research/openrouter-model.ts";
import { renderReport } from "../src/rsi/research/report.ts";
import type { BrokerModel } from "../src/rsi/research/task-budget.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const dry = flag("--dry-run");
const out = opt("--out");
const seeds = Number(opt("--seeds") ?? 10);
const usdCap = dry ? 0 : Number(opt("--usd-cap"));
// ponytail: a worst-case task (200k in + 20k out) is $0.024 at Muse Spark's
// price; 0.03 leaves room for the estimate's rounding.
const perTaskUsd = dry ? 0 : Number(opt("--per-task-usd") ?? 0.03);

const die = (msg: string): never => {
  console.error(`rsi-e0: ${msg}`);
  process.exit(2);
};
if (!out) die("--out <report.md> is required");
if (!Number.isInteger(seeds) || seeds < 1) die("--seeds must be a whole number of 1 or more");
if (!dry && !(usdCap > 0)) die("--usd-cap <dollars> is required for a paid run (or use --dry-run)");
if (!dry && !(perTaskUsd > 0)) die("--per-task-usd must be above 0");

async function checkPrice(): Promise<void> {
  const res = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(30_000) });
  const list = (await res.json()) as { data: { id: string; pricing: { prompt: string; completion: string } }[] };
  const m = list.data.find((x) => x.id === MUSE_SPARK_CONTRIBUTOR.id);
  if (!m) die(`${MUSE_SPARK_CONTRIBUTOR.id} is not on OpenRouter any more`);
  const inM = Number(m!.pricing.prompt) * 1e6;
  const outM = Number(m!.pricing.completion) * 1e6;
  if (Math.abs(inM - MUSE_SPARK_CONTRIBUTOR.usdPerMInput) > 1e-9 || Math.abs(outM - MUSE_SPARK_CONTRIBUTOR.usdPerMOutput) > 1e-9) {
    die(`price changed: OpenRouter says $${inM}/$${outM} per M, the broker charges $${MUSE_SPARK_CONTRIBUTOR.usdPerMInput}/$${MUSE_SPARK_CONTRIBUTOR.usdPerMOutput}; update openrouter-model.ts first`);
  }
}

const stub: BrokerModel = {
  id: "stub",
  usdPerMInput: 0,
  usdPerMOutput: 0,
  call: async () => ({ choices: [{ message: { role: "assistant", content: "Done." }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } }),
};

let model: BrokerModel;
if (dry) model = stub;
else {
  await checkPrice();
  model = openRouterModel(MUSE_SPARK_CONTRIBUTOR, process.env.OPENROUTER_API_KEY ?? "");
}

const pkg = join(import.meta.dir, "..");
const iso = new DockerIsolation({ exec: bunExec, limits: { pids: 256, memory: "1g", cpus: 2, scratch: "128m", wallMs: 120_000 } });
const available = await iso.available();
if (!available.ok) die(available.reason);

const set = buildRepairSet(12, 1000, { ...BUDGET, maxUsd: perTaskUsd });
const genome = {};
const executorHash = sha256Canonical({ model: model.id, genome, agent: "CinderpawAgent/src" });
const plan = agentLoopPlan(set, executorHash);
const promo = plan.partitions.promotion.length;
console.error(
  `rsi-e0: ${dry ? "DRY RUN (stub, free)" : `model ${model.id}, cap $${usdCap}`}; ${seeds} seeds x 2 x ${promo} tasks = ${seeds * 2 * promo} runs` +
    (dry ? "" : `; worst case $${(seeds * 2 * promo * perTaskUsd).toFixed(2)}, stops at the cap`),
);

const runs: ExecutorRun[] = [];
const verdicts: Verdict[] = [];
const armFor = (side: string): ArmFn => {
  const inner = agentLoopArm({
    tasks: plan.tasks,
    checks: set.checks,
    canaries: canaries(set, mkdtempSync(join(tmpdir(), "cp-e0-can-"))),
    evalCell: iso,
    executorHash,
    execute: (task, workspaceDir) =>
      runExecutor({ iso, task, workspaceDir, agentSrcDir: join(pkg, "src"), depsDir: pkg, model, genome, executorHash, caps: { maxBytes: 10_000_000, maxEntries: 1_000 } }),
  });
  return async (ctx) => {
    const r = (await inner(ctx)) as AgentLoopArmRun;
    const solve = r.solve;
    r.solve = async (t) => {
      const graded = r.verdicts.length;
      const ok = await solve(t);
      const last = r.runs.at(-1)!;
      runs.push(last);
      if (r.verdicts.length > graded) verdicts.push(r.verdicts.at(-1)!);
      console.error(`  seed ${ctx.seed} ${side} ${t.id}: ${last.terminal}${ok ? " PASS" : ""} ($${last.usage.usd.toFixed(4)}, ${last.usage.calls} calls)`);
      return ok;
    };
    return r;
  };
};

const manifest: CampaignManifest = {
  id: `e0-f1-${model.id}`,
  seeds: Array.from({ length: seeds }, (_, i) => i + 1),
  arms: ["self-a", "self-b"],
  partitions: plan.partitions,
  usdCap,
  wallMsCap: 48 * 3_600_000,
  agentLoop: plan.agentLoop,
};
const result = await runPairedCampaign(manifest, { "self-a": armFor("a"), "self-b": armFor("b") });
const md = renderReport({ manifest, result, runs, verdicts, startedBy: "Darius", startedAt: new Date().toISOString(), tier: "Micro" });
const deltas = result.samples.map((s) => s.candidate - s.baseline);
const ci = result.gate.bootstrap;
// E0 asks the opposite of the promotion gate: the same agent against itself
// must show NO difference, so the interval has to contain 0.
// Two ways to "pass" vacuously, both refused: too few pairs (spec: 10), and
// an agent that passes nothing (0 vs 0 always agrees with itself).
const anyPass = verdicts.some((v) => v.passed);
const e0Verdict = result.stopped
  ? "fail"
  : result.samples.length < 10
    ? `inconclusive: ${result.samples.length} paired runs, E0 needs 10`
    : !anyPass
      ? "inconclusive: no task passed, a harness that grades only failures cannot be judged"
      : result.matched && ci.ciLower <= 0 && ci.ciUpper >= 0
        ? "pass"
        : "fail";
const e0 = [
  "",
  "### E0",
  "",
  `- verdict: ${e0Verdict}${result.stopped ? ` (stopped: ${result.stopped})` : ""}`,
  `- self-run deltas: ${deltas.map((d) => d.toFixed(3)).join(", ") || "none"}`,
  `- mean ${ci.mean.toFixed(3)}, 95% interval [${ci.ciLower.toFixed(3)}, ${ci.ciUpper.toFixed(3)}]`,
  "- pass needs: canaries passed (else the run stops), no stop, at least 10 paired runs, at least one task passed, the interval contains 0.",
  "",
].join("\n");
writeFileSync(out!, md + e0);
console.error(`rsi-e0: report written to ${out}${result.stopped ? `; STOPPED: ${result.stopped}` : ""}`);
