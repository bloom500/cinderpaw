/**
 * Global Feral Agent stream manager.
 *
 * The Feral Agent sidecar streams `feral://agent-output` events for the whole
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
import type { FeralAgentEvent } from '@/lib/tauri';

export interface FeralStreamHandlers {
  onChunk: (content: string) => void;
  /** Called when the agent loop finishes. `finalContent` is the agent's
   *  authoritative answer — use it as fallback if no chunks were streamed. */
  onDone: (finalContent?: string) => void;
  onError: (message: string) => void;
  onToolStart?: (tool: string, args: Record<string, unknown>) => void;
  onToolDone?: (tool: string) => void;
}

const inflight = new Map<string, FeralStreamHandlers>();
let unlisten: UnlistenFn | null = null;
let initPromise: Promise<void> | null = null;

/**
 * Lazily install the single persistent `feral://agent-output` listener.
 * Idempotent and safe to call before every send. Must resolve before the
 * `feral_send_message` invoke so the first chunk is never missed.
 */
export function ensureFeralListener(): Promise<void> {
  if (unlisten) return Promise.resolve();
  if (initPromise) return initPromise;
  initPromise = listen<{ data: string }>('feral://agent-output', (event) => {
    let parsed: FeralAgentEvent;
    try {
      parsed = JSON.parse(event.payload.data) as FeralAgentEvent;
    } catch {
      return;
    }

    switch (parsed.type) {
      case 'chunk':
        if (parsed.id) inflight.get(parsed.id)?.onChunk(parsed.content);
        break;
      case 'done':
        if (parsed.id) {
          const h = inflight.get(parsed.id);
          if (h) {
            inflight.delete(parsed.id);
            h.onDone(parsed.content);
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
            h.onError(parsed.message);
          }
        } else {
          for (const [, h] of inflight) h.onError(parsed.message);
          inflight.clear();
        }
        break;
      case 'tool_start':
        if (parsed.id) inflight.get(parsed.id)?.onToolStart?.(parsed.tool, parsed.args ?? {});
        break;
      case 'tool_done':
        if (parsed.id) inflight.get(parsed.id)?.onToolDone?.(parsed.tool);
        break;
      // proactive / pong / model_set / model_error handled elsewhere (useFeralGlobal).
      default:
        break;
    }
  }).then((fn) => {
    unlisten = fn;
  });
  return initPromise;
}

/** Register handlers for an in-flight sidecar message. */
export function registerFeralStream(messageId: string, handlers: FeralStreamHandlers): void {
  inflight.set(messageId, handlers);
}
