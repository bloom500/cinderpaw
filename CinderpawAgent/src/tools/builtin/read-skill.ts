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

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolveAllowedPath } from "../../egress/tool-permissions.ts";
import type { Tool, ToolManifest } from "../../types.ts";

/** Largest skill body the tool will return, to keep transcripts bounded. */
const MAX_BYTES = 64 * 1024;

/** Safe id charset — mirrors the validator in src-tauri/src/skills.rs. */
const SAFE_ID = /^[a-z0-9_-]+$/;

// Cinderpaw-WIP #9: skill content validation. A SKILL.md is just markdown
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
      file: {
        type: "string",
        description:
          "Optional: one of the files beside SKILL.md (e.g. reference/forms.md), as listed when the skill is read. Omit to read SKILL.md.",
        required: false,
      },
    },
    async execute(args, ctx) {
      const id = args.id;
      const file = typeof args.file === "string" && args.file.trim() ? args.file.trim().replace(/\\/g, "/") : "SKILL.md";
      if (!safeRel(file)) {
        return { ok: false, content: `invalid file "${file}": use a path as listed when the skill is read.`, error: "bad_args" };
      }
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
        `${skillsDir.replace(/\/+$/, "")}/${id}/${file}`,
      );

      let buf: Buffer;
      try {
        buf = await readFile(safePath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return {
            ok: false,
            content: file === "SKILL.md"
              ? `skill "${id}" is not installed (no SKILL.md found).`
              : `skill "${id}" has no file "${file}".`,
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
      // Cinderpaw-WIP #9: validate the body BEFORE handing it to the model.
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
      // SKILL.md points at its other files by relative path ("see
      // reference/forms.md"); name them so the model can ask for one.
      const beside = file === "SKILL.md" ? await besideFiles(`${skillsDir.replace(/\/+$/, "")}/${id}`) : [];
      // A link install leaves a skill's programs behind. Told only "run
      // timemachine.py", a model with no timemachine.py printed odds for a
      // trade anyway (27 Oct review of the day-trader Reel): so name what is
      // missing, and forbid the made-up result in the same breath.
      const missing = file === "SKILL.md" ? missingPrograms(text, beside) : [];
      let content = truncated ? `${text}\n\n[truncated at ${MAX_BYTES} bytes]` : text;
      if (beside.length) content += `\n\n---\nFiles in this skill (read one with read_skill and \`file\`): ${beside.join(", ")}`;
      if (missing.length) {
        content +=
          `\n\n---\nNot installed with this skill: ${missing.join(", ")}. Steps that run these files cannot be done here. ` +
          "Tell the person so in plain words, and never estimate, simulate or make up what they would have produced " +
          "(numbers, odds, prices, results).";
      }
      return {
        ok: true,
        content,
        data: { id, path: safePath, bytes: buf.byteLength, truncated, missing },
      };
    },
  };
}

/**
 * Programs SKILL.md tells the model to run that are not in its folder. Script
 * names count anywhere (`python3 "$DIR/scan.py"`, `` `scan.py universe` ``);
 * .js/.ts only after a path or a runner, so "Node.js" is not a missing file.
 * Matched by name, since skills write their paths in many ways.
 */
function missingPrograms(text: string, beside: string[]): string[] {
  const present = new Set(beside.map((p) => p.split("/").pop()!.toLowerCase()));
  const refs = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s"'`(/])([\w-]+\.(?:py|sh|ps1|rb|mjs|cjs))\b/gm)) refs.add(m[1]!);
  for (const m of text.matchAll(/(?:\/|\b(?:node|bun|deno|tsx)\s+["']?)([\w-]+\.(?:js|ts))\b/g)) refs.add(m[1]!);
  return [...refs].filter((r) => !present.has(r.toLowerCase())).slice(0, 12);
}

/** Relative path inside a skill's folder: plain names, no `.` or `..`. */
function safeRel(p: string): boolean {
  return p.split("/").every((s) => s !== "" && s !== "." && s !== ".." && /^[A-Za-z0-9._-]+$/.test(s));
}

/** Files beside SKILL.md, relative with forward slashes. ponytail: 3 levels, 50 names. */
async function besideFiles(dir: string, rel = "", depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > 3) return out;
  let entries: Dirent[];
  try {
    entries = await readdir(rel ? `${dir}/${rel}` : dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= 50) break;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await besideFiles(dir, p, depth + 1, out);
    else if (e.isFile() && p !== "SKILL.md") out.push(p);
  }
  return out;
}
