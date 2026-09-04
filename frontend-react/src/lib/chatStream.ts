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
  /** Fired once with the real prompt token count right before generation (local models). */
  onStart?: (promptTokens: number) => void;
  /** Fired once at the end of a cloud stream when real usage stats are available. */
  onUsage?: (promptTokens: number, completionTokens: number) => void;
}

interface StreamEntry extends ChatStreamHandlers {
  /** Set when the user (or a competing send) asked to stop. */
  stopped: boolean;
  /** Timestamp of the last event seen for this stream — see the stall watchdog. */
  lastActivity: number;
}

const inflight = new Map<string, StreamEntry>();

/**
 * How long a registered stream may go completely silent before we give up on it.
 *
 * Every exit from `inflight` depends on the backend emitting `done`, `error` or
 * `truncated`. If the sidecar dies without a word — killed, crashed, OOM — none
 * of those ever arrives, the entry stays forever, `isChatStreaming()` keeps
 * answering true, and the sidebar spinner turns for the rest of the session with
 * no way for the user to clear it but a reload nothing suggests.
 *
 * Generous on purpose: waiting for the first token of a large local model is
 * routinely 5-20s and a loaded cloud provider can be slower still. This is the
 * ceiling for hearing NOTHING at all, not for finishing.
 */
const STALL_TIMEOUT_MS = 180_000;
const STALL_CHECK_MS = 15_000;
let stallTimer: ReturnType<typeof setInterval> | null = null;

/** Mark a stream as alive; any event from the backend counts. */
function touch(sessionId: string): void {
  const entry = inflight.get(sessionId);
  if (entry) entry.lastActivity = Date.now();
}

/** Runs only while something is in flight, so idle app = no timer at all. */
function armStallWatchdog(): void {
  if (stallTimer !== null) return;
  stallTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of [...inflight]) {
      if (now - entry.lastActivity < STALL_TIMEOUT_MS) continue;
      inflight.delete(id);
      entry.onError('The response stopped arriving — the local engine may have crashed. Try sending again.');
    }
    if (inflight.size === 0) disarmStallWatchdog();
  }, STALL_CHECK_MS);
}

function disarmStallWatchdog(): void {
  if (stallTimer === null) return;
  clearInterval(stallTimer);
  stallTimer = null;
}
/** A stop that arrived after the UI declared streaming but before registration. */
const stopRequested = new Set<string>();
let unlistens: UnlistenFn[] = [];
let initPromise: Promise<void> | null = null;

async function ensureListeners(): Promise<void> {
  if (unlistens.length > 0) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // Registration is all-or-nothing: if a later `listen()` rejects, the ones
    // already registered are released before the error propagates. Leaving them
    // attached would double every token on the next successful attempt.
    const acquired: UnlistenFn[] = [];
    try {
      acquired.push(await events.tokenEvent.listen((e) => {
        touch(e.payload.sessionId);
        const entry = inflight.get(e.payload.sessionId);
        if (entry && !entry.stopped) entry.onToken(e.payload.text);
      }));
      acquired.push(await events.streamDoneEvent.listen((e) => {
        const entry = inflight.get(e.payload.sessionId);
        if (!entry) return;
        if (entry.stopped) {
          entry.onStopped();
        } else {
          entry.onDone();
        }
        inflight.delete(e.payload.sessionId);
        if (inflight.size === 0) disarmStallWatchdog();
      }));
      acquired.push(await events.streamErrorEvent.listen((e) => {
        const entry = inflight.get(e.payload.sessionId);
        if (!entry) return;
        entry.onError(e.payload.error);
        inflight.delete(e.payload.sessionId);
        if (inflight.size === 0) disarmStallWatchdog();
      }));
      acquired.push(await events.streamTruncatedEvent.listen((e) => {
        const entry = inflight.get(e.payload.sessionId);
        if (!entry) return;
        if (entry.stopped) return;
        entry.onTruncated?.(e.payload.reason);
        inflight.delete(e.payload.sessionId);
        if (inflight.size === 0) disarmStallWatchdog();
      }));
      acquired.push(await events.streamStartEvent.listen((e) => {
        touch(e.payload.sessionId);
        const entry = inflight.get(e.payload.sessionId);
        if (entry && !entry.stopped) entry.onStart?.(e.payload.promptTokens);
      }));
      acquired.push(await events.streamUsageEvent.listen((e) => {
        touch(e.payload.sessionId);
        const entry = inflight.get(e.payload.sessionId);
        if (entry && !entry.stopped) entry.onUsage?.(e.payload.promptTokens, e.payload.completionTokens);
      }));
      unlistens = acquired;
    } catch (err) {
      for (const un of acquired) un();
      throw err;
    }
  })();
  // A failed registration must not be cached. Without this, one `listen()`
  // rejecting at boot (host not ready, permission denied) leaves `initPromise`
  // holding a rejected promise forever: every later send awaits that same
  // rejection, and chat stays dead until the user reloads the window — with no
  // hint that reloading is what fixes it. Clearing the cache lets the next send
  // try again.
  initPromise.catch(() => {
    initPromise = null;
  });
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
    const interrupted: string[] = [];
    for (const [prevId, entry] of inflight) {
      entry.stopped = true;
      // Don't fire onStopped for an interrupted-by-new-send — fire onError
      // instead so the previous conversation's streamStatus leaves 'streaming'
      // and the sidebar spinner clears. The previous turn's *partial* answer
      // is already in the persisted snapshot (saved at send time).
      entry.onError('Interrupted by a new message');
      inflight.delete(prevId);
      interrupted.push(prevId);
    }
    if (inflight.size === 0) disarmStallWatchdog();
    try {
      // Stop flags are per-session on the backend, so each interrupted stream
      // has to be named. A single blanket stop would leave the others running.
      await Promise.all(interrupted.map((id) => tauri.chat.stop(id)));
    } catch (err) {
      // Backend may have nothing to stop (e.g. previous stream already
      // completed between our check and the call). Not fatal.
      console.warn('[chatStream] stop during auto-stop failed:', err);
    }
  }

  // `useSendMessage` performs async setup before it reaches this registration.
  // A barge-in during that setup must cancel this send, not become a stale stop
  // that the fresh backend generation never sees.
  if (stopRequested.delete(sessionId)) {
    handlers.onStopped();
    return;
  }

  inflight.set(sessionId, { ...handlers, stopped: false, lastActivity: Date.now() });
  armStallWatchdog();

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
      if (inflight.size === 0) disarmStallWatchdog();
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
  else stopRequested.add(sessionId);
  // The backend keys its stop flags by session, so a stale stop click from a
  // tab whose stream already finished is a no-op there and cannot touch
  // another session's generation. No guard needed on this side.
  await tauri.chat.stop(sessionId);
}
