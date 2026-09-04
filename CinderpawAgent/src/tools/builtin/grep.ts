/**
 * grep — content search across files in an allowed directory.
 *
 * Walks the directory tree and returns every line that matches a regex
 * pattern, formatted as `relative/path:line:content` (ripgrep-style).
 * Optional `glob` argument restricts which files are inspected (e.g.
 * `*.ts` skips test fixtures and binary blobs).
 *
 * Implementation notes:
 *   - Files larger than `MAX_FILE_BYTES` are skipped (would otherwise
 *     waste memory on minified bundles or generated docs).
 *   - The search is synchronous and bounds memory by capping `max_results`
 *     and per-line length.
 *   - `context_lines` adds N lines of leading and trailing context to
 *     each match (ripgrep-style `--context`); default 2.
 *
 * Requires `fs:read`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { resolveAllowedPath, firstAllowedPath } from "../../egress/tool-permissions.ts";
import type { Tool, ToolManifest } from "../../types.ts";

const DEFAULT_MAX_RESULTS = 200;
const ABSOLUTE_MAX_RESULTS = 5_000;
const MAX_FILE_BYTES = 512_000; // skip huge files
const MAX_LINE_LENGTH = 2_000; // truncate very long lines
const MAX_DEPTH = 8;

export function createGrepTool(allowedPaths: string[]): Tool {
  const manifest: ToolManifest = {
    name: "grep",
    description:
      "Search file contents for a regex pattern under an allowed path. " +
      "Returns matches formatted as `file:line:content` (ripgrep style). " +
      "Use `glob` to limit to a file type (e.g. `*.ts`) and `context_lines` " +
      "to add leading/trailing context.",
    permissions: ["fs:read"],
    networkAccess: false,
    allowedPaths,
  };

  return {
    manifest,
    parameters: {
      pattern: {
        type: "string",
        description: "Regex pattern (JavaScript RegExp syntax).",
        required: true,
      },
      path: {
        type: "string",
        description: "Absolute directory to search. Defaults to the first allowed root.",
        required: false,
      },
      glob: {
        type: "string",
        description:
          "Optional file-name filter, e.g. `*.ts` or `*.{ts,tsx}`. " +
          "Supports `*` (any non-`/` chars) and `{a,b}` alternation.",
        required: false,
      },
      max_results: {
        type: "number",
        description: "Cap on the number of matched lines (default 200, hard max 5000).",
        required: false,
      },
      context_lines: {
        type: "number",
        description: "Number of context lines before and after each match (default 2, max 10).",
        required: false,
      },
      case_insensitive: {
        type: "boolean",
        description: "When true, match case-insensitively (default: case-sensitive).",
        required: false,
      },
    },
    async execute(args, ctx) {
      const pattern = args.pattern;
      const caseInsensitive = args.case_insensitive === true;
      const contextLines = Math.min(
        Math.max(typeof args.context_lines === "number" ? Math.floor(args.context_lines) : 2, 0),
        10,
      );
      const max = Math.min(
        Math.max(
          typeof args.max_results === "number" ? Math.floor(args.max_results) : DEFAULT_MAX_RESULTS,
          1,
        ),
        ABSOLUTE_MAX_RESULTS,
      );

      if (typeof pattern !== "string" || !pattern) {
        return { ok: false, content: "grep requires a non-empty 'pattern' string.", error: "bad_args" };
      }

      let regex: RegExp;
      try {
        regex = new RegExp(pattern, caseInsensitive ? "i" : "");
      } catch (err) {
        return { ok: false, content: `Invalid regex: ${String(err)}`, error: "bad_args" };
      }
      if (isCatastrophic(regex)) {
        return {
          ok: false,
          content:
            `That pattern can take effectively forever to match (nested repetition — ` +
            `"${pattern}"). Rewrite it more specifically, e.g. replace (a+)+ with a+.`,
          error: "bad_args",
        };
      }

      const requestedRoot = typeof args.path === "string" && args.path.trim()
        ? args.path
        : (firstAllowedPath(ctx.manifest) ?? "");
      if (!requestedRoot) {
        return { ok: false, content: "grep needs a 'path' or an allowed root in the manifest.", error: "bad_args" };
      }
      let root: string;
      try {
        root = resolveAllowedPath(ctx.manifest, "fs:read", requestedRoot);
      } catch (err) {
        return {
          ok: false,
          content: String((err as Error).message ?? err),
          error: "permission_denied",
        };
      }

      // Optional file-name glob. We turn it into a tiny regex; the only
      // constructs supported are `*` and `{a,b}` alternation, which covers
      // the agent's two main use cases ("only .ts files" / ".ts or .tsx").
      const globFilter = typeof args.glob === "string" && args.glob.trim()
        ? compileNameFilter(args.glob)
        : null;

      const matches: { file: string; line: number; content: string }[] = [];

      const visit = (dir: string, depth: number): void => {
        if (depth > MAX_DEPTH) return;
        if (matches.length >= max) return;
        let entries: string[];
        try { entries = readdirSync(dir); } catch { return; }
        for (const name of entries) {
          if (matches.length >= max) return;
          if (name.startsWith(".")) continue;
          const full = join(dir, name);
          let stat;
          try { stat = statSync(full); } catch { continue; }
          if (stat.isDirectory()) {
            visit(full, depth + 1);
            continue;
          }
          if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
          if (globFilter && !globFilter(name)) continue;

          // Skip obviously binary extensions — the read is utf-8 and a
          // binary blob would just produce a wall of garbage matches.
          const ext = extname(name).toLowerCase();
          if (BINARY_EXTS.has(ext)) continue;

          let content: string;
          try { content = readFileSync(full, "utf8"); } catch { continue; }

          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i] ?? "";
            if (regex.test(line)) {
              // Push the match plus its context window (if any).
              for (let ctx = Math.max(0, i - contextLines); ctx <= Math.min(lines.length - 1, i + contextLines); ctx++) {
                if (ctx === i || matches.length < max) {
                  const ctxLine = (lines[ctx] ?? "").length > MAX_LINE_LENGTH
                    ? (lines[ctx] ?? "").slice(0, MAX_LINE_LENGTH) + "…"
                    : (lines[ctx] ?? "");
                  if (ctx === i) {
                    matches.push({ file: relative(root, full).split(sep).join("/"), line: ctx + 1, content: ctxLine });
                  } else {
                    matches.push({ file: relative(root, full).split(sep).join("/"), line: ctx + 1, content: `  ${ctxLine}` });
                  }
                }
              }
              // Skip the context lines we just emitted on the next match.
              i = Math.min(lines.length - 1, i + contextLines);
            }
          }
        }
      };

      try {
        visit(root, 0);
      } catch (err) {
        return { ok: false, content: `Search failed: ${String(err)}`, error: "io_error" };
      }

      const truncated = matches.length >= max;
      const lines = matches.map((m) => `${m.file}:${m.line}:${m.content}`);
      const summary = truncated
        ? `${root} — showing first ${max} match(es) for "${pattern}":\n${lines.join("\n")}`
        : matches.length === 0
          ? `No matches for "${pattern}" in ${root}.`
          : `${root} — ${matches.length} match(es) for "${pattern}":\n${lines.join("\n")}`;

      return {
        ok: true,
        content: summary,
        data: { matches, truncated, root },
      };
    },
  };
}

const BINARY_EXTS: Set<string> = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tiff",
  ".mp3", ".mp4", ".wav", ".ogg", ".flac", ".mov", ".webm",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".so", ".dll", ".dylib", ".class", ".o", ".a", ".lib",
  ".exe", ".bin",
]);

/**
 * Compile a tiny file-name filter to a predicate. Supports `*` (any chars
 * except `.`) and `{a,b}` alternation — enough for the agent's two
 * common needs: `*.ts` and `*.{ts,tsx}`.
 */
