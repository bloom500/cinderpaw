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
    adapters.set(seam, a);
  }
  return a;
}

/** Test hook: drop the singletons so a fresh registry dir takes effect. */
export function resetSeamRuntimeForTests(): void {
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

/** The builtin planner IS today's decomposition: n parts, `[Part k/N]`
 *  prefix, no tool suggestions — byte-identical to the historical
 *  behavior in invoke-agent.ts (AC10). */
export function builtinPlanSteps(goal: string, n: number): PlanStep[] {
  return Array.from({ length: n }, (_, k) => ({
    description: `[Part ${k + 1}/${n}]\n${goal}`,
    suggestedTools: [],
  }));
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
