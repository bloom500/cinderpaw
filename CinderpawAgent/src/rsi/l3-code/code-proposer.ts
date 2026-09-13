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
import { createHash } from "node:crypto";
import { buildSelfModel, nothingLeftToLearn } from "./self-model.ts";
import { DEFAULT_BUDGET_CAPS } from "../infra/budget.ts";
import {
  FAILURE_CLASSES,
  SELECTOR_VERSION,
  poolOf,
  selectExperiment,
  type Attempt,
  type FailureClass,
  type Prediction,
} from "./experiment-selector.ts";

export interface ProposerDeps {
  /** LOCAL-ONLY completion (see module docblock). Returns raw model text. */
  completeLocal: (args: { system: string; user: string; maxTokens: number }) => Promise<string>;
  /** rsi/ source filenames (basenames, e.g. "mutation.ts"). Production:
   *  readdir over `<repoRoot>/CinderpawAgent/src/rsi`. */
  listRsiFiles: () => Promise<string[]>;
  /** Read one rsi/ source by basename. */
  readRsiFile: (basename: string) => Promise<string>;
  /** Commit the patch applies on top of (the repo's current HEAD). */
  baseCommit: () => Promise<string>;
  /** The ledger of past L3 rounds (see `experiment-selector.ts`). The
   *  selector picks the target from it and tells the model what was already
   *  refused there. Default: empty, which behaves like the old random pick. */
  attempts?: Attempt[];
  /** Files with an open question on them (see `questions.ts`): not offered
   *  until the user answers, because trying again without the answer is the
   *  same waste. Default: none. */
  blockedFiles?: string[];
  /** Answers the user gave about a file, read by the proposer verbatim. */
  answersFor?: (file: string) => { question: string; answer: string }[];
  /** Called instead of returning a candidate when the proposer says it
   *  lacks information (`Prediction.missing`). The round does not run. */
  onQuestion?: (q: { file: string; question: string; rationale: string }) => void;
  /** Tokens one round may spend (the contract's cycle cap). A prediction
   *  that says `over_mandate`, or an `expectedCost` above this, becomes a
   *  question for the user instead of a round. Default: the BRSI cycle cap. */
  roundBudgetTokens?: number;
  /** Called instead of asking the model when the self-model says every file
   *  in the pool is a settled result (`nothingLeftToLearn`). The round costs
   *  nothing; `poolSize` is how many files were considered. */
  onNothingLeft?: (poolSize: number) => void;
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

Output format — one RATIONALE line, one PREDICTION line, then 1 to 3 edit blocks:

RATIONALE: <what and why, one sentence>
PREDICTION: {"pAccept":<0..1>,"expectedEffect":<score points, 0 if none>,"expectedCost":<tokens>,"failureClass":<"wrong_proposal"|"wrong_file"|"unmeasured"|"missing_info"|"need_tool"|"need_method"|"over_mandate"|null>,"missing":<"what you need to know from the user"|null>}
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
efficiency win. If you see nothing worth changing, output the single word SKIP.

The PREDICTION is a bet about yourself and it is checked: after the change is
judged, your pAccept is scored against the verdict, so an honest 0.3 beats a
flattering 0.9. "failureClass" is the failure you expect IF you fail:
wrong_proposal (the idea), wrong_file (the place), unmeasured (the evaluator
cannot see the gain), missing_info (you need to know something), need_tool
(you would need a tool you do not have), need_method (you would need to
experiment first), over_mandate (the right change costs more than this round
may spend). Set "missing" only when you genuinely cannot decide without
something the user knows (what a value is for, whether a behaviour is
intended); then emit NO edit blocks: the question is sent to the user and you
get the answer next time. over_mandate is also sent to the user as a question,
so say in "missing" what the larger change would be.`;

/** The prompt's identity, written on every receipt. Two rounds under
 *  different prompt hashes were asked different questions. */
export const PROMPT_HASH = createHash("sha256").update(SYSTEM_PROMPT).digest("hex").slice(0, 16);

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

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
/** Parse the PREDICTION line. Anything malformed is `undefined`: a round
 *  without a prediction still runs, it just teaches the self-model nothing.
 *  Values are clamped and the failure class is checked against the fixed
 *  vocabulary, because the model writes this and the ledger is counted. */
export function parsePrediction(text: string): Prediction | undefined {
  const m = /PREDICTION:\s*(\{.*\})/.exec(text);
  if (!m) return undefined;
  try {
    const raw = JSON.parse(m[1]!) as Record<string, unknown>;
    const num = (v: unknown, lo: number, hi: number, dflt: number) =>
      typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
    const fc = raw.failureClass;
    const missing = typeof raw.missing === "string" && raw.missing.trim() ? raw.missing.trim() : null;
    return {
      pAccept: num(raw.pAccept, 0, 1, 0.5),
      expectedEffect: num(raw.expectedEffect, 0, 1e6, 0),
      expectedCost: num(raw.expectedCost, 0, 1e9, 0),
      failureClass: (FAILURE_CLASSES as readonly string[]).includes(fc as string)
        ? (fc as FailureClass)
        : missing
          ? "missing_info"
          : null,
      missing,
    };
  } catch {
    return undefined;
  }
}

export async function proposeCodePatch(deps: ProposerDeps): Promise<CodeGenome | null> {
  const rng = deps.rng ?? Math.random;
  const blocked = new Set(deps.blockedFiles ?? []);
  const candidates = proposableFiles(await deps.listRsiFiles()).filter((f) => !blocked.has(f));
  if (candidates.length === 0) return null;
  // A plateau is a result (spec §9.4), and it is cheaper to notice before
  // the proposal than after: when every file left in the pool is a settled
  // dead end or a settled win, the model is not asked. New code, a new
  // answer, or an accept re-opens the pool by construction.
  const attempts = deps.attempts ?? [];
  const pool = poolOf(candidates, attempts);
  if (pool.length > 0 && nothingLeftToLearn(buildSelfModel(attempts), pool)) {
    deps.onNothingLeft?.(pool.length);
    return null;
  }
  // M0 chooses the experiment. Every file struck out means nothing is worth
  // trying this round, which is a verdict too, not an error.
  const experiment = selectExperiment(candidates, attempts, rng);
  if (!experiment) return null;
  const target = experiment.target;
  const source = await deps.readRsiFile(target);

  const answers = (deps.answersFor?.(target) ?? [])
    .map((a) => `- You asked: "${a.question}"\n  The user answered: "${a.answer}"`)
    .join("\n");
  const user =
    `File: src/rsi/${target}\n\n\`\`\`ts\n${source}\n\`\`\`\n\n` +
    `Evidence from earlier rounds:\n${experiment.brief}\n\n` +
    (answers ? `Answers from the user about this file:\n${answers}\n\n` : "") +
    `Propose one improvement to src/rsi/${target} as SEARCH/REPLACE blocks.`;
  const text = await deps.completeLocal({
    system: SYSTEM_PROMPT,
    user,
    maxTokens: deps.maxTokens ?? 4096,
  });

