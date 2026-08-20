/**
 * Global Cinderpaw Agent stream manager.
 *
 * The Feral Agent sidecar streams `cinderpaw://agent-output` events for the whole
 * app lifetime, regardless of which tab is mounted. Previously the listener
 * lived inside `AgentChat`, so navigating away from the Agents tab tore it down
 * mid-generation: chunks stopped arriving (generation appeared to freeze) and
 * the terminal `done` event was missed, so the Recents "streaming" spinner was
 * never cleared.
 *
 * This module owns a single, persistent listener and a registry of in-flight
 * messages keyed by the sidecar's messageId. Send sites register callbacks that
 * outlive their component — so a generation started on the Agents tab keeps
 * applying and completes correctly even after the user switches tabs.
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import type { CinderpawAgentEvent } from '@/lib/tauri';
import { tauri } from '@/lib/tauri';
import { useChat } from '@/stores/chat';
import { useAskUser, type AskUserAnswer, type AskUserQuestion } from '@/stores/askUser';

export interface FeralStreamHandlers {
  onChunk: (content: string) => void;
  onDone: (finalContent?: string, stopped?: boolean) => void;
  onError: (message: string) => void;
  onStopped?: () => void;
  onToolStart?: (callId: string, tool: string, args: Record<string, unknown>) => void;
  onToolDone?: (callId: string, tool: string, result: unknown) => void;
  onUsage?: (promptTokens: number, completionTokens: number) => void;
  onAskUser?: (
    requestId: string,
    sessionId: string,
    questions: AskUserQuestion[],
  ) => Promise<AskUserAnswer[]>;
  onSpawning?: (count: number) => void;
  getToolCallCount?: () => number;
  /**
   * React-side id of the assistant message that this stream is producing.
   * Used by the ask_user flow to attach the question card to the correct
   * message even when the user has switched tabs / chats since the stream
   * started. The card is rendered off `message.askUser` (see MessageItem),
   * so we need to know which message to patch.
   */
  chatMessageId?: string;
  /**
   * Chat session this stream belongs to. Lets `requestFeralStop(sessionId)`
   * stop only that session's streams instead of every in-flight stream —
   * the same per-session stop semantics `lib/chatStream` has (audit A2).
   */
  sessionId?: string;
}

interface InflightEntry extends FeralStreamHandlers {
  stopped: boolean;
}

const inflight = new Map<string, InflightEntry>();
let unlisten: UnlistenFn | null = null;
let initPromise: Promise<void> | null = null;

/**
 * Lazily install the single persistent `cinderpaw://agent-output` listener.
 * Idempotent and safe to call before every send. Must resolve before the
 * `feral_send_message` invoke so the first chunk is never missed.
 */
