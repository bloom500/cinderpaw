// Typed event wrappers for Tauri events.
// If tauri-specta exports a compatible `events` object from bindings.ts, this
// file re-exports those. Otherwise (fallback per spec §2.2), it hand-wires
// listen() to the literal "feral://..." channel names using specta-generated
// payload types so the component API stays identical either way.

import { listen, type UnlistenFn, type EventCallback } from '@tauri-apps/api/event';

// Payload types — mirrors events.rs structs (camelCase due to serde rename_all)
export interface TokenEvent        { sessionId: string; text: string }
export interface StreamDoneEvent   { sessionId: string }
export interface StreamErrorEvent  { sessionId: string; error: string }
/**
 * Emitted when an OpenAI-compatible provider reports `finish_reason: "length"`
 * — the model hit its server-side max_tokens cap before producing a natural
 * stop. The frontend surfaces this as a small "truncated" hint on the message
 * bubble so the user knows the response was cut off by the provider, not by
 * Feral.
 */
export interface StreamTruncatedEvent { sessionId: string; reason: string }
export interface DownloadProgressEvent { repoId: string; filename: string; progress: number }
export interface DownloadCompleteEvent { repoId: string; filename: string; path: string }
export interface DownloadErrorEvent    { repoId: string; filename: string; error: string; cancelled: boolean }
export interface ModelLoadProgressEvent { percentage: number; statusText: string }
/** One streamed agent event. `data` is a JSON-serialized AgentEvent. */
export interface AgentStreamEvent { sessionId: string; data: string }
/** Emitted right before generation starts with the real prompt token count (local models only). */
export interface StreamStartEvent  { sessionId: string; promptTokens: number }
/** Emitted at the end of a cloud stream when the provider returns usage stats. */
export interface StreamUsageEvent  { sessionId: string; promptTokens: number; completionTokens: number }

function wrap<T>(channel: string) {
  return {
    listen: (cb: EventCallback<T>): Promise<UnlistenFn> => listen<T>(channel, cb),
  };
}

export const events = {
  tokenEvent:             wrap<TokenEvent>('feral://token'),
  streamDoneEvent:        wrap<StreamDoneEvent>('feral://stream-done'),
  streamErrorEvent:       wrap<StreamErrorEvent>('feral://stream-error'),
  streamTruncatedEvent:   wrap<StreamTruncatedEvent>('feral://stream-truncated'),
  streamStartEvent:       wrap<StreamStartEvent>('feral://stream-start'),
  streamUsageEvent:       wrap<StreamUsageEvent>('feral://stream-usage'),
  downloadProgressEvent:  wrap<DownloadProgressEvent>('feral://download-progress'),
  downloadCompleteEvent:  wrap<DownloadCompleteEvent>('feral://download-complete'),
  downloadErrorEvent:     wrap<DownloadErrorEvent>('feral://download-error'),
  modelLoadProgressEvent: wrap<ModelLoadProgressEvent>('model-load-progress'),
  agentStreamEvent:       wrap<AgentStreamEvent>('feral://agent-event'),
};
