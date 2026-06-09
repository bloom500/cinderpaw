/**
 * file_search — glob-style file finder (no content).
 *
 * Walks an allowed directory recursively, matching each entry's path
 * against a shell-style glob. Returns paths (relative to the search root
 * by default) plus per-entry metadata. Stops at `max_results` to avoid
 * hammering the host filesystem; the result reports `truncated` when the
 * cap was hit so the caller can re-issue with a tighter pattern.
 *
 * Glob syntax is intentionally small (no `**` / `?` / character classes
 * beyond `*`) — enough for "find me all .ts files" and "everything under
 * src/components" without dragging in a full minimatch implementation.
 *
 * Requires `fs:read`.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { resolveAllowedPath, firstAllowedPath } from "../../sandbox/tool-permissions.ts";
import type { Tool, ToolManifest } from "../../types.ts";

const DEFAULT_MAX_RESULTS = 200;
const ABSOLUTE_MAX_RESULTS = 5_000;
const MAX_DEPTH = 8; // bound recursion like scan_workspace does

export function createFileSearchTool(allowedPaths: string[]): Tool {
  const manifest: ToolManifest = {
    name: "file_search",
    description:
      "Find files and directories by glob pattern under an allowed path. " +
      "Pattern uses shell-style `*` (any segment chars except `/`). " +
      "Example: `src/**/*.ts` matches every `.ts` file under `src/`.",
    permissions: ["fs:read"],
    networkAccess: false,
    allowedPaths,
  };

  return {
    manifest,
    parameters: {
      pattern: {
        type: "string",
        description:
          "Glob pattern. `*` matches any chars except the path separator; " +
          "`**` matches any number of segments (including none).",
        required: true,
      },
      path: {
        type: "string",
        description: "Absolute path of the directory to search. Defaults to the first allowed root.",
        required: false,
      },
      max_results: {
        type: "number",
        description: "Cap on the number of results (default 200, hard max 5000).",
        required: false,
      },
      include_dirs: {
        type: "boolean",
        description: "When true, directories are included in the results (default: files only).",
        required: false,
      },
    },
    async execute(args, ctx) {
      const pattern = args.pattern;
      const includeDirs = args.include_dirs === true;
      const max = Math.min(
        Math.max(
          typeof args.max_results === "number" ? Math.floor(args.max_results) : DEFAULT_MAX_RESULTS,
          1,
        ),
        ABSOLUTE_MAX_RESULTS,
      );

      if (typeof pattern !== "string" || !pattern.trim()) {
        return { ok: false, content: "file_search requires a non-empty 'pattern' string.", error: "bad_args" };
      }

      // The search root defaults to the first allowed path so the tool
      // works without the caller having to know the workspace root.
      const requestedRoot = typeof args.path === "string" && args.path.trim()
        ? args.path
        : (firstAllowedPath(ctx.manifest) ?? "");
      if (!requestedRoot) {
        return { ok: false, content: "file_search needs a 'path' or an allowed root in the manifest.", error: "bad_args" };
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

      const matcher = compileGlob(pattern);
      if (!matcher) {
        return { ok: false, content: `Invalid glob pattern: ${pattern}`, error: "bad_args" };
      }

      const hits: { path: string; type: "file" | "dir"; size?: number }[] = [];
      const truncated = false;

      const visit = (dir: string, depth: number): void => {
        if (depth > MAX_DEPTH) return;
        if (hits.length >= max) return;
        let entries: string[];
        try { entries = readdirSync(dir); } catch { return; }
        for (const name of entries) {
          if (hits.length >= max) return;
          // Skip dot-dirs and the usual noise. Hidden files inside a
          // searched dir can still be matched explicitly via ".*".
          if (name.startsWith(".") && !pattern.startsWith(".")) continue;
          const full = join(dir, name);
          let stat;
          try { stat = statSync(full); } catch { continue; }
          const rel = relative(root, full).split(sep).join("/");
          const isDir = stat.isDirectory();
          if (!isDir || includeDirs) {
            if (matcher(rel)) {
              hits.push({
                path: full,
                type: isDir ? "dir" : "file",
                size: isDir ? undefined : stat.size,
              });
            }
          }
          if (isDir) visit(full, depth + 1);
        }
      };

      try {
        visit(root, 0);
      } catch (err) {
        return { ok: false, content: `Search failed: ${String(err)}`, error: "io_error" };
      }

      const lines = hits.map((h) =>
        h.type === "dir"
          ? `  ${relative(root, h.path) || "."}/`
          : `  ${relative(root, h.path) || "."} (${h.size ?? "?"}b)`,
      );
      const summary = truncated
        ? `${root} — showing first ${max} of (more available):\n${lines.join("\n")}`
        : `${root} — ${hits.length} match(es) for "${pattern}":\n${lines.join("\n")}`;

      return {
        ok: true,
        content: summary,
        data: { results: hits, truncated: hits.length >= max, root },
      };
    },
  };
}

/**
 * Compile a tiny glob pattern to a predicate. Supports `*` (any chars
 * except `/`) and `**` (any number of segments, including zero). No
 * character classes or `?` — the agent is encouraged to use narrow
 * patterns anyway, and anything fancier would need a real minimatch.
 *
 * Returns null if the pattern is malformed (e.g. an unterminated escape).
 */
function compileGlob(pattern: string): ((relPath: string) => boolean) | null {
  // We translate the glob into a regex over the full relative path (with
  // forward slashes). `**` is the only construct that needs special care
  // — it must be able to span `/`.
  const re = globToRegex(pattern);
  if (!re) return null;
  const compiled = new RegExp(`^${re}$`);
  return (relPath: string) => compiled.test(relPath);
}

function globToRegex(pattern: string): string | null {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**` matches any number of segments, including slashes.
        // It must be followed by `/` (or end of pattern) to be a
        // segment-spanning wildcard; otherwise it collapses to `*`.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (c === "/") {
      out += "/";
      i += 1;
      continue;
    }
    if (c === "." || c === "(" || c === ")" || c === "+" || c === "?" || c === "|" || c === "^" || c === "$" || c === "{" || c === "}" || c === "\\") {
      out += `\\${c}`;
      i += 1;
      continue;
    }
    if (c === "[") {
      // A very small character-class implementation: `[abc]` or `[a-z]`.
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) return null;
      out += pattern.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}
