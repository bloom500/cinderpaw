/**
 * S1.9 of the AgentLoop evolution spec (2026-10-04, §4.2 step 2, §17): the
 * task proposer. Turns one sampled field (an O*NET task statement or an
 * ESCO occupation, in a language) into a concrete task in the Code-as-Task
 * shape, then sends it through the gate and the feasibility check. Every
 * outcome, kept or not, is a receipt with what it cost.
 *
 * RESEARCH ONLY (spec §4.7). A user install never proposes tasks.
 *
 * Rules this file holds:
 *   1. The proposer never sees a holdout field: a field outside the
 *      development partition is refused before any model call.
 *   2. Every model call goes through the broker, so a malformed answer is
 *      a failure whose spend is kept, never a free retry.
 *   3. Nothing is built before the gate (S1.8) allows it; the gate's
 *      classifier is never the proposer model.
 */

import type { IsolationBackend } from "../l3-code/isolation.ts";
import type { CheckRegistry } from "./agent-evaluator.ts";
import { gate, type Classifier } from "./domain-gate.ts";
import { admit, checkFeasibility, materialize, type TaskProposal } from "./feasibility.ts";
import type { FieldTask } from "./field-sampler.ts";
import type { BrokerUsage, BudgetBroker } from "./task-budget.ts";
import type { AgentTask, TaskBudget } from "./task-family.ts";
import type { Partition } from "../infra/campaign.ts";

export const PROPOSER_PROMPT_VERSION = "proposer/1";

const LIMITS = { files: 50, bytes: 200_000, check: 20_000, failures: 10 };

export function proposerMessages(field: FieldTask): { role: string; content: string }[] {
  return [
    {
      role: "system",
      content:
        "You write one realistic work task that a person in the given occupation does, small enough for an assistant to finish " +
        "in a few minutes with files only (no internet). Answer with ONE JSON object and nothing else:\n" +
        '{"instruction": string, "files": {path: text}, "check": string, "solution": {path: text}, "failures": [{path: text}, ...]}\n' +
        "- instruction and every file are written in the requested language.\n" +
        "- files: the starting workspace, with every fact the task needs planted in it (numbers, names, dates).\n" +
        "- check: a JavaScript program run with Bun; process.argv[1] is the workspace directory; it reads the files and exits 0 " +
        "only when the work is right, checking the planted facts, never only that a file exists.\n" +
        "- solution: the files that, laid over the starting workspace, make a correct answer.\n" +
        "- failures: at least two plausible wrong answers, laid over the starting workspace the same way.\n" +
        "- Paths are relative, use /, no '..'.",
    },
    {
      role: "user",
      content: `Language: ${field.language}\nOccupation: ${field.title}\nReal work this occupation does: ${field.task}`,
    },
  ];
}

const safePath = (p: string) => !!p && !p.startsWith("/") && !p.includes("\\") && !/^[a-zA-Z]:/.test(p) && !p.split("/").includes("..");

function fileMap(v: unknown, what: string): Record<string, string> | string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return `${what} is not an object of files`;
  for (const [k, t] of Object.entries(v)) {
    if (!safePath(k)) return `${what}: path "${k}" leaves the workspace`;
    if (typeof t !== "string") return `${what}: "${k}" is not text`;
  }
  return v as Record<string, string>;
}

/** Parse the proposer's answer. Fenced or bare JSON; anything else is a reason. */
export function parseProposal(text: string): { ok: true; proposal: TaskProposal } | { ok: false; reason: string } {
  const body = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, reason: "the answer is not one JSON object" };
  }
  if (typeof raw.instruction !== "string" || !raw.instruction.trim()) return { ok: false, reason: "no instruction" };
  if (typeof raw.check !== "string" || !raw.check.trim()) return { ok: false, reason: "no check program" };
  if (raw.check.length > LIMITS.check) return { ok: false, reason: "the check program is too long" };
  const files = fileMap(raw.files, "files");
  if (typeof files === "string") return { ok: false, reason: files };
  const solution = fileMap(raw.solution, "solution");
  if (typeof solution === "string") return { ok: false, reason: solution };
  if (!Array.isArray(raw.failures) || raw.failures.length < 2) return { ok: false, reason: "fewer than two failure cases" };
  if (raw.failures.length > LIMITS.failures) return { ok: false, reason: "too many failure cases" };
  const failures: Record<string, string>[] = [];
  for (const [i, f] of raw.failures.entries()) {
    const m = fileMap(f, `failure ${i + 1}`);
    if (typeof m === "string") return { ok: false, reason: m };
    failures.push(m);
  }
  const all = [files, solution, ...failures];
  if (Object.keys(files).length + Object.keys(solution).length > LIMITS.files) return { ok: false, reason: "too many files" };
  if (all.reduce((s, m) => s + Object.values(m).reduce((t, x) => t + x.length, 0), 0) > LIMITS.bytes) {
    return { ok: false, reason: "the files are too large" };
  }
  return { ok: true, proposal: { instruction: raw.instruction, files, check: raw.check, solution, failures } };
}

export interface ProposalReceipt {
  fieldTaskId: string;
  source: string;
  family: string;
  /** The occupation (O*NET-SOC or ESCO code). Coverage counts these. */
  code: string;
  language: string;
  stage: "refused" | "model" | "malformed" | "gate" | "cell" | "infeasible" | "accepted";
  reason: string;
  /** What the proposer had spent when this receipt was written. */
  usage: BrokerUsage;
  promptVersion: string;
}

