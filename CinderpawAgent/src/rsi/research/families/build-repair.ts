/**
 * S1.4 of the AgentLoop evolution spec (2026-10-04, §3.2, §17): family F1,
 * build repair, on disk. The four build/config templates of `fixtures.ts`
 * become real workspaces an executor edits with real tools, and each task
 * gets a composite check the evaluator runs in its own cell.
 *
 * RESEARCH ONLY (spec §4.7). Nothing here is wired into a live path.
 *
 * Rules this file holds:
 *
 *   1. Whole templates per partition (spec §26.3: one template per
 *      partition, so E0/E1 on F1 measure one failure type each, and the
 *      report says so). Frozen in `PLAN`.
 *   2. The verifier never enters the workspace. A check is a `bun -e` script
 *      carried in the check's argv, held by the evaluator's registry; the
 *      workspace holds only the broken repository.
 *   3. The check does not trust the workspace. It runs from `/tmp` (a fresh
 *      tmpfs in the evaluation cell), so a `bunfig.toml`, `.env` or
 *      `package.json` script the agent planted in its tree is never loaded;
 *      the workspace is only read as data.
 *   4. Three sub-checks per task: `builds` (the same static checker the S3
 *      fixtures used), `fixed` (the planted failure is repaired the honest
 *      way, not by deleting what used it), `intact` (every file the failure
 *      did not touch is byte-identical). A repair that games `builds` by
 *      gutting another file fails `intact`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256Canonical } from "../../infra/hash-chain.ts";
import type { Partition } from "../../infra/campaign.ts";
import { checkRepo, healthyRepo, REPAIRS, rngOf, TEMPLATES, type Repo, type Template } from "../../infra/fixtures.ts";
import type { Canary, CheckRegistry, LeafCheck } from "../agent-evaluator.ts";
import { TASK_FAMILY_SCHEMA, type AgentTask, type TaskBudget, type TaskFamily } from "../task-family.ts";

export const FAMILY_ID = "build-repair";

/** Frozen before the first run (spec Q4). */
export const PLAN: Readonly<Record<Partition, readonly Template[]>> = {
  development: ["missing-dep"],
  promotion: ["bad-env-name"],
  final: ["broken-import"],
  transfer: ["stale-engine"],
};

/** ponytail: one budget for the family (spec §26 H20). maxUsd 0 = stub model
 *  only; a paid campaign is a new family version carrying his written cap. */
export const BUDGET: TaskBudget = {
  maxInputTokens: 200_000,
  maxOutputTokens: 20_000,
  maxToolCalls: 40,
  maxWallMs: 10 * 60_000,
  maxUsd: 0,
};

const REFERENCE: Record<Template, string> = {
  "missing-dep": "add-missing-dep",
  "bad-env-name": "declare-env-keys",
  "broken-import": "fix-import-paths",
  "stale-engine": "bump-engine",
};

/** Where the evaluation cell puts the workspace (isolation.ts IMAGE_WORKDIR). */
const CELL_WORKSPACE = "/app/work";
const CHECK_MS = 30_000;

export type Probe =
  | { mode: "builds" }
  | { mode: "fixed"; template: Template; dep: string; env: string; mod: string }
  | { mode: "intact"; sha256: Record<string, string> };

/**
 * The check itself. Runs INSIDE the evaluation cell as a script made from its
 * source text, so it must stay self-contained: only `require`d built-ins and
 * `checkRepo`, whose source is prepended to the script. Never throws: any
 * surprise is a failed check.
 */
export function probe(p: Probe, root: string): boolean {
  const fs = require("node:fs") as typeof import("node:fs");
  const crypto = require("node:crypto") as typeof import("node:crypto");
  try {
    const repo: Record<string, string> = {};
    const walk = (rel: string) => {
      for (const e of fs.readdirSync(root + "/" + rel, { withFileTypes: true })) {
        const path = rel ? rel + "/" + e.name : e.name;
        if (e.isDirectory()) walk(path);
        else if (e.isFile()) repo[path] = fs.readFileSync(root + "/" + path, "utf8");
      }
    };
    walk("");
    if (p.mode === "builds") return checkRepo(repo).ok;
    if (p.mode === "intact") {
      return Object.entries(p.sha256).every(
        ([path, want]) => path in repo && crypto.createHash("sha256").update(repo[path]!).digest("hex") === want,
      );
    }
    const envKeys = (repo[".env.example"] ?? "").split("\n").map((l) => l.split("=")[0]!.trim());
    const pkg = repo["package.json"] ? JSON.parse(repo["package.json"]) : {};
    if (p.template === "missing-dep") return typeof pkg.dependencies?.[p.dep] === "string";
    if (p.template === "bad-env-name") return envKeys.includes(p.env);
    if (p.template === "broken-import") {
      const index = repo["src/index.ts"] ?? "";
      return index.includes(`from "./${p.mod}.ts"`) && /\brun\(\)/.test(index) && `src/${p.mod}.ts` in repo;
    }
    const node = pkg.engines?.node;
    return node === undefined || (typeof node === "string" && !/^<=?\s*1[0-6]\b/.test(node));
  } catch {
    return false;
  }
}

