/**
 * Cowork contracts (Agent Cowork S2) — mailbox messages and task handoffs.
 *
 * Shared vocabulary for `mailbox.ts` and `handoff.ts`. Timestamps are
 * epoch milliseconds (project convention — see every other repo in
 * `src/`), ids are UUIDs minted by the repos, never supplied by callers.
 *
 * The `fromAgentId` / `toAgentId` of both types may be an agent id or the
 * literal `"human"` — escalation to a human is just a message addressed
 * to `"human"` (S4 wires the transport).
 */

/** Lifecycle of one mailbox message. */
export type CoworkMessageStatus = "pending" | "read" | "processed" | "rejected";

export interface CoworkMessage {
  id: string;
  /** Agent id or `"human"`. */
  fromAgentId: string;
  /** Agent id or `"human"`. */
  toAgentId: string;
  /** Groups a message into an A2A conversation thread. Null = standalone. */
  threadId: string | null;
  body: string;
  /**
   * Optional JSON blob for structured content. Pointers only — artifacts
   * themselves live in memory/workspace storage, never inline here.
   */
  payloadJson: string | null;
  status: CoworkMessageStatus;
  createdAt: number;
  /** First time the message moved out of `pending`. */
  readAt: number | null;
}

export interface CoworkMessageInput {
  fromAgentId: string;
  toAgentId: string;
  threadId?: string | null;
  body: string;
  payloadJson?: string | null;
}

/** Lifecycle of one task handoff (TeamOlimpo discipline: auditable end state mandatory). */
export type CoworkHandoffStatus =
  | "initiated"
  | "accepted"
  | "completed"
  | "failed";

export interface CoworkHandoff {
  id: string;
  /** Agent id or `"human"`. */
  fromAgentId: string;
  /** Agent id or `"human"`. */
  toAgentId: string;
  threadId: string | null;
  status: CoworkHandoffStatus;
  /** Bounded context for the receiver — the receiver must not need the sender's full transcript. */
  summary: string;
  /** Pointers into memory/workspace, not blobs. */
  artifactRefs: string[];
  /** Set on completion or failure; the auditable outcome. */
  resultSummary: string | null;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface CoworkHandoffInput {
  fromAgentId: string;
  toAgentId: string;
  threadId?: string | null;
  summary: string;
  artifactRefs?: string[];
}
