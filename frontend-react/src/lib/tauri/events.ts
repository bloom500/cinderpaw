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

/**
 * One raw line from the Feral Agent sidecar, forwarded by Rust over
 * `feral://agent-output`. The `data` field is the sidecar's JSON
 * line verbatim — the React side parses it and dispatches by `type`.
 * For the RSI engine specifically, lines look like:
 *   { "type": "rsi_engine_event", "event": "started", "id": "<uuid>",
 *     "iteration": 0, "concurrency": 1, "costSoFarUsd": 0.0, "bestScore": null }
 */
export interface FeralAgentOutputEvent { data: string }

/**
 * Parsed RSI engine event extracted from a `feral://agent-output`
 * line. Mirrors the wire shape documented in `feral_agent.rs
 * handle_rsi_engine_event`. Fields are optional because each event
 * carries only the relevant subset (e.g. a `progress` event omits
 * `stopReason`, a `concurrency_set` omits `iteration`).
 */
export interface RsiEngineEventLine {
  type: 'rsi_engine_event';
  event: 'started' | 'stopped' | 'concurrency_set' | 'progress';
  id?: string;
  iteration?: number;
  bestScore?: number | null;
  costSoFarUsd?: number;
  concurrency?: number;
  stopReason?: string;
}

/**
 * A Fractal Memory Search pulse, extracted from a `feral://agent-output` line.
 * The sidecar emits these so the living organism is driven by memory activity,
 * not RSI:
 *   - `recall` (a semantic query traversed the tree → breathing focus)
 *   - `grow`   (a rebuild grew the tree → filament growth)
 *   - `seed`   (a single memory was written → fine per-iteration impulse
 *               so +1 leaf on 2700 isn't invisible until the next 1.2×
 *               rebuild threshold)
 * Counts / ids are per-kind.
 */
export interface FractalActivityLine {
  type: 'fractal_activity';
  kind: 'recall' | 'grow' | 'seed';
  hits?: number;
  leafCount?: number;
  clusterCount?: number;
  clusters?: { x: number; y: number; weight: number }[];
  leafId?: number;
  sessionId?: string;
  ts?: number;
}

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
  /**
   * The Feral Agent sidecar's raw stdout forwarded by Rust. The
   * `data` field is the original JSON line — the React side parses
   * it and routes by `type` (chunk/done/tool/rsi_engine_event/…).
   * The listener fires for EVERY sidecar line, not just RSI events,
   * so callers must filter.
   */
  feralAgentOutputEvent: wrap<FeralAgentOutputEvent>('feral://agent-output'),

  /**
   * Thin binding over `feralAgentOutputEvent` that filters for RSI engine
   * events only. Fires for any `rsi_engine_event` line (started / progress /
   * stopped / concurrency_set). Mirrors the `wrap()` shape so callers use
   * the same `.listen(cb)` API as every other event in this file.
   */
  onRsiEngineEvent: {
    listen: (cb: (e: RsiEngineEventLine) => void): Promise<UnlistenFn> =>
      listen<FeralAgentOutputEvent>('feral://agent-output', (raw) => {
        try {
          const parsed: unknown = JSON.parse(raw.payload.data);
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            (parsed as Record<string, unknown>)['type'] === 'rsi_engine_event'
          ) {
            cb(parsed as RsiEngineEventLine);
          }
        } catch {
          // non-JSON sidecar lines — ignore
        }
      }),
  },

  /**
   * Fractal Memory Search activity (`recall` / `grow`), filtered out of the
   * raw sidecar line stream. Drives the living organism. Same `.listen(cb)`
   * shape as every other event here.
   */
  onFractalActivity: {
    listen: (cb: (e: FractalActivityLine) => void): Promise<UnlistenFn> =>
      listen<FeralAgentOutputEvent>('feral://agent-output', (raw) => {
        try {
          const parsed: unknown = JSON.parse(raw.payload.data);
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            (parsed as Record<string, unknown>)['type'] === 'fractal_activity'
          ) {
            cb(parsed as FractalActivityLine);
          }
        } catch {
          // non-JSON sidecar lines — ignore
        }
      }),
  },
};
