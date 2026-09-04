/**
 * Faza 2 Slice 5 — the approval gate: pending code patches + live apply.
 * Spec: `docs/superpowers/specs/2026-07-01-faza2-code-rsi-design.md` §2.5/§3.
 *
 * A code candidate that wins the ratchet is NOT applied to the live
 * source. It lands here, as a pending patch, and crosses into the real
 * tree only through `applyPatchLive` — which demands:
 *
 *   1. an explicit approval recorded in this store. The first
 *      `APPROVALS_BEFORE_AUTO` (10) applied patches REQUIRE a human
 *      click (spec §2.5); after that the host may auto-approve, and
 *      `requiresManualApproval()` tells it when that unlocks.
 *   2. a fresh TS-wall re-check at apply time (parse + policy) — the
 *      patch was validated at proposal, at commit (Rust), and again
 *      here; a wall change between promotion and apply still bites.
 *
 * Even then, "live" means the SOURCE tree: the running sidecar is a
 * compiled binary, so an applied patch becomes the running agent at the
 * next rebuild + restart — the running process never mutates itself
 * (trust boundary §2.3). `revertPatchLive` is the rollback half:
 * `git apply -R` of the exact same patch text.
 *
 * The store is a small versioned JSON file (journal discipline: corrupt
 * or wrong-version → start empty, never throw on load).
 *
 * This file is on BOTH patch denylists — it IS the gate.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "../../atomic-write.ts";
import { dirname, join } from "node:path";
import {
  isDiffParseError,
  parseUnifiedDiff,
  validateCodePatch,
  type CodeGenome,
} from "./code-genome.ts";
import { bunExec, type ExecFn } from "./code-sandbox.ts";
import { paths } from "../infra/instance-paths.ts";

/** Applied patches needed before the host may stop asking (spec §2.5). */
export const APPROVALS_BEFORE_AUTO = 10;

export type PatchStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "applied"
  | "apply_failed"
  | "reverted";

export interface PendingPatch {
  /** The candidate's genome id. */
  id: string;
  genome: CodeGenome;
  /** The Rust composite score it won the ratchet with. */
  score: number;
  /** Its substrate commit (the receipt). */
  commitHash: string;
  status: PatchStatus;
  createdAt: number;
  resolvedAt?: number;
  appliedAt?: number;
  /** Failure detail for `apply_failed`. */
  note?: string;
}

/** Default on-disk location, next to the journal. */
export function defaultPendingPatchesPath(): string {
  return join(paths().root, "pending-patches.json");
}

interface Envelope {
  version: 1;
  patches: PendingPatch[];
}

export class PendingPatchStore {
  #patches: PendingPatch[] = [];

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Envelope;
      if (parsed?.version === 1 && Array.isArray(parsed.patches)) {
        this.#patches = parsed.patches;
      }
    } catch {
      // Missing / corrupt / wrong version → start empty. The substrate
      // commits are the durable record; this queue is resolvable state.
    }
  }

  #save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const envelope: Envelope = { version: 1, patches: this.#patches };
    // Atomic: the Rust watchdog reads this same file to find the text of a
    // patch it needs to revert. A crash mid-write leaves JSON nobody can parse,
    // and then a patch that has already been applied to the live source tree
    // cannot be undone — the safety net for code-RSI is gone exactly when
    // something has gone wrong.
    atomicWriteFileSync(this.file, JSON.stringify(envelope, null, 2));
  }

  /** Register a ratchet-winning candidate as pending. Idempotent per id
   *  (a re-run of the same candidate does not duplicate the queue). */
  add(args: { id: string; genome: CodeGenome; score: number; commitHash: string }): PendingPatch {
    const existing = this.get(args.id);
    if (existing) return existing;
    const p: PendingPatch = {
      id: args.id,
      genome: args.genome,
      score: args.score,
      commitHash: args.commitHash,
      status: "pending",
      createdAt: Date.now(),
    };
    this.#patches.push(p);
    this.#save();
    return p;
  }

  list(): PendingPatch[] {
    return structuredClone(this.#patches);
  }

  get(id: string): PendingPatch | undefined {
    const p = this.#patches.find((x) => x.id === id);
    return p ? structuredClone(p) : undefined;
  }

  /** pending → approved/rejected. Anything else is a caller bug. */
  resolve(id: string, action: "approve" | "reject"): PendingPatch {
    const p = this.#require(id);
    if (p.status !== "pending") {
      throw new Error(`patch '${id}' is ${p.status}, not pending`);
    }
    p.status = action === "approve" ? "approved" : "rejected";
    p.resolvedAt = Date.now();
    this.#save();
    return structuredClone(p);
  }

  /** True while the first-10 window is open — every apply needs a human. */
  requiresManualApproval(): boolean {
    return this.appliedCount() < APPROVALS_BEFORE_AUTO;
  }

  /** Patches that actually reached the live tree (reverted ones counted:
   *  the human saw and approved them, which is what the window measures). */
  appliedCount(): number {
    return this.#patches.filter(
      (p) => p.status === "applied" || p.status === "reverted",
    ).length;
  }

  markApplied(id: string): void {
    const p = this.#require(id);
    p.status = "applied";
    p.appliedAt = Date.now();
    this.#save();
  }

  markApplyFailed(id: string, note: string): void {
    const p = this.#require(id);
    p.status = "apply_failed";
    p.note = note;
    this.#save();
  }

  markReverted(id: string): void {
    const p = this.#require(id);
    if (p.status !== "applied") {
      throw new Error(`patch '${id}' is ${p.status}, not applied — nothing to revert`);
    }
    p.status = "reverted";
    this.#save();
  }

  #require(id: string): PendingPatch {
    const p = this.#patches.find((x) => x.id === id);
    if (!p) throw new Error(`unknown patch '${id}'`);
    return p;
  }
}

