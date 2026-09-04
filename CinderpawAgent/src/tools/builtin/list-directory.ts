/**
 * list_directory — lists files and folders inside the sandbox.
 *
 * Requires `fs:read` permission. The path is validated against `allowedPaths`
 * before any disk access. Returns a flat listing with file type and size.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveAllowedPath } from "../../egress/tool-permissions.ts";
import type { Tool, ToolManifest } from "../../types.ts";

const MAX_ENTRIES = 200;

export function createListDirectoryTool(allowedPaths: string[]): Tool {
  const manifest: ToolManifest = {
    name: "list_directory",
    description:
      "List the contents of a directory inside an allowed path. " +
      "Returns names, types (file/dir), and sizes.",
    permissions: ["fs:read"],
    networkAccess: false,
    allowedPaths,
  };

  return {
    manifest,
    parameters: {
      path: {
        type: "string",
        description: "Absolute path to the directory to list.",
        required: true,
      },
    },
    async execute(args, ctx) {
      const requested = args.path;
      if (typeof requested !== "string" || !requested.trim()) {
        return { ok: false, content: "list_directory requires a non-empty 'path' string.", error: "bad_args" };
      }

      const safePath = resolveAllowedPath(ctx.manifest, "fs:read", requested);

      let entries: string[];
      try {
        entries = await readdir(safePath);
      } catch (err) {
        return { ok: false, content: `Cannot list directory: ${String(err)}`, error: "io_error" };
      }

      const limited = entries.slice(0, MAX_ENTRIES);
      const results: { name: string; type: "file" | "dir"; size?: number }[] = [];

      for (const name of limited) {
        try {
          const info = await stat(join(safePath, name));
          results.push({
            name,
            type: info.isDirectory() ? "dir" : "file",
            size: info.isFile() ? info.size : undefined,
          });
        } catch {
          results.push({ name, type: "file" });
        }
      }

      const truncated = entries.length > MAX_ENTRIES;
      const lines = results.map(
        (e) => e.type === "dir"
          ? `  ${e.name}/`
          : `  ${e.name} (${e.size ?? "?"}b)`,
      );
      const summary = truncated
        ? `${safePath} — showing ${MAX_ENTRIES} of ${entries.length} entries:\n${lines.join("\n")}`
        : `${safePath} — ${results.length} entries:\n${lines.join("\n")}`;

      return { ok: true, content: summary, data: results };
    },
  };
}
