/**
 * Skill auto-creation — P0-2.
 *
 * Pattern: after each turn, a hermetic LLM pass over the transcript
 * decides whether a reusable procedure emerged. If yes, the response
 * is parsed as a typed YAML-ish block (type / title / body / triggers)
 * and materialised to `~/.feral/skills/<id>/SKILL.md`. The id is the
 * title kebab-cased; if a skill with that id already exists we skip
 * (refinement is the self-improve path, not auto-create).
 *
 * Design choices:
 *   - Disabled by default (`enabled: false`). Off-by-default is the
 *     safer posture — auto-creating skills surprises users. Set
 *     `FERAL_SKILL_AUTO_CREATE=true` to enable.
 *   - The LLM is asked to output SKIP when the transcript is routine
 *     chit-chat. Anything else is parsed strictly; a malformed block
 *     yields `null` without surfacing an error to the agent loop.
 *   - `minTurnLength` guards against 1-line user messages becoming
 *     "skills." Default 4 turns.
 *   - The skill is written synchronously here; for a fire-and-forget
 *     pattern, wrap in `Promise.resolve().then(...)` from the caller.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { InferenceRouter } from "../sandbox/inference-router.ts";
import type { SkillsStorage, SkillManifest } from "./storage.ts";

export interface SkillCandidate {
  id: string;
  type: "discovery" | "decision" | "procedure" | "preference";
  title: string;
  body: string;
  triggers: string[];
}

export interface SkillAutoCreatorConfig {
  storage: SkillsStorage;
  db: Database;
  router: InferenceRouter;
  enabled: boolean;
  /** Minimum number of turns in the transcript to consider. Default 4. */
  minTurnLength?: number;
  /**
   * Optional callback fired after a successful materialisation.
   * Receives the persisted skill manifest and its absolute path.
   * The index.ts wiring emits a `skill_created` OutboundEvent here.
   */
  onCreated?: (manifest: SkillManifest, path: string) => void;
}

const SYSTEM_PROMPT = `You are a skill curator. Look at the recent conversation and decide if a reusable procedure, decision, or preference has emerged that would be worth saving as a SKILL for future runs.

If the conversation is routine chit-chat with nothing worth saving, reply with exactly: SKIP

If a skill IS worth saving, reply with a strict format (no other text, no markdown wrapper):

type: <one of: procedure|decision|preference|discovery>
title: <short title, max 60 chars>
body: |
  <markdown body, multi-line, indented with two spaces>
triggers: <comma-separated keywords>

Rules:
- type="procedure" when the user walked through a multi-step process
- type="preference" when the user expressed a recurring taste or constraint
- type="decision" when the user picked between alternatives with rationale
- type="discovery" when the user learned a new fact about their environment
- triggers are short keywords the agent can match on later (3-6 of them)
- keep body under 600 chars
- body MUST be indented two spaces under "body: |"`;

export class SkillAutoCreator {
  readonly #storage: SkillsStorage;
  readonly #db: Database;
  readonly #router: InferenceRouter;
  readonly #enabled: boolean;
  readonly #minTurnLength: number;
  readonly #onCreated: ((manifest: SkillManifest, path: string) => void) | null;

  constructor(config: SkillAutoCreatorConfig) {
    this.#storage = config.storage;
    this.#db = config.db;
    this.#router = config.router;
    this.#enabled = config.enabled;
    this.#minTurnLength = config.minTurnLength ?? 4;
    this.#onCreated = config.onCreated ?? null;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /**
   * Inspect `transcript` and, if a skill-worthy pattern emerges,
   * materialise it to disk and log the event. Returns the candidate
   * on success, `null` otherwise. Never throws.
   */
  async maybeCreate(
    transcript: string,
    sessionId: string,
  ): Promise<SkillCandidate | null> {
    if (!this.#enabled) return null;
    if (transcript.split("\n").length < this.#minTurnLength) return null;

    let raw: string;
    try {
      const res = await this.#router.complete({
        sessionId: `${sessionId}__skill_curator`,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: transcript },
        ],
        maxTokens: 512,
        temperature: 0.2,
      });
      raw = res.content.trim();
    } catch {
      return null; // never fatal
    }

    if (!raw || raw.toUpperCase() === "SKIP") return null;

    const candidate = parseSkillOutput(raw);
    if (!candidate) return null;

    const id = kebab(candidate.title);
    if (!id) return null;

    // If a skill with this id already exists, this isn't an auto-create
    // event — the self-improve path handles refinement.
    if (this.#storage.readSkill(id)) return null;

    const manifest: SkillManifest = {
      id,
      name: candidate.title,
      description: `${candidate.type}: ${candidate.title}`,
      body: candidate.body,
      triggers: candidate.triggers,
      version: 1,
      updatedAt: Date.now(),
    };
    const path = this.#storage.writeSkill(manifest);
    this.#log(id, "created", null, 1);

    // Best-effort event: callers (index.ts) may want to surface this to
    // the React UI so the user can review.
    if (this.#onCreated) {
      try {
        this.#onCreated(manifest, path);
      } catch (err) {
        process.stderr.write(
          `[skills] onCreated callback failed: ${String(err)}\n`,
        );
      }
    }
    return { ...candidate, id };
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
      // Logging failure is non-fatal.
    }
  }
}

function parseSkillOutput(raw: string): Omit<SkillCandidate, "id"> | null {
  let type: SkillCandidate["type"] | null = null;
  let title = "";
  let body = "";
  let inBody = false;
  const bodyLines: string[] = [];
  let triggers: string[] = [];

  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (inBody) {
      // Body lines are indented 2 spaces. The YAML literal-block rule
      // is "any indentation"; we require 2 spaces (per the prompt) and
      // blank lines (preserved as paragraph breaks).
      if (line.startsWith("  ")) {
        bodyLines.push(line.slice(2));
        continue;
      }
      if (line.trim() === "") {
        bodyLines.push("");
        continue;
      }
      // Non-indented, non-blank → end of body, fall through to handle
      // this line as a new key (e.g. `triggers:`).
      inBody = false;
    }

    if (line.startsWith("type:")) {
      const v = line.slice(5).trim().toLowerCase();
      if (v === "procedure" || v === "decision" || v === "preference" || v === "discovery") {
        type = v;
      }
    } else if (line.startsWith("title:")) {
      title = line.slice(6).trim().slice(0, 80);
    } else if (line.startsWith("body:")) {
      inBody = true;
    } else if (line.startsWith("triggers:")) {
      triggers = line
        .slice(9)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s.length <= 30)
        .slice(0, 6);
    }
  }

  if (bodyLines.length > 0) {
    body = bodyLines.join("\n").trim();
  }

  if (!type || !title || !body) return null;
  return { type, title, body, triggers };
}

/** Convert a free-text title to a stable kebab-case id. */
function kebab(s: string): string {
  const slug = s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || randomUUID().slice(0, 8);
}
