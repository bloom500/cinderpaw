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

/** Files the proposer may target: allowed extension, not enforcement.
 *  `paths` may be bare basenames (flat layout) or rsi/-relative paths
 *  (e.g. "l1-config/mutation.ts") — the denylist always matches on the
 *  basename, same as the wall's own check in `pathViolation` above. */
export function proposableFiles(paths: string[]): string[] {
  return paths.filter(
    (p) =>
      p.endsWith(DEFAULT_CODE_PATCH_POLICY.allowedExtension) &&
      !DEFAULT_CODE_PATCH_POLICY.denylistBasenames.includes(p.slice(p.lastIndexOf("/") + 1)),
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
You propose ONE small improvement to ONE TypeScript source file.

Output format — one RATIONALE line, then 1 to 3 edit blocks:

RATIONALE: <what and why, one sentence>
<<<<<<< SEARCH
<exact lines copied verbatim from the file, enough to be unique>
=======
<the replacement lines>
>>>>>>> REPLACE

Hard rules (violations are auto-rejected by a compiled policy wall):
- SEARCH text must be copied EXACTLY from the file shown (same whitespace).
- Each SEARCH must match exactly one place in the file.
- Change at most 200 lines total. Prefer under 50.
- Only the file shown. No new files, no renames, no dependencies.
- The FULL existing test suite must still pass and \`tsc --noEmit\` must stay clean.

Aim for: a real bug, a missed edge case, clearer control flow, or a measurable
efficiency win. If you see nothing worth changing, output the single word SKIP.`;

/** One parsed SEARCH/REPLACE edit block. */
export interface EditBlock {
  search: string;
  replace: string;
}

/**
 * Parse Aider-style SEARCH/REPLACE blocks. Small local models produce
 * these far more reliably than unified diffs (no line-number arithmetic,
 * no context reconstruction) — the diff the walls demand is then built
 * programmatically from the REAL file, so \`git apply\` can never fail on
 * hallucinated context. Returns null when no block is present.
 */
export function parseEditBlocks(text: string): EditBlock[] | null {
  const re = /<{5,9} *SEARCH\r?\n([\s\S]*?)\r?\n?={5,9}\r?\n([\s\S]*?)\r?\n?>{5,9} *REPLACE/g;
  const blocks: EditBlock[] = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    blocks.push({ search: m[1] ?? "", replace: m[2] ?? "" });
  }
  return blocks.length > 0 ? blocks : null;
}

/**
 * Apply edit blocks to a source string. Every SEARCH must match exactly
 * once (zero matches = hallucinated text; two+ = ambiguous edit) — any
 * violation returns null and the proposal round yields no candidate.
 */
export function applyEditBlocks(source: string, blocks: EditBlock[]): string | null {
  let out = source;
  for (const b of blocks) {
    if (b.search === "") return null;
    const first = out.indexOf(b.search);
    if (first === -1) return null;
    if (out.indexOf(b.search, first + 1) !== -1) return null;
    out = out.slice(0, first) + b.replace + out.slice(first + b.search.length);
  }
  return out === source ? null : out;
}

/**
 * Serialize (oldText → newText) as a minimal single-hunk unified diff with
 * up to 3 context lines, in exactly the a/ b/ path shape the policy wall
 * demands. Built from the real file contents, so the emitted patch always
 * applies cleanly. Returns null when the texts are identical.
 */
export function buildUnifiedDiff(oldText: string, newText: string, path: string): string | null {
  if (oldText === newText) return null;
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  let prefix = 0;
  const maxPrefix = Math.min(oldLines.length, newLines.length);
  while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = Math.min(oldLines.length, newLines.length) - prefix;
  while (
    suffix < maxSuffix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const ctxBefore = Math.min(3, prefix);
  const ctxAfter = Math.min(3, suffix);
  const oldBody = oldLines.slice(prefix, oldLines.length - suffix);
  const newBody = newLines.slice(prefix, newLines.length - suffix);

  const hunk: string[] = [];
  for (const l of oldLines.slice(prefix - ctxBefore, prefix)) hunk.push(` ${l}`);
  for (const l of oldBody) hunk.push(`-${l}`);
  for (const l of newBody) hunk.push(`+${l}`);
  for (const l of oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + ctxAfter)) {
    hunk.push(` ${l}`);
  }

  const oldCount = ctxBefore + oldBody.length + ctxAfter;
  const newCount = ctxBefore + newBody.length + ctxAfter;
  // Unified-diff convention: start is the first line of the hunk (1-based);
  // a zero-count side anchors on the line BEFORE the change instead.
  const oldStart = oldCount === 0 ? prefix - ctxBefore : prefix - ctxBefore + 1;
  const newStart = newCount === 0 ? prefix - ctxBefore : prefix - ctxBefore + 1;

  return (
    `--- a/${path}\n+++ b/${path}\n` +
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n` +
    hunk.join("\n") +
    "\n"
  );
}

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

  const user = `File: src/rsi/${target}\n\n\`\`\`ts\n${source}\n\`\`\`\n\nPropose one improvement to src/rsi/${target} as SEARCH/REPLACE blocks.`;
  const text = await deps.completeLocal({
    system: SYSTEM_PROMPT,
    user,
    maxTokens: deps.maxTokens ?? 4096,
  });

  if (text.trim() === "SKIP") return null;
  // Primary path: SEARCH/REPLACE blocks → apply → serialize a clean diff
  // ourselves. Fallback: a model that emitted a unified diff anyway is
  // accepted as before (the walls still judge it).
  let patch: string | null = null;
  const blocks = parseEditBlocks(text);
  if (blocks) {
    const edited = applyEditBlocks(source, blocks);
    if (edited !== null) {
      patch = buildUnifiedDiff(source, edited, `src/rsi/${target}`);
    }
  } else {
    patch = extractUnifiedDiff(text);
  }
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
