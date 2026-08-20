/**
 * TUI transport — Cinderpaw headless slice 5.1.
 *
 * In-process fan-out transport for the terminal TUI. Unlike TauriTransport,
 * which serialises JSON to stdout, this transport:
 *
 *   - DOES NOT read stdin (the chat loop uses readline and calls
 *     {@link sendInboundAsMessage} explicitly).
 *   - Fans out every outbound event to subscribers registered via
 *     {@link onEvent}, so the chat loop can render chunks/tool calls/errors
 *     as they arrive.
 *
 * The chat loop constructs a TuiTransport, registers its renderer via
 * onEvent, then calls `main(transport)` with it as the override.
 */

import type { InboundMessage, OutboundEvent, Transport } from "../types.ts";
import { randomUUID } from "node:crypto";

export type TuiEventHandler = (event: OutboundEvent) => void;

export class TuiTransport implements Transport {
  #onMessage: ((msg: InboundMessage) => void | Promise<void>) | null = null;
  #onReady: (() => void) | null = null;
  #eventHandlers = new Set<TuiEventHandler>();
  #started = false;
  /** In-flight handler promises, drained before exit. */
  readonly #pending = new Set<Promise<void>>();

  /**
   * Subscribe to outbound events. Returns an unsubscribe function.
   * The chat loop registers its renderer here.
   */
  onEvent(handler: TuiEventHandler): () => void {
    this.#eventHandlers.add(handler);
    return () => this.#eventHandlers.delete(handler);
  }

  /**
   * Inject a plain-text user message into the inbound handler, bypassing
   * stdin. Called by the chat loop when the user presses Enter.
   */
  sendInboundAsMessage(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.#dispatch({
      type: "message",
      id: randomUUID(),
      content: trimmed,
    });
  }

  /** Transport.send — fan out to all subscribed event handlers. */
  send(event: OutboundEvent): void {
    for (const handler of this.#eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        process.stderr.write(`[tui] event handler threw: ${String(err)}\n`);
      }
    }
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
    // No stdin listeners — the chat loop owns stdin via readline.
    // Just fire ready on the next tick.
    queueMicrotask(() => this.#onReady?.());
  }

  #dispatch(msg: InboundMessage): void {
    const handler = this.#onMessage;
    if (handler === null) return;
    const promise = Promise.resolve(handler(msg)).catch(() => {})
      .then(() => { this.#pending.delete(promise); });
    this.#pending.add(promise);
  }
}