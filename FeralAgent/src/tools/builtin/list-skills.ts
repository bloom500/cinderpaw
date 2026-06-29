/**
 * list_skills — discover locally-installed skills on demand.
 *
 * The drawer index for the skills system. The system prompt no longer carries
 * a full "Available skills" menu (it cost tokens on every single turn even when
 * the model never touched a skill). Instead the model calls this tool to list
 * installed skills — optionally filtered by a query — gets back a compact
 * `id — name: description` table, and then calls `read_skill` to load the body
 * of the one it wants.
 *
 * Self-contained: it scans the skills directory on disk (the same dir
 * `read_skill` reads from), so it needs no per-turn roster plumbing from the
 * host. Frontmatter parsing is intentionally minimal (name + description) — the
 * full body is `read_skill`'s job.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Tool, ToolManifest } from "../../types.ts";

/** Cap on skills listed, so a huge skills dir can't flood the context. */
const MAX_SKILLS = 200;
/** Bytes of each SKILL.md read for frontmatter — name/description live at the top. */
const FRONTMATTER_BYTES = 2048;

/** Pull `name:` / `description:` out of a SKILL.md's YAML-ish frontmatter head. */
function parseFrontmatter(head: string): { name: string; description: string } {
  const grab = (key: string): string => {
    const m = new RegExp(`^${key}:\\s*(.+)$`, "im").exec(head);
    return m ? m[1]!.trim().replace(/^["']|["']$/g, "") : "";
  };
  return { name: grab("name"), description: grab("description") };
}

/**
 * Build a list_skills tool restricted to the given skills directory. The
 * directory is the only path the tool reads.
 */
export function createListSkillsTool(skillsDir: string): Tool {
  const manifest: ToolManifest = {
    name: "list_skills",
    description:
      "Discover locally-installed skills. Returns a compact 'id — name: description' " +
      "list you can filter with an optional query. Call this to find a skill, then " +
      "call read_skill with the id to load its full instructions before applying it.",
    permissions: ["fs:read"],
    networkAccess: false,
    allowedPaths: [skillsDir],
  };

  return {
    manifest,
    parameters: {
      query: {
        type: "string",
        description:
          "Optional filter — only skills whose id, name, or description contains this " +
          "substring (case-insensitive) are returned. Omit to list everything.",
        required: false,
      },
    },
    async execute(args) {
      const query =
        typeof args.query === "string" ? args.query.trim().toLowerCase() : "";

      let entries: string[];
      try {
        const dirents = await readdir(skillsDir, { withFileTypes: true });
        entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return { ok: true, content: "No skills are installed." };
        }
        return {
          ok: false,
          content: `failed to list skills: ${String(err)}`,
          error: "io_error",
        };
      }

      const rows: string[] = [];
      for (const id of entries.sort()) {
        if (rows.length >= MAX_SKILLS) break;
        let name = "";
        let description = "";
        try {
          const buf = await readFile(join(skillsDir, id, "SKILL.md"));
          ({ name, description } = parseFrontmatter(
            buf.toString("utf8", 0, FRONTMATTER_BYTES),
          ));
        } catch {
          // No readable SKILL.md → skip; not an installed skill.
          continue;
        }
        const hay = `${id} ${name} ${description}`.toLowerCase();
        if (query && !hay.includes(query)) continue;
        rows.push(`- \`${id}\` — ${name || id}: ${description || "(no description)"}`);
      }

      if (rows.length === 0) {
        return {
          ok: true,
          content: query
            ? `No installed skills match "${query}".`
            : "No skills are installed.",
        };
      }
      return {
        ok: true,
        content:
          `Installed skills (${rows.length}). Call read_skill with an id to load one:\n` +
          rows.join("\n"),
        data: { count: rows.length },
      };
    },
  };
}
