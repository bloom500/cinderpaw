/**
 * Liveness heartbeat — P2-#1.
 *
 * Emits a periodic `heartbeat` OutboundEvent to the transport so the
 * Tauri shell / React UI knows:
 *   - the sidecar is alive (didn't crash or hang)
 *   - memory pressure (RSS in MB)
 *   - how many sessions are currently active
 *
 * The heartbeat fires on a slow tick (default 30s) — fast enough to
 * detect hangs within the UI's polling window, slow enough that the
 * event stream isn't dominated by heartbeats.
 *
 * The Tauri transport's onMessage handler should send `process.exit(0)`
 * if no heartbeat has been received in N intervals (e.g. 3× = 90s).
 * Without a heartbeat, the sidecar might be silently stuck in a bun:sqlite
 * call or an infinite loop — the only signal that it's still alive is
 * stdout activity, and a stuck process emits nothing.
 */

import type { EventSink } from "./agent-loop.ts";

export interface HeartbeatConfig {
  /** Heartbeat interval in milliseconds. Default 30s. */
  intervalMs: number;
  /**
   * Function returning the number of currently active sessions. The
   * AgentLoop provides this via its `#activeSessions` set size.
   * Returning 0 is fine; the heartbeat still fires for "alive" signal.
   */
  getActiveSessions: () => number;
}

export class HeartbeatLoop {
  readonly #startedAt = Date.now();
  #intervalMs: number;
  #getActiveSessions: () => number;
  #emit: EventSink | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;

  constructor(config: Partial<HeartbeatConfig> = {}) {
    this.#intervalMs = config.intervalMs ?? 30_000;
    this.#getActiveSessions = config.getActiveSessions ?? (() => 0);
  }

  /** Attach the transport sink that receives heartbeat events. */
  setEmit(emit: EventSink): void {
    this.#emit = emit;
  }

  /** Start the heartbeat loop. Idempotent. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#schedule();
  }

  /** Stop the loop cleanly. */
  stop(): void {
    this.#running = false;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /** Update the interval at runtime (e.g. dev tools toggling). */
  setInterval(intervalMs: number): void {
    this.#intervalMs = intervalMs;
  }

  /** Build the current heartbeat payload. Public for testing. */
  snapshot(): { uptimeMs: number; rssMb: number; activeSessions: number } {
    return {
      uptimeMs: Date.now() - this.#startedAt,
      rssMb: this.#rssMb(),
      activeSessions: this.#getActiveSessions(),
    };
  }

  /** Emit a heartbeat right now (also called on the timer). */
  emitNow(): void {
    if (this.#emit) {
      this.#emit({ type: "heartbeat", ...this.snapshot() });
    }
  }

  #schedule(): void {
    if (!this.#running) return;
    this.#timer = setTimeout(() => {
      try {
        this.emitNow();
      } catch {
        // Heartbeat errors must NEVER crash the sidecar.
      }
      this.#schedule();
    }, this.#intervalMs);
    // Don't keep the process alive just for heartbeats.
    this.#timer.unref?.();
  }

  /**
   * Best-effort RSS (Resident Set Size) in MB. Uses process.memoryUsage
   * on Node-style runtimes; on runtimes where it's unavailable, returns
   * 0 and the heartbeat still fires (we just lose the memory signal).
   */
  #rssMb(): number {
    try {
      // Bun exposes process.memoryUsage with rss (bytes).
      const mem = (process as { memoryUsage?: () => { rss?: number } }).memoryUsage?.();
      if (mem?.rss) return Math.round(mem.rss / 1024 / 1024);
      return 0;
    } catch {
      return 0;
    }
  }
}
