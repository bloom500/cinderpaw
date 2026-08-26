/**
 * The receipt a run has to produce before its numbers mean anything.
 *
 * A score with no manifest is a rumour. Cinderpaw's own benchmark notes
 * anchor on published figures from other systems, and the only thing that
 * separates "we measured X" from "someone typed X" is whether a reader can
 * rebuild the conditions. Today nothing in this repo records what a run
 * actually ran with: not the commit, not the models, not the seed, not the
 * budgets, and not the machine-level environment. One documented example of
 * why that matters lives in OPUS_CHECKPOINT_20260824.md - a
 * `setx FERAL_EMBED_GPU_LAYERS 0` applied outside git that changed how
 * embeddings behaved on the dev box and appears in no commit anywhere.
 *
 * So: INVARIANT G. A harness writes a manifest beside its results, or it
 * does not get to claim it measured anything.
 *
 * Three pieces, deliberately separate:
 *   - createRunManifest() gathers and records the TRUTH, always. It never
 *     refuses, because a manifest describing a dirty tree is exactly the
 *     evidence you want when the number looks wrong later.
 *   - assertReportable() is the POLICY. It throws when the recorded truth
 *     cannot support a published claim, and it reports every reason at
 *     once rather than one per run.
 *   - writeRunManifest() puts it on disk next to the results.
 *
 * Secrets: environment capture is driven by CONFIG_SCHEMA, so it tracks the
 * documented surface automatically instead of drifting behind a hand-kept
 * list. Anything whose NAME looks like a credential is recorded as set or
 * unset and never by value - a manifest is meant to be published alongside
 * a scorecard, which makes it exactly the wrong place to learn an API key.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CONFIG_SCHEMA } from "../config.ts";
import { assertValidRunId } from "./run-id.ts";

export const MANIFEST_VERSION = 1 as const;
export const MANIFEST_FILENAME = "run-manifest.json";

/** Recorded in place of any value whose name looks like a credential. */
export const REDACTED = "<redacted:set>";
export const REDACTED_UNSET = "<redacted:unset>";

/**
 * Name-shaped secret detection. Deliberately independent of CONFIG_SCHEMA's
 * `security` flag: that flag marks "security-relevant", which includes
 * things like FERAL_WORKSPACE whose VALUE is reproducibility information we
 * want to keep. This pattern targets the narrower "this is a credential".
 */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_PAT$|AUTH)/i;

export interface RunManifest {
  manifestVersion: typeof MANIFEST_VERSION;
  runId: string;
  createdAt: string;
  harness: { name: string; version: string };
  /** Null fields mean "could not determine", never "fine". */
  code: { commit: string | null; branch: string | null; dirty: boolean | null };
  runtime: { platform: string; arch: string; runtime: string; runtimeVersion: string };
  /** Every model the run used, by role. An oracle or fixed policy counts. */
  models: Record<string, string>;
  seed: number | null;
  budgets: Record<string, number>;
  /** Tool names the run was allowed to call. Empty array = none, not unknown. */
  tools: string[];
  config: { hash: string; env: Record<string, string> };
  /** Free-form caveats the harness wants travelling with the numbers. */
  notes: string[];
}

export interface CreateRunManifestInput {
  runId: string;
  harness: { name: string; version: string };
  models?: Record<string, string>;
  seed?: number | null;
  budgets?: Record<string, number>;
  tools?: string[];
  /** Hashed canonically into config.hash. Any shape. */
  config?: unknown;
  notes?: string[];
  /** Repo root for the git probe. Default: process.cwd(). */
  repoRoot?: string;
  /** Injectable for tests. */
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

/** Stable stringify so the same config always hashes the same. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function hashConfig(config: unknown): string {
  return createHash("sha256").update(canonical(config)).digest("hex").slice(0, 32);
}

/**
 * Git facts, or nulls. Never throws: a fresh clone with no git installed,
 * a tarball download, or a CI checkout with no history all have to produce
 * a manifest — one that honestly says the code could not be identified.
 */
export function probeGit(repoRoot: string): RunManifest["code"] {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      }).trim();
    } catch {
      return null;
    }
  };
  const commit = git(["rev-parse", "HEAD"]);
  if (commit === null) return { commit: null, branch: null, dirty: null };
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = git(["status", "--porcelain"]);
  return {
    commit,
    branch: branch === "HEAD" ? null : branch,
    // A failed status probe is `null`, not `false`. "We could not check" and
    // "we checked and it is clean" must not collapse into the same word.
    dirty: status === null ? null : status.length > 0,
  };
}

