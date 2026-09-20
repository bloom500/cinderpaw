/**
 * create_skill: the agent writes a SKILL.md of its own, the "Teach" flow.
 *
 * `read_skill` and `list_skills` could only read what a person had installed
 * from the drawer; the tip above the composer promised "teach Cinderpaw a
 * task" and nothing on the agent's side could keep that promise. This is the
 * write half: id, name, description and a markdown body go to
 * `<skills>/<id>/SKILL.md` with the same frontmatter the drawer and
 * `list_skills` already parse, so a skill taught in a chat shows up next to an
 * installed one with no extra plumbing.
 *
 * Same guards as the read side, on purpose: the id regex and
 * `resolveAllowedPath` keep the path inside the skills dir, and
 * `validateSkillContent` refuses a body that `read_skill` would refuse later,
 * so a taught skill cannot smuggle in what an imported one cannot.
 */
import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { resolveAllowedPath } from "../../egress/tool-permissions.ts";
import { validateSkillContent } from "./read-skill.ts";
import type { Tool, ToolManifest } from "../../types.ts";

const SAFE_ID = /^[a-z0-9_-]+$/;
/** Same ceiling as read_skill: a body it could not load back is not a skill. */
const MAX_BYTES = 64 * 1024;

/** The file as the drawer and list_skills expect it: frontmatter, then body. */
export function renderSkillFile(name: string, description: string, body: string): string {
  const line = (s: string) => s.replace(/\s+/g, " ").trim();
  return `---\nname: ${line(name)}\ndescription: ${line(description)}\n---\n\n${body.trim()}\n`;
}

export function createCreateSkillTool(skillsDir: string): Tool {
  const manifest: ToolManifest = {
    name: "create_skill",
    description:
      "Save a new skill the person has taught you: a SKILL.md with a name, a one-line " +
      "description and step-by-step instructions in markdown. Use it once you know " +
      "exactly how they want the task done; ask first if you do not. The skill appears " +
      "in list_skills and in the Skills drawer immediately. Refuses to overwrite an " +
      "existing id unless overwrite is true.",
    permissions: ["fs:write"],
    networkAccess: false,
    allowedPaths: [skillsDir],
  };

  return {
    manifest,
    parameters: {
      id: {
        type: "string",
        description: "Short id for the folder: lowercase letters, digits, hyphens, underscores. E.g. weekly-report.",
        required: true,
      },
      name: { type: "string", description: "Human name shown in the drawer.", required: true },
      description: {
        type: "string",
        description: "One line: when to use this skill. list_skills shows it, so make it specific.",
        required: true,
      },
      body: {
        type: "string",
        description: "The instructions, in markdown: the steps, the format wanted, what to avoid. No HTML.",
        required: true,
      },
      overwrite: { type: "boolean", description: "Replace an existing skill with this id.", required: false },
    },
    async execute(args, ctx) {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      const name = typeof args.name === "string" ? args.name.trim() : "";
      const description = typeof args.description === "string" ? args.description.trim() : "";
      const body = typeof args.body === "string" ? args.body : "";
      if (!id || !name || !description || !body.trim()) {
        return { ok: false, content: "create_skill needs id, name, description and body.", error: "bad_args" };
      }
      if (!SAFE_ID.test(id)) {
        return { ok: false, content: `invalid skill id "${id}" (only a-z, 0-9, -, _ are allowed).`, error: "bad_args" };
      }
      const text = renderSkillFile(name, description, body);
      if (Buffer.byteLength(text) > MAX_BYTES) {
        return { ok: false, content: `skill is too long (over ${MAX_BYTES} bytes). Split it or shorten it.`, error: "too_large" };
      }
      const why = validateSkillContent(text);
      if (why) {
        return { ok: false, content: `skill body rejected (${why}): no HTML tags and no system-prompt overrides.`, error: "rejected" };
      }

      const dir = join(skillsDir, id);
      const safePath = resolveAllowedPath(ctx.manifest, "fs:write", join(dir, "SKILL.md"));
      if (args.overwrite !== true) {
        try {
          await access(safePath);
          return { ok: false, content: `skill "${id}" already exists. Pass overwrite: true to replace it.`, error: "exists" };
        } catch {
          // not there: fine
        }
      }
      await mkdir(dir, { recursive: true });
      await writeFile(safePath, text, "utf8");
      return { ok: true, content: `Saved skill "${name}" as ${id}. It is listed by list_skills and in the Skills drawer.`, data: { id } };
    },
  };
}