export function ensureFeralListener(): Promise<void> {
  if (unlisten) return Promise.resolve();
  if (initPromise) return initPromise;
  initPromise = listen<{ data: string }>('cinderpaw://agent-output', (event) => {
    let parsed: CinderpawAgentEvent;
    try {
      parsed = JSON.parse(event.payload.data) as CinderpawAgentEvent;
    } catch {
      return;
    }

    switch (parsed.type) {
      case 'chunk':
        if (parsed.id) {
          const entry = inflight.get(parsed.id);
          if (entry && !entry.stopped) entry.onChunk(parsed.content);
        }
        break;
      case 'done':
        if (parsed.id) {
          const h = inflight.get(parsed.id);
          if (h) {
            inflight.delete(parsed.id);
            if (h.stopped) {
              if (h.onStopped) h.onStopped();
              else h.onDone(parsed.content, true);
            } else {
              h.onDone(parsed.content, false);
            }
          }
        }
        break;
      case 'error':
        // Errors may be global (no id). With an id, route to that message;
        // without one, fail every in-flight stream so nothing stays "running".
        if (parsed.id) {
          const h = inflight.get(parsed.id);
          if (h) {
            inflight.delete(parsed.id);
            // An abort-triggered error is surfaced as onStopped (if registered)
            // so the UI shows "stopped" rather than "error".
            if (h.stopped && h.onStopped) h.onStopped();
            else h.onError(parsed.message);
          }
        } else {
          for (const [, h] of inflight) h.onError(parsed.message);
          inflight.clear();
        }
        break;
      case 'tool_start':
        if (parsed.id) inflight.get(parsed.id)?.onToolStart?.(parsed.callId, parsed.tool, parsed.args ?? {});
        break;
      case 'tool_done':
        if (parsed.id) inflight.get(parsed.id)?.onToolDone?.(parsed.callId, parsed.tool, parsed.result);
        break;
      case 'usage':
        if (parsed.id) inflight.get(parsed.id)?.onUsage?.(parsed.promptTokens, parsed.completionTokens);
        break;
      case 'tool_progress':
        // #18: retry/backoff/fallback notes from long-running tools. These
        // carry a sessionId (not a message id), so route straight to the
        // chat store's most recent running bubble — previously dropped.
        if (parsed.message) useChat.getState().noteToolProgress(parsed.message);
        break;
      case 'rlm_child':
        // A background worker from the notebook's `rlm()`. Like tool_progress
        // it carries a sessionId and no message id — but for a stronger
        // reason: the turn that spawned it has usually ENDED by now, so there
        // is no in-flight stream to route through. Straight to the store.
        useChat.getState().upsertWorker({
          childId: parsed.childId,
          name: parsed.name,
          status: parsed.status,
          detail: parsed.detail,
        });
        break;
      case 'spawning':
        if (parsed.id) {
          inflight.get(parsed.id)?.onSpawning?.(parsed.count ?? 1);
        }
        break;
      case 'ask_user':
        // Route the ask_user event to the matching in-flight stream's handler
        // (if any). Falls back to the global useAskUser store when no
        // per-stream handler is registered — this keeps the UI working even
        // when ask_user events arrive outside an active generation (e.g. a
        // proactive ask from the inner-thoughts loop).
        routeAskUser(parsed.id, parsed.sessionId, parsed.questions);
        break;
      case 'ask_user_cancelled':
        // Sidecar reports a cancel/timeout for ONE request (carries its id).
        // Cancel exactly that request wherever it sits in the queue; the
        // matching routeAskUser .catch advances the card. Only fall back to
        // cancelling everything if the event somehow lacks an id.
        if (parsed.id) {
          useAskUser.getState().cancelById(parsed.id, parsed.reason ?? 'sidecar cancelled');
        } else {
          cancelAskUserOnAllInflight(parsed.reason ?? 'sidecar cancelled');
        }
        break;
      // proactive / pong / model_set / model_error handled elsewhere (useCinderpawGlobal).
      default:
        break;
    }
  }).then((fn) => {
    unlisten = fn;
  });
  return initPromise;
}

/**
 * Find the chat-message id of the active in-flight Cinderpaw stream. Returns
 * undefined when no stream is active (e.g. a proactive ask from the
 * inner-thoughts loop) or when the consumer didn't pass `chatMessageId`.
 *
 * We pick the first non-stopped entry — at the moment an ask_user fires
 * the agent loop is blocked on the user's answer, so there is exactly one
 * active stream in the typical case.
 */
function activeChatMessageId(): string | undefined {
  for (const h of inflight.values()) {
    if (!h.stopped && h.chatMessageId) return h.chatMessageId;
  }
  return undefined;
}

/**
 * Route an ask_user event to a per-stream handler (preferred) or the
 * global useAskUser store. After the user answers, send the response
 * back to the sidecar via Rust.
 *
 * Also patches the assistant message that triggered the question with
 * `message.askUser = { requestId, sessionId, questions }` so the
 * `AskUserCard` (rendered in `MessageItem`) shows up. Without this patch
 * the card never appears, because the component reads off the message
 * prop — see the "ui/ux missing for ask_user" bug fixed in this commit.
 */
