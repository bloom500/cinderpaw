/**
 * Audit log — the immutable record of every action the agent takes.
 *
 * Non-negotiable constraint: *every* tool call, inference, network request,
 * memory write, and block produces a row here. The logger never throws to its
 * caller; an audit failure must not crash the agent, but it is reported to
 * stderr so it is not silently swallowed.
 */

import type { Database } from "bun:sqlite";
import type { AuditEntry, AuditLogger } from "../types.ts";

export class AuditLog {
  readonly #insert: ReturnType<Database["query"]>;

  constructor(db: Database) {
    this.#insert = db.query(`
      INSERT INTO audit_log (
        timestamp, session_id, action_type, tool_name,
        args_json, result, blocked_reason, token_cost, duration_ms
      ) VALUES (
        $timestamp, $sessionId, $actionType, $toolName,
        $argsJson, $result, $blockedReason, $tokenCost, $durationMs
      )
    `);
  }

  /** Record one entry. Swallows errors so auditing can never crash the agent. */
  record(entry: AuditEntry): void {
    try {
      this.#insert.run({
        $timestamp: entry.timestamp,
        $sessionId: entry.sessionId,
        $actionType: entry.actionType,
        $toolName: entry.toolName ?? null,
        $argsJson: entry.argsJson ?? null,
        $result: entry.result,
        $blockedReason: entry.blockedReason ?? null,
        $tokenCost: entry.tokenCost ?? null,
        $durationMs: entry.durationMs ?? null,
      });
    } catch (err) {
      // Last-resort visibility: audit must not take down the process.
      process.stderr.write(
        `[audit] failed to record entry: ${String(err)}\n`,
      );
    }
  }

  /** Bound logger function suitable for handing to tools and other layers. */
  get logger(): AuditLogger {
    return (entry: AuditEntry) => this.record(entry);
  }

  /** Convenience helper that timestamps a partial entry with `Date.now()`. */
  log(entry: Omit<AuditEntry, "timestamp">): void {
    this.record({ ...entry, timestamp: Date.now() });
  }
}
