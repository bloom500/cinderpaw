/**
 * Faza 2 Slice 4 — the code-patch proposal operator.
 * Spec: `docs/superpowers/specs/2026-07-01-faza2-code-rsi-design.md` §3.
 *
 * `proposeCodePatch` asks the LOCAL model to read one of the agent's own
 * rsi/ sources and emit a unified diff improving it. The proposal is a
 * suggestion, never an action: everything it emits must still clear the
 * TS wall, the Rust wall, the worktree suite, tsc, the build, and the
 * strict-greater ratchet before it means anything.
 *
 * Trust notes:
 *   - `completeLocal` MUST be wired to local inference only (spec §2.5:
 *     no network during proposal). There is no provider-forcing field on
 *     InferenceRequest, so this is a WIRING obligation at the seam — the
 *     production composition root binds this to the local engine, not
 *     the router's cloud fallback.
 *   - Target selection excludes the denylist up front — proposing a
 *     patch the wall will reject is a wasted candidate slot, and this
 *     also keeps enforcement sources out of the model's context.
 *   - This file is deliberately NOT on the denylist: the proposal
 *     operator is legitimate self-improvement surface. A degenerate
 *     proposer produces candidates that fail the walls; it cannot
 *     weaken them.
 */

import type { CodeGenome } from "./code-genome.ts";
import { DEFAULT_CODE_PATCH_POLICY } from "./code-genome.ts";

export interface ProposerDeps {
  /** LOCAL-ONLY completion (see module docblock). Returns raw model text. */
  completeLocal: (args: { system: string; user: string; maxTokens: number }) => Promise<string>;
  /** rsi/ source filenames (basenames, e.g. "mutation.ts"). Production:
   *  readdir over `<repoRoot>/FeralAgent/src/rsi`. */
  listRsiFiles: () => Promise<string[]>;
  /** Read one rsi/ source by basename. */
  readRsiFile: (basename: string) => Promise<string>;
  /** Commit the patch applies on top of (the repo's current HEAD). */
  baseCommit: () => Promise<string>;
  /** Injectable for deterministic tests. Default Math.random. */
  rng?: () => number;
  /** Completion budget. Default 4096 (a ≤200-line diff fits easily). */
  maxTokens?: number;
}

/** Files the proposer may target: allowed extension, not enforcement. */
export function proposableFiles(basenames: string[]): string[] {
  return basenames.filter(
    (b) =>
      b.endsWith(DEFAULT_CODE_PATCH_POLICY.allowedExtension) &&
      !DEFAULT_CODE_PATCH_POLICY.denylistBasenames.includes(b),
  );
}

/**
 * Pull a unified diff out of model output. Prefers a ```diff fenced
 * block; falls back to the first `diff --git`/`--- ` line through the
 * end (minus any trailing fence). Returns null when nothing diff-shaped
 * is present. Pure; exported for tests.
 */
export function extractUnifiedDiff(text: string): string | null {
  const fence = /```(?:diff|patch)\r?\n([\s\S]*?)```/.exec(text);
  if (fence?.[1]) return fence[1].trimEnd() + "\n";

  const lines = text.split("\n");
  const start = lines.findIndex(
    (l) => l.startsWith("diff --git ") || l.startsWith("--- "),
  );
  if (start === -1) return null;
  const body = lines
    .slice(start)
    .filter((l) => !l.startsWith("```"))
    .join("\n");
  return body.trimEnd() + "\n";
}

/** Derive the touched paths from the `+++`/`---` headers (a/ b/ prefixes
 *  stripped, /dev/null sides skipped). NOT a validator — the walls judge;
 *  this only fills `CodeGenome.affectedFiles` for the journal. */
export function affectedFilesOf(patch: string): string[] {
  const files: string[] = [];
  for (const raw of patch.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const m = /^(?:---|\+\+\+) (?:[ab]\/)?(.+)$/.exec(line);
    if (!m) continue;
    const p = m[1]!.split("\t")[0]!.trim().replace(/\\/g, "/");
    if (p !== "/dev/null" && !files.includes(p)) files.push(p);
  }
  return files;
}

const SYSTEM_PROMPT = `You are the code-evolution operator of a bounded self-improving agent.
You propose ONE small improvement to ONE TypeScript source file as a unified diff.

Hard rules (violations are auto-rejected by a compiled policy wall):
- Output exactly one unified diff, inside a \`\`\`diff fence.
- Paths must be exactly as given (a/src/rsi/<file> and b/src/rsi/<file>).
- Change at most 200 lines total. Prefer under 50.
- Only the file shown. No new files, no renames, no dependencies.
- The FULL existing test suite must still pass and \`tsc --noEmit\` must stay clean.

Aim for: a real bug, a missed edge case, clearer control flow, or a measurable
efficiency win. If you see nothing worth changing, output the single word SKIP.

Before the fence, write one line: RATIONALE: <what and why, one sentence>.`;

/**
 * Propose one code candidate. Returns null when the model declines
 * (SKIP), emits nothing diff-shaped, or no proposable target exists —
 * a null is a normal "no candidate this round", never an error.
 */
export async function proposeCodePatch(deps: ProposerDeps): Promise<CodeGenome | null> {
  const rng = deps.rng ?? Math.random;
  const candidates = proposableFiles(await deps.listRsiFiles());
  if (candidates.length === 0) return null;
  const target = candidates[Math.floor(rng() * candidates.length)]!;
  const source = await deps.readRsiFile(target);

  const user = `File: src/rsi/${target}\n\n\`\`\`ts\n${source}\n\`\`\`\n\nPropose one improvement as a unified diff over src/rsi/${target}.`;
  const text = await deps.completeLocal({
    system: SYSTEM_PROMPT,
    user,
    maxTokens: deps.maxTokens ?? 4096,
  });

  if (text.trim() === "SKIP") return null;
  const patch = extractUnifiedDiff(text);
  if (!patch) return null;

  const rationale = /RATIONALE:\s*(.+)/.exec(text)?.[1]?.trim() ?? "unspecified";
  return {
    patch,
    affectedFiles: affectedFilesOf(patch),
    baseCommit: await deps.baseCommit(),
    proposal: {
      rationale,
      riskAssessment: "auto: judged by wall + worktree suite + tsc + build",
      testPlan: "full existing suite + tsc --noEmit + build in the disposable worktree",
    },
  };
}