export async function proposeTask(args: {
  field: FieldTask;
  source: "onet" | "esco";
  partitions: Readonly<Record<Partition, readonly string[]>>;
  broker: BudgetBroker;
  proposerModelId: string;
  classifier: Classifier;
  cell: IsolationBackend;
  budget: TaskBudget;
}): Promise<{ receipt: ProposalReceipt; proposed?: { task: AgentTask; repo: Record<string, string>; checks: CheckRegistry } }> {
  const { field, broker } = args;
  const receipt = (stage: ProposalReceipt["stage"], reason: string): ProposalReceipt => ({
    fieldTaskId: field.taskId,
    source: args.source,
    family: field.family,
    code: field.code,
    language: field.language,
    stage,
    reason,
    usage: broker.usage(),
    promptVersion: PROPOSER_PROMPT_VERSION,
  });

  if (!args.partitions.development.includes(field.family)) {
    return { receipt: receipt("refused", `family ${field.family} is not a development family; the proposer never sees holdouts`) };
  }
  const got = await broker.complete({ model: args.proposerModelId, messages: proposerMessages(field) });
  if (!got.ok) return { receipt: receipt("model", got.reason) };
  const content = got.answer.choices?.[0]?.message?.content;
  const parsed = parseProposal(typeof content === "string" ? content : "");
  if (!parsed.ok) return { receipt: receipt("malformed", parsed.reason) };

  const verdict = await gate(
    { id: field.taskId, language: field.language, text: JSON.stringify(parsed.proposal) },
    args.classifier,
    args.proposerModelId,
  );
  const gated = admit(parsed.proposal, verdict);
  if (!gated) return { receipt: receipt("gate", verdict.reason) };

  const feasible = await checkFeasibility(gated, args.cell);
  if (!feasible.ok) return { receipt: receipt(feasible.kind, feasible.reason) };
  const proposed = materialize(
    gated,
    { source: args.source, family: field.family, fieldTaskId: field.taskId, language: field.language },
    args.budget,
  );
  return { receipt: receipt("accepted", "gate allowed, solution passes, start and every failure fail"), proposed };
}

/*
 * S1.10 (spec §4.2 step 5, §4.5): the learnability band and the novelty
 * archive. The current executor tries each accepted task k times on the
 * development side; the task is learnable when it passes 10%-90% of them.
 * The proposer's reward is its novelty when learnable, else 0: it never
 * contains the pass rate itself, so proposing easy tasks earns nothing, and
 * neither does proposing the same task twice (novelty 0).
 */

export const K_ATTEMPTS = 3;
export const BAND = { min: 0.1, max: 0.9 };
export type Band = "too_easy" | "learnable" | "too_hard";

export function bandOf(passes: number, attempts: number): Band {
  if (!Number.isInteger(attempts) || attempts < 1 || !Number.isInteger(passes) || passes < 0 || passes > attempts) {
    throw new Error(`bandOf: ${passes} passes of ${attempts} attempts`);
  }
  const rate = passes / attempts;
  return rate < BAND.min ? "too_hard" : rate > BAND.max ? "too_easy" : "learnable";
}

/** The pinned novelty embedder (spec §4.2 roles): never evolved, never the proposer. */
export interface Embedder {
  id: string;
  embed(text: string): Promise<number[]>;
}

/** One executor attempt, run and graded by the orchestrator (executor + evaluator). */
export type Attempt = (task: AgentTask) => Promise<{ passed: boolean; usd: number }>;

export interface ArchiveEntry {
  receipt: ProposalReceipt;
  /** Only for accepted tasks. */
  learnability?: { attempts: number; passes: number; band: Band; usd: number };
  /** 1 - cosine similarity to the nearest archived task, in [0, 1]; 0 when not accepted. */
  novelty: number;
  /** What the proposer is credited: novelty when learnable, else 0. */
  reward: number;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error("embeddings of different length: the embedder changed");
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Every proposal outcome, kept or not (spec §4.2 step 8). In memory; the
 *  frozen per-run archive of H21 comes with the manifest work. */
export class TaskArchive {
  readonly entries: ArchiveEntry[] = [];
  readonly #vectors: number[][] = [];

  constructor(
    readonly embedder: Embedder,
    readonly partitions: Readonly<Record<Partition, readonly string[]>>,
  ) {}

  async record(out: Awaited<ReturnType<typeof proposeTask>>, attempt: Attempt, k = K_ATTEMPTS): Promise<ArchiveEntry> {
    const { receipt, proposed } = out;
    if (!proposed) return this.#push({ receipt, novelty: 0, reward: 0 });
    // The band is a development measurement; a holdout task never reaches the executor here.
    if (!this.partitions.development.includes(receipt.family)) {
      throw new Error(`family ${receipt.family} is not a development family; the band is computed on development only`);
    }
    const v = await this.embedder.embed(`${proposed.task.instruction}\n${JSON.stringify(proposed.repo)}`);
    const nearest = this.#vectors.reduce((m, u) => Math.max(m, cosine(u, v)), 0);
    const novelty = Math.min(1, Math.max(0, 1 - nearest));
    this.#vectors.push(v);

    let passes = 0;
    let usd = 0;
    for (let i = 0; i < k; i++) {
      const r = await attempt(proposed.task);
      if (r.passed) passes++;
      usd += r.usd;
    }
    const band = bandOf(passes, k);
    return this.#push({ receipt, learnability: { attempts: k, passes, band, usd }, novelty, reward: band === "learnable" ? novelty : 0 });
  }

  #push(e: ArchiveEntry): ArchiveEntry {
    this.entries.push(e);
    return e;
  }
}
