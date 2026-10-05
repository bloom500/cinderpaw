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
