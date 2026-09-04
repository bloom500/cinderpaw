/**
 * L4 module proposer — the GENERATIVE half of architecture evolution.
 *
 * Until now the L4 lifecycle (propose→sandbox→build→eval→approval→
 * promote) only ever judged modules a human dropped into the modules
 * dir. This operator closes that gap: the LOCAL model reads one seam's
 * contract from the catalog and authors a candidate implementation. The
 * proposal is a suggestion, never an action — everything it emits must
 * still clear the lexical wall here, then the full lifecycle (wall
 * again, sandbox, build, paired eval, contract FSM, human approval)
 * before a seam ever points at it.
 *
 * Trust notes (mirrors l3-code/code-proposer.ts):
 *   - `completeLocal` MUST be wired to local inference only.
 *   - The wall runs HERE before anything is written to disk — a
 *     candidate that mentions `process` never becomes a module dir.
 *   - proposedBy: "dream" marks the provenance on the manifest.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SEAM_CATALOG, type SeamCatalogRow } from "./seam-catalog.ts";
import { wallCheck } from "./module-wall.ts";
import type { ModuleManifest } from "./module-registry.ts";

/** Seam → the method name the seam adapter invokes. The catalog carries
 *  schemas, not method names (they live in the adapters); this map must
 *  stay in sync with seam-runtime.ts's invoke() call sites. */
const SEAM_METHOD: Record<string, string> = {
  retrieval_strategy: "retrieve",
  planner: "plan",
};

export interface ModuleProposerDeps {
  /** LOCAL-ONLY completion. Returns raw model text. */
  completeLocal: (args: { system: string; user: string; maxTokens: number }) => Promise<string>;
  /** Where module dirs are created (production: defaultModulesDir()). */
  modulesDir: string;
  /** Runtime version stamped into manifest.compat (must satisfy the
   *  registry's compat check). */
  runtimeVersion: string;
  /** Target seam. Default: random catalog row. */
  seam?: string;
  /** Injectable for deterministic tests. Default Math.random. */
  rng?: () => number;
  /** Completion budget. Default 4096. */
  maxTokens?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface ProposedModule {
  moduleId: string;
  dir: string;
  seam: string;
  rationale: string;
}

const SYSTEM_PROMPT = `You are the architecture-evolution operator of a bounded self-improving agent.
You write ONE small TypeScript module implementing ONE extension-point (seam).

Hard rules (violations are auto-rejected by a compiled lexical wall):
- Single file. The ONLY allowed import is "node:assert" (you rarely need it).
- FORBIDDEN anywhere in the file (even in comments or strings): fetch, process,
  require, eval, Bun, new Function, dynamic import().
- Pure computation only: no filesystem, no network, no environment.
- The file must end with a default export OBJECT whose method implements the seam.

Output format — one RATIONALE line, then exactly one fenced code block:

RATIONALE: <what strategy this module implements and why it could beat the builtin, one sentence>
\`\`\`ts
<the complete module source>
\`\`\`

If you cannot think of a strategy plausibly better than the builtin, output the single word SKIP.`;

/** Extract the fenced module source. Exported for tests. */
export function extractModuleSource(text: string): string | null {
  const fence = /```(?:ts|typescript|js|javascript)?\s*\n([\s\S]*?)```/.exec(text);
  const body = fence?.[1]?.trim();
  return body && body.length > 0 ? `${body}\n` : null;
}

/** Build the user prompt for one seam. Exported for tests. */
export function seamPrompt(row: SeamCatalogRow): string {
  const method = SEAM_METHOD[row.seam] ?? row.seam;
  return (
    `Seam: ${row.seam} (interface v${row.seamApiVersion})\n` +
    `Your default export must be: { ${method}(params) { ... } }\n` +
    `Request params JSON schema:\n${JSON.stringify(row.requestSchema, null, 2)}\n` +
    `Response JSON schema (return exactly this shape):\n${JSON.stringify(row.responseSchema, null, 2)}\n\n` +
    `Write the module now.`
  );
}

/**
 * Propose one module candidate: pick a seam, ask the local model, wall-check,
 * and materialize `<modulesDir>/<id>/{manifest.json, impl.ts}`. Returns null
 * when the model declines (SKIP), emits nothing code-shaped, or the wall
 * rejects — a null is a normal "no candidate this round", never an error.
 * The returned module starts UNKNOWN to the lifecycle; the caller feeds its
 * id to ModuleLifecycle (propose→sandbox→build→evaluate).
 */
export async function proposeModule(deps: ModuleProposerDeps): Promise<ProposedModule | null> {
  const rng = deps.rng ?? Math.random;
  const now = deps.now ?? Date.now;
  const row = deps.seam
    ? SEAM_CATALOG.find((r) => r.seam === deps.seam)
    : SEAM_CATALOG[Math.floor(rng() * SEAM_CATALOG.length)];
  if (!row) return null;

  const text = await deps.completeLocal({
    system: SYSTEM_PROMPT,
    user: seamPrompt(row),
    maxTokens: deps.maxTokens ?? 4096,
  });
  if (text.trim() === "SKIP") return null;

  const source = extractModuleSource(text);
  if (!source) return null;
  const wall = wallCheck(source);
  if (!wall.ok) return null;

  const rationale = /RATIONALE:\s*(.+)/.exec(text)?.[1]?.trim() ?? "unspecified";
  const sourceHash = createHash("sha256").update(source).digest("hex");
  // 16 hex chars, not 8. At 8 the id space is 32 bits, and the module dir is
  // created with `recursive: true` — which does not complain about an existing
  // directory — so a collision silently overwrote the impl.ts of whatever
  // module already held that id. On a long-running install proposing a
  // candidate every dream cycle, the collision is not hypothetical, and the
  // module it lands on may be the one currently promoted and serving a seam.
  const moduleId = `mod-${row.seam.replace(/_/g, "-")}-${sourceHash.slice(0, 16)}`;
  const dir = join(deps.modulesDir, moduleId);

  const manifest: ModuleManifest = {
    schemaVersion: 1,
    id: moduleId,
    seam: row.seam,
    seamApiVersion: row.seamApiVersion,
    // Floor = the runtime that authored it (">=X.Y.Z" per §2.1).
    compat: { runtime: `>=${deps.runtimeVersion}` },
    requires: [],
    displayName: `${row.seam} candidate ${sourceHash.slice(0, 8)}`,
    entry: "impl.ts",
    permissions: [],
    // Human-only hints for the approval card (§12.4 two-channel rule).
    capabilitiesClaimed: { rationale, proposer: "module-proposer" },
    limits: { timeoutMs: 2_000, maxRssMb: 128 },
    createdAt: now(),
    sourceHash,
    proposedBy: "dream",
  };

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "impl.ts"), source, "utf8");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  return { moduleId, dir, seam: row.seam, rationale };
}
