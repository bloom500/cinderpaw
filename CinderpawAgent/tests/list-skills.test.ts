import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createListSkillsTool } from "../src/tools/builtin/list-skills.ts";

let dir: string;
const ctx = { manifest: {} as any } as any;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cinderpaw-skills-"));
  await mkdir(join(dir, "pdf-wizard"));
  await writeFile(
    join(dir, "pdf-wizard", "SKILL.md"),
    "---\nname: PDF Wizard\ndescription: Extract and merge PDF files\n---\nbody",
  );
  await mkdir(join(dir, "email-sender"));
  await writeFile(
    join(dir, "email-sender", "SKILL.md"),
    "---\nname: Email Sender\ndescription: Send transactional email\n---\nbody",
  );
  // A directory with no SKILL.md must be skipped, not listed.
  await mkdir(join(dir, "not-a-skill"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("list_skills", () => {
  it("lists installed skills with name + description, skips dirs without SKILL.md", async () => {
    const tool = createListSkillsTool(dir);
    const res = await tool.execute({}, ctx);
    expect(res.ok).toBe(true);
    expect(res.content).toContain("`pdf-wizard` — PDF Wizard: Extract and merge PDF files");
    expect(res.content).toContain("`email-sender` — Email Sender: Send transactional email");
    expect(res.content).not.toContain("not-a-skill");
  });

  it("filters by query (case-insensitive, across id/name/description)", async () => {
    const tool = createListSkillsTool(dir);
    const res = await tool.execute({ query: "PDF" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.content).toContain("pdf-wizard");
    expect(res.content).not.toContain("email-sender");
  });

  it("reports cleanly when nothing matches", async () => {
    const tool = createListSkillsTool(dir);
    const res = await tool.execute({ query: "nonexistent-zzz" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/No installed skills match/);
  });

  it("handles a missing skills directory", async () => {
    const tool = createListSkillsTool(join(dir, "does-not-exist"));
    const res = await tool.execute({}, ctx);
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/No skills are installed/);
  });
});
