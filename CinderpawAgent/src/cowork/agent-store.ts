/**
 * Cowork agents repository — SQLite-backed CRUD for {@link CoworkAgent}.
 *
 * S1 of the Agent Cowork plan (see
 * `docs/agents-memory/project_agent_cowork.md`). Pure persistence: no
 * loops, no inference, no transport. A worker loop (S3) and the A2A
 * mailbox/handoff protocol (S2) consume this repo; neither exists yet.
 *
 * Zero-behaviour-change discipline: nothing in this module is wired into
 * boot or dispatch. With no rows, the feature simply does not exist for
 * the user — which is exactly the fresh-install contract.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";

export interface CoworkAgent {
  id: string;
  name: string;
  role: string;
  /** Standing prompt, applied on every turn this agent takes. */
  instructions: string;
  /** Brain model id. `undefined` ⇒ the Brain Stack routes per task. */
  modelPin?: string;
  /**
   * Tool names this teammate may call. `undefined` ⇒ everything the host
   * exposes, which is the pre-scoping behaviour and stays the fallback for
   * rows written before this column existed.
   *
   * The reason it exists is measured, not theoretical: handing every teammate
   * all 39 tools meant re-sending ~16.5k tokens of schema on every completion
   * to produce ~600, with 13-55 seconds of prefill before the first token.
   */
  tools?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CoworkAgentInput {
  id?: string;
  name: string;
  role?: string;
  instructions?: string;
  modelPin?: string | undefined;
  tools?: string[] | undefined;
}

interface CoworkRow {
  id: string;
  name: string;
  role: string;
  instructions: string;
  model_pin: string | null;
  tools: string | null;
  created_at: number;
  updated_at: number;
}

export class CoworkAgentRepo {
  readonly #upsertStmt: ReturnType<Database["query"]>;
  readonly #listStmt: ReturnType<Database["query"]>;
  readonly #getStmt: ReturnType<Database["query"]>;
  readonly #deleteStmt: ReturnType<Database["query"]>;

  constructor(db: Database) {
    this.#upsertStmt = db.query(`
      INSERT INTO cowork_agents (
        id, name, role, instructions, model_pin, tools, created_at, updated_at
      ) VALUES (
        $id, $name, $role, $instructions, $modelPin, $tools, $createdAt, $updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        role = excluded.role,
        instructions = excluded.instructions,
        model_pin = excluded.model_pin,
        tools = excluded.tools,
        updated_at = excluded.updated_at
    `);
    this.#listStmt = db.query(`
      SELECT id, name, role, instructions, model_pin, tools, created_at, updated_at
      FROM cowork_agents
      ORDER BY created_at ASC
    `);
    this.#getStmt = db.query(`
      SELECT id, name, role, instructions, model_pin, tools, created_at, updated_at
      FROM cowork_agents
      WHERE id = ?
    `);
    this.#deleteStmt = db.query(`DELETE FROM cowork_agents WHERE id = ?`);
  }

  /** List all agents, ordered by creation time (oldest first). */
  list(): CoworkAgent[] {
    return (this.#listStmt.all() as CoworkRow[]).map(fromRow);
  }

  /** Look up a single agent by id, or `undefined` if not present. */
  get(id: string): CoworkAgent | undefined {
    const row = this.#getStmt.get(id) as CoworkRow | null;
    return row ? fromRow(row) : undefined;
  }

  /**
   * Insert or update. Returns the persisted agent (with id + timestamps).
   * An update keeps the original `createdAt` — renaming an agent must not
   * reorder it in the roster.
   */
  upsert(input: CoworkAgentInput): CoworkAgent {
    const existing = input.id ? this.get(input.id) : undefined;
    const id = input.id ?? randomUUID();
    const now = Date.now();

    this.#upsertStmt.run({
      $id: id,
      $name: input.name,
      $role: input.role ?? "",
      $instructions: input.instructions ?? "",
      // `undefined` would bind as NULL through bun's named-params path only
      // when the key is present; normalise explicitly so a pin can also be
      // CLEARED (Brain re-routes) by passing undefined on update.
      $modelPin: input.modelPin ?? null,
      // Stored as JSON so the column stays one value; an empty array is a
      // REAL answer ("this teammate calls no tools") and must survive as one,
      // so only undefined becomes NULL.
      $tools: input.tools === undefined ? null : JSON.stringify(input.tools),
      $createdAt: existing?.createdAt ?? now,
      $updatedAt: now,
    });

    return this.get(id)!;
  }

  /** Remove an agent. Returns true if a row was deleted. */
  remove(id: string): boolean {
    const result = this.#deleteStmt.run(id);
    return result.changes > 0;
  }
}

function fromRow(r: CoworkRow): CoworkAgent {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    instructions: r.instructions,
    modelPin: r.model_pin ?? undefined,
    tools: parseTools(r.tools),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** A corrupt or non-array value reads as "unscoped", never as "no tools":
 *  silently muting a teammate is worse than leaving it as it was. */
function parseTools(raw: string | null): string[] | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : undefined;
  } catch {
    return undefined;
  }
}
