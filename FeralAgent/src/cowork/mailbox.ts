/**
 * Cowork Mailbox Repository (S2 Inter-Agent Asynchronous Messaging).
 *
 * Provides messaging, inbox/outbox queries, and status updates for Cowork Agents.
 */

import type { Database } from "bun:sqlite";
import { CoworkMessage, MessageStatus } from "../types/cowork.js";

export interface SendMessageParams {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  subject: string;
  body: string;
  payloadJson?: string | null;
}

export class CoworkMailboxRepo {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  public sendMessage(params: SendMessageParams): CoworkMessage {
    const now = new Date().toISOString();
    const message: CoworkMessage = {
      id: params.id,
      fromAgentId: params.fromAgentId,
      toAgentId: params.toAgentId,
      subject: params.subject,
      body: params.body,
      payloadJson: params.payloadJson ?? null,
      status: "pending",
      createdAt: now,
      readAt: null,
    };

    this.db
      .query(
        `INSERT INTO cowork_mailbox (id, from_agent_id, to_agent_id, subject, body, payload_json, status, created_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        message.id,
        message.fromAgentId,
        message.toAgentId,
        message.subject,
        message.body,
        message.payloadJson,
        message.status,
        message.createdAt,
        message.readAt
      );

    return message;
  }

  public getInbox(toAgentId: string, status?: MessageStatus): CoworkMessage[] {
    let sql = "SELECT * FROM cowork_mailbox WHERE to_agent_id = ?";
    const args: any[] = [toAgentId];

    if (status) {
      sql += " AND status = ?";
      args.push(status);
    }

    sql += " ORDER BY created_at DESC";

    const rows = this.db.query(sql).all(...args) as any[];
    return rows.map((r) => this.mapRow(r));
  }

  public getOutbox(fromAgentId: string): CoworkMessage[] {
    const rows = this.db
      .query("SELECT * FROM cowork_mailbox WHERE from_agent_id = ? ORDER BY created_at DESC")
      .all(fromAgentId) as any[];

    return rows.map((r) => this.mapRow(r));
  }

  public updateStatus(id: string, status: MessageStatus): boolean {
    const now = new Date().toISOString();
    const readAt = status === "read" || status === "processed" ? now : null;

    const res = this.db
      .query(
        `UPDATE cowork_mailbox
         SET status = ?, read_at = COALESCE(read_at, ?)
         WHERE id = ?`
      )
      .run(status, readAt, id);

    return res.changes > 0;
  }

  private mapRow(r: any): CoworkMessage {
    return {
      id: r.id,
      fromAgentId: r.from_agent_id,
      toAgentId: r.to_agent_id,
      subject: r.subject,
      body: r.body,
      payloadJson: r.payload_json ?? null,
      status: r.status as MessageStatus,
      createdAt: r.created_at,
      readAt: r.read_at ?? null,
    };
  }
}
