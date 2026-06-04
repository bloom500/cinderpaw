/**
 * Transport interface.
 *
 * The agent core is transport-agnostic: it speaks only in InboundMessage /
 * OutboundEvent envelopes and never knows whether it is running inside Tauri,
 * Telegram, or anything else. Concrete transports (tauri.ts, and the V2 stubs)
 * implement this contract.
 *
 * The canonical type definitions live in ../types.ts; this module re-exports
 * them so transport implementations can import from a single, intent-revealing
 * location.
 */

export type {
  InboundMessage,
  OutboundEvent,
  Transport,
} from "../types.ts";
