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

describe("list_skills, learned procedures (competence plan §3.1)", () => {
  const learned = {
    id: "abc12345",
    name: "fix-broken-import",
    steps: [{ tool: "fix-import-paths" }],
    conditions: { condition: 'import "_" not found', requiresTools: [], verifiedBy: "checkRepo" },
    evidence: { supporting: ["a@1", "b@2"], heldOut: ["c@3"], heldOutPassed: true },
    costBefore: 2,
    inducedAt: Date.UTC(2026, 8, 14),
    methodVersion: "m0.2",
  };

  it("lists a learned procedure next to installed skills, marked with its evidence", async () => {
    const tool = createListSkillsTool(dir, () => [learned]);
    const res = await tool.execute({}, ctx);
    expect(res.content).toMatch(/Installed skills \(2\)/);
    expect(res.content).toMatch(/Learned procedures \(1\)/);
    expect(res.content).toContain('`learned:abc12345` — fix-broken-import: when "import "_" not found": fix-import-paths [learned, 2 receipts, verified by checkRepo 2026-09-14]');
  });

  it("a retired procedure is not offered, and an empty library changes nothing", async () => {
    const retired = { ...learned, retired: { at: 1, reason: "counterexample" } };
    const res = await createListSkillsTool(dir, () => [retired]).execute({}, ctx);
    expect(res.content).not.toMatch(/Learned/);
    const none = await createListSkillsTool(join(dir, "does-not-exist"), () => []).execute({}, ctx);
    expect(none.content).toMatch(/No skills are installed/);
  });

  it("the query filters learned rows too", async () => {
    const res = await createListSkillsTool(dir, () => [learned]).execute({ query: "import" }, ctx);
    expect(res.content).toMatch(/Learned procedures \(1\)/);
    expect(res.content).not.toMatch(/Installed skills/);
  });
});
