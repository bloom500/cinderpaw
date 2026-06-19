/**
 * Faza 1 — runEval real: the production spec combiner.
 *
 * Assembles the full eval suite from three sources:
 *   1. Tier 0 — fetched from Rust over the bridge (`rsi_get_tier0_specs`),
 *      the frozen sanity bar. Rust's `Tier0Spec` has no `tier` field, so
 *      it is stamped `tier: 0` here.
 *   2. Tier 1/2 embedded defaults (`default-tier-specs.ts`).
 *   3. Operator-supplied JSON specs on disk (`loadTierSpecs`), which
 *      OVERRIDE an embedded default sharing the same id — letting a bad
 *      default be patched without a rebuild.
 *
 * Output is ordered by (tier, id) so a run is reproducible.
 */

import { TIER1_SPECS, TIER2_SPECS } from "./default-tier-specs.ts";
import type { EvalSpec, EvalExpected, EvalKind } from "./eval-spec.ts";

/** A Tier 0 spec as it arrives from Rust (shape of `tier0::Tier0Spec`). */
interface RustTier0Spec {
  id: string;
  name: string;
  description: string;
  prompt: string;
  kind: EvalKind;
  expected: EvalExpected;
}

export interface GetSpecsDeps {
  /** Fetch Tier 0 from Rust (bridge `rsi_get_tier0_specs` in production). */
  fetchTier0: () => Promise<RustTier0Spec[]>;
  /** Load operator-supplied Tier 1/2 specs from disk. Defaults to none. */
  loadDiskSpecs?: () => EvalSpec[];
}

/** Build the production `getSpecs` the suite runner calls each eval. */
export function makeGetSpecs(
  deps: GetSpecsDeps,
): () => Promise<EvalSpec[]> {
  const loadDiskSpecs = deps.loadDiskSpecs ?? (() => []);
  return async () => {
    const tier0: EvalSpec[] = (await deps.fetchTier0()).map((s) => ({
      ...s,
      tier: 0,
    }));

    // Embedded defaults, then disk specs override by id.
    const byId = new Map<string, EvalSpec>();
    for (const s of [...TIER1_SPECS, ...TIER2_SPECS]) byId.set(s.id, s);
    for (const s of loadDiskSpecs()) byId.set(s.id, s);

    return [...tier0, ...byId.values()].sort(
      (a, b) => a.tier - b.tier || a.id.localeCompare(b.id),
    );
  };
}