function routeAskUser(
  requestId: string,
  sessionId: string,
  questions: AskUserQuestion[],
): void {
  const targetMessageId = activeChatMessageId();

  // The promise returned by useAskUser.request() resolves when the user
  // clicks Submit. We then forward the answers to the sidecar. If another
  // request is already pending, this one is QUEUED — it won't become the
  // visible head until the earlier ones are answered.
  const promise = useAskUser.getState().request(requestId, sessionId, questions);

  // Only paint the card when THIS request is the current head. A request
  // queued behind an unanswered one must not steal the card (that was the
  // bug: the visible card and the resolving request desynced).
  if (targetMessageId && useAskUser.getState().pending?.id === requestId) {
    useChat.getState().patchMessage(targetMessageId, {
      askUser: { requestId, sessionId, questions },
    });
  }

  // Best-effort: also notify per-stream handlers (e.g. so the chat can
  // attach a "thinking" indicator on the streaming message). This is a
  // fire-and-forget; the actual user response is handled by the store.
  for (const [, h] of inflight) {
    try {
      h.onAskUser?.(requestId, sessionId, questions);
    } catch {
      // ignore — handler is optional and may throw on missing UI
    }
  }

  promise
    .then((answers) => {
      // Forward the user's selection back to Rust → sidecar.
      void invoke('feral_ask_user_response', { requestId, answers });
      // Advance the visible card to the next queued request, or REMOVE it
      // entirely when the queue has drained. We deliberately do not leave an
      // "answered" summary card lingering in the chat — once the user has
      // picked, the card disappears (the agent's own message reflects the
      // decision). This matters most for control_app, which can leave a
      // trail of identical "Allow" confirmations otherwise.
      advanceAskUserCard(targetMessageId);
    })
    .catch((err) => {
      // User cancelled, sidecar cancelled, or timeout. Tell the sidecar so
      // it can stop waiting (silently no-op when the sidecar initiated the
      // cancel), then advance to the next queued request (or clear).
      void invoke('feral_ask_user_cancel', { requestId }).catch(() => {
        console.warn('[askUser] cancel invoke also failed:', err);
      });
      advanceAskUserCard(targetMessageId);
    });
}

/**
 * Move the on-message ask_user card to the next queued request after the
 * current head settled, or remove the card when the queue has drained. The
 * card never lingers as an "answered" summary — answering or cancelling makes
 * it advance or disappear.
 */
function advanceAskUserCard(targetMessageId: string | undefined): void {
  if (!targetMessageId) return;
  const next = useAskUser.getState().pending;
  useChat.getState().patchMessage(targetMessageId, {
    askUser: next
      ? { requestId: next.id, sessionId: next.sessionId, questions: next.questions }
      : undefined,
  });
}

/**
 * Clear the ask_user UI state for every in-flight stream. Used when the
 * sidecar reports a cancel/timeout — we don't know which request the
 * sidecar was cancelling (the event doesn't carry a sidecar messageId),
 * so we clear all entries whose React message is currently being asked.
 */
function cancelAskUserOnAllInflight(reason: string): void {
  useAskUser.getState().cancel(reason);
  for (const h of inflight.values()) {
    if (h.chatMessageId) {
      useChat.getState().patchMessage(h.chatMessageId, { askUser: undefined });
    }
  }
}

/** Register handlers for an in-flight sidecar message. */
export function registerFeralStream(messageId: string, handlers: FeralStreamHandlers): void {
  inflight.set(messageId, { ...handlers, stopped: false });
}

/**
 * Mark in-flight feral streams as stopped and send a stop signal to the
 * sidecar. The next done/error event for each message will route to `onStopped`
 * instead of `onDone`/`onError` so the UI shows the partial response cleanly.
 *
 * With a `sessionId`, only that session's streams are marked (entries that
 * didn't declare a session are also marked, conservatively — they may belong
 * to it). Without one, everything stops.
 */
export async function requestFeralStop(sessionId?: string): Promise<void> {
  for (const entry of inflight.values()) {
    if (!sessionId || !entry.sessionId || entry.sessionId === sessionId) {
      entry.stopped = true;
    }
  }
  try {
    await tauri.feralAgent.stop(sessionId);
  } catch (err) {
    console.warn('[feralAgentStream] stop signal failed:', err);
  }
}

/**
 * True if a feral stream is in flight — for `sessionId` when given (entries
 * without a declared session count as a match), otherwise for any session.
 */
export function isFeralStreaming(sessionId?: string): boolean {
  if (!sessionId) return inflight.size > 0;
  for (const entry of inflight.values()) {
    if (!entry.sessionId || entry.sessionId === sessionId) return true;
  }
  return false;
}
