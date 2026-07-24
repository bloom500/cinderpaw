/**
 * read_file — a filesystem read tool gated by the sandbox.
 *
 * Declares the `fs:read` permission and a set of allowed roots. Every path the
 * agent supplies is resolved and checked against those roots
 * (resolveAllowedPath), so directory-traversal out of the sandbox is rejected
 * and audited before any disk access happens.
 */

import { readFile } from "node:fs/promises";
import { resolveAllowedPath } from "../../egress/tool-permissions.ts";
import { noteRead } from "../read-ledger.ts";
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
      "Read the contents of a UTF-8 text file. " +
      (allowedPaths.length > 0
        ? `Reads are allowed ONLY inside these directories: ${allowedPaths.join(", ")}. ` +
          "A path outside them is refused — never guess a directory; use one of these roots."
        : "No readable directories are configured, so every read will be refused."),
    permissions: ["fs:read"],
    networkAccess: false,
    allowedPaths,
  };

  return {
    manifest,
    parameters: {
      path: {
        type: "string",
        description:
          allowedPaths.length > 0
            ? `Absolute path to the file, inside one of the allowed directories (${allowedPaths.join(", ")}).`
            : "Absolute path to the file to read.",
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

      // Satisfies the read-before-edit gate in edit_file / write_file.
      // Deliberately recorded even for a TRUNCATED read: the agent has seen
      // the head of the file, and edit_file matches an exact old_string that
      // must appear in what it saw. A blind whole-file write_file over a
      // truncated read is the risky case, and that one is on the prompt.
      noteRead(ctx.sessionId, safePath);

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
