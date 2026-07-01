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
 * Heartbeat for in-flight inference — emitted by the local Rust watchdog on
 * `feral://stream-progress` and by the sidecar (agent path) as a
 * `stream_progress` line on `feral://agent-output`. The React
 * `streamProgressEvent` (raw Rust) + `onStreamProgress` (filtered sidecar)
 * listeners fan this into the `streamProgress` zustand store.
 */
export interface StreamProgressEvent {
  sessionId: string;
  phase: 'prefill' | 'generating';
  elapsedMs: number;
  promptTokens: number;
  tokensGenerated: number;
  tokensPerSec: number;
}

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
  kind: 'recall' | 'grow' | 'seed' | 'prune';
  hits?: number;
  leafCount?: number;
  clusterCount?: number;
  clusters?: { x: number; y: number; weight: number }[];
  leafId?: number;
  sessionId?: string;
  ts?: number;
  /** `prune`: which cluster the fallen leaf belonged to (best-effort). */
  clusterIndex?: number;
}

/** Drill-down reply: the real member memories of one top-level cluster. */
export interface FractalClusterLeavesLine {
  type: 'fractal_cluster_leaves_result';
  id: string;
  leaves: { leafId: number; text: string; ts: number }[];
}

/**
 * Dream Cycle lifecycle pulse — emitted when an evolutionary episode starts
 * (`phase:"started"`) and ends (`phase:"ended"`). Drives the dream toast and
 * the typing-bar mascot's `dreaming` pose. Mirrors the `dream_cycle` arm of the
 * sidecar's OutboundEvent union.
 */
export interface DreamCycleLine {
  type: 'dream_cycle';
  phase: 'started' | 'ended';
  /** Fine 7-stage FSM transition (BRSI §2.8). Present on stage pulses; the
   *  toast/mascot only consume the coarse `phase` envelope (see the listener,
   *  which filters to phase-bearing events), so stage is informational here. */
  stage?: 'wake' | 'observe' | 'dream' | 'mutate' | 'evaluate' | 'remember' | 'sleep';
  trigger: 'idle' | 'error' | 'schedule' | 'user' | 'threshold' | 'budget_available';
  iterations?: number;
  ratchets?: number;
  stopReason?: string;
}

/**
 * Code-patch approval-gate snapshot (Faza 2 Slice 5). Filtered out of the
 * raw sidecar line stream. Mirrors the `code_patches` OutboundEvent in
 * `FeralAgent/src/types.ts`. Sent on `feral_code_patches_list` and after
 * every resolution so the Dreams-panel card always reflects the truth.
 */
export interface CodePatchesLine {
  type: 'code_patches';
  patches: Array<{
    id: string;
    status: string;
    score: number;
    rationale: string;
    affectedFiles: string[];
    patch: string;
    commitHash: string;
    createdAt: number;
    note?: string;
    error?: string;
  }>;
  /** True while the first-10 window is open (spec §2.5). */
  manualWindowOpen: boolean;
  appliedCount: number;
}

/**
 * Code-patch resolution ack (Faza 2 Slice 5). A single `code_patch_resolved`
 * arrives in reply to `feral_code_patch_resolve`; the sidecar follows it
 * with a refreshed `code_patches` snapshot. Same listener shape as the
 * other filtered sidecar streams.
 */
export interface CodePatchResolvedLine {
  type: 'code_patch_resolved';
  id: string;
  status: string;
  error?: string;
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
  /**
   * Live progress heartbeat for the local Rust inference path — emitted on
   * `feral://stream-progress` by the watchdog in `chat_stream`. The
   * sidecar's equivalent (`stream_progress` OutboundEvent) arrives on
   * `feral://agent-output` and is filtered by `onStreamProgress` below.
   */
  streamProgressEvent:    wrap<StreamProgressEvent>('feral://stream-progress'),
  downloadProgressEvent:  wrap<DownloadProgressEvent>('feral://download-progress'),
  downloadCompleteEvent:  wrap<DownloadCompleteEvent>('feral://download-complete'),
  downloadErrorEvent:     wrap<DownloadErrorEvent>('feral://download-error'),
  modelLoadProgressEvent: wrap<ModelLoadProgressEvent>('model-load-progress'),
  /**
   * Fractal Memory Search embedding-model download (the ~130 MB bge-small
   * model the sidecar needs at runtime). Same `Download*Event` payload shape
   * as the general-purpose HF download channel — only the channel name and
   * `repo_id` discriminator change. Always filter by `e.repoId === 'embedding'`
   * before applying state, since the sidecar can emit other repo downloads on
   * the same channels in the future.
   */
  onEmbeddingDownloadProgress: wrap<DownloadProgressEvent>('feral://embedding-download-progress'),
  onEmbeddingDownloadComplete: wrap<DownloadCompleteEvent>('feral://embedding-download-complete'),
  onEmbeddingDownloadError:    wrap<DownloadErrorEvent>('feral://embedding-download-error'),
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

