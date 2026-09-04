/**
 * RequestBridge — Promise-based request/response RPC over the transport.
 *
 * The sidecar emits a `<name>_request` event and awaits the matching
 * `<name>_response`. That pattern already exists twice in this codebase
 * (`desktop-control-bridge.ts` and the RSI bridge) and is entirely generic:
 * only the two event names and the timeout differ. This is that plumbing,
 * once.
 *
 * ponytail: the two existing bridges still have their own copies. They work
 * and they are wired into live paths, so they are not being rewritten as a
 * side effect of a security change — port them when one of them next needs a
 * fix.
 *
 * The bridge makes no decisions. Every security gate lives on the host side
 * of the wire; this only marshals JSON and guarantees each request settles
 * exactly once — on a response, or on the timeout.
 */

import { randomUUID } from "node:crypto";
import type { OutboundEvent } from "../types.ts";

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RequestBridgeTimeoutError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly timeoutMs: number,
    kind: string,
  ) {
    super(`${kind} request ${requestId} timed out after ${timeoutMs}ms`);
    this.name = "RequestBridgeTimeoutError";
  }
}

export class RequestBridge {
  readonly #emit: (event: OutboundEvent) => void;
  readonly #kind: string;
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, Pending>();

  /**
   * @param kind        event-name stem — "capability" emits `capability_request`
   * @param timeoutMs   per-request ceiling; a network fetch needs room
   */
  constructor(
    emit: (event: OutboundEvent) => void,
    kind: string,
    timeoutMs = 30_000,
  ) {
    this.#emit = emit;
    this.#kind = kind;
    this.#timeoutMs = timeoutMs;
  }

  request(
    action: string,
    params: Record<string, unknown>,
    sessionId = "default",
  ): Promise<unknown> {
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.#pending.get(id);
        if (!p) return;
        this.#pending.delete(id);
        reject(new RequestBridgeTimeoutError(id, this.#timeoutMs, this.#kind));
      }, this.#timeoutMs);

      this.#pending.set(id, { resolve, reject, timer });
      this.#emit({
        type: `${this.#kind}_request`,
        id,
        sessionId,
        action,
        params,
      } as OutboundEvent);
    });
  }

  /**
   * Settle a pending request from the matching inbound response. A no-op for
   * unknown ids (already timed out or cancelled), so a late reply cannot
   * resolve a request that has moved on.
   */
  resolve(id: string, ok: boolean, data: unknown, error?: string): void {
    const p = this.#pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.#pending.delete(id);
    if (ok) p.resolve(data);
    else p.reject(new Error(error ?? `${this.#kind} request failed`));
  }

  /** Reject everything in flight (shutdown). */
  cancelAll(reason = "agent shutdown"): void {
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      this.#pending.delete(id);
      p.reject(new Error(`${this.#kind} request ${id} cancelled: ${reason}`));
    }
  }

  /** Diagnostic: number of in-flight requests. */
  get pendingCount(): number {
    return this.#pending.size;
  }
}
