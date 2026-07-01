/**
 * Faza 2 — code-RSI: the CodeGenome type layer + patch policy wall.
 * Spec: `docs/superpowers/specs/2026-07-01-faza2-code-rsi-design.md`.
 *
 * ── Division of labor (frozen — do not widen without an ADR) ─────────────────
 * This file holds three things with different owners:
 *
 *   1. TYPES (`CodeGenome`, `ParsedDiff`, …) — the frozen contract both
 *      halves compose against.
 *   2. `parseUnifiedDiff` — pure string → structure. **MiniMax implements
 *      this** (stub throws until then). NO policy, NO IO, NO fs access:
 *      parsing and judging are deliberately separate so the security-
 *      critical half is never delegated.
 *   3. `validateCodePatch` + `DEFAULT_CODE_PATCH_POLICY` — the policy WALL
 *      (trust boundary, Opus/Fable territory). Everything the spec's §2
 *      guardrails promise is enforced here, over the parser's output.
 *
 * The wall is itself on the patch DENYLIST: a code candidate may never
 * patch the guard that judges code candidates. Rust (scorer, ratchet,
 * rollback) holds the other half of the trust boundary — see spec §2.
 */

/** A code-RSI candidate: a unified diff over the agent's own rsi/ sources
 *  (rsi-evolution-spec §Faza 2). Carried on `GenomeSpec.code` (optional,
 *  sibling of `config`) once the engine threading lands (Slice 4). */
export interface CodeGenome {
  /** The patch, unified diff format (`git diff` output). */
  patch: string;
  /** Repo-relative files the patch touches (derived from the diff at
   *  proposal time; re-derived + cross-checked by the policy wall). */
  affectedFiles: string[];
  /** Commit hash the patch applies on top of. */
  baseCommit: string;
  /** The proposer's self-report — journaled for transparency, never
   *  trusted by the wall. */
  proposal: {
    rationale: string;
    riskAssessment: string;
    testPlan: string;
  };
}

/** One file's worth of parsed diff. Paths are as they appear in the diff
 *  headers, WITHOUT the a/ b/ prefixes, normalised to forward slashes. */
export interface ParsedDiffFile {
  /** Path before the change; null for a newly created file. */
  oldPath: string | null;
  /** Path after the change; null for a deleted file. */
  newPath: string | null;
  /** Total added lines across hunks. */
  addedLines: number;
  /** Total removed lines across hunks. */
  removedLines: number;
  /** True if the diff marks this file as binary. */
  binary: boolean;
}

/** Structured view of a unified diff — everything the policy wall needs. */
export interface ParsedDiff {
  files: ParsedDiffFile[];
}

/** Parse failure. A malformed patch is a verdict, not an exception. */
export interface DiffParseError {
  error: string;
}

export function isDiffParseError(v: ParsedDiff | DiffParseError): v is DiffParseError {
  return "error" in v;
}

// ─────────────────────────────────────────────────────────────────────────────
// MiniMax: implement `parseUnifiedDiff` (pure, no IO). Contract:
//   - Input: raw unified-diff text (`git diff` / `git format-patch` body).
//   - Output: ParsedDiff, or DiffParseError for anything malformed.
//   - Per file: read old/new path from the `--- a/…` / `+++ b/…` headers
//     (strip the a/ b/ prefixes; `/dev/null` → null side = created/deleted).
//     Count added (`+`) / removed (`-`) hunk body lines (NOT the `+++`/`---`
//     headers). `Binary files … differ` / `GIT binary patch` → binary: true.
//   - Tolerate CRLF input; normalise paths to forward slashes.
//   - Errors (DiffParseError, message naming the offence): empty/whitespace
//     input; a hunk `@@` header whose counts don't match the body; a file
//     section with no `+++`/`---` pair; text after the last hunk that is not
//     a new file header. Never throw.
//   - Tests in `tests/rsi-code-genome.test.ts` (extend the policy suite):
//     single-file edit, multi-file, create (`--- /dev/null`), delete
//     (`+++ /dev/null`), rename header pair, binary marker, CRLF, malformed
//     hunk → error. Fixtures inline, no fs.
// ─────────────────────────────────────────────────────────────────────────────
export function parseUnifiedDiff(_patch: string): ParsedDiff | DiffParseError {
  throw new Error("parseUnifiedDiff: not implemented (MiniMax leaf — see contract above)");
}

