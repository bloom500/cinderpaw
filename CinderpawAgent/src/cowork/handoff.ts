/**
 * Cowork handoff service (S2) — structured task-ownership transfers.
 *
 * TeamOlimpo rule (see `docs/agents-memory/project_agent_cowork.md`):
 * *no handoff driven to a terminal status = the task is not done.* So the
 * state machine is enforced HERE, deterministically, not left to loop
 * discipline:
 *
 *   initiated ──accept──▶ accepted ──complete──▶ completed
 *        │                    │
 *        └─────────fail───────┴──────────▶ failed
 *
 * `complete` on a handoff nobody accepted throws — that is the audit
 * guarantee: every completed handoff has an accepting owner on record.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type {
  CoworkHandoff,
  CoworkHandoffInput,
  CoworkHandoffStatus,
} from "./types.ts";

interface HandoffRow {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  thread_id: string | null;
  status: string;
  summary: string;
  artifact_refs_json: string;
  result_summary: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

/** Tolerate a corrupt artifact-refs payload — unparseable becomes empty. */
function safeParseRefs(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export class CoworkHandoffService {
  readonly #insert: ReturnType<Database["query"]>;
  readonly #transition: ReturnType<Database["query"]>;
  readonly #failFromAccepted: ReturnType<Database["query"]>;
  readonly #failFromInitiated: ReturnType<Database["query"]>;
  readonly #getStmt: ReturnType<Database["query"]>;
  readonly #historyByTo: ReturnType<Database["query"]>;
  readonly #historyByFrom: ReturnType<Database["query"]>;

  constructor(db: Database) {
    this.#insert = db.query(`
      INSERT INTO cowork_handoffs (
        id, from_agent_id, to_agent_id, thread_id, status,
        summary, artifact_refs_json, result_summary,
        created_at, updated_at, closed_at
      ) VALUES (?, ?, ?, ?, 'initiated', ?, ?, NULL, ?, ?, NULL)
    `);
    this.#transition = db.query(`
      UPDATE cowork_handoffs
      SET status = $status, result_summary = $resultSummary,
          updated_at = $updatedAt, closed_at = $closedAt
      WHERE id = $id AND status = $expectedStatus
    `);
    // fail() accepts two source statuses; two guarded updates beat a WHERE IN.
    this.#failFromInitiated = db.query(`
      UPDATE cowork_handoffs
      SET status = 'failed', result_summary = $resultSummary,
          updated_at = $updatedAt, closed_at = $closedAt
      WHERE id = $id AND status = 'initiated'
    `);
    this.#failFromAccepted = db.query(`
      UPDATE cowork_handoffs
      SET status = 'failed', result_summary = $resultSummary,
          updated_at = $updatedAt, closed_at = $closedAt
      WHERE id = $id AND status = 'accepted'
    `);
    this.#getStmt = db.query(`SELECT * FROM cowork_handoffs WHERE id = ?`);
    this.#historyByTo = db.query(`
      SELECT * FROM cowork_handoffs WHERE to_agent_id = ?
      ORDER BY created_at DESC
    `);
    this.#historyByFrom = db.query(`
      SELECT * FROM cowork_handoffs WHERE from_agent_id = ?
      ORDER BY created_at DESC
    `);
  }

  /**
   * Create a handoff in `initiated`. The sender lets go of the task at
   * this moment (HandoffKit actor rule): ownership now sits with `to`.
   */
  initiate(input: CoworkHandoffInput): CoworkHandoff {
    const now = Date.now();
    const handoff: CoworkHandoff = {
      id: randomUUID(),
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      threadId: input.threadId ?? null,
      status: "initiated",
      summary: input.summary,
      artifactRefs: input.artifactRefs ?? [],
      resultSummary: null,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    this.#insert.run(
      handoff.id,
      handoff.fromAgentId,
      handoff.toAgentId,
      handoff.threadId,
      handoff.summary,
      JSON.stringify(handoff.artifactRefs),
      handoff.createdAt,
      handoff.updatedAt,
    );
    return handoff;
  }

  /** Receiver takes ownership. Only valid from `initiated`. */
  accept(id: string): CoworkHandoff {
    return this.#guardedTransition(id, "accepted", "initiated", null, false);
  }

  /**
   * Mark done with an outcome summary. Only valid from `accepted` —
   * completing an unclaimed handoff is exactly the silent-drop the
   * protocol exists to prevent.
   */
  complete(id: string, resultSummary: string): CoworkHandoff {
    if (!resultSummary.trim()) {
      throw new Error(
        `cowork: handoff ${id} cannot be completed without a non-empty ` +
          `result summary — the outcome IS the audit record`,
      );
    }
    return this.#guardedTransition(
      id, "completed", "accepted", resultSummary, true,
    );
  }

  /** Terminal failure. Valid from `initiated` or `accepted`. */
  fail(id: string, reason: string): CoworkHandoff {
    const current = this.get(id);
    if (!current) {
      throw new Error(`cowork: unknown handoff ${id}`);
    }
    if (current.status === "failed" || current.status === "completed") {
      throw new Error(
        `cowork: handoff ${id} is already ${current.status} and cannot fail`,
      );
    }
    if (!reason.trim()) {
      throw new Error(
        `cowork: handoff ${id} cannot fail without a non-empty reason`,
      );
    }
    const now = Date.now();
    const stmt =
      current.status === "initiated" ? this.#failFromInitiated : this.#failFromAccepted;
    stmt.run({ $id: id, $resultSummary: reason, $updatedAt: now, $closedAt: now });
    return this.get(id)!;
  }

  /** Look up one handoff by id, or `undefined`. */
  get(id: string): CoworkHandoff | undefined {
    const row = this.#getStmt.get(id) as HandoffRow | null;
    return row ? fromRow(row) : undefined;
  }

  /**
   * Audit view: every handoff involving `agentId` as sender or receiver,
   * newest first.
   */
  history(agentId: string): CoworkHandoff[] {
    const from = (this.#historyByFrom.all(agentId) as HandoffRow[]).map(fromRow);
    const to = (this.#historyByTo.all(agentId) as HandoffRow[]).map(fromRow);
    return [...from, ...to]
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1))
      // A handoff can't have the same agent on both sides in practice, but
      // dedupe anyway so history never lies by duplication.
      .filter((h, i, arr) => i === arr.findIndex((x) => x.id === h.id));
  }

  #guardedTransition(
    id: string,
    nextStatus: Exclude<CoworkHandoffStatus, "initiated">,
    expectedStatus: CoworkHandoffStatus,
    resultSummary: string | null,
    close: boolean,
  ): CoworkHandoff {
    const current = this.get(id);
    if (!current) {
      throw new Error(`cowork: unknown handoff ${id}`);
    }
    if (current.status !== expectedStatus) {
      throw new Error(
        `cowork: handoff ${id} is '${current.status}', cannot move to ` +
          `'${nextStatus}' — only '${expectedStatus}' may transition there`,
      );
    }
    this.#transition.run({
      $status: nextStatus,
      $resultSummary: resultSummary,
      $updatedAt: Date.now(),
      $closedAt: close ? Date.now() : null,
      $id: id,
      $expectedStatus: expectedStatus,
    });
    return this.get(id)!;
  }
}

function fromRow(r: HandoffRow): CoworkHandoff {
  return {
    id: r.id,
    fromAgentId: r.from_agent_id,
    toAgentId: r.to_agent_id,
    threadId: r.thread_id,
    status: r.status as CoworkHandoffStatus,
    summary: r.summary,
    artifactRefs: safeParseRefs(r.artifact_refs_json),
    resultSummary: r.result_summary,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    closedAt: r.closed_at,
  };
}
