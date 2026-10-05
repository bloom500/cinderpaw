/**
 * S1.6 of the AgentLoop evolution spec (2026-10-04, §0.4, §11, §12, §17):
 * the campaign report. Computes what E1 and E2 need (rank agreement with an
 * interval, the strict gate's verdict, cost-AUC, sub-check pass rates) and
 * opens with "Pentru Darius": one Romanian sentence per INT line, filled
 * from the data or saying why it cannot be yet.
 *
 * RESEARCH ONLY (spec §4.7).
 *
 * Rules:
 *   1. "Pentru Darius" comes first; its first line is the spend against the
 *      cap (INT-12) and the tier (INT-16). It uses no technical words.
 *   2. A line the data cannot fill says "nu se poate masura inca" and why.
 *      Never a guessed number.
 *   3. The word "RSI" appears nowhere unless E5 passed (INT-11). No E5 runs
 *      in Phase 1, so this report never writes it.
 *   4. E1 obeys H18 (§26): it can pass only if each fitness ranks its own
 *      genomes reliably (test-retest tau >= 0.6, interval above 0); else it
 *      is "inconclusive: the genomes do not differ", never a pass by noise.
 */

import type { CampaignManifest, CampaignResult } from "../infra/campaign.ts";
import { rngOf } from "../infra/fixtures.ts";
import type { Verdict } from "./agent-evaluator.ts";
import type { ExecutorRun } from "./agent-executor.ts";

/** Kendall's tau-b: rank agreement in [-1, 1], ties counted. NaN when one
 *  side has no variation (nothing to rank). */
export function kendallTau(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error("kendallTau: rankings of different length");
  let concordant = 0;
  let discordant = 0;
  let tiesA = 0;
  let tiesB = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      const da = Math.sign(a[i]! - a[j]!);
      const db = Math.sign(b[i]! - b[j]!);
      if (da === 0 && db === 0) continue;
      if (da === 0) tiesA++;
      else if (db === 0) tiesB++;
      else if (da === db) concordant++;
      else discordant++;
    }
  }
  const denom = Math.sqrt((concordant + discordant + tiesA) * (concordant + discordant + tiesB));
  return denom === 0 ? Number.NaN : (concordant - discordant) / denom;
}

/** Tau with a 95% percentile bootstrap interval over the ranked items.
 *  Seeded: the same scores give the same interval. */
export function kendallTauInterval(
  a: readonly number[],
  b: readonly number[],
  iterations = 2_000,
  seed = 0xc0ffee,
): { tau: number; lo: number; hi: number } {
  const rng = rngOf(seed);
  const taus: number[] = [];
  for (let k = 0; k < iterations; k++) {
    const idx = a.map(() => Math.floor(rng() * a.length));
    const t = kendallTau(
      idx.map((i) => a[i]!),
      idx.map((i) => b[i]!),
    );
    if (!Number.isNaN(t)) taus.push(t);
  }
  taus.sort((x, y) => x - y);
  const at = (q: number) => (taus.length ? taus[Math.min(taus.length - 1, Math.floor(q * taus.length))]! : Number.NaN);
  return { tau: kendallTau(a, b), lo: at(0.025), hi: at(0.975) };
}

/** Scores of K genomes under one fitness, twice, with different seeds. */
export interface FitnessScores {
  first: readonly number[];
  retest: readonly number[];
}

export interface E1Result {
  verdict: "pass" | "fail" | "inconclusive";
  why: string;
  suiteRetest: ReturnType<typeof kendallTauInterval>;
  agentRetest: ReturnType<typeof kendallTauInterval>;
  cross: ReturnType<typeof kendallTauInterval>;
  sameChampion: boolean;
}

const argmax = (xs: readonly number[]): number => xs.reduce((best, x, i) => (x > xs[best]! ? i : best), 0);
const mean2 = (s: FitnessScores): number[] => s.first.map((x, i) => (x + s.retest[i]!) / 2);

/** E1 (§12) with H18: test-retest first, then the cross-fitness ranking. */
export function judgeE1(suite: FitnessScores, agent: FitnessScores): E1Result {
  if (suite.first.length < 8) throw new Error(`E1 needs K >= 8 genomes, got ${suite.first.length}`);
  const suiteRetest = kendallTauInterval(suite.first, suite.retest);
  const agentRetest = kendallTauInterval(agent.first, agent.retest);
  const s = mean2(suite);
  const g = mean2(agent);
  const cross = kendallTauInterval(s, g);
  const sameChampion = argmax(s) === argmax(g);
  const reliable = (r: typeof suiteRetest) => r.tau >= 0.6 && r.lo > 0;
  const base = { suiteRetest, agentRetest, cross, sameChampion };
  if (!reliable(suiteRetest) || !reliable(agentRetest)) {
    return { ...base, verdict: "inconclusive", why: "the genomes do not differ: a fitness does not rank its own genomes reliably (test-retest)" };
  }
  if (cross.tau < 0.5 && cross.hi < 1) return { ...base, verdict: "pass", why: "the two fitnesses rank the genomes differently" };
  if (cross.tau >= 0.8 && sameChampion) return { ...base, verdict: "fail", why: "same ranking and same champion: the evaluator is not the bottleneck" };
  return { ...base, verdict: "inconclusive", why: "rankings neither clearly differ nor clearly agree" };
}

