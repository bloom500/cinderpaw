import { create } from 'zustand';

/**
 * Live transcript of REAL agent-to-agent traffic (Agent Cowork).
 *
 * Every `cowork_event` the sidecar emits carries the actual text exchanged
 * between agents (`data.body` = incoming message, `data.output`/`result` =
 * the receiver's reply, `summary`/`reason` for handoffs and approvals).
 * This store accumulates those into chat-like exchanges grouped per
 * counterpart pair, rendered live by CoworkTranscriptPanel.
 *
 * Deliberately NOT part of useChat: this traffic is app-wide and arrives on
 * the cowork schedule, not the user's session — switching chats must not
 * wipe it (and it must not be capped/faded like the mascot's 4-bubble
 * strip, which is glanceability, not a record).
 */

export type CoworkExchangeKind = 'message' | 'handoff' | 'approval';
export type CoworkExchangeStatus = 'running' | 'done' | 'error';

/** One A2A exchange: what was asked (requestText) and what came back. */
export interface CoworkExchange {
  /** Stable upsert key — `msg:`/`handoff:`/`approval:` + domain id. */
  id: string;
  threadId: string;
  kind: CoworkExchangeKind;
  fromAgentId: string;
  toAgentId: string;
  requestText: string | null;
  responseText: string | null;
  status: CoworkExchangeStatus;
  /** Approval events only: send/publish/delete/purchase/prod_change. */
  approvalClass?: string;
  at: number;
  /** Roster names, when the sidecar knew them. The panel falls back to the
   *  id, but a person should never have to read "demo-agent-atlas". */
  fromName?: string;
  toName?: string;
  /** When this exchange STARTED running, for the elapsed clock. Distinct
   *  from `at`, which is the exchange's own creation time and does not move:
   *  a card that was already running when the panel mounted still needs an
   *  honest "since when". */
  startedAt?: number;
  /** Tools this agent has called during the turn, oldest first, with the
   *  running one last. "Atlas is working" answers whether anything is
   *  happening; this answers what. Capped so a long turn cannot grow the
   *  row without bound. */
  tools?: { name: string; done: boolean }[];
}

/** Enough to see the shape of a turn without turning the row into a log. */
export const COWORK_TOOLS_PER_EXCHANGE = 8;

/**
 * Record a tool call against whichever exchange that cowork agent is running.
 *
 * Attribution is by AGENT, not by exchange id: tool events know the session
 * (`cowork:<agentId>`) but nothing about the mailbox row being processed, and
 * the worker drains one message at a time per agent — so the open exchange for
 * that agent is the one that called it.
 */
export function applyCoworkToolEvent(
  exchanges: CoworkExchange[],
  evt: { sessionId?: string; tool: string; done: boolean },
): CoworkExchange[] {
  const prefix = 'cowork:';
  if (!evt.sessionId?.startsWith(prefix)) return exchanges;
  const agentId = evt.sessionId.slice(prefix.length);
  // Last open exchange addressed to that agent: the one being worked on now.
  let idx = -1;
  for (let i = exchanges.length - 1; i >= 0; i--) {
    const e = exchanges[i]!;
    if (e.toAgentId === agentId && e.status === 'running') {
      idx = i;
      break;
    }
  }
  if (idx === -1) return exchanges;
  const target = exchanges[idx]!;
  const tools = [...(target.tools ?? [])];
  const open = tools.findIndex((t) => t.name === evt.tool && !t.done);
  if (evt.done && open !== -1) tools[open] = { name: evt.tool, done: true };
  else if (!evt.done) tools.push({ name: evt.tool, done: false });
  const next = { ...target, tools: tools.slice(-COWORK_TOOLS_PER_EXCHANGE) };
  return exchanges.map((e, i) => (i === idx ? next : e));
}

/** The subset of the sidecar's `cowork_event` the transcript needs. */
export interface CoworkEventInput {
  eventType: string;
  agentId: string;
  threadId?: string;
  title: string;
  data: Record<string, unknown>;
}

export const COWORK_TRANSCRIPT_MAX = 100;

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Pure reducer so the ingest rules are unit-testable without the Tauri
 * event listener. Upserts by the same key contract as the mascot bubbles
 * (`cinderpawAgentStream.ts`): received→terminal mutates ONE exchange.
 */
