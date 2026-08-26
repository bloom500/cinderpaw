/**
 * Cowork approval gates (S4) — deterministic human sign-off before a
 * cowork agent takes a consequential action.
 *
 * The locked design (docs/agents-memory/project_agent_cowork.md): the
 * escalation classes are FIXED and enumerated — send / publish / delete /
 * purchase / prod_change — and the default posture is GATED. A new agent
 * gets no relaxations, because the default IS the product; learning to
 * relax gates comes later, after trust data exists.
 *
 * The gate point is the existing `before_tool_call` hook (P0-4), which the
 * tool registry fires BEFORE a tool runs. The handler here:
 *   1. ignores every non-cowork session (zero behaviour change outside
 *      cowork — the fresh-install contract),
 *   2. classifies the call deterministically; unclassifiable ⇒ allowed,
 *   3. for a gated class: persists an ApprovalRequest (durable audit row),
 *      emits a `cowork_event` of the new approval_* kinds so the request is
 *      readable where the user actually is (the chat surface, never just a
 *      sidecar log line), and BLOCKS until the human answers or the wait
 *      times out. Fail-closed on timeout: expiry denies, never approves.
 *
 * v1 classifier coverage (deliberately narrow, expanded only with tests):
 *   - shell_exec classified destructive ⇒ "delete"
 *   - http_request with a non-GET/HEAD method ⇒ "send" (data leaves the machine)
 *   publish / purchase / prod_change have no producing tools yet; the classes
 *   stay enumerated so the UI vocabulary does not churn when they arrive.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type {
  BeforeToolCallPayload,
  HookResult,
  OutboundEvent,
} from "../types.ts";
import { classifyCommandLine } from "../core/command-intent.ts";
import type { CoworkAgentRepo } from "./agent-store.ts";

/** The escalation classes. Fixed and enumerated per the locked design. */
export const APPROVAL_CLASSES = [
  "send",
  "publish",
  "delete",
  "purchase",
  "prod_change",
] as const;
export type ApprovalClass = (typeof APPROVAL_CLASSES)[number];

export type CoworkApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface CoworkApproval {
  id: string;
  agentId: string;
  /** The cowork session that asked (`cowork:<agentId>`). Kept for audit. */
  sessionId: string;
  approvalClass: ApprovalClass;
  /** Shown to the human verbatim — this is the thing they approve. */
  description: string;
  tool: string;
  status: CoworkApprovalStatus;
  createdAt: number;
  resolvedAt: number | null;
}

/** How long an unanswered request waits before it expires (fail-closed). */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000;

/** Cowork sessions are exactly `cowork:<agentId>` (see runtime.sessionIdFor). */
const COWORK_SESSION_PREFIX = "cowork:";
/** A subagent's session is `subagent:<parentSessionId>:<subagentId>`
 *  (see core/subagent.ts). Each nesting level adds this prefix AND one
 *  trailing `:<id>` segment. */
const SUBAGENT_SESSION_PREFIX = "subagent:";

/**
 * The session a call ultimately belongs to, with any subagent wrapping undone.
 *
 * The gate used to test `sessionId.startsWith("cowork:")` on the raw id. A
 * teammate that was refused a destructive `shell_exec` could hand the same
 * command to `delegate_task`: the child runs as
 * `subagent:cowork:<agentId>:<saId>`, which fails that test, so the gate
 * returned `block: false` and the command ran with no second question. The
 * gate was one `delegate_task` wide.
 *
 * Unwinding is exact rather than a guess about the shape of an agent id: each
 * level contributed one prefix and one trailing segment, so the same number of
 * trailing segments come back off. Nesting works at any depth.
 */
export function rootSessionId(sessionId: string): string {
  let id = sessionId;
  let depth = 0;
  while (id.startsWith(SUBAGENT_SESSION_PREFIX)) {
    id = id.slice(SUBAGENT_SESSION_PREFIX.length);
    depth++;
  }
  for (let i = 0; i < depth; i++) {
    const cut = id.lastIndexOf(":");
    if (cut === -1) break;
    id = id.slice(0, cut);
  }
  return id;
}

interface ApprovalRow {
  id: string;
  agent_id: string;
  session_id: string;
  approval_class: string;
  description: string;
  tool: string;
  status: string;
  created_at: number;
  resolved_at: number | null;
}

