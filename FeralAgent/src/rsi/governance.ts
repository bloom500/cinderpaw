/**
 * L5 Governance — policy schema + G0 loader (spec:
 * `docs/2026-07-04-l5-governance-evolution-spec.md` §1, §2.1, §9).
 *
 * This module owns governance-as-data: the bounds, gates, budgets and
 * approval requirements the other layers hardcode become one versioned
 * `GovernancePolicy` document. The loader mirrors the `clampMetaGenome`
 * discipline (`meta-evolution.ts`): unknown keys dropped, every numeric
 * clamped into its hardcoded G0 wall, missing fields defaulted to the
 * strictest built-in.
 *
 * Two doors, two postures:
 *   - `clampPolicy(raw)` never fails — it normalizes any input and
 *     reports what it had to clamp/default. It is the single door every
 *     policy document passes through before it can steer anything.
 *   - `loadPolicy(dir)` is strict (G-INV-3 fail-closed): the ACTIVE
 *     policy on disk was written by the lifecycle FSM, so a value
 *     outside its G0 wall means a hand edit or corruption — the file is
 *     quarantined (`policy.json.quarantine-<ts>`, §9 row 2) and the
 *     runtime boots on `builtinFailClosedPolicy()` with every evolution
 *     layer frozen until an operator intervenes.
 *
 * The hardcoded consts in `meta-evolution.ts` / `confidence.ts` remain
 * in code as the G0 outer walls; `effectiveGates` / `effectiveMetaBounds`
 * compose policy values on top with max()/min() so no document — however
 * loaded — can weaken them (G-INV-1, AC 1).
 */

import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_GATE_THRESHOLDS, type GateThresholds } from "./confidence.ts";
import {
  META_ACCEPT_MARGIN,
  META_BOUNDS,
  MIN_META_CYCLES,
  type MetaGenome,
} from "./meta-evolution.ts";
import { paths } from "./instance-paths.ts";

// ── Schema ─────────────────────────────────────────────────────────────────

export interface GovernanceApprovalRecord {
  approvedBy: string;
  at: number;
  note: string;
}

/** Per-layer freeze flags (G-INV-7). */
export interface FrozenFlags {
  l1: boolean;
  l2: boolean;
  l3: boolean;
  l4: boolean;
  l6: boolean;
}

export interface GovernanceMeta {
  /** Must be sub-intervals of the hardcoded META_BOUNDS. */
  bounds: Record<keyof MetaGenome, [number, number]>;
  /** ≥ hardcoded MIN_META_CYCLES. */
  minCycles: number;
  /** ≥ hardcoded META_ACCEPT_MARGIN. */
  acceptMargin: number;
}

/** Outer walls over episode-options.ts knobs. */
export interface GovernanceBudgets {
  episodeMaxIterations: number;
  episodeMaxTokens: number;
  episodeMaxCostUsd: number;
  episodeMaxWallClockMs: number;
}

/** Which layer actions REQUIRE a human (true = human required). */
export interface GovernanceApprovals {
  l3CodePatchApply: boolean;
  l2LoraPromote: boolean;
  /** Always true in v1 (L4 spec §6) — the loader forces it. */
  l4ModulePromote: boolean;
  l6Evolve: boolean;
}

export interface GovernancePolicy {
  version: 1;
  policyId: string;
  parentId: string | null;
  createdAt: number;
  activatedAt: number;
  /** Hash of the parent policy row in history; null for genesis/builtin. */
  prevHash: string | null;
  /** null = auto-adopted (tightening); else the human approval record. */
  approval: GovernanceApprovalRecord | null;
  frozen: FrozenFlags;
  gates: GateThresholds;
  meta: GovernanceMeta;
  budgets: GovernanceBudgets;
  approvals: GovernanceApprovals;
}

// ── G0 walls (Tier G0 — immutable, hardcoded) ──────────────────────────────

/** Budget ceilings a policy may not exceed. These are sanity walls
 *  (roughly 10–25× the shipped defaults below), not tuning targets —
 *  their only job is keeping a hostile/corrupt policy from uncapping
 *  dream episodes. Tightening happens in the policy, not here. */
