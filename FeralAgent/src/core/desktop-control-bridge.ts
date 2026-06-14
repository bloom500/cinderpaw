/**
 * DesktopControlBridge — Promise-based RPC to the Rust desktop-control backend.
 *
 * Same shape as the AskUserBridge: emit a `desktop_control_request` event with
 * a fresh id, hold a pending Promise, and resolve it when the matching
 * `desktop_control_response` arrives back over the transport. The OS
 * accessibility work — and every security decision — lives in the Rust host;
 * this module is a transport-agnostic correlator with a timeout so a lost
 * response can never hang the agent loop forever.
 */

import { randomUUID } from "node:crypto";
import type {
  DesktopControlBridge,
  OutboundEvent,
} from "../types.ts";
import { DesktopControlTimeoutError } from "../types.ts";

export { DesktopControlTimeoutError };

export interface DesktopControlBridgeConfig {
  /** Per-request timeout in ms. UIA tree walks on a busy app can be slow, so
   *  this is generous (30s) but bounded. */
  timeoutMs: number;
}

const DEFAULT_CONFIG: DesktopControlBridgeConfig = {
  timeoutMs: 30_000,
};

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class DesktopControlBridgeImpl implements DesktopControlBridge {
  readonly #emit: (event: OutboundEvent) => void;
  readonly #config: DesktopControlBridgeConfig;
  readonly #pending = new Map<string, Pending>();

  constructor(
    emit: (event: OutboundEvent) => void,
    config: Partial<DesktopControlBridgeConfig> = {},
  ) {
    this.#emit = emit;
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }

  request(
    action: string,
    params: Record<string, unknown>,
    sessionId: string = "default",
  ): Promise<unknown> {
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.#pending.get(id);
        if (!p) return;
        this.#pending.delete(id);
        reject(new DesktopControlTimeoutError(id, this.#config.timeoutMs));
      }, this.#config.timeoutMs);

      this.#pending.set(id, { resolve, reject, timer });
      this.#emit({ type: "desktop_control_request", id, sessionId, action, params });
    });
  }

  /**
   * Settle a pending request from an inbound `desktop_control_response`.
   * No-op for unknown ids (already timed out / cancelled). On `ok === false`
   * the Promise rejects with the backend's error message.
   */
  resolve(id: string, ok: boolean, data: unknown, error?: string): void {
    const p = this.#pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.#pending.delete(id);
    if (ok) {
      p.resolve(data);
    } else {
      p.reject(new Error(error ?? "desktop control failed"));
    }
  }

  /** Reject all in-flight requests (shutdown). */
  cancelAll(reason: string = "agent shutdown"): void {
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      this.#pending.delete(id);
      p.reject(new Error(`desktop_control request ${id} cancelled: ${reason}`));
    }
  }

  /** Diagnostic: number of in-flight requests. */
  get pendingCount(): number {
    return this.#pending.size;
  }
}