  if (text.trim() === "SKIP") return null;
  const prediction = parsePrediction(text);
  const rationale = /RATIONALE:\s*(.+)/.exec(text)?.[1]?.trim() ?? "unspecified";
  // "I lack X" is a question, not a candidate: nothing runs until it is
  // answered, and the ledger does not record a refusal that was never tried.
  if (prediction?.missing) {
    deps.onQuestion?.({ file: target, question: prediction.missing, rationale });
    return null;
  }
  // "The right change is bigger than my mandate" is the same shape: the
  // user decides the scope, the loop does not quietly try a cheaper thing
  // and record a refusal for it. Astra's fifth decision (plan §2.4). The
  // budget is not lifted by an answer; the answer reshapes the next proposal.
  const budget = deps.roundBudgetTokens ?? DEFAULT_BUDGET_CAPS.tokens;
  if (prediction && (prediction.failureClass === "over_mandate" || prediction.expectedCost > budget)) {
    deps.onQuestion?.({
      file: target,
      question:
        `This change looks like ~${Math.round(prediction.expectedCost)} tokens, above the ` +
        `${budget}-token round budget. Answer with a smaller scope for this file, or refuse to leave it alone.`,
      rationale,
    });
    return null;
  }
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

  return {
    patch,
    affectedFiles: affectedFilesOf(patch),
    baseCommit: await deps.baseCommit(),
    fileHash: sha256(source),
    proposal: {
      rationale,
      ...(prediction ? { prediction } : {}),
      methodVersion: { selector: SELECTOR_VERSION, promptHash: PROMPT_HASH },
      riskAssessment: "auto: judged by wall + worktree suite + tsc + build",
      testPlan: "full existing suite + tsc --noEmit + build in the disposable worktree",
    },
  };
}
