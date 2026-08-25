/**
 * Cowork Agent Store (S1 Agent Entity Repository).
 *
 * Provides CRUD operations for Cowork Agents stored in SQLite table `cowork_agents`.
 */

import type { Database } from "bun:sqlite";

export interface CoworkAgent {
  id: string;
  name: string;
  role: string;
  instructions: string;
  modelPin?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertCoworkAgentParams {
  id: string;
  name: string;
  role: string;
  instructions: string;
  modelPin?: string | null;
}

export class CoworkAgentRepo {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  public list(): CoworkAgent[] {
    const rows = this.db
      .query("SELECT * FROM cowork_agents ORDER BY name ASC")
      .all() as any[];

    return rows.map((r) => this.mapRow(r));
  }

  public get(id: string): CoworkAgent | null {
    const row = this.db
      .query("SELECT * FROM cowork_agents WHERE id = ?")
      .get(id) as any;

    if (!row) return null;
    return this.mapRow(row);
  }

  public upsert(params: UpsertCoworkAgentParams): CoworkAgent {
    const now = new Date().toISOString();
    const existing = this.get(params.id);

    if (existing) {
      this.db
        .query(
          `UPDATE cowork_agents
           SET name = ?, role = ?, instructions = ?, model_pin = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          params.name,
          params.role,
          params.instructions,
          params.modelPin ?? null,
          now,
          params.id
        );

      return {
        ...existing,
        name: params.name,
        role: params.role,
        instructions: params.instructions,
        modelPin: params.modelPin ?? null,
        updatedAt: now,
      };
    } else {
      this.db
        .query(
          `INSERT INTO cowork_agents (id, name, role, instructions, model_pin, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          params.id,
          params.name,
          params.role,
          params.instructions,
          params.modelPin ?? null,
          now,
          now
        );

      return {
        id: params.id,
        name: params.name,
        role: params.role,
        instructions: params.instructions,
        modelPin: params.modelPin ?? null,
        createdAt: now,
        updatedAt: now,
      };
    }
  }

  public remove(id: string): boolean {
    const res = this.db
      .query("DELETE FROM cowork_agents WHERE id = ?")
      .run(id);
    return res.changes > 0;
  }

  private mapRow(r: any): CoworkAgent {
    return {
      id: r.id,
      name: r.name,
      role: r.role,
      instructions: r.instructions,
      modelPin: r.model_pin ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