function compileNameFilter(pattern: string): ((name: string) => boolean) | null {
  // Convert brace groups to regex alternation. We do this with a tiny
  // state machine to handle nested braces correctly.
  const expand = (s: string): string => {
    let out = "";
    let i = 0;
    while (i < s.length) {
      const c = s[i]!;
      if (c === "{") {
        const close = findMatchingBrace(s, i);
        if (close === -1) return s; // malformed → fall through
        const inner = s.slice(i + 1, close);
        const alts = splitTopLevel(inner, ",");
        out += "(?:" + alts.map(expand).join("|") + ")";
        i = close + 1;
        continue;
      }
      if (c === "*") { out += "[^.]*"; i += 1; continue; }
      if (c === "." || c === "(" || c === ")" || c === "+" || c === "?" || c === "|" || c === "^" || c === "$" || c === "\\") {
        out += `\\${c}`;
        i += 1;
        continue;
      }
      out += c;
      i += 1;
    }
    return out;
  };
  let reSrc: string;
  try { reSrc = expand(pattern); } catch { return null; }
  const compiled = new RegExp(`^${reSrc}$`);
  return (name) => compiled.test(name);
}

function findMatchingBrace(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    if (c === sep && depth === 0) { parts.push(buf); buf = ""; continue; }
    buf += c;
  }
  parts.push(buf);
  return parts;
}


/**
 * Refuse a pattern that backtracks catastrophically, before it is ever run on
 * real files.
 *
 * The pattern comes from the model, and the model's idea of a pattern can come
 * from a file it just read or a page it just fetched — so `(a+)+$` is a thing
 * that can arrive here without anyone hostile being involved. JavaScript's
 * regex engine has no timeout: one `test()` on the wrong pattern pins the
 * sidecar's single thread for minutes or hours, and everything else the agent
 * was doing — connectors, cron, the current conversation — stops with it.
 *
 * ponytail: an empirical canary, not a regex parser. We run the pattern against
 * short strings built to provoke backtracking and time it. That catches the
 * classic shapes without a new dependency and without rejecting the many
 * legitimate patterns a static "nested quantifier" rule would refuse. A pattern
 * that only explodes on input unlike the canaries still gets through — swap in
 * a linear-time engine (RE2) if that ever shows up in practice.
 */
function isCatastrophic(regex: RegExp): boolean {
  const CANARY_BUDGET_MS = 50;
  const canaries = [
    "a".repeat(32) + "!",
    "ab".repeat(16) + "!",
    "0".repeat(32) + "!",
    " ".repeat(32) + "!",
  ];
  for (const canary of canaries) {
    const started = Date.now();
    try {
      // `lastIndex` is irrelevant here: the tool builds a non-global regex.
      regex.test(canary);
    } catch {
      return false;
    }
    if (Date.now() - started > CANARY_BUDGET_MS) return true;
  }
  return false;
}