export interface LiveApplyArgs {
  store: PendingPatchStore;
  id: string;
  /** Root of the real source repo. Live apply is a dev-mode operation —
   *  without a repo there is nothing to apply to. */
  repoRoot: string;
  /** Package dir the diff paths are relative to. Default "CinderpawAgent". */
  packageSubdir?: string;
  exec?: ExecFn;
}

export type LiveApplyResult = { ok: true } | { ok: false; reason: string };

/** Apply an APPROVED patch to the live source tree. See module docblock
 *  for what "live" means. Soft-fails into the store, never throws for
 *  patch-caused errors. */
export async function applyPatchLive(args: LiveApplyArgs): Promise<LiveApplyResult> {
  const { store, id } = args;
  const p = store.get(id);
  if (!p) return { ok: false, reason: `unknown patch '${id}'` };
  // INVARIANT I14: human approval gate for L3+ changes. Winning the ratchet
  // does not apply a patch; only a recorded approval does. This refusal IS the
  // gate — scripts/check-invariant-coverage.ts matches the id above, and
  // without it a fully-enforced invariant reported as unenforced.
  if (p.status !== "approved") {
    return { ok: false, reason: `patch '${id}' is ${p.status}, not approved` };
  }

  // Apply-time wall re-check (see module docblock, rule 2).
  const parsed = parseUnifiedDiff(p.genome.patch);
  if (isDiffParseError(parsed)) {
    store.markApplyFailed(id, `parse: ${parsed.error}`);
    return { ok: false, reason: `parse: ${parsed.error}` };
  }
  const wall = validateCodePatch(parsed);
  if (!wall.ok) {
    store.markApplyFailed(id, wall.reason);
    return { ok: false, reason: wall.reason };
  }

  const r = await gitApply(args, p.genome.patch, []);
  if (!r.ok) {
    store.markApplyFailed(id, r.reason);
    return r;
  }
  store.markApplied(id);
  return { ok: true };
}

/** Rollback: reverse-apply an APPLIED patch (`git apply -R`). */
export async function revertPatchLive(args: LiveApplyArgs): Promise<LiveApplyResult> {
  const { store, id } = args;
  const p = store.get(id);
  if (!p) return { ok: false, reason: `unknown patch '${id}'` };
  if (p.status !== "applied") {
    return { ok: false, reason: `patch '${id}' is ${p.status}, not applied` };
  }
  const r = await gitApply(args, p.genome.patch, ["-R"]);
  if (!r.ok) return r;
  store.markReverted(id);
  return { ok: true };
}

/** `git apply --check` then the real apply, from the repo root with
 *  `--directory` (NEVER from a subdir — git silently no-ops there, the
 *  Slice 2 lesson). */
async function gitApply(
  args: LiveApplyArgs,
  patch: string,
  extra: string[],
): Promise<LiveApplyResult> {
  const exec = args.exec ?? bunExec;
  const base = [
    "git",
    "apply",
    `--directory=${args.packageSubdir ?? "CinderpawAgent"}`,
    "--whitespace=nowarn",
    ...extra,
  ];
  const opts = { cwd: args.repoRoot, timeoutMs: 30_000, stdin: patch };
  const check = await exec([...base, "--check"], opts);
  if (check.exitCode !== 0) {
    return { ok: false, reason: check.stderr.split("\n", 1)[0]?.trim() || "git apply --check failed" };
  }
  const applied = await exec(base, opts);
  if (applied.exitCode !== 0) {
    return { ok: false, reason: applied.stderr.split("\n", 1)[0]?.trim() || "git apply failed" };
  }
  return { ok: true };
}
