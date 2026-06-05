/**
 * Global Chat stream manager.
 *
 * The chat tab's stream is owned here, NOT in a per-component hook, so a
 * generation keeps applying and completes correctly when the user navigates
 * between tabs (which unmounts `ChatInput` and its `useChatStream` consumer).
 *
 * Previously the listeners lived inside `useChatStream`, and the hook's
 * unmount cleanup called `tauri.chat.stop()` — so leaving `/chat` mid-stream
 * silently killed the backend generation, dropped every subsequent token, and
 * left the sidebar spinner stuck on forever.
 *
 * This module owns a single persistent listener per event channel and a
 * registry of in-flight streams keyed by sessionId. Start sites register
 * callbacks that outlive their component — so a generation started on `/chat`
 * keeps applying, the streaming indicator stays live, and `done` is delivered
 * to the right callbacks regardless of which tab is currently mounted.
 */

import type { UnlistenFn } from '@tauri-apps/api/event';
import { tauri, events, type Message, type InferParams } from '@/lib/tauri';
import type { CloudModel } from '@/stores/model';

export interface ChatStreamHandlers {
  onToken:     (text: string) => void;
  onDone:      () => void;
  onError:     (err: string) => void;
  onStopped:   () => void;
  /** Backend hit max_tokens before producing a natural stop. */
  onTruncated?: (reason: string) => void;
}

interface StreamEntry extends ChatStreamHandlers {
  /** Set when the user (or a competing send) asked to stop. */
  stopped: boolean;
}

const inflight = new Map<string, StreamEntry>();
let unlistens: UnlistenFn[] = [];
let initPromise: Promise<void> | null = null;

async function ensureListeners(): Promise<void> {
  if (unlistens.length > 0) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const tokenUn = await events.tokenEvent.listen((e) => {
      const entry = inflight.get(e.payload.sessionId);
      if (entry && !entry.stopped) entry.onToken(e.payload.text);
    });
    const doneUn = await events.streamDoneEvent.listen((e) => {
      const entry = inflight.get(e.payload.sessionId);
      if (!entry) return;
      if (entry.stopped) {
        entry.onStopped();
      } else {
        entry.onDone();
      }
      inflight.delete(e.payload.sessionId);
    });
    const errUn = await events.streamErrorEvent.listen((e) => {
      const entry = inflight.get(e.payload.sessionId);
      if (!entry) return;
      entry.onError(e.payload.error);
      inflight.delete(e.payload.sessionId);
    });
    const truncUn = await events.streamTruncatedEvent.listen((e) => {
      const entry = inflight.get(e.payload.sessionId);
      if (!entry) return;
      if (entry.stopped) return;
      entry.onTruncated?.(e.payload.reason);
      inflight.delete(e.payload.sessionId);
    });
    unlistens = [tokenUn, doneUn, errUn, truncUn];
  })();
  return initPromise;
}

/**
 * Start a chat stream for `sessionId` and register its callbacks.
 *
 * Only one chat stream runs at a time — starting a new one auto-stops any
 * previous in-flight stream. This matches the original `useChatStream`
 * behaviour: the user clicking "send" while a response is in flight
 * implicitly cancels the previous turn.
 */
export async function startChatStream(
  sessionId: string,
  messages: Message[],
  params: InferParams,
  cloud: CloudModel | null,
  handlers: ChatStreamHandlers,
): Promise<void> {
  await ensureListeners();

  // Auto-stop any previous stream — the backend can only run one generation
  // at a time, and a fresh send is an implicit interrupt.
  if (inflight.size > 0) {
    for (const [prevId, entry] of inflight) {
      entry.stopped = true;
      // Don't fire onStopped for an interrupted-by-new-send — fire onError
      // instead so the previous conversation's streamStatus leaves 'streaming'
      // and the sidebar spinner clears. The previous turn's *partial* answer
      // is already in the persisted snapshot (saved at send time).
      entry.onError('Interrupted by a new message');
      inflight.delete(prevId);
    }
    try {
      await tauri.chat.stop();
    } catch (err) {
      // Backend may have nothing to stop (e.g. previous stream already
      // completed between our check and the call). Not fatal.
      console.warn('[chatStream] stop during auto-stop failed:', err);
    }
  }

  inflight.set(sessionId, { ...handlers, stopped: false });

  try {
    if (cloud) {
      await tauri.chat.cloudStream(cloud.providerId, cloud.modelId, messages, params, sessionId);
    } else {
      await tauri.chat.stream(messages, params, sessionId);
    }
  } catch (err) {
    // Backend may throw if the user stopped the stream. Surface as a stopped
    // event so callers update their UI consistently.
    const entry = inflight.get(sessionId);
    if (entry) {
      if (entry.stopped) {
        entry.onStopped();
      } else {
        entry.onError(String(err));
      }
      inflight.delete(sessionId);
    }
    throw err;
  }
}

/**
 * Mark an in-flight stream as stopped and tell the backend to halt.
 *
 * The next `done` event for this session will route to `onStopped` (not
 * `onDone`) so the UI can show the partial response without the
 * streaming-spinner / done-completion path.
 */
export async function requestStreamStop(sessionId: string): Promise<void> {
  const entry = inflight.get(sessionId);
  if (entry) entry.stopped = true;
  await tauri.chat.stop();
}

/** True if a stream is currently in flight for `sessionId`. */
export function isChatStreaming(sessionId: string): boolean {
  return inflight.has(sessionId);
}
