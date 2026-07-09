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
import { resolveAllowedPath } from "../../egress/tool-permissions.ts";
import type { Tool, ToolManifest } from "../../types.ts";

/** Largest skill body the tool will return, to keep transcripts bounded. */
const MAX_BYTES = 64 * 1024;

/** Safe id charset — mirrors the validator in src-tauri/src/skills.rs. */
const SAFE_ID = /^[a-z0-9_-]+$/;

// Feral-WIP #9: skill content validation. A SKILL.md is just markdown
// the LLM reads on demand, but a malicious skill (or one imported from
// an untrusted source) could try to (a) smuggle HTML the chat renderer
// would treat as markup, or (b) override the agent's identity / system
// prompt. The validator rejects both shapes BEFORE the body reaches
// the model. The function is exported so the test suite can exercise
// the regex set directly without spinning up the full read_skill tool.
const FORBIDDEN_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // HTML the renderer would treat as markup. We deliberately leave
  // benign tags (p, code, ul, …) alone — markdown already covers them
  // and a chat renderer that doesn't sanitise is a different bug.
  { name: "html-script", re: /<\/?script\b[^>]*>/i },
  { name: "html-iframe", re: /<\/?iframe\b[^>]*>/i },
  { name: "html-object", re: /<\/?object\b[^>]*>/i },
  { name: "html-embed", re: /<\/?embed\b[^>]*>/i },
  { name: "html-style", re: /<\/?style\b[^>]*>/i },
  { name: "html-link", re: /<\/?link\b[^>]*>/i },
  { name: "html-meta", re: /<\/?meta\b[^>]*>/i },
  // SOUL.md / system-prompt override attempts. The first three cover
  // the common "ignore / forget / disregard" injection phrasings; the
  // "System:" prefix matches role-tag smuggling (some chat templates
  // treat a line starting with "System:" as a system-prompt message).
  { name: "override-ignore-previous", re: /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier|preceding)\s+instructions?\b/i },
  { name: "override-forget", re: /\bforget\s+(?:everything|all)\s+(?:above|before|prior)\b/i },
  { name: "override-disregard-soul", re: /\bdisregard\s+(?:the\s+)?(?:soul|soul\.md|system\s*prompt)\b/i },
  { name: "override-system-prefix", re: /^\s*System\s*:/im },
];

/**
 * Validate a loaded skill body. Returns null when the body is safe, or a
 * short human-readable reason string when the validator rejects it.
 * Reasons include the rule name (e.g. "html-script") so callers can
 * surface something specific in audit logs and the rejected content
 * stays blocked from the model.
 */
export function validateSkillContent(text: string): string | null {
  for (const { name, re } of FORBIDDEN_PATTERNS) {
    if (re.test(text)) return `forbidden:${name}`;
  }
  return null;
}

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
      // Feral-WIP #9: validate the body BEFORE handing it to the model.
      // The body lives in the LLM's context as a `tool` role message;
      // any HTML / system-override smuggling in here would be effectively
      // a prompt-injection vector. Reject the whole load so the model
      // never sees the malicious content.
      const violation = validateSkillContent(text);
      if (violation) {
        return {
          ok: false,
          content: `skill "${id}" content rejected by validator (${violation}); refusing to load.`,
          error: "invalid_content",
        };
      }
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