const SCRIPT = `${checkRepo.toString()}\nprocess.exit((${probe.toString()})(JSON.parse(process.argv[1]), process.argv[2]) ? 0 : 1);`;

/** The argv the evaluation cell runs: `cd /tmp` first (rule 3). The last
 *  three items are what a host test passes to `bun -e` directly. */
export function probeArgv(p: Probe): string[] {
  return ["sh", "-c", 'cd /tmp && exec bun -e "$0" "$1" "$2"', SCRIPT, JSON.stringify(p), CELL_WORKSPACE];
}

const sha256 = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");

export interface BuildRepairTask {
  task: AgentTask;
  /** The broken repository the executor starts from. */
  repo: Repo;
  /** The S3 reference repair applied: a known pass. */
  reference: Repo;
}

export interface BuildRepairSet {
  family: TaskFamily;
  tasks: BuildRepairTask[];
  checks: CheckRegistry;
}

function makeTask(template: Template, seed: number): { item: BuildRepairTask; checks: LeafCheck[] } {
  const { repo: healthy, dep, env, mod } = healthyRepo(rngOf(seed));
  const repo = TEMPLATES[template](healthy, { dep, env, mod });
  const reference = REPAIRS.find((r) => r.id === REFERENCE[template])!.apply(repo);
  const untouched = Object.fromEntries(
    Object.keys(healthy)
      .filter((p) => repo[p] === healthy[p])
      .map((p) => [p, sha256(healthy[p]!)]),
  );
  const id = `${FAMILY_ID}/${template}#${seed}`;
  const problems = checkRepo(repo).problems.map((p) => `- ${p}`).join("\n");
  const task: AgentTask = {
    id,
    familyId: FAMILY_ID,
    templateId: template,
    seed,
    instruction:
      `This TypeScript repository does not build. The build check reports:\n${problems}\n\n` +
      "Repair the repository so it builds. Change only what the failure needs; leave every other file as it is.",
    workspaceImage: sha256Canonical(repo),
    budget: BUDGET,
    verifier: { kind: "composite", checkId: id },
  };
  const leaf = (p: Probe): LeafCheck => ({ kind: "command", argv: probeArgv(p), timeoutMs: CHECK_MS });
  return {
    item: { task, repo, reference },
    checks: [leaf({ mode: "builds" }), leaf({ mode: "fixed", template, dep, env, mod }), leaf({ mode: "intact", sha256: untouched })],
  };
}

/** F1 at `perTemplate` tasks per template (12+ per partition, spec S1.4).
 *  Seeds that repeat a workspace already in the set are skipped, so no two
 *  tasks are the same repository. */
export function buildRepairSet(perTemplate = 12, seedBase = 1000): BuildRepairSet {
  const family: TaskFamily = {
    schemaVersion: TASK_FAMILY_SCHEMA,
    id: FAMILY_ID,
    version: "1",
    templates: Object.values(PLAN).flat(),
    partitions: PLAN,
    budget: BUDGET,
  };
  const tasks: BuildRepairTask[] = [];
  const checks: Record<string, CheckRegistry[string]> = {};
  const seen = new Set<string>();
  let seed = seedBase;
  for (const template of family.templates as Template[]) {
    for (let made = 0; made < perTemplate; seed++) {
      const { item, checks: leaves } = makeTask(template, seed);
      if (seen.has(item.task.workspaceImage)) continue;
      seen.add(item.task.workspaceImage);
      tasks.push(item);
      checks[item.task.id] = { kind: "composite", checks: leaves.map((check, i) => ({ id: ["builds", "fixed", "intact"][i]!, check })) };
      made++;
    }
  }
  return { family, tasks, checks };
}

/** Write a repository as files under `dir`. */
export function writeRepo(repo: Repo, dir: string): void {
  for (const [path, text] of Object.entries(repo)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/** The family's canary pair (spec §10): the first task broken (must fail)
 *  and with its reference repair (must pass), written under `dir`. */
export function canaries(set: BuildRepairSet, dir: string): Canary[] {
  const { task, repo, reference } = set.tasks[0]!;
  writeRepo(repo, join(dir, "fail"));
  writeRepo(reference, join(dir, "pass"));
  return [
    { name: `${FAMILY_ID} broken`, task, workspaceDir: join(dir, "fail"), expect: "fail" },
    { name: `${FAMILY_ID} reference`, task, workspaceDir: join(dir, "pass"), expect: "pass" },
  ];
}
