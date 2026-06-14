/**
 * Tauri sidecar transport.
 *
 * Used when Feral Agent runs as a Bun sidecar inside the Feral desktop app.
 * Communication is newline-delimited JSON:
 *   - inbound:  one JSON object per line on stdin
 *   - outbound: one JSON object per line on stdout
 * stdout is reserved exclusively for protocol traffic; all diagnostics go to
 * stderr so the host never has to parse mixed output.
 */

import type {
  InboundMessage,
  OutboundEvent,
  Transport,
} from "../types.ts";

export class TauriTransport implements Transport {
  #onMessage: ((msg: InboundMessage) => void | Promise<void>) | null = null;
  #onReady: (() => void) | null = null;
  #buffer = "";
  #started = false;
  /** In-flight handler promises, drained before exit on stdin close. */
  readonly #pending = new Set<Promise<void>>();

  send(event: OutboundEvent): void {
    // One compact JSON object per line. process.stdout.write is synchronous
    // enough for line-delimited protocol use and avoids console formatting.
    process.stdout.write(JSON.stringify(event) + "\n");
  }

  onMessage(handler: (msg: InboundMessage) => void | Promise<void>): void {
    this.#onMessage = handler;
  }

  onReady(handler: () => void): void {
    this.#onReady = handler;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;

    process.stdin.setEncoding("utf8");

    process.stdin.on("data", (chunk: string) => {
      this.#buffer += chunk;
      this.#drain();
    });

    process.stdin.on("end", () => {
      // Flush any trailing line without a terminator, then exit once all
      // in-flight handlers have settled so no response is dropped.
      const last = this.#buffer.trim();
      if (last) this.#dispatch(last);
      void Promise.allSettled([...this.#pending]).then(() => process.exit(0));
    });

    // Signal readiness on the next tick so callers can finish wiring handlers.
    queueMicrotask(() => this.#onReady?.());
  }

  /** Split the buffer on newlines and dispatch each complete line. */
  #drain(): void {
    let index = this.#buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line) this.#dispatch(line);
      index = this.#buffer.indexOf("\n");
    }
  }

  #dispatch(line: string): void {
    let msg: InboundMessage;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isInbound(parsed)) {
        throw new Error("missing or invalid 'type' field");
      }
      msg = parsed;
    } catch (err) {
      this.send({
        type: "error",
        message: `malformed inbound message: ${String(err)}`,
      });
      return;
    }

    // Errors thrown by the handler must not break the stdin reader. Track the
    // promise so a stdin close waits for it before exiting.
    const work = Promise.resolve(this.#onMessage?.(msg))
      .catch((err: unknown) => {
        this.send({
          type: "error",
          id: msg.id,
          message: `handler error: ${String(err)}`,
        });
      })
      .then(() => {
        this.#pending.delete(work);
      });
    this.#pending.add(work);
  }
}

/**
 * Validate an inbound JSON object as an `InboundMessage`. Exported so the
 * type drift that caused the ask_user response bug (a new type added in
 * React, sidecar's `onMessage`, and the validator) can be caught with a
 * one-line test.
 */
export function isInbound(value: unknown): value is InboundMessage {
  if (typeof value !== "object" || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return (
    t === "message" ||
    t === "ping" ||
    t === "shutdown" ||
    t === "set_model" ||
    t === "stop" ||
    t === "ask_user_response" ||
    t === "ask_user_cancel" ||
    t === "cron_add" ||
    t === "cron_remove" ||
    t === "cron_toggle" ||
    t === "cron_list" ||
    t === "desktop_control_response"
  );
}