export const G0_BUDGET_MAX: GovernanceBudgets = {
  episodeMaxIterations: 1000,
  episodeMaxTokens: 20_000_000,
  episodeMaxCostUsd: 100,
  episodeMaxWallClockMs: 7_200_000,
};

/** Shipped budget defaults (spec §2.1 example document). */
const BUILTIN_BUDGETS: GovernanceBudgets = {
  episodeMaxIterations: 100,
  episodeMaxTokens: 2_000_000,
  episodeMaxCostUsd: 0,
  episodeMaxWallClockMs: 480_000,
};

/** The fail-closed policy (G-INV-3): strictest built-in defaults, every
 *  evolution layer frozen. Used whenever no valid policy can be loaded. */
export function builtinFailClosedPolicy(now: number = Date.now()): GovernancePolicy {
  return {
    version: 1,
    policyId: "gp-builtin",
    parentId: null,
    createdAt: now,
    activatedAt: now,
    prevHash: null,
    approval: null,
    frozen: { l1: true, l2: true, l3: true, l4: true, l6: true },
    gates: { ...DEFAULT_GATE_THRESHOLDS },
    meta: {
      bounds: structuredClone(META_BOUNDS),
      minCycles: MIN_META_CYCLES,
      acceptMargin: META_ACCEPT_MARGIN,
    },
    budgets: { ...BUILTIN_BUDGETS },
    approvals: {
      l3CodePatchApply: true,
      l2LoraPromote: true,
      l4ModulePromote: true,
      l6Evolve: true,
    },
  };
}

// ── Clamp (the single door) ────────────────────────────────────────────────

