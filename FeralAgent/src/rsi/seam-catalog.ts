/**
 * L4 Architecture Evolution — the seam catalog (spec §1, §12.1).
 *
 * A seam is a typed extension point with a builtin default. Seams are DATA:
 * every generic part of L4 (registry, manifest validation, module host,
 * watchdog, approval UX) is written against catalog rows, never against
 * named seams — adding seam #3 must cost exactly one row here plus one
 * adapter call site in runtime code (structural acceptance test in
 * rsi-module-registry.test.ts proves zero registry/validation changes).
 *
 * Seam creation is a governance act, not a module act: modules cannot mint
 * rows here (§12.1 — a module that can mint extension points can mint
 * itself an escape hatch).
 */

export interface SeamCatalogRow {
  /** Registry key, e.g. "retrieval_strategy". */
  seam: string;
  /** Version of the seam INTERFACE. Append-only within a major; a major
   *  bump auto-demotes stale modules to builtin at boot (§12.2). */
  seamApiVersion: number;
  /** Identifier of the permanent fallback implementation. */
  builtinId: string;
  /** Where the runtime consults the seam (documentation, not dispatch). */
  resolutionPoints: string[];
  /** JSON-schema-shaped description of the request/response. v1: carried
   *  for the approval card + future host validation; not enforced yet. */
  requestSchema: Record<string, unknown>;
  responseSchema: Record<string, unknown>;
}

/** The v1 catalog: exactly two seams (spec §1 — no more until graduated). */
export const SEAM_CATALOG: readonly SeamCatalogRow[] = [
  {
    seam: "retrieval_strategy",
    seamApiVersion: 1,
    builtinId: "builtin:retrieval_strategy",
    resolutionPoints: ["memory/fractal context assembly (GenomeConfig.retrievalStrategy pool)"],
    requestSchema: {
      type: "object",
      required: ["query", "k", "sessionId"],
      properties: { query: { type: "string" }, k: { type: "number" }, sessionId: { type: "string" } },
    },
    responseSchema: {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["text", "score", "sourceId"],
            properties: { text: { type: "string" }, score: { type: "number" }, sourceId: { type: "string" } },
          },
        },
      },
    },
  },
  {
    seam: "planner",
    seamApiVersion: 1,
    builtinId: "builtin:planner",
    resolutionPoints: ["core/agent-loop.ts task decomposition (decompositionDepth caps maxDepth)"],
    requestSchema: {
      type: "object",
      required: ["goal", "maxDepth", "toolNames"],
      properties: {
        goal: { type: "string" },
        maxDepth: { type: "number" },
        toolNames: { type: "array", items: { type: "string" } },
      },
    },
    responseSchema: {
      type: "object",
      required: ["steps"],
      properties: {
        steps: {
          type: "array",
          items: {
            type: "object",
            required: ["description", "suggestedTools"],
            properties: {
              description: { type: "string" },
              suggestedTools: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
  },
];

/** Look up a catalog row. Callers treat `undefined` as "unknown seam". */
export function catalogRow(
  seam: string,
  catalog: readonly SeamCatalogRow[] = SEAM_CATALOG,
): SeamCatalogRow | undefined {
  return catalog.find((r) => r.seam === seam);
}
