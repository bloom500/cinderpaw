/**
 * create_skill: the write half of the skills drawer, used by the "Teach" flow.
 * A taught skill must land where list_skills finds it, in the shape it parses,
 * and must be refused for exactly what read_skill would refuse later.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCreateSkillTool } from "../src/tools/builtin/create-skill.ts";
import { createListSkillsTool } from "../src/tools/builtin/list-skills.ts";

const ctxFor = (tool: { manifest: unknown }) =>
  ({ sessionId: "s", manifest: tool.manifest, fetch: (() => Promise.reject(new Error("not used"))) as never, audit: () => {} }) as never;

describe("create_skill", () => {
  test("writes a SKILL.md that list_skills then lists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cinderpaw-create-skill-"));
    try {
      const tool = createCreateSkillTool(dir);
      const r = await tool.execute(
        { id: "weekly-report", name: "Weekly report", description: "How the Monday report is written.", body: "# Steps\n\n1. Read the log.\n2. Three bullets, no adjectives." },
        ctxFor(tool),
      );
      expect(r.ok).toBe(true);
      const text = readFileSync(join(dir, "weekly-report", "SKILL.md"), "utf8");
      expect(text.startsWith("---\nname: Weekly report\ndescription: How the Monday report is written.\n---\n")).toBe(true);

      const list = createListSkillsTool(dir, () => []);
      const listed = await list.execute({}, ctxFor(list));
      expect(listed.content).toContain("weekly-report");
      expect(listed.content).toContain("Weekly report");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a bad id, an existing id, and a body read_skill would reject", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cinderpaw-create-skill-"));
    try {
      const tool = createCreateSkillTool(dir);
      const ok = { name: "n", description: "d", body: "fine" };
      expect((await tool.execute({ id: "../escape", ...ok }, ctxFor(tool))).error).toBe("bad_args");
      expect((await tool.execute({ id: "a", ...ok, body: "<script>x</script>" }, ctxFor(tool))).error).toBe("rejected");
      expect((await tool.execute({ id: "a", ...ok }, ctxFor(tool))).ok).toBe(true);
      expect((await tool.execute({ id: "a", ...ok }, ctxFor(tool))).error).toBe("exists");
      expect((await tool.execute({ id: "a", ...ok, overwrite: true }, ctxFor(tool))).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("delete_skill", () => {
  test("removes a taught skill, refuses an unknown id and a path outside the skills root", async () => {
    const { createDeleteSkillTool } = await import("../src/tools/builtin/delete-skill.ts");
    const { existsSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "cinderpaw-delete-skill-"));
    try {
      const create = createCreateSkillTool(dir);
      await create.execute(
        { id: "oops", name: "Oops", description: "Taught by mistake.", body: "# Steps\n\n1. Nothing." },
        ctxFor(create),
      );
      const del = createDeleteSkillTool(dir);
      const gone = await del.execute({ id: "oops" }, ctxFor(del));
      expect(gone.ok).toBe(true);
      expect(existsSync(join(dir, "oops"))).toBe(false);

      const missing = await del.execute({ id: "oops" }, ctxFor(del));
      expect(missing.ok).toBe(false);
      expect(missing.error).toBe("not_found");

      const outside = await del.execute({ id: "../etc" }, ctxFor(del));
      expect(outside.ok).toBe(false);
      expect(outside.error).toBe("bad_args");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