/**
 * Capture the documented config surface. Only CONFIG_SCHEMA names are read,
 * so an unrelated secret sitting in the process environment is never swept
 * up by accident.
 */
export function captureEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of CONFIG_SCHEMA) {
    const raw = env[entry.name];
    if (SECRET_NAME.test(entry.name)) {
      // Whether a credential is present changes behaviour, so record that
      // much — never the value itself.
      out[entry.name] = raw === undefined || raw === "" ? REDACTED_UNSET : REDACTED;
      continue;
    }
    if (raw !== undefined) out[entry.name] = raw;
  }
  return out;
}

export function createRunManifest(input: CreateRunManifestInput): RunManifest {
  assertValidRunId(input?.runId);
  if (!input.harness || typeof input.harness.name !== "string" || !input.harness.name.trim()) {
    throw new Error("createRunManifest: harness.name is required — a result must say what produced it");
  }
  if (typeof input.harness.version !== "string" || !input.harness.version.trim()) {
    throw new Error("createRunManifest: harness.version is required");
  }
  const env = input.env ?? process.env;
  return {
    manifestVersion: MANIFEST_VERSION,
    runId: input.runId,
    createdAt: (input.now ?? new Date()).toISOString(),
    harness: { name: input.harness.name, version: input.harness.version },
    code: probeGit(input.repoRoot ?? process.cwd()),
    runtime: {
      platform: process.platform,
      arch: process.arch,
      runtime: typeof Bun === "undefined" ? "node" : "bun",
      runtimeVersion:
        typeof Bun === "undefined" ? process.version : `${Bun.version} (node ${process.version})`,
    },
    models: { ...(input.models ?? {}) },
    seed: input.seed ?? null,
    budgets: { ...(input.budgets ?? {}) },
    tools: [...(input.tools ?? [])],
    config: { hash: hashConfig(input.config ?? null), env: captureEnv(env) },
    notes: [...(input.notes ?? [])],
  };
}

/**
 * Every reason this run's numbers cannot be published, in one throw.
 *
 * Reported together on purpose: finding out about a dirty tree, then
 * re-running for twenty minutes to find out the seed was missing too, is
 * how a gate gets switched off.
 */
export function reportabilityProblems(manifest: RunManifest): string[] {
  const problems: string[] = [];
  if (manifest.code.commit === null) {
    problems.push("the code commit could not be determined (no git, or not a repository)");
  }
  if (manifest.code.dirty === null) {
    problems.push("whether the working tree was clean could not be determined");
  } else if (manifest.code.dirty) {
    problems.push("the working tree had uncommitted changes, so the code cannot be recovered from the commit alone");
  }
  if (Object.keys(manifest.models).length === 0) {
    problems.push('no model recorded (a fixed or oracle policy still counts — record it, e.g. { policy: "oracle-bfs" })');
  }
  if (manifest.seed === null) {
    problems.push("no seed recorded, so the run cannot be repeated");
  }
  return problems;
}

export function assertReportable(manifest: RunManifest): void {
  const problems = reportabilityProblems(manifest);
  if (problems.length > 0) {
    throw new Error(
      `run ${manifest.runId} is not reportable:\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        "\nThe manifest was still written; fix these before quoting the numbers.",
    );
  }
}

/** Write the manifest beside a run's results. Returns the path written. */
export function writeRunManifest(manifest: RunManifest, outDir: string): string {
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, MANIFEST_FILENAME);
  fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return target;
}
