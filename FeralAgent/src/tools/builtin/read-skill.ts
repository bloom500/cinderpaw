/**
 * read_skill — load the full body of a locally-installed skill on demand.
 *
 * Part of the Claude Code-style skills system: the agent's system prompt
 * carries only a short "Available skills" menu (id + name + description),
 * and the LLM calls this tool to load the full SKILL.md of any skill it
 * wants to apply. Body loads are bounded (MAX_BYTES) so a misbehaving model
 * cannot exfiltrate a huge file into the context.
 *
 * The id is validated against a safe character set and the resolved path is
 * double-checked (via resolveAllowedPath) to stay inside the skills
 * directory — both layers reject directory traversal before any disk read.
 */

import { readFile } from "node:fs/promises";
import { resolveAllowedPath } from "../../sandbox/tool-permissions.ts";
import type { Tool, ToolManifest } from "../../types.ts";

/** Largest skill body the tool will return, to keep transcripts bounded. */
const MAX_BYTES = 64 * 1024;

/** Safe id charset — mirrors the validator in src-tauri/src/skills.rs. */
const SAFE_ID = /^[a-z0-9_-]+$/;

/**
 * Build a read_skill tool restricted to the given skills directory. The
 * directory is the only path the tool is allowed to read.
 */
export function createReadSkillTool(skillsDir: string): Tool {
  const manifest: ToolManifest = {
    name: "read_skill",
    description:
      "Load the full body of a locally-installed skill by id. The system prompt's " +
      "'Available skills' menu lists ids you can call this with. Use it before " +
      "applying a skill so you can follow its instructions exactly.",
    permissions: ["fs:read"],
    networkAccess: false,
    allowedPaths: [skillsDir],
  };

  return {
    manifest,
    parameters: {
      id: {
        type: "string",
        description:
          "The skill id (from the 'Available skills' menu). Lowercase letters, digits, hyphens, underscores only.",
        required: true,
      },
    },
    async execute(args, ctx) {
      const id = args.id;
      if (typeof id !== "string" || !id.trim()) {
        return {
          ok: false,
          content: "read_skill requires a non-empty 'id' string.",
          error: "bad_args",
        };
      }
      if (!SAFE_ID.test(id)) {
        return {
          ok: false,
          content:
            `invalid skill id "${id}" (only a-z, 0-9, -, _ are allowed).`,
          error: "bad_args",
        };
      }

      // resolveAllowedPath rejects any path that escapes `skillsDir` (and
      // audits the attempt), giving us a second traversal guard on top of
      // the id regex.
      const safePath = resolveAllowedPath(
        ctx.manifest,
        "fs:read",
        `${skillsDir.replace(/\/+$/, "")}/${id}/SKILL.md`,
      );

      let buf: Buffer;
      try {
        buf = await readFile(safePath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return {
            ok: false,
            content: `skill "${id}" is not installed (no SKILL.md found).`,
            error: "not_found",
          };
        }
        return {
          ok: false,
          content: `failed to read skill "${id}": ${String(err)}`,
          error: "io_error",
        };
      }

      const truncated = buf.byteLength > MAX_BYTES;
      const text = buf.toString("utf8", 0, MAX_BYTES);
      return {
        ok: true,
        content: truncated
          ? `${text}\n\n[truncated at ${MAX_BYTES} bytes]`
          : text,
        data: { id, path: safePath, bytes: buf.byteLength, truncated },
      };
    },
  };
}