/** What the policy wall enforces (spec §2.5 guardrails). Host-tunable in
 *  principle, but production uses the default; the agent NEVER holds a
 *  reference to a policy object it could mutate. */
export interface CodePatchPolicy {
  /** Repo-relative dir prefix a patch may touch. */
  allowedDirPrefix: string;
  /** Allowed file extension. */
  allowedExtension: string;
  /** Max total changed lines (added + removed) per patch. */
  maxChangedLines: number;
  /** Basenames (without dir) that may never be patched — the enforcement
   *  chain itself. Checked against BOTH sides of a rename. */
  denylistBasenames: readonly string[];
}

/** Locked production policy. rsi/ only, .ts only, ≤200 lines, and the
 *  guard/gate/ratchet chain is untouchable (spec §2.4). */
export const DEFAULT_CODE_PATCH_POLICY: CodePatchPolicy = {
  allowedDirPrefix: "src/rsi/",
  allowedExtension: ".ts",
  maxChangedLines: 200,
  denylistBasenames: [
    "code-genome.ts", // this wall
    "code-sandbox.ts", // the measurement runner — patching it = lying to the scorer
    "contract-runner.ts",
    "contract-stages.ts",
    "contract-deps.ts",
    "contract-leaves.ts",
    "contract.ts",
    "ratchet-handler.ts",
    "confidence.ts",
    // Slice 4 additions — the code-aware leaves + the runner that wires
    // the walls together. Kept in sync BY HAND with the Rust mirror
    // (`src-tauri/src/rsi/code_patch.rs` DENYLIST_BASENAMES).
    "code-leaves.ts",
    "code-rsi.ts",
  ],
};

/** Policy verdict. `ok:false` is a normal candidate rejection (soft), the
 *  same shape discipline as the contract stages. */
export type PatchVerdict = { ok: true } | { ok: false; reason: string };

/** The policy wall: judge a parsed diff against the locked policy. Pure +
 *  deterministic. Called by the code-RSI `static_analysis` leaf (Slice 4)
 *  and re-asserted by `safety_checks`. Trust boundary — NOT delegable. */
export function validateCodePatch(
  parsed: ParsedDiff,
  policy: CodePatchPolicy = DEFAULT_CODE_PATCH_POLICY,
): PatchVerdict {
  if (parsed.files.length === 0) {
    return { ok: false, reason: "patch touches no files" };
  }

  let changedLines = 0;
  for (const f of parsed.files) {
    if (f.binary) {
      return { ok: false, reason: `binary patch not allowed: ${f.newPath ?? f.oldPath}` };
    }
    // Both sides of the change must clear the wall — a rename INTO the
    // allowed dir from outside (or vice versa) is a violation on the
    // offending side.
    for (const path of [f.oldPath, f.newPath]) {
      if (path === null) continue; // created/deleted side
      const bad = pathViolation(path, policy);
      if (bad) return { ok: false, reason: bad };
    }
    changedLines += f.addedLines + f.removedLines;
  }

  if (changedLines > policy.maxChangedLines) {
    return {
      ok: false,
      reason: `patch too large: ${changedLines} changed lines > ${policy.maxChangedLines}`,
    };
  }
  return { ok: true };
}

/** One path's policy check; returns the violation reason or null. */
function pathViolation(path: string, policy: CodePatchPolicy): string | null {
  // Normalise defensively even though the parser contract promises forward
  // slashes — the wall must not depend on the parser being polite.
  const p = path.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) {
    return `absolute path not allowed: ${path}`;
  }
  if (p.split("/").includes("..")) {
    return `path traversal not allowed: ${path}`;
  }
  if (!p.startsWith(policy.allowedDirPrefix)) {
    return `file outside ${policy.allowedDirPrefix}: ${path}`;
  }
  if (!p.endsWith(policy.allowedExtension)) {
    return `only ${policy.allowedExtension} files may be patched: ${path}`;
  }
  const basename = p.slice(p.lastIndexOf("/") + 1);
  if (policy.denylistBasenames.includes(basename)) {
    return `enforcement file may not be patched: ${path}`;
  }
  return null;
}
