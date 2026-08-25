/**
 * Cowork Handoff Protocol Service (S2 Task Delegation Between Agents).
 *
 * Manages handoff initiation, acceptance, completion, and failure tracking.
 */

import type { Database } from "bun:sqlite";
import { CoworkHandoff, HandoffStatus } from "../types/cowork.js";

export interface InitiateHandoffParams {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  taskDescription: string;
  contextData?: Record<string, any>;
}

export class CoworkHandoffService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  public initiateHandoff(params: InitiateHandoffParams): CoworkHandoff {
    const now = new Date().toISOString();
    const contextJson = JSON.stringify(params.contextData ?? {});

    const handoff: CoworkHandoff = {
      id: params.id,
      fromAgentId: params.fromAgentId,
      toAgentId: params.toAgentId,
      taskDescription: params.taskDescription,
      contextJson,
      status: "initiated",
      resultJson: null,
      createdAt: now,
      completedAt: null,
    };

    this.db
      .query(
        `INSERT INTO cowork_handoffs (id, from_agent_id, to_agent_id, task_description, context_json, status, result_json, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        handoff.id,
        handoff.fromAgentId,
        handoff.toAgentId,
        handoff.taskDescription,
        handoff.contextJson,
        handoff.status,
        handoff.resultJson,
        handoff.createdAt,
        handoff.completedAt
      );

    return handoff;
  }

  public acceptHandoff(id: string): boolean {
    const res = this.db
      .query("UPDATE cowork_handoffs SET status = 'accepted' WHERE id = ? AND status = 'initiated'")
      .run(id);

    return res.changes > 0;
  }

  public completeHandoff(id: string, resultData?: Record<string, any>): boolean {
    const now = new Date().toISOString();
    const resultJson = JSON.stringify(resultData ?? {});

    const res = this.db
      .query(
        `UPDATE cowork_handoffs
         SET status = 'completed', result_json = ?, completed_at = ?
         WHERE id = ?`
      )
      .run(resultJson, now, id);

    return res.changes > 0;
  }

  public failHandoff(id: string, errorReason: string): boolean {
    const now = new Date().toISOString();
    const resultJson = JSON.stringify({ error: errorReason });

    const res = this.db
      .query(
        `UPDATE cowork_handoffs
         SET status = 'failed', result_json = ?, completed_at = ?
         WHERE id = ?`
      )
      .run(resultJson, now, id);

    return res.changes > 0;
  }

  public getHandoffHistory(agentId: string): CoworkHandoff[] {
    const rows = this.db
      .query(
        `SELECT * FROM cowork_handoffs
         WHERE from_agent_id = ? OR to_agent_id = ?
         ORDER BY created_at DESC`
      )
      .all(agentId, agentId) as any[];

    return rows.map((r) => this.mapRow(r));
  }

  private mapRow(r: any): CoworkHandoff {
    return {
      id: r.id,
      fromAgentId: r.from_agent_id,
      toAgentId: r.to_agent_id,
      taskDescription: r.task_description,
      contextJson: r.context_json,
      status: r.status as HandoffStatus,
      resultJson: r.result_json ?? null,
      createdAt: r.created_at,
      completedAt: r.completed_at ?? null,
    };
  }
}
