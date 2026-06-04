/**
 * read_file — a filesystem read tool gated by the sandbox.
 *
 * Declares the `fs:read` permission and a set of allowed roots. Every path the
 * agent supplies is resolved and checked against those roots
 * (resolveAllowedPath), so directory-traversal out of the sandbox is rejected
 * and audited before any disk access happens.
 */

import { readFile } from "node:fs/promises";
import { resolveAllowedPath } from "../../sandbox/tool-permissions.ts";
import type { Tool, ToolManifest } from "../../types.ts";

/** Largest file the tool will return, to keep transcripts bounded. */
const MAX_BYTES = 64 * 1024;

/**
 * Build a read_file tool restricted to the given absolute roots. Callers pass
 * the directories the agent is permitted to read (e.g. a workspace folder).
 */
export function createReadFileTool(allowedPaths: string[]): Tool {
  const manifest: ToolManifest = {
    name: "read_file",
    description:
      "Read the contents of a UTF-8 text file inside an allowed directory.",
    permissions: ["fs:read"],
    networkAccess: false,
    allowedPaths,
  };

  return {
    manifest,
    parameters: {
      path: {
        type: "string",
        description: "Absolute path to the file to read.",
        required: true,
      },
    },
    async execute(args, ctx) {
      const requested = args.path;
      if (typeof requested !== "string" || !requested.trim()) {
        return {
          ok: false,
          content: "read_file requires a non-empty 'path' string.",
          error: "bad_args",
        };
      }

      // Throws PermissionDeniedError (caught by the registry) if out of bounds.
      const safePath = resolveAllowedPath(ctx.manifest, "fs:read", requested);

      const buf = await readFile(safePath);
      const truncated = buf.byteLength > MAX_BYTES;
      const text = buf.toString("utf8", 0, MAX_BYTES);

      return {
        ok: true,
        content: truncated
          ? `${text}\n\n[truncated at ${MAX_BYTES} bytes]`
          : text,
        data: { path: safePath, bytes: buf.byteLength, truncated },
      };
    },
  };
}
