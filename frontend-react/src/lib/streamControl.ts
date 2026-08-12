/**
 * Unified stop entry point over the app's two streaming paths (audit A2).
 *
 * The app streams through two managers with identical stop semantics but
 * separate registries: `lib/chatStream` (local llama.cpp / cloud BYOK chat)
 * and `lib/feralAgentStream` (Feral Agent sidecar). UI code used to call one
 * of them directly — the Stop button in `ChatInput` always called the chat
 * path, so in Agent mode it told the chat backend (which had nothing running)
 * to stop while the sidecar kept generating.
 *
 * UI code should call `stopActiveStream` instead of either manager: it asks
 * both registries who actually has a stream in flight for the session and
 * forwards the stop there. Any future change to stop semantics lands here
 * once instead of being fixed twice.
 */

import { requestStreamStop } from './chatStream';
import { requestFeralStop } from './feralAgentStream';

/**
 * Stop whatever is streaming for `sessionId`, on whichever path it runs.
 * No-op when nothing is in flight for that session (e.g. the terminal event
 * raced ahead of the click).
 */
export async function stopActiveStream(sessionId: string): Promise<void> {
  // Both paths are asked, unconditionally.
  //
  // This used to be gated on `isFeralStreaming` / `isChatStreaming`, and that is
  // what made the Stop button do nothing: the button is rendered from
  // `useChat.streamStatus`, while the guards read a separate in-flight registry.
  // Two sources of truth for one question, and when they disagreed the user got a
  // visible button that sent no signal at all — the logs show zero `stop
  // requested` lines reaching the sidecar for an entire session of pressing it.
  //
  // Nothing is saved by guarding. Both stop paths document themselves as no-ops
  // when that session has nothing in flight: the chat registry trips a flag no
  // one is reading, and the sidecar latches a stop for a session it is not
  // running. Asking twice costs one ignored message; asking never costs the user
  // their only way to interrupt.
  await Promise.all([
    requestFeralStop(sessionId).catch(() => {}),
    requestStreamStop(sessionId).catch(() => {}),
  ]);
}
