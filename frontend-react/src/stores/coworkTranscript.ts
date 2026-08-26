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

interface CoworkTranscriptStore {
  exchanges: CoworkExchange[];
  ingest: (evt: CoworkEventInput) => void;
  clear: () => void;
}

export const useCoworkTranscript = create<CoworkTranscriptStore>((set) => ({
  exchanges: [],
  ingest: (evt) => set((s) => ({ exchanges: applyCoworkEvent(s.exchanges, evt) })),
  clear: () => set({ exchanges: [] }),
}));
