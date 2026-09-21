/**
 * delete_skill: the undo of create_skill.
 *
 * A skill the person taught by mistake, or that stopped being true, used to be
 * removable only by hand in the Skills drawer; the agent could offer to keep
 * one and never to drop one (20 Sep). Same directory, same id rule, and the
 * same guard the drawer applies: only a skill that is a plain `<id>/SKILL.md`
 * under the skills root goes, nothing outside it. The person confirms first,
 * because a deletion is not undone by a second call.
 */
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveAllowedPath } from "../../egress/tool-permissions.ts";
import type { Tool, ToolManifest } from "../../types.ts";

const SAFE_ID = /^[a-z0-9_-]+$/;

export function createDeleteSkillTool(skillsDir: string): Tool {
  const manifest: ToolManifest = {
    name: "delete_skill",
    description:
      "Remove a skill by id (the folder name shown by list_skills), the reverse of " +
      "create_skill. Ask the person first: it cannot be undone. Only skills under the " +
      "user's skills folder can be removed; bundled tools cannot.",
    permissions: ["fs:write"],
    networkAccess: false,
    allowedPaths: [skillsDir],
  };
  return {
    manifest,
    parameters: {
      id: { type: "string", description: "The skill id, as listed by list_skills.", required: true },
    },
    async execute(args, ctx) {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!SAFE_ID.test(id)) {
        return { ok: false, content: "delete_skill needs an id of lowercase letters, digits, - or _.", error: "bad_args" };
      }
      const dir = join(skillsDir, id);
      // Resolved through the permission layer, so `..` and symlinks out of the
      // skills root are refused there, not here.
      const file = resolveAllowedPath(ctx.manifest, "fs:write", join(dir, "SKILL.md"));
      try {
        await stat(file);
      } catch {
        return { ok: false, content: `No skill "${id}" is installed.`, error: "not_found" };
      }
      await rm(dir, { recursive: true, force: true });
      return { ok: true, content: `Removed skill "${id}". It is gone from list_skills and from the Skills drawer.`, data: { id } };
    },
  };
}
