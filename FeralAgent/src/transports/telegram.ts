/**
 * Telegram transport — V2 stub.
 *
 * Placeholder implementing the Transport contract so the agent core can be
 * wired against it without change when Telegram support lands. Throws on start
 * to make accidental use obvious during V1.
 */

import type {
  InboundMessage,
  OutboundEvent,
  Transport,
} from "../types.ts";

export class TelegramTransport implements Transport {
  send(_event: OutboundEvent): void {
    throw new Error("TelegramTransport is not implemented (V2)");
  }

  onMessage(_handler: (msg: InboundMessage) => void | Promise<void>): void {
    // no-op until V2
  }

  onReady(_handler: () => void): void {
    // no-op until V2
  }

  start(): void {
    throw new Error("TelegramTransport is not implemented (V2)");
  }
}
