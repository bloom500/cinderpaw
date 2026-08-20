/**
 * L4 seam runtime wiring (spec §1, §6) — B5's call-site half.
 *
 * The generic pieces (registry, adapter, host) are B1–B3; this module is
 * where the two v1 seams meet the LIVE runtime:
 *
 *   retrieval_strategy — the `recall` tool's search path (index.ts). The
 *     builtin maps `FractalMemory.query` hits into the seam's wire shape
 *     ({items: [{text, score, sourceId}]}) and back, so a promoted module
 *     sees the catalog schema while the tool keeps its historical shape.
 *
 *   planner — eval-suite decomposition (`invoke-agent.ts`), the ONE place
 *     the runtime decomposes a task today. The seam catalog's resolution
 *     point named an agent-loop decomposition that does not exist
 *     (verified 2026-07-09) — wiring goes where the behavior actually
 *     lives; the agent-loop gains the seam if/when it grows a planner.
 *
 * Singletons: one ModuleRegistry + one SeamAdapter per seam per process.
 * The adapter re-reads the registry on every invoke, so promotion /
 * demotion / quarantine take effect on the next request with no restart
 * (§6) — the singletons here are just process-level plumbing.
 */

import { SeamAdapter } from "./seam-adapter.ts";
import { ModuleRegistry } from "./module-registry.ts";

let registrySingleton: ModuleRegistry | null = null;

export function liveModuleRegistry(): ModuleRegistry {
  registrySingleton ??= new ModuleRegistry();
  return registrySingleton;
}

const adapters = new Map<string, SeamAdapter>();

/** Which builtin each seam's adapter was constructed with — see below. */
const boundBuiltins = new Map<string, (method: string, params: unknown) => Promise<unknown>>();

/** Fired on watchdog auto-quarantine (§8.2) — B6 wires the desktop toast. */
let quarantineHook: ((moduleId: string, reason: string) => void) | null = null;
export function onModuleQuarantine(hook: (moduleId: string, reason: string) => void): void {
  quarantineHook = hook;
}

/** The process-wide adapter for a seam. The builtin is bound on FIRST
 *  call for that seam; later calls reuse the existing adapter. */
export function liveSeamAdapter(
  seam: string,
  builtin: (method: string, params: unknown) => Promise<unknown>,
  log?: (msg: string) => void,
): SeamAdapter {
  let a = adapters.get(seam);
  if (!a) {
    a = new SeamAdapter({
      seam,
      registry: liveModuleRegistry(),
      builtin,
      ...(log ? { log } : {}),
      onQuarantine: (id, reason) => quarantineHook?.(id, reason),
    });
    boundBuiltins.set(seam, builtin);
    adapters.set(seam, a);
  } else if (boundBuiltins.get(seam) !== builtin) {
    // The builtin is bound once, on the first call. A later call passing a
    // DIFFERENT fallback silently got the old one back, so a refactor that
    // changed the builtin would have kept running the previous implementation
    // with nothing to show for it. Say so rather than quietly disagreeing.
    throw new Error(
      `liveSeamAdapter(${seam}): the builtin is bound on first use and cannot be ` +
        "replaced — call resetSeamRuntimeForTests() first, or keep one builtin per seam",
    );
  }
  return a;
}

/** Test hook: drop the singletons so a fresh registry dir takes effect. */
export function resetSeamRuntimeForTests(): void {
  boundBuiltins.clear();
  for (const a of adapters.values()) a.stopHost();
  adapters.clear();
  registrySingleton = null;
}

// ── retrieval_strategy: wire-shape mapping (catalog schema §1.1) ────────────

export interface RetrievalItem {
  text: string;
  score: number;
  sourceId: string;
}

export interface RecallHit {
  leafId: number;
  text: string;
}

/** FractalMemory.query hits → seam response. Rank-based score (1 → 1/n)
 *  because the builtin returns ranked hits without scores. */
export function hitsToItems(hits: readonly RecallHit[]): { items: RetrievalItem[] } {
  const n = Math.max(1, hits.length);
  return {
    items: hits.map((h, i) => ({
      text: h.text,
      score: (n - i) / n,
      sourceId: String(h.leafId),
    })),
  };
}

/** Seam response → the recall tool's historical hit shape. Malformed
 *  replies (a module in breach of the response schema) → empty, never a
 *  crash into the turn. Non-numeric sourceIds (module-minted) → leafId -1. */
export function itemsToHits(reply: unknown, limit: number): RecallHit[] {
  const items = (reply as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const out: RecallHit[] = [];
  for (const it of items.slice(0, limit)) {
    const o = it as { text?: unknown; sourceId?: unknown };
    if (typeof o.text !== "string") continue;
    const n = Number(o.sourceId);
    out.push({ leafId: Number.isFinite(n) ? n : -1, text: o.text });
  }
  return out;
}

// ── planner: builtin steps (catalog schema §1.2) ────────────────────────────

export interface PlanStep {
  description: string;
  suggestedTools: string[];
}

/**
 * The builtin planner does not plan: it returns the goal, once.
 *
 * It used to return `n` copies of the same goal under a `[Part k/N]` prefix,
 * which is not a decomposition — it is the same question asked `n` times, and
 * `invoke-agent` then joined the `n` answers into one string. Measured on the
 * VPS, that is exactly what every genome with `decompositionDepth > 0` was
 * graded on: `{"answer": 7} {"answer": 7} {"answer": 7} {"answer": 7}`. The
 * answer was right every time and the grader saw malformed JSON, so Tier 0
 * failed, the confidence gate rejected the candidate, and no genome could ever
 * be promoted — at three to four times the tokens for the privilege.
 *
 * Splitting a goal needs something that can actually split it. Until a planner
 * module is promoted into this seam, one call is the honest answer, and
 * `decompositionDepth` costs nothing rather than disqualifying its genome.
 */
export function builtinPlanSteps(goal: string): PlanStep[] {
  return [{ description: goal, suggestedTools: [] }];
}

/** Seam response → validated steps. A malformed module reply yields
 *  null (caller falls back to the builtin split). */
export function repliesToSteps(reply: unknown): PlanStep[] | null {
  const steps = (reply as { steps?: unknown })?.steps;
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const out: PlanStep[] = [];
  for (const s of steps) {
    const o = s as { description?: unknown; suggestedTools?: unknown };
    if (typeof o.description !== "string") return null;
    out.push({
      description: o.description,
      suggestedTools: Array.isArray(o.suggestedTools)
        ? o.suggestedTools.filter((t): t is string => typeof t === "string")
        : [],
    });
  }
  return out;
}
