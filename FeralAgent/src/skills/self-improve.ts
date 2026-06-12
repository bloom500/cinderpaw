/**
 * Skill self-improvement — P0-2.
 *
 * The `feedback_skill` builtin tool calls into this. The user says
 * "improve this skill by …" and the LLM rewrites the body in light
 * of the feedback. The new version is written to disk, the
 * `skill_log` table is updated, and a `skill_refined` event is
 * emitted (in the V2 wiring; V1 returns the result synchronously).
 *
 * Pattern from Hermes "self-improving skills": every user-supplied
 * feedback is a chance to grow the skill. We never auto-delete —
 * refinement is monotonic; a bad version can be reverted by writing
 * the previous body back through the storage API.
 */

import type { Database } from "bun:sqlite";
import type { InferenceRouter } from "../sandbox/inference-router.ts";
import type { SkillsStorage, SkillManifest } from "./storage.ts";

export interface SkillSelfImproverConfig {
  storage: SkillsStorage;
  db: Database;
  router: InferenceRouter;
}

export interface RefineResult {
  skillId: string;
  newVersion: number;
  body: string;
  description: string;
  triggers: string[];
}

const SYSTEM_PROMPT = `You are a skill editor. You will be given:
  1. The current SKILL.md body of a skill.
  2. User feedback describing how the skill should change.

Reply with STRICT JSON (no markdown wrapper, no explanation):
{"body":"<new body, markdown>","description":"<one-sentence summary>","triggers":["k1","k2","k3"]}

Rules:
- The new body should incorporate the feedback while preserving any
  parts of the original the user did not ask to change.
- Keep body under 800 chars.
- triggers should reflect the new scope (3-6 keywords).
- description is a fresh one-sentence summary.`;

/** Re-export the randomUUID import so the file's imports stay clean. */
// (randomUUID is no longer needed here; the id is supplied by the caller.)

export class SkillSelfImprover {
  readonly #storage: SkillsStorage;
  readonly #db: Database;
  readonly #router: InferenceRouter;

  constructor(config: SkillSelfImproverConfig) {
    this.#storage = config.storage;
    this.#db = config.db;
    this.#router = config.router;
  }

  /**
   * Refine the skill with the given id. Throws when the skill is
   * missing or when the LLM produces malformed output. Callers
   * (the `feedback_skill` tool) convert the throw to a structured
   * ToolResult error.
   */
  async refine(skillId: string, feedback: string): Promise<RefineResult> {
    const existing = this.#storage.readSkill(skillId);
    if (!existing) {
      throw new Error(`skill "${skillId}" not found`);
    }

    let raw: string;
    try {
      const res = await this.#router.complete({
        sessionId: `${skillId}__refine`,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content:
              `Current skill body:\n${existing.body}\n\n` +
              `Triggers: ${existing.triggers.join(", ")}\n\n` +
              `Description: ${existing.description}\n\n` +
              `User feedback: ${feedback}`,
          },
        ],
        maxTokens: 1024,
        temperature: 0.3,
      });
      raw = res.content.trim();
    } catch (err) {
      throw new Error(`refine: inference failed: ${String(err)}`);
    }

    const parsed = parseRefineOutput(raw);
    if (!parsed) {
      throw new Error(`refine: model produced malformed output`);
    }

    const refined = this.#storage.refineSkill(
      skillId,
      parsed.body,
      parsed.description,
    );
    // Apply the new triggers, if the LLM provided any. We write the
    // manifest with the SAME version refineSkill already assigned so
    // writeSkill's auto-bump doesn't double-count.
    let final: SkillManifest = refined;
    if (parsed.triggers.length > 0) {
      final = { ...refined, triggers: parsed.triggers };
      this.#storage.writeSkill(final);
      // writeSkill may have re-bumped version. Re-read for the true
      // version so the log row matches what's on disk.
      final = this.#storage.readSkill(skillId) ?? refined;
    }

    this.#log(skillId, "refined", feedback, final.version);
    return {
      skillId,
      newVersion: final.version,
      body: final.body,
      description: final.description,
      triggers: final.triggers,
    };
  }

  #log(
    skillId: string,
    action: "created" | "refined" | "rejected",
    reason: string | null,
    version: number,
  ): void {
    try {
      this.#db
        .query(
          `INSERT INTO skill_log (timestamp, skill_id, action, reason, version)
           VALUES ($ts, $skillId, $action, $reason, $version)`,
        )
        .run({
          $ts: Date.now(),
          $skillId: skillId,
          $action: action,
          $reason: reason,
          $version: version,
        });
    } catch {
      // logging failure is non-fatal
    }
  }
}

function parseRefineOutput(raw: string): { body: string; description: string; triggers: string[] } | null {
  // Allow either pure JSON or a JSON block embedded in prose.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const r = obj as Record<string, unknown>;
  if (typeof r.body !== "string" || r.body.length === 0) return null;
  if (typeof r.description !== "string") return null;
  const triggers = Array.isArray(r.triggers)
    ? (r.triggers as unknown[]).filter((t): t is string => typeof t === "string").slice(0, 6)
    : [];
  return { body: r.body, description: r.description, triggers };
}
