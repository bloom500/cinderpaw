/**
 * Faza 1 — Async RSI Engine: protocol (a) bridge client (sidecar → Rust).
 *
 * The asymmetric-trust boundary in action: the sidecar never scores
 * itself or writes the git substrate. It sends a request over stdout and
 * Rust replies over stdin. This client assigns a correlation id, emits
 * `{type:"rsi_request", id, method, params}` through the transport, and
 * resolves the matching Promise when `onResponse` delivers a
 * `{type:"rsi_response", id, ok, data|error}` line.
 *
 * The Rust side (feral_agent.rs `handle_rsi_request`) guarantees exactly
 * one response per request, mirroring the desktop_control bridge.
 */

/** The minimal stdout transport: write one JSON object as a line. */
export interface BridgeTransport {
  send: (message: Record<string, unknown>) => void;
}

/** A response line as delivered by the stdin reader. */
export interface RsiResponse {
  type?: string;
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export class RsiBridge {
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  constructor(private readonly transport: BridgeTransport) {}

  /** Send `method`(`params`) to Rust and resolve with its `data`. */
  request<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = `rsi-${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.transport.send({ type: "rsi_request", id, method, params });
    });
  }

  /** Feed a response line in; resolves/rejects the matching request. */
  onResponse(msg: RsiResponse): void {
    const entry = this.pending.get(msg.id);
    if (!entry) return; // unknown / already-settled id — ignore
    this.pending.delete(msg.id);
    if (msg.ok) {
      entry.resolve(msg.data);
    } else {
      entry.reject(new Error(msg.error ?? "rsi_request failed"));
    }
  }
}
