/**
 * Live mirror of in-flight Cinderpaw Agent sessions.
 *
 * The chat store only holds the session currently on screen, so when the
 * user navigates away mid-generation the streamed tokens, tool-call bubbles
 * and agent phase stop being applied (correctly — they'd leak into the
 * wrong conversation). Before this module, coming BACK to the in-flight
 * chat reloaded the stale disk snapshot: the response looked reset until
 * the next token happened to arrive, and tool bubbles/phase never returned.
 * During long tool runs (no tokens for minutes) the task appeared dead.
 *
 * `useCinderpawSendMessage` writes every streaming update here unconditionally,
 * keyed by sessionId. `useConversations.open()` calls `rehydrate` after
 * loading a session that is still streaming, restoring the full live state.
 */

import {
  useChat,
  type AgentPhase,
  type ToolCallEvent,
  TOOL_CALL_STREAM_MAX,
  TOOL_CALL_LINGER_MS,
} from '@/stores/chat';

/** Drop finished bubbles past their on-screen linger window. */
function pruneExpired(stream: ToolCallEvent[]): ToolCallEvent[] {
  const cutoff = Date.now() - TOOL_CALL_LINGER_MS;
  return stream.filter((e) => e.endedAt === null || e.endedAt > cutoff);
}

export interface CinderpawLiveSnapshot {
  content: string;
  thinking: string | null;
  thinkingComplete: boolean;
  toolCallStream: ToolCallEvent[];
  agentPhase: AgentPhase;
  agentTool: string | null;
  /** Real token counts from the latest completion (for the context ring). */
  promptTokens: number | null;
  completionTokens: number | null;
}

const live = new Map<string, CinderpawLiveSnapshot>();

export function beginLiveSession(sessionId: string): void {
  live.set(sessionId, {
    content: '',
    thinking: null,
    thinkingComplete: true,
    toolCallStream: [],
    agentPhase: null,
    agentTool: null,
    promptTokens: null,
    completionTokens: null,
  });
}

export function getLiveSession(sessionId: string): CinderpawLiveSnapshot | undefined {
  return live.get(sessionId);
}

/** Pruned view of the mirror's tool strip, safe to copy into the store. */
export function getLiveToolStrip(sessionId: string): ToolCallEvent[] | undefined {
  const snap = live.get(sessionId);
  return snap ? pruneExpired(snap.toolCallStream) : undefined;
}

export function updateLiveSession(
  sessionId: string,
  patch: Partial<CinderpawLiveSnapshot>,
): void {
  const snap = live.get(sessionId);
  if (!snap) return;
  Object.assign(snap, patch);
}

/** Append a tool event to the mirror (same cap as the chat store strip). */
export function pushLiveToolCall(
  sessionId: string,
  event: ToolCallEvent,
): void {
  const snap = live.get(sessionId);
  if (!snap) return;
  snap.toolCallStream = [...pruneExpired(snap.toolCallStream), event].slice(-TOOL_CALL_STREAM_MAX);
}

export function completeLiveToolCall(
  sessionId: string,
  id: string,
  result: { ok: boolean; error?: string; preview?: string },
): void {
  const snap = live.get(sessionId);
  if (!snap) return;
  snap.toolCallStream = snap.toolCallStream.map((e) =>
    e.id === id && e.kind === 'tool'
      ? {
          ...e,
          status: result.ok ? ('done' as const) : ('error' as const),
          endedAt: Date.now(),
          resultPreview: result.preview ?? null,
          errorMessage: result.error ?? null,
          progressNote: null,
        }
      : e,
  );
}

/** Terminal event — the generation finished; disk now has the final state. */
export function endLiveSession(sessionId: string): void {
  live.delete(sessionId);
}

/**
 * Restore the live streaming state into the chat store after
 * `loadSession()` replaced it with the disk snapshot. Only call when the
 * session being opened is the one mid-stream (the caller checks
 * `streamingIds`). No-op when there's no mirror entry.
 */
export function rehydrateLiveSession(sessionId: string): void {
  const snap = live.get(sessionId);
  if (!snap) return;
  const chat = useChat.getState();
  if (chat.sessionId !== sessionId) return;

  // The disk snapshot includes the (possibly empty) assistant placeholder
  // saved at send time. If it's missing (older save), append one so the
  // streamed content has somewhere to land.
  const last = chat.messages[chat.messages.length - 1];
  if (!last || last.role !== 'assistant') {
    chat.addMessage({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      thinkingComplete: true,
      createdAt: Date.now(),
    });
  }

  chat.updateLastAssistantMessage({
    content: snap.content,
    ...(snap.thinking !== null
      ? { thinking: snap.thinking, thinkingComplete: snap.thinkingComplete }
      : {}),
  });
  useChat.setState({
    toolCallStream: pruneExpired(snap.toolCallStream),
    agentPhase: snap.agentPhase,
    agentTool: snap.agentTool,
    livePromptTokens: snap.promptTokens,
    liveCompletionTokens: snap.completionTokens,
  });
}