export interface ClampResult {
  policy: GovernancePolicy;
  /** Field paths whose value was OUTSIDE its G0 wall (a G0 violation —
   *  visible, and fatal for `loadPolicy`). */
  clamped: string[];
  /** Field paths that were missing/invalid and fell back to the
   *  strictest built-in (schema drift — tolerated at load). */
  defaulted: string[];
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Normalize any input into a G0-conformant policy. Never throws.
 *  Unknown keys dropped (the output is rebuilt field by field), numerics
 *  clamped into their walls, missing/invalid fields → strictest default. */
export function clampPolicy(raw: unknown): ClampResult {
  const src = obj(raw) ?? {};
  const clamped: string[] = [];
  const defaulted: string[] = [];

  // A numeric field with a wall: missing/non-finite → strictest default
  // (defaulted); finite but out of wall → wall value (clamped).
  const bounded = (
    path: string,
    v: unknown,
    dflt: number,
    lo: number,
    hi: number,
  ): number => {
    const n = num(v);
    if (n === null) {
      defaulted.push(path);
      return dflt;
    }
    if (n < lo || n > hi) {
      clamped.push(path);
      return Math.min(hi, Math.max(lo, n));
    }
    return n;
  };

  const bool = (path: string, v: unknown, dflt: boolean): boolean => {
    if (typeof v === "boolean") return v;
    defaulted.push(path);
    return dflt;
  };

  const gatesSrc = obj(src.gates) ?? (defaulted.push("gates"), {});
  const gates: GateThresholds = {
    pValueMax: bounded("gates.pValueMax", gatesSrc.pValueMax, DEFAULT_GATE_THRESHOLDS.pValueMax, 0, DEFAULT_GATE_THRESHOLDS.pValueMax),
    effectSizeMin: bounded("gates.effectSizeMin", gatesSrc.effectSizeMin, DEFAULT_GATE_THRESHOLDS.effectSizeMin, DEFAULT_GATE_THRESHOLDS.effectSizeMin, Number.MAX_VALUE),
    confidenceMin: bounded("gates.confidenceMin", gatesSrc.confidenceMin, DEFAULT_GATE_THRESHOLDS.confidenceMin, DEFAULT_GATE_THRESHOLDS.confidenceMin, 1),
  };

  const metaSrc = obj(src.meta) ?? (defaulted.push("meta"), {});
  const boundsSrc = obj(metaSrc.bounds) ?? {};
  const bounds = {} as Record<keyof MetaGenome, [number, number]>;
  for (const key of Object.keys(META_BOUNDS) as (keyof MetaGenome)[]) {
    const wall = META_BOUNDS[key];
    const v = boundsSrc[key];
    const lo = Array.isArray(v) ? num(v[0]) : null;
    const hi = Array.isArray(v) ? num(v[1]) : null;
    if (lo === null || hi === null || lo > hi) {
      defaulted.push(`meta.bounds.${key}`);
      bounds[key] = [wall[0], wall[1]];
      continue;
    }
    const clo = Math.max(lo, wall[0]);
    const chi = Math.min(hi, wall[1]);
    if (clo !== lo || chi !== hi || clo > chi) {
      clamped.push(`meta.bounds.${key}`);
      bounds[key] = clo > chi ? [wall[0], wall[1]] : [clo, chi];
    } else {
      bounds[key] = [lo, hi];
    }
  }
  const meta: GovernanceMeta = {
    bounds,
    minCycles: Math.round(bounded("meta.minCycles", metaSrc.minCycles, MIN_META_CYCLES, MIN_META_CYCLES, 10_000)),
    acceptMargin: bounded("meta.acceptMargin", metaSrc.acceptMargin, META_ACCEPT_MARGIN, META_ACCEPT_MARGIN, 1),
  };

  const budSrc = obj(src.budgets) ?? (defaulted.push("budgets"), {});
  const budgets: GovernanceBudgets = {
    episodeMaxIterations: bounded("budgets.episodeMaxIterations", budSrc.episodeMaxIterations, BUILTIN_BUDGETS.episodeMaxIterations, 0, G0_BUDGET_MAX.episodeMaxIterations),
    episodeMaxTokens: bounded("budgets.episodeMaxTokens", budSrc.episodeMaxTokens, BUILTIN_BUDGETS.episodeMaxTokens, 0, G0_BUDGET_MAX.episodeMaxTokens),
    episodeMaxCostUsd: bounded("budgets.episodeMaxCostUsd", budSrc.episodeMaxCostUsd, BUILTIN_BUDGETS.episodeMaxCostUsd, 0, G0_BUDGET_MAX.episodeMaxCostUsd),
    episodeMaxWallClockMs: bounded("budgets.episodeMaxWallClockMs", budSrc.episodeMaxWallClockMs, BUILTIN_BUDGETS.episodeMaxWallClockMs, 0, G0_BUDGET_MAX.episodeMaxWallClockMs),
  };

  const apprSrc = obj(src.approvals) ?? (defaulted.push("approvals"), {});
  const approvals: GovernanceApprovals = {
    l3CodePatchApply: bool("approvals.l3CodePatchApply", apprSrc.l3CodePatchApply, true),
    l2LoraPromote: bool("approvals.l2LoraPromote", apprSrc.l2LoraPromote, true),
    // Always-true in v1 (L4 spec §6). A false here is dropped silently-
    // visibly: not a wall breach, just non-negotiable.
    l4ModulePromote: true,
    l6Evolve: bool("approvals.l6Evolve", apprSrc.l6Evolve, true),
  };

  const frozenSrc = obj(src.frozen) ?? (defaulted.push("frozen"), {});
  const frozen: FrozenFlags = {
    l1: bool("frozen.l1", frozenSrc.l1, true),
    l2: bool("frozen.l2", frozenSrc.l2, true),
    l3: bool("frozen.l3", frozenSrc.l3, true),
    l4: bool("frozen.l4", frozenSrc.l4, true),
    l6: bool("frozen.l6", frozenSrc.l6, true),
  };

  const approvalSrc = obj(src.approval);
  const approval: GovernanceApprovalRecord | null =
    approvalSrc && typeof approvalSrc.approvedBy === "string"
      ? {
          approvedBy: approvalSrc.approvedBy,
          at: num(approvalSrc.at) ?? 0,
          note: typeof approvalSrc.note === "string" ? approvalSrc.note : "",
        }
      : null;

  const policy: GovernancePolicy = {
    version: 1,
    policyId: typeof src.policyId === "string" && src.policyId.length > 0 ? src.policyId : "gp-builtin",
    parentId: typeof src.parentId === "string" ? src.parentId : null,
    createdAt: num(src.createdAt) ?? 0,
    activatedAt: num(src.activatedAt) ?? 0,
    prevHash: typeof src.prevHash === "string" ? src.prevHash : null,
    approval,
    frozen,
    gates,
    meta,
    budgets,
    approvals,
  };
  return { policy, clamped, defaulted };
}

// ── Effective composition (G-INV-1 belt-and-suspenders, spec §7) ───────────

/** Policy gates composed with the hardcoded floor — the values consumers
 *  actually use. `max()`/`min()` so no input can weaken the floor. */
export function effectiveGates(p: GovernancePolicy): GateThresholds {
  return {
    pValueMax: Math.min(p.gates.pValueMax, DEFAULT_GATE_THRESHOLDS.pValueMax),
    effectSizeMin: Math.max(p.gates.effectSizeMin, DEFAULT_GATE_THRESHOLDS.effectSizeMin),
    confidenceMin: Math.max(p.gates.confidenceMin, DEFAULT_GATE_THRESHOLDS.confidenceMin),
  };
}

/** Policy meta bounds intersected with the hardcoded META_BOUNDS wall.
 *  A degenerate intersection falls back to the wall. */
export function effectiveMetaBounds(
  p: GovernancePolicy,
): Record<keyof MetaGenome, [number, number]> {
  const out = {} as Record<keyof MetaGenome, [number, number]>;
  for (const key of Object.keys(META_BOUNDS) as (keyof MetaGenome)[]) {
    const wall = META_BOUNDS[key];
    const b = p.meta.bounds[key] ?? wall;
    const lo = Math.max(b[0], wall[0]);
    const hi = Math.min(b[1], wall[1]);
    out[key] = lo <= hi ? [lo, hi] : [wall[0], wall[1]];
  }
  return out;
}

// ── Loader (G-INV-3 fail-closed) ───────────────────────────────────────────

export type PolicyLoad =
  | { source: "file"; policy: GovernancePolicy; defaulted: string[] }
  | {
      source: "builtin";
      policy: GovernancePolicy;
      reason: string;
      /** Where the corrupt file was preserved for forensics; null when
       *  there was nothing to quarantine (missing file / rename failed). */
      quarantinedTo: string | null;
    };

export function defaultGovernanceDir(): string {
  return paths().governance;
}

/** Load the active policy from `<dir>/policy.json`. Structurally invalid
 *  or G0-violating documents are quarantined and the runtime fails closed
 *  onto `builtinFailClosedPolicy()` (§9 rows 1–2). */
export function loadPolicy(dir: string = defaultGovernanceDir()): PolicyLoad {
  const policyPath = join(dir, "policy.json");
  if (!existsSync(policyPath)) {
    return {
      source: "builtin",
      policy: builtinFailClosedPolicy(),
      reason: "policy.json missing",
      quarantinedTo: null,
    };
  }

  const failClosed = (reason: string): PolicyLoad => ({
    source: "builtin",
    policy: builtinFailClosedPolicy(),
    reason,
    quarantinedTo: quarantine(policyPath),
  });

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(policyPath, "utf8"));
  } catch (err) {
    return failClosed(`policy.json unparseable: ${String(err)}`);
  }

  const doc = obj(raw);
  if (!doc) return failClosed("policy.json is not a JSON object");
  if (doc.version !== 1) return failClosed(`unsupported policy version: ${String(doc.version)}`);
  if (typeof doc.policyId !== "string" || doc.policyId.length === 0) {
    return failClosed("policy.json has no policyId");
  }

  const { policy, clamped, defaulted } = clampPolicy(doc);
  if (clamped.length > 0) {
    // The lifecycle FSM never writes out-of-wall values — this is a hand
    // edit or corruption, not schema drift. Quarantine, fail closed.
    return failClosed(`G0 violation in active policy: ${clamped.join(", ")}`);
  }
  return { source: "file", policy, defaulted };
}

/** Move a corrupt policy aside as `policy.json.quarantine-<ts>` (§9).
 *  Returns the quarantine path, or null if the move itself failed —
 *  the caller fails closed either way. */
function quarantine(policyPath: string): string | null {
  const dest = `${policyPath}.quarantine-${Date.now()}`;
  try {
    renameSync(policyPath, dest);
    return dest;
  } catch {
    return null;
  }
}
