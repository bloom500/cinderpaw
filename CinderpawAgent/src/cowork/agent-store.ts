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
  createdAt: number;
  updatedAt: number;
}

export interface CoworkAgentInput {
  id?: string;
  name: string;
  role?: string;
  instructions?: string;
  modelPin?: string | undefined;
}

interface CoworkRow {
  id: string;
  name: string;
  role: string;
  instructions: string;
  model_pin: string | null;
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
        id, name, role, instructions, model_pin, created_at, updated_at
      ) VALUES (
        $id, $name, $role, $instructions, $modelPin, $createdAt, $updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        role = excluded.role,
        instructions = excluded.instructions,
        model_pin = excluded.model_pin,
        updated_at = excluded.updated_at
    `);
    this.#listStmt = db.query(`
      SELECT id, name, role, instructions, model_pin, created_at, updated_at
      FROM cowork_agents
      ORDER BY created_at ASC
    `);
    this.#getStmt = db.query(`
      SELECT id, name, role, instructions, model_pin, created_at, updated_at
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
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