// ---------------------------------------------------------------------------
// Deterministic classification
// ---------------------------------------------------------------------------

export interface Classification {
  approvalClass: ApprovalClass;
  /** Bounded, human-readable line describing WHAT would happen. */
  description: string;
}

function bounded(text: string, max = 160): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * Map a tool call to its escalation class, or `null` when the call is not
 * gated. Pure and deterministic: same inputs ⇒ same answer, forever.
 */
export function classifyToolCall(
  tool: string,
  args: Record<string, unknown>,
): Classification | null {
  if (tool === "shell_exec") {
    const command = typeof args.command === "string" ? args.command : "";
    if (!command.trim()) return null;
    if (classifyCommandLine(command) === "destructive") {
      return { approvalClass: "delete", description: bounded(`Run command: ${command}`) };
    }
    return null;
  }
  if (tool === "http_request") {
    const method = typeof args.method === "string" ? args.method.toUpperCase() : "GET";
    // GET/HEAD only read. Everything else sends data out and can change the
    // far end, which is exactly the "send" class the design locks as gated.
    if (method === "GET" || method === "HEAD") return null;
    const url = typeof args.url === "string" ? args.url : "";
    return {
      approvalClass: "send",
      description: bounded(`${method} ${url}`.trim() || `${method} request`),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * SQLite-backed approval requests. One row per gate hit, terminal status
 * mandatory for audit: pending → approved | denied | expired, and a terminal
 * status is never rewritten (resolving twice is refused, like the handoff
 * state machine refuses complete-without-accept).
 */
export class CoworkApprovalRepo {
  readonly #insert: ReturnType<Database["query"]>;
  readonly #get: ReturnType<Database["query"]>;
  readonly #resolve: ReturnType<Database["query"]>;

  constructor(db: Database) {
    this.#insert = db.query(`
      INSERT INTO cowork_approvals (
        id, agent_id, session_id, approval_class, description, tool,
        status, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
    `);
    this.#get = db.query(`SELECT * FROM cowork_approvals WHERE id = ?`);
    this.#resolve = db.query(`
      UPDATE cowork_approvals
      SET status = ?, resolved_at = ?
      WHERE id = ? AND status = 'pending'
    `);
  }

  create(input: {
    agentId: string;
    sessionId: string;
    approvalClass: ApprovalClass;
    description: string;
    tool: string;
  }): CoworkApproval {
    const approval: CoworkApproval = {
      id: randomUUID(),
      agentId: input.agentId,
      sessionId: input.sessionId,
      approvalClass: input.approvalClass,
      description: input.description,
      tool: input.tool,
      status: "pending",
      createdAt: Date.now(),
      resolvedAt: null,
    };
    this.#insert.run(
      approval.id,
      approval.agentId,
      approval.sessionId,
      approval.approvalClass,
      approval.description,
      approval.tool,
      approval.createdAt,
    );
    return approval;
  }

  get(id: string): CoworkApproval | undefined {
    const row = this.#get.get(id) as ApprovalRow | null;
    return row ? fromRow(row) : undefined;
  }

  /**
   * Move a PENDING request to a terminal status. Returns false when the id
   * is unknown or already resolved — callers must treat both as "no-op",
   * not as errors (a late double-answer from the UI must be harmless).
   */
  resolve(id: string, status: Exclude<CoworkApprovalStatus, "pending">): boolean {
    const result = this.#resolve.run(status, Date.now(), id);
    return result.changes > 0;
  }
}

function fromRow(r: ApprovalRow): CoworkApproval {
  return {
    id: r.id,
    agentId: r.agent_id,
    sessionId: r.session_id,
    approvalClass: r.approval_class as ApprovalClass,
    description: r.description,
    tool: r.tool,
    status: r.status as CoworkApprovalStatus,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

// ---------------------------------------------------------------------------
// The gate + resolution transport
// ---------------------------------------------------------------------------

type Decision = "approved" | "denied" | "expired";

export interface CoworkApprovalServiceDeps {
  approvals: CoworkApprovalRepo;
  /** Agent names for the widget title; existence is NOT required here. */
  agents: CoworkAgentRepo;
  emitEvent: (event: OutboundEvent) => void;
  log?: (msg: string) => void;
  timeoutMs?: number;
}

/**
 * Owns the pending-waiter map and the resolution paths. One instance per
 * sidecar; `gate()` registers on the shared HookRegistry, `resolveExternal`
 * is called from dispatch when the user answers from chat.
 */
export class CoworkApprovalService {
  readonly #deps: CoworkApprovalServiceDeps;
  readonly #log: (msg: string) => void;
  readonly #timeoutMs: number;
  readonly #waiters = new Map<string, (d: Decision) => void>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: CoworkApprovalServiceDeps) {
    this.#deps = deps;
    this.#log = deps.log ?? (() => {});
    this.#timeoutMs = deps.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  }

  /**
   * The `before_tool_call` hook handler. Non-cowork sessions pass through
   * untouched; unclassifiable calls pass through; everything else blocks
   * the tool until the human decides or the wait expires (deny).
   */
  readonly gate = async (payload: BeforeToolCallPayload): Promise<HookResult> => {
    // The ROOT session, so a subagent spawned by a teammate is still that
    // teammate as far as the gate is concerned. See rootSessionId.
    const root = rootSessionId(payload.sessionId);
    if (!root.startsWith(COWORK_SESSION_PREFIX)) return { block: false };
    const cls = classifyToolCall(payload.tool, payload.args);
    if (!cls) return { block: false };

    const agentId = root.slice(COWORK_SESSION_PREFIX.length);
    const agentName = this.#deps.agents.get(agentId)?.name ?? agentId;
    const approval = this.#deps.approvals.create({
      agentId,
      sessionId: payload.sessionId,
      approvalClass: cls.approvalClass,
      description: cls.description,
      tool: payload.tool,
    });

    this.#emit("approval_requested", approval, agentName, undefined);
    this.#log(
      `cowork: approval requested (${approval.id}) — ${agentName}: ${cls.description}`,
    );

    const decision = await new Promise<Decision>((resolve) => {
      this.#waiters.set(approval.id, resolve);
      // Deliberately NOT unref'd: while an approval is pending this timer is
      // the thing that guarantees the wait ENDS. An unref'd timer that is
      // also the only pending handle can simply never fire (observed under
      // bun on Windows) — which would park the agent's tool call forever
      // with no event, no log line, nothing on the user's screen.
      const timer = setTimeout(() => {
        this.#timers.delete(approval.id);
        this.#waiters.delete(approval.id);
        // Expiry DENIES — an unanswered gate never becomes a silent yes.
        this.#deps.approvals.resolve(approval.id, "expired");
        this.#emit("approval_expired", approval, agentName, "no answer in time");
        resolve("expired");
      }, this.#timeoutMs);
      this.#timers.set(approval.id, timer);
    });

    if (decision === "approved") return { block: false };
    return {
      block: true,
      reason:
        decision === "denied"
          ? `the user denied this ${cls.approvalClass} action`
          : `the ${cls.approvalClass} action expired without a user answer`,
    };
  };

  /**
   * The user answered from chat. Returns false when the id is unknown or
   * already terminal (harmless no-op for a late double-click).
   */
  resolveExternal(id: string, approve: boolean): boolean {
    const approval = this.#deps.approvals.get(id);
    if (!approval) return false;
    const status: Decision = approve ? "approved" : "denied";
    if (!this.#deps.approvals.resolve(id, status)) return false;
    const waiter = this.#waiters.get(id);
    if (waiter) {
      this.#waiters.delete(id);
      waiter(status);
    }
    // The expiry timer must not fire after a human decision — it would emit
    // a spurious approval_expired over the real verdict.
    const timer = this.#timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.delete(id);
    }
    const agentName = this.#deps.agents.get(approval.agentId)?.name ?? approval.agentId;
    this.#emit(
      approve ? "approval_approved" : "approval_denied",
      approval,
      agentName,
      approval.description,
    );
    return true;
  }

  #emit(
    eventType: Extract<OutboundEvent, { type: "cowork_event" }>["eventType"],
    approval: CoworkApproval,
    agentName: string,
    detail: string | undefined,
  ): void {
    this.#deps.emitEvent({
      type: "cowork_event",
      eventType,
      agentId: approval.agentId,
      title: `🔐 ${agentName}: ${approval.description}`,
      data: {
        requestId: approval.id,
        approvalClass: approval.approvalClass,
        description: approval.description,
        tool: approval.tool,
        ...(detail !== undefined ? { detail } : {}),
      },
    });
  }
}
