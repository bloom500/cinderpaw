/**
 * write_file — creates or overwrites a file inside the sandbox.
 *
 * Requires `fs:write` permission. The path is validated against `allowedPaths`
 * before any disk access (resolveAllowedPath with "fs:write"), so traversal
 * out of the workspace is refused and audited by the registry.
 */

import { readFile, mkdir } from "node:fs/promises";
import { atomicWriteFile } from "../../atomic-write.ts";
import { dirname } from "node:path";
import { resolveAllowedPath } from "../../egress/tool-permissions.ts";
import { checkBeforeWrite, noteWrite } from "../read-ledger.ts";
import { lineDelta, isScratchPath, scratchpadBrief } from "../file-delta.ts";
import type { Tool, ToolManifest } from "../../types.ts";

const MAX_WRITE_BYTES = 1024 * 1024; // 1 MB guard

export function createWriteFileTool(allowedPaths: string[]): Tool {
  const manifest: ToolManifest = {
    name: "write_file",
    description:
      "Create or overwrite a UTF-8 text file. Creates intermediate directories if needed. " +
      (allowedPaths.length > 0
        ? `Writes are allowed ONLY inside these directories: ${allowedPaths.join(", ")}. ` +
          "A path outside them is refused — never guess a directory; use one of these roots.\n" +
          scratchpadBrief()
        : "No writable directories are configured, so every write will be refused."),
    permissions: ["fs:write"],
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
            : "Absolute path to the file to write.",
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

      // Idempotency: if the file already holds exactly this content, skip the
      // write. Always safe (the on-disk result is identical either way), and it
      // makes a replayed write after a crash/retry a no-op instead of a
      // redundant disk churn + mtime bump that could retrigger watchers.
      // Kept beyond the idempotency check so the line delta below is free: this
      // read is the only one either write path makes, and the telemetry needs
      // exactly the "before" it already has in hand.
      let previous = "";
      try {
        previous = await readFile(safePath, "utf8");
        if (previous === content) {
          return {
            ok: true,
            content: `Unchanged — ${safePath} already contains exactly this content (${Buffer.byteLength(content, "utf8")} bytes), nothing written.`,
            data: {
              path: safePath,
              bytes: Buffer.byteLength(content, "utf8"),
              skipped: true,
              linesAdded: 0,
              linesRemoved: 0,
              scratch: isScratchPath(safePath),
            },
          };
        }
      } catch {
        // Not readable (absent, or binary/permission) — fall through and write.
        // `previous` stays "", so a brand-new file reads as all-added.
      }

      // Read-before-overwrite gate, deliberately AFTER the idempotency check.
      // `checkBeforeWrite` returns null when the path does not exist, so
      // CREATING a file is untouched; the gate only stands between the agent
      // and clobbering a file it never looked at. This is the sharper of the
      // two write paths — write_file replaces the whole body, so an unread
      // overwrite destroys everything it did not know was there.
      //
      // The ordering is load-bearing: crash-resume REPLAYS writes, in a fresh
      // process whose ledger is empty. A replay whose content already matches
      // disk exited above as a no-op; gating before that would have turned
      // every resumed write into a hard failure, breaking the very walk-away
      // recovery this gate exists to protect. See read-ledger.ts.
      const stale = checkBeforeWrite(ctx.sessionId, safePath);
      if (stale) {
        return { ok: false, content: `write_file: ${stale}`, error: "unread_file" };
      }

      await mkdir(dirname(safePath), { recursive: true });
      await atomicWriteFile(safePath, content);
      // Our own write must not make a follow-up edit look stale.
      noteWrite(ctx.sessionId, safePath);

      const delta = lineDelta(previous, content);
      return {
        ok: true,
        content: `Written ${Buffer.byteLength(content, "utf8")} bytes to ${safePath}`,
        data: {
          path: safePath,
          bytes: Buffer.byteLength(content, "utf8"),
          linesAdded: delta.added,
          linesRemoved: delta.removed,
          scratch: isScratchPath(safePath),
        },
      };
    },
  };
}
