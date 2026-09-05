/**
 * read_file — a filesystem read tool gated by the sandbox.
 *
 * Declares the `fs:read` permission and a set of allowed roots. Every path the
 * agent supplies is resolved and checked against those roots
 * (resolveAllowedPath), so directory-traversal out of the sandbox is rejected
 * and audited before any disk access happens.
 */

import { open, readFile, stat } from "node:fs/promises";
import { resolveAllowedPath } from "../../egress/tool-permissions.ts";
import { noteRead } from "../read-ledger.ts";
import type { Tool, ToolManifest } from "../../types.ts";

/** Largest file the tool will return, to keep transcripts bounded. */
const MAX_BYTES = 64 * 1024;

/**
 * Largest file we are willing to pull into memory whole.
 *
 * `readFile` ignores MAX_BYTES: it loads everything and only then trims to
 * 64 KB, so a GGUF model or a big log inside an allowed root took the sidecar
 * down with an out-of-memory kill before the cap it already had could apply.
 * Under this ceiling we still read the whole file, because that is what makes
 * the exact line count possible; over it we read only the head.
 */
const MAX_SLURP_BYTES = 8 * 1024 * 1024;

/**
 * Image files, by extension, and what MIME type to send them as.
 *
 * A PNG read as UTF-8 is mojibake with line numbers on it — the tool used to
 * return exactly that, and the model would then try to recover the picture from
 * the garbage. Every mainstream vision API accepts these four, so an image goes
 * to the model as pixels instead.
 */
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Largest image we will inline. Above this the providers reject the request
 * anyway (5 MB is the common ceiling), and a refusal that names the size is
 * something the agent can act on - resize it, or crop the part that matters.
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * `cat -n` layout: right-aligned line number, tab, content.
 *
 * Measured, three clean live runs asked for the line counts of two files they
 * had just read in full. The 227-line file came back as 194, 227, 213; the
 * 146-line one as 148, 146, 140. One run in three, and the near-misses are the
 * tell: it was not inventing the files — every summary was accurate — it was
 * COUNTING them, from raw text, and no model counts hundreds of lines by eye.
 * Nothing in the old output told it that, so it guessed with the same
 * confidence it uses for things it knows.
 *
 * With the numbers: 3 of 3, both files, same question, same model.
 *
 * With numbers, "how many lines" stops being arithmetic and becomes reading.
 * The header carries the exact total, because the LAST number is only the
 * total when the read was not cut short.
 *
 * Deliberately the format models have seen most: `edit_file` matching depends
 * on the model knowing to strip this prefix, and an invented layout is one it
 * has never been taught to strip.
 */
function numberLines(text: string): string {
  const lines = text.split("\n");
  // A file ending in a newline yields a trailing "" that `cat -n` does not
  // number, and numbering it would report one line too many — which is the
  // exact error class this function exists to remove.
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const width = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(width, " ")}\t${l}`).join("\n");
}

/** Lines in the whole file, counted the way `wc -l` counts them. */
function countLines(text: string): number {
  if (text === "") return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

/**
 * Build a read_file tool restricted to the given absolute roots. Callers pass
 * the directories the agent is permitted to read (e.g. a workspace folder).
 */
export function createReadFileTool(allowedPaths: string[]): Tool {
  const manifest: ToolManifest = {
    name: "read_file",
    description:
      "Read the contents of a file. A UTF-8 text file comes back as a header " +
      "giving the file's exact line count, then the lines prefixed `N<tab>` " +
      "like `cat -n`. Those prefixes are NOT part of the file: strip them " +
      "before passing text to edit_file or write_file. An image file " +
      "(.png/.jpg/.jpeg/.gif/.webp) comes back as the image itself, so read " +
      "one instead of trying to decode its bytes. " +
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

      const size = (await stat(safePath)).size;

      // An image is returned as pixels, not as text. Whether the model can
      // actually SEE them depends on the route it is on; a text-only model gets
      // the note and nothing else, which is at least honest about what it has.
      const dot = safePath.lastIndexOf(".");
      const mediaType = dot >= 0 ? IMAGE_TYPES[safePath.slice(dot).toLowerCase()] : undefined;
      if (mediaType) {
        if (size > MAX_IMAGE_BYTES) {
          return {
            ok: false,
            content:
              `${safePath} is a ${mediaType} image of ${size} bytes, over the ` +
              `${MAX_IMAGE_BYTES}-byte limit for an image. Resize or crop it ` +
              `(e.g. with a shell command) and read the smaller file.`,
            error: "too_large",
          };
        }
        const bytes = await readFile(safePath);
        noteRead(ctx.sessionId, safePath);
        return {
          ok: true,
          content: `${safePath} — ${mediaType} image, ${size} bytes. It is attached below; describe what it shows before acting on it.`,
          images: [`data:${mediaType};base64,${bytes.toString("base64")}`],
          data: { path: safePath, bytes: size, mediaType },
        };
      }

      let buf: Buffer;
      let totalLines: number | null;
      if (size <= MAX_SLURP_BYTES) {
        buf = await readFile(safePath);
        // The whole file is already in memory, so the true total costs nothing
        // and is the one number that was being guessed.
        totalLines = countLines(buf.toString("utf8"));
      } else {
        // Too big to hold. Read the head only; the exact line count is not
        // knowable without walking the file, and saying so beats guessing.
        const handle = await open(safePath, "r");
        try {
          const head = Buffer.alloc(MAX_BYTES);
          const { bytesRead } = await handle.read(head, 0, MAX_BYTES, 0);
          buf = head.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }
        totalLines = null;
      }
      const truncated = size > MAX_BYTES;
      const text = buf.toString("utf8", 0, Math.min(buf.byteLength, MAX_BYTES));

      // Satisfies the read-before-edit gate in edit_file / write_file.
      // Deliberately recorded even for a TRUNCATED read: the agent has seen
      // the head of the file, and edit_file matches an exact old_string that
      // must appear in what it saw. A blind whole-file write_file over a
      // truncated read is the risky case, and that one is on the prompt.
      noteRead(ctx.sessionId, safePath);

      const body = numberLines(text);
      const shown = countLines(text);
      const lineLabel = totalLines === null ? "?" : String(totalLines);
      const notShown =
        totalLines === null ? "the rest" : `${totalLines - shown} lines`;
      return {
        ok: true,
        content: truncated
          ? `${safePath} — ${lineLabel} lines, ${size} bytes; showing lines 1-${shown} ` +
            `(first ${MAX_BYTES} bytes)\n${body}\n\n[truncated at ${MAX_BYTES} bytes — ` +
            `${notShown} not shown]`
          : `${safePath} — ${lineLabel} lines, ${size} bytes\n${body}`,
        data: { path: safePath, bytes: size, lines: totalLines, truncated },
      };
    },
  };
}
