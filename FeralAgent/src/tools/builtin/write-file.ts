/**
 * write_file — creates or overwrites a file inside the sandbox.
 *
 * Requires `fs:write` permission. The path is validated against `allowedPaths`
 * before any disk access (resolveAllowedPath with "fs:write"), so traversal
 * out of the workspace is refused and audited by the registry.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveAllowedPath } from "../../egress/tool-permissions.ts";
import type { Tool, ToolManifest } from "../../types.ts";

const MAX_WRITE_BYTES = 1024 * 1024; // 1 MB guard

export function createWriteFileTool(allowedPaths: string[]): Tool {
  const manifest: ToolManifest = {
    name: "write_file",
    description:
      "Create or overwrite a UTF-8 text file inside an allowed directory. " +
      "Creates intermediate directories if needed.",
    permissions: ["fs:write"],
    networkAccess: false,
    allowedPaths,
  };

  return {
    manifest,
    parameters: {
      path: {
        type: "string",
        description: "Absolute path to the file to write.",
        required: true,
      },
      content: {
        type: "string",
        description: "Text content to write.",
        required: true,
      },
    },
    async execute(args, ctx) {
      const requested = args.path;
      const content = args.content;

      if (typeof requested !== "string" || !requested.trim()) {
        return { ok: false, content: "write_file requires a non-empty 'path' string.", error: "bad_args" };
      }
      if (typeof content !== "string") {
        return { ok: false, content: "write_file requires a 'content' string.", error: "bad_args" };
      }
      if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
        return { ok: false, content: `Content exceeds the 1 MB write limit.`, error: "too_large" };
      }

      const safePath = resolveAllowedPath(ctx.manifest, "fs:write", requested);

      await mkdir(dirname(safePath), { recursive: true });
      await writeFile(safePath, content, "utf8");

      return {
        ok: true,
        content: `Written ${Buffer.byteLength(content, "utf8")} bytes to ${safePath}`,
        data: { path: safePath, bytes: Buffer.byteLength(content, "utf8") },
      };
    },
  };
}