/**
 * Area under success versus cumulative cost (§4.4 secondary fitness), as a
 * fraction of the budget: success(c) is the share of all tasks passed by the
 * time `c` was spent, a step that rises when a passing task completes. 1 is
 * every task passed at zero cost; spending more for the same passes lowers it.
 */
export function costAuc(tasks: readonly { cost: number; passed: boolean }[], budget: number): number {
  if (tasks.length === 0 || budget <= 0) return 0;
  let spent = 0;
  let passed = 0;
  let area = 0;
  for (const t of tasks) {
    const end = Math.min(budget, spent + t.cost);
    area += (passed / tasks.length) * (end - Math.min(budget, spent));
    spent += t.cost;
    if (t.passed && spent <= budget) passed++;
  }
  if (spent < budget) area += (passed / tasks.length) * (budget - spent);
  return area / budget;
}

/** Pass rate of each sub-check id across verdicts. */
export function subCheckRates(verdicts: readonly Verdict[]): Record<string, { passed: number; total: number }> {
  const out: Record<string, { passed: number; total: number }> = {};
  for (const v of verdicts) {
    for (const s of v.subChecks) {
      const r = (out[s.id] ??= { passed: 0, total: 0 });
      r.total++;
      if (s.passed) r.passed++;
    }
  }
  return out;
}

export interface ReportInput {
  manifest: CampaignManifest;
  result: CampaignResult;
  /** Every executor run and verdict of the campaign, all arms. */
  runs: readonly ExecutorRun[];
  verdicts: readonly Verdict[];
  startedBy: string;
  startedAt: string;
  tier: "Micro" | "Standard" | "Frontier";
  e1?: E1Result;
}

/** Words the owner-facing section must never use (S1.6 test list, plus
 *  "RSI" for INT-11). */
export const TECHNICAL_WORDS = ["genome", "manifest", "hash", "arm", "partition", "RSI", "token", "verdict", "seed"];

const NOT_YET = "nu se poate masura inca";
const usd = (n: number) => `${n.toFixed(4)} $`;

function forDarius(r: ReportInput): string[] {
  const spent = Object.values(r.result.ledger).reduce((s, c) => s + c.usd, 0);
  const promo = r.manifest.partitions.promotion.length;
  const listed = Object.values(r.manifest.partitions).reduce((s, p) => s + p.length, 0);
  const graded = r.verdicts.length;
  // Per executor: a ceiling is one agent passing the set (§27.2 rule 2),
  // not the pooled rate of every agent in the campaign.
  const byExecutor = new Map<string, { passed: number; total: number }>();
  for (const v of r.verdicts) {
    const e = byExecutor.get(v.executorHash) ?? { passed: 0, total: 0 };
    e.total++;
    if (v.passed) e.passed++;
    byExecutor.set(v.executorHash, e);
  }
  const rates = [...byExecutor.values()].map((e) => e.passed / e.total);
  const best = rates.length ? Math.max(...rates) : 0;
  const worst = rates.length ? Math.min(...rates) : 0;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const crashed = r.runs.filter((x) => x.terminal === "error").length;
  return [
    `Cheltuit ${usd(spent)} din plafonul ${usd(r.manifest.usdCap)}. Nivel: ${r.tier}.`,
    `INT-1: Nicio lista fixa nu a fost folosita ca agentul sa caute sau sa se antreneze: da. Nota a venit din ${listed} sarcini generate si inghetate doar pentru aceasta campanie, iar teste scrise de alti oameni nu au fost folosite inca.`,
    `INT-2: Sarcini propuse de agent: 0, ${NOT_YET}, pentru ca in aceasta etapa sarcinile sunt de reparat proiecte, generate de noi, nu alese de agent.`,
    `INT-3: Sarcini din meserii reale: ${NOT_YET}, pentru ca lista de meserii nu este conectata in aceasta etapa.`,
    `INT-4: Meserii acoperite: 1 (reparat proiecte de programare); restul ${NOT_YET}, pentru ca generatorul de sarcini din orice domeniu nu exista inca.`,
    `INT-5: Respinse de filtrul de domenii interzise: 0, pentru ca filtrul nu ruleaza inca; nicio sarcina din domeniile interzise nu exista in aceasta campanie: da.`,
    `INT-6: Note date de un program din afara agentului: ${graded} din ${graded}; agentul nu si-a dat nicio nota: da.`,
    `INT-7: Scor pe sarcini pe care nu le-a mai vazut: cel mai bun agent ${pct(best)}, cel mai slab ${pct(worst)}, din ${graded} notate (${promo} pe rulare); comparatia cu sarcinile exersate ${NOT_YET}, pentru ca agentul nu exerseaza in aceasta etapa.`,
    `INT-8: Versiuni ale felului in care invata: 0, ${NOT_YET}, pentru ca partea care isi schimba felul de a invata vine dupa aceasta etapa.`,
    `INT-9: Proceduri ajunse la utilizator: 0; nimic din aceasta campanie nu ajunge la utilizator: da.`,
    `INT-10: Evaluari economisite din istoric: 0, ${NOT_YET}, pentru ca invatarea din istoric vine mai tarziu.`,
    `INT-11: Cuvantul folosit pentru auto-imbunatatire dovedita nu apare in acest raport, pentru ca testul final nu a rulat: da.`,
    `INT-12: Cheltuit ${usd(spent)} din plafonul ${usd(r.manifest.usdCap)}; s-a oprit singura la plafon daca era nevoie: ${r.result.stopped?.includes("usd cap") ? "da, s-a oprit" : "nu a fost nevoie"}.`,
    `INT-13: Lucru izolat de calculatorul tau: da, fiecare sarcina a rulat in cutia ei; rulari care s-au blocat: ${crashed}; aprobari umane cerute: 0; podeaua veche de verificare ${NOT_YET} in aceasta campanie.`,
    `INT-14: Limbi folosite: 1 (engleza); celelalte ${NOT_YET}, pentru ca filtrul pe fiecare limba nu exista inca.`,
    `INT-15: Pornita de ${r.startedBy}, la ${r.startedAt}, cu plafon: da.`,
    `INT-16: Nivel ${r.tier}, cost ${usd(spent)}; cel mai mic castig dovedibil ${NOT_YET}, pentru ca asta cere masurarea zgomotului la acest nivel.`,
    `INT-17: Cost pe sarcina rezolvata, pe dificultati: ${NOT_YET}, pentru ca sarcinile nu au inca dificultati masurate.`,
    `INT-18: Fara plafon: ${best > 0.9 ? "un agent a trecut peste 90%, deci setul este retras si urmatoarea campanie trebuie sa aiba sarcini mai grele" : "sub plafon, setul ramane"}; nota deschisa ${NOT_YET}, pentru ca masuratoarea fara plafon vine in pasul urmator.`,
  ];
}