  /**
   * Reactive-tree drill-down responses — the sidecar's member-memory reply to a
   * `feral_fractal_cluster_leaves` request, paired by `id`. Same filtered shape
   * as `onFractalActivity`.
   */
  onFractalClusterLeaves: {
    listen: (cb: (e: FractalClusterLeavesLine) => void): Promise<UnlistenFn> =>
      listen<FeralAgentOutputEvent>('feral://agent-output', (raw) => {
        try {
          const parsed: unknown = JSON.parse(raw.payload.data);
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            (parsed as Record<string, unknown>)['type'] === 'fractal_cluster_leaves_result'
          ) {
            cb(parsed as FractalClusterLeavesLine);
          }
        } catch {
          // non-JSON sidecar lines — ignore
        }
      }),
  },

/**
 * Dream Cycle lifecycle (`started` / `ended`), filtered out of the raw
 * sidecar line stream. Drives the dream toast + mascot pose. Same
 * `.listen(cb)` shape as every other event here.
 */
  onDreamCycle: {
    listen: (cb: (e: DreamCycleLine) => void): Promise<UnlistenFn> =>
      listen<FeralAgentOutputEvent>('feral://agent-output', (raw) => {
        try {
          const parsed: unknown = JSON.parse(raw.payload.data);
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            (parsed as Record<string, unknown>)['type'] === 'dream_cycle' &&
            // Forward only the coarse envelope (started/ended) that drives the
            // toast + mascot. The intermediate 7-stage pulses (observe/evaluate/
            // remember) carry no `phase` and flow past to other stream consumers.
            ((parsed as Record<string, unknown>)['phase'] === 'started' ||
              (parsed as Record<string, unknown>)['phase'] === 'ended')
          ) {
            cb(parsed as DreamCycleLine);
          }
        } catch {
          // non-JSON sidecar lines — ignore
        }
      }),
  },

  /**
   * Fine-grained Dream Cycle stage pulses (BRSI §2.8): every `dream_cycle`
   * event that carries a `stage` field — wake → observe → evaluate → remember
   * → sleep. Separate from `onDreamCycle` (which forwards only the coarse
   * started/ended envelope for the toast + mascot) so a per-stage indicator can
   * subscribe without touching the mascot path.
   */
  onDreamStage: {
    listen: (cb: (e: DreamCycleLine) => void): Promise<UnlistenFn> =>
      listen<FeralAgentOutputEvent>('feral://agent-output', (raw) => {
        try {
          const parsed: unknown = JSON.parse(raw.payload.data);
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            (parsed as Record<string, unknown>)['type'] === 'dream_cycle' &&
            typeof (parsed as Record<string, unknown>)['stage'] === 'string'
          ) {
            cb(parsed as DreamCycleLine);
          }
        } catch {
          // non-JSON sidecar lines — ignore
        }
      }),
  },

/**
   * Heartbeat for the agent (sidecar) inference path. Filters the raw
   * `feral://agent-output` stream for `type === "stream_progress"` lines.
   * Same `.listen(cb)` shape as every other event in this file.
   */
  onStreamProgress: {
    listen: (cb: (e: StreamProgressEvent) => void): Promise<UnlistenFn> =>
      listen<FeralAgentOutputEvent>('feral://agent-output', (raw) => {
        try {
          const parsed: unknown = JSON.parse(raw.payload.data);
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            (parsed as Record<string, unknown>)['type'] === 'stream_progress'
          ) {
            cb(parsed as StreamProgressEvent);
          }
        } catch {
          // non-JSON sidecar lines — ignore
        }
      }),
  },

  /**
   * Pending code-patch queue snapshot (Faza 2 Slice 5). Filtered out of the
   * raw sidecar line stream for `type === "code_patches"`. The Dreams-panel
   * card consumes this on mount (via `feral_code_patches_list`) and on every
   * resolution ack. Same `.listen(cb)` shape as the other filtered listeners.
   */
  onCodePatches: {
    listen: (cb: (e: CodePatchesLine) => void): Promise<UnlistenFn> =>
      listen<FeralAgentOutputEvent>('feral://agent-output', (raw) => {
        try {
          const parsed: unknown = JSON.parse(raw.payload.data);
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            (parsed as Record<string, unknown>)['type'] === 'code_patches'
          ) {
            cb(parsed as CodePatchesLine);
          }
        } catch {
          // non-JSON sidecar lines — ignore
        }
      }),
  },

  /**
   * Code-patch resolution ack (Faza 2 Slice 5). Filtered out of the raw
   * sidecar line stream for `type === "code_patch_resolved"`. The card uses
   * this for per-row feedback (`apply_failed` surfaces the error inline);
   * a refreshed `code_patches` always follows this ack.
   */
  onCodePatchResolved: {
    listen: (cb: (e: CodePatchResolvedLine) => void): Promise<UnlistenFn> =>
      listen<FeralAgentOutputEvent>('feral://agent-output', (raw) => {
        try {
          const parsed: unknown = JSON.parse(raw.payload.data);
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            (parsed as Record<string, unknown>)['type'] === 'code_patch_resolved'
          ) {
            cb(parsed as CodePatchResolvedLine);
          }
        } catch {
          // non-JSON sidecar lines — ignore
        }
      }),
  },
};
