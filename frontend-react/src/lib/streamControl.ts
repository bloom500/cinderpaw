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

import { isChatStreaming, requestStreamStop } from './chatStream';
import { isFeralStreaming, requestFeralStop } from './feralAgentStream';

/**
 * Stop whatever is streaming for `sessionId`, on whichever path it runs.
 * No-op when nothing is in flight for that session (e.g. the terminal event
 * raced ahead of the click).
 */
export async function stopActiveStream(sessionId: string): Promise<void> {
  const stops: Promise<void>[] = [];
  if (isFeralStreaming(sessionId)) stops.push(requestFeralStop(sessionId));
  if (isChatStreaming(sessionId)) stops.push(requestStreamStop(sessionId));
  await Promise.all(stops);
}
