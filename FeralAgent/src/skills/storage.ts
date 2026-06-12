/**
 * Skills storage — read/write/list SKILL.md files on disk.
 *
 * Each skill lives at `<skillsRoot>/<id>/SKILL.md`. The on-disk format
 * is a single markdown file with optional YAML front-matter; the body
 * is the SKILL.md content the LLM reads when `read_skill` is called.
 *
 * The directory layout is Feral-specific (matches `~/.feral/skills/`,
 * which is what the existing `read_skill` builtin tool reads from).
 * The storage class is the single source of truth for layout decisions.
 *
 * V1: the on-disk format is JSON (id, name, description, body, triggers,
 * version, updatedAt). The `read_skill` builtin tool reads whatever is
 * at the path and surfaces it to the LLM — the storage format is an
 * implementation detail the agent loop never sees.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  /** Markdown body — what the LLM reads via the `read_skill` tool. */
  body: string;
  /** Trigger keywords the agent can use to decide when to apply. */
  triggers: string[];
  /** Monotonically increasing version. 1 on first write. */
  version: number;
  /** Epoch ms. */
  updatedAt: number;
}

export class SkillsStorage {
  readonly #root: string;

  constructor(homeDir: string = homedir()) {
    this.#root = join(homeDir, ".feral", "skills");
  }

  /** Absolute path to the skills root. */
  get root(): string {
    return this.#root;
  }

  /** Absolute path to a single skill's directory. */
  skillDir(id: string): string {
    return join(this.#root, id);
  }

  /** Absolute path to a single skill's file. */
  skillPath(id: string): string {
    return join(this.#root, id, "SKILL.md");
  }

  /** Write a skill. Bumps `version` on conflict. Returns the absolute path. */
  writeSkill(skill: SkillManifest): string {
    const dir = this.skillDir(skill.id);
    mkdirSync(dir, { recursive: true });
    const existing = this.readSkill(skill.id);
    const next: SkillManifest = existing
      ? { ...skill, version: existing.version + 1, updatedAt: Date.now() }
      : { ...skill, version: skill.version || 1, updatedAt: Date.now() };
    const path = this.skillPath(skill.id);
    writeFileSync(path, JSON.stringify(next, null, 2), "utf8");
    return path;
  }

  /** Read a skill, or `undefined` if no SKILL.md exists. */
  readSkill(id: string): SkillManifest | undefined {
    const path = this.skillPath(id);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as SkillManifest;
    } catch {
      return undefined;
    }
  }

  /** All skills, sorted by id (so the menu is deterministic). */
  listSkills(): SkillManifest[] {
    if (!existsSync(this.#root)) return [];
    const out: SkillManifest[] = [];
    for (const entry of readdirSync(this.#root)) {
      const dirPath = join(this.#root, entry);
      let isDir = false;
      try {
        isDir = statSync(dirPath).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const skill = this.readSkill(entry);
      if (skill) out.push(skill);
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  /**
   * Refine an existing skill. Returns the new version of the manifest.
   * The caller is responsible for running the LLM that produces the
   * new body / description; this method only handles persistence.
   */
  refineSkill(
    id: string,
    newBody: string,
    newDescription?: string,
  ): SkillManifest {
    const existing = this.readSkill(id);
    if (!existing) {
      throw new Error(`skill "${id}" not found`);
    }
    const refined: SkillManifest = {
      ...existing,
      body: newBody,
      description: newDescription ?? existing.description,
      version: existing.version + 1,
      updatedAt: Date.now(),
    };
    writeFileSync(this.skillPath(id), JSON.stringify(refined, null, 2), "utf8");
    return refined;
  }
}