export function applyCoworkEvent(
  exchanges: CoworkExchange[],
  evt: CoworkEventInput,
): CoworkExchange[] {
  const isApproval = evt.eventType.startsWith('approval_');
  const requestId = str(evt.data.requestId);
  const messageId = str(evt.data.messageId);
  const handoffId = str(evt.data.handoffId);
  // Same key derivation as cinderpawAgentStream, so a mascot bubble and its
  // transcript exchange always refer to the same underlying occurrence.
  const id =
    isApproval && requestId
      ? `approval:${requestId}`
      : messageId
        ? `msg:${messageId}`
        : handoffId
          ? `handoff:${handoffId}`
          : crypto.randomUUID();
  const kind: CoworkExchangeKind = isApproval ? 'approval' : handoffId ? 'handoff' : 'message';
  const threadId = evt.threadId ?? 'direct';

  const status: CoworkExchangeStatus =
    evt.eventType === 'message_received' ||
    evt.eventType === 'handoff_received' ||
    evt.eventType === 'approval_requested'
      ? 'running'
      : evt.eventType === 'message_rejected' ||
          evt.eventType === 'handoff_failed' ||
          evt.eventType === 'approval_denied' ||
          evt.eventType === 'approval_expired'
        ? 'error'
        : 'done';

  const prev = exchanges.find((e) => e.id === id);
  const base: CoworkExchange = prev ?? {
    id,
    threadId,
    kind,
    fromAgentId: 'unknown',
    toAgentId: evt.agentId,
    requestText: null,
    responseText: null,
    status,
    at: Date.now(),
  };
  const fromName = str(evt.data.fromAgentName) ?? prev?.fromName;
  const toName = str(evt.data.agentName) ?? prev?.toName;
  // Set once, on the transition into `running`, and never overwritten - the
  // clock must measure the wait, not the time since the last event.
  const startedAt =
    prev?.startedAt ?? (status === 'running' ? Date.now() : undefined);
  // The first sight of an exchange may be its terminal half (e.g. the panel
  // mounted mid-flow). Rebuild from the event instead of trusting `prev`.
  const at = prev?.at ?? Date.now();

  const named = { fromName, toName, startedAt };
  let next: CoworkExchange;
  switch (evt.eventType) {
    case 'message_received':
      next = {
        ...base,
        ...named,
        kind,
        threadId,
        fromAgentId: str(evt.data.fromAgentId) ?? 'human',
        toAgentId: evt.agentId,
        requestText: str(evt.data.body) ?? null,
        status,
        at,
      };
      break;
    case 'message_processed':
      next = { ...base, ...named, kind, threadId, responseText: str(evt.data.output) ?? null, status, at };
      break;
    case 'message_rejected':
      next = { ...base, ...named, kind, threadId, responseText: str(evt.data.reason) ?? null, status, at };
      break;
    case 'handoff_received':
      next = {
        ...base,
        ...named,
        kind,
        threadId,
        fromAgentId: str(evt.data.fromAgentId) ?? 'human',
        toAgentId: evt.agentId,
        requestText: str(evt.data.summary) ?? null,
        status,
        at,
      };
      break;
    case 'handoff_completed':
      next = { ...base, ...named, kind, threadId, responseText: str(evt.data.result) ?? null, status, at };
      break;
    case 'handoff_failed':
      next = { ...base, ...named, kind, threadId, responseText: str(evt.data.reason) ?? null, status, at };
      break;
    case 'approval_requested':
      next = {
        ...base,
        ...named,
        kind,
        threadId,
        fromAgentId: evt.agentId,
        toAgentId: 'human',
        requestText: str(evt.data.description) ?? evt.title,
        approvalClass: str(evt.data.approvalClass),
        status,
        at,
      };
      break;
    default:
      // approval_approved / denied / expired: terminal state on the open ask.
      next = { ...base, ...named, kind, threadId, status, approvalClass: base.approvalClass ?? str(evt.data.approvalClass), at };
      break;
  }

  const withoutPrev = exchanges.filter((e) => e.id !== id);
  return [...withoutPrev, next].slice(-COWORK_TRANSCRIPT_MAX);
}

/** One persisted mailbox row, as `cowork_history_result` delivers it. */
export interface CoworkHistoryRow {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  fromAgentName?: string;
  toAgentName?: string;
  body: string;
  status: string;
  createdAt: number;
}

/**
 * Rebuild a transcript from the mailbox.
 *
 * A stored row is ONE message, where a live exchange is a request plus its
 * reply — so each row becomes an exchange carrying only `requestText`, and the
 * reply is simply the next row (its sender is the previous recipient). That is
 * how the conversation reads on screen either way, and it avoids inventing a
 * pairing the mailbox never recorded.
 *
 * Status maps honestly: `rejected` is an error, `pending` is still running (a
 * teammate that never got to it before the app closed), anything else is done.
 * A restart cannot resume a turn, so `startedAt` is deliberately absent — an
 * elapsed clock counting from a run that ended yesterday would be a lie.
 */
export function fromHistory(threadId: string, rows: CoworkHistoryRow[]): CoworkExchange[] {
  return rows.map((r) => ({
    id: `msg:${r.id}`,
    threadId,
    kind: 'message' as const,
    fromAgentId: r.fromAgentId,
    toAgentId: r.toAgentId,
    fromName: r.fromAgentName,
    toName: r.toAgentName,
    requestText: r.body,
    responseText: null,
    status:
      r.status === 'rejected'
        ? ('error' as const)
        : r.status === 'pending'
          ? ('running' as const)
          : ('done' as const),
    at: r.createdAt,
  }));
}

interface CoworkTranscriptStore {
  exchanges: CoworkExchange[];
  ingest: (evt: CoworkEventInput) => void;
  ingestTool: (evt: { sessionId?: string; tool: string; done: boolean }) => void;
  /** Replace the transcript with one thread replayed from disk. */
  hydrate: (threadId: string, rows: CoworkHistoryRow[]) => void;
  clear: () => void;
}

export const useCoworkTranscript = create<CoworkTranscriptStore>((set) => ({
  exchanges: [],
  ingest: (evt) => set((s) => ({ exchanges: applyCoworkEvent(s.exchanges, evt) })),
  ingestTool: (evt) => set((s) => ({ exchanges: applyCoworkToolEvent(s.exchanges, evt) })),
  // Replace, not merge: switching conversations must not leave the previous
  // chat's teammate traffic on screen under a new heading. Empty rows = no
  // history for this thread, so clear (panel hides per-thread).
  hydrate: (threadId, rows) => set({ exchanges: fromHistory(threadId, rows) }),
  clear: () => set({ exchanges: [] }),
}));