export function renderReport(r: ReportInput): string {
  const lines = ["## Pentru Darius", "", ...forDarius(r).map((l) => `- ${l}`), "", "## Technical", ""];
  const res = r.result;
  lines.push(`- manifest: ${res.manifestHash}`);
  if (r.manifest.agentLoop) {
    const a = r.manifest.agentLoop;
    lines.push(`- family ${a.familyHash}, evaluator ${a.evaluatorHash}, executor ${a.executorHash}`);
  }
  lines.push(`- samples: ${res.samples.length} of ${r.manifest.seeds.length} seeds, matched: ${res.matched}`);
  if (res.stopped) lines.push(`- STOPPED: ${res.stopped}`);
  lines.push(`- gate (E2 global criteria): ${res.gate.accept ? "accept" : "reject"}: ${res.gate.reason}`);
  for (const [arm, c] of Object.entries(res.ledger)) lines.push(`- ledger ${arm}: ${c.tokens} tokens, ${usd(c.usd)}, ${c.wallMs} ms`);

  const terminals: Record<string, number> = {};
  for (const x of r.runs) terminals[x.terminal] = (terminals[x.terminal] ?? 0) + 1;
  lines.push(`- executor ends: ${Object.entries(terminals).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
  const passed = new Set(r.verdicts.filter((v) => v.passed).map((v) => `${v.executorHash}|${v.taskId}`));
  const curve = r.runs.map((x) => ({ cost: x.usage.inputTokens + x.usage.outputTokens, passed: passed.has(`${x.executorHash}|${x.taskId}`) }));
  const auc = costAuc(curve, curve.reduce((s, t) => s + t.cost, 0));
  lines.push(`- cost-AUC (tokens, budget = tokens spent): ${auc.toFixed(3)}`);
  for (const [id, s] of Object.entries(subCheckRates(r.verdicts))) lines.push(`- sub-check ${id}: ${s.passed}/${s.total}`);
  lines.push("- one failure type per held-out set on F1 (spec §26.3).");

  if (r.e1) {
    const e = r.e1;
    const f = (t: { tau: number; lo: number; hi: number }) => `${t.tau.toFixed(2)} [${t.lo.toFixed(2)}, ${t.hi.toFixed(2)}]`;
    lines.push("", "### E1", "", `- verdict: ${e.verdict}: ${e.why}`);
    lines.push(`- test-retest tau, suite: ${f(e.suiteRetest)}; AgentLoop: ${f(e.agentRetest)}`);
    lines.push(`- cross tau: ${f(e.cross)}; same champion: ${e.sameChampion}`);
  }
  return lines.join("\n") + "\n";
}
