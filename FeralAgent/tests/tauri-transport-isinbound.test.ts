/**
 * Tests for the Tauri transport's `isInbound` message-type validator.
 *
 * The validator decides which `InboundMessage.type` strings the sidecar
 * accepts from stdin. New message types must be added in three places:
 *   1. The `InboundMessage` union in `src/types.ts`
 *   2. The `isInbound` check in `src/transports/tauri.ts`
 *   3. The `onMessage` handler in `src/index.ts` (where the type is routed)
 *
 * This test pins the validator's surface so a future change doesn't
 * silently drop new message types (the ask_user bug was caused by exactly
 * this kind of drift).
 */

import { describe, expect, it } from "bun:test";
import { isInbound } from "../src/transports/tauri.ts";
import type { InboundMessage } from "../src/types.ts";

describe("isInbound", () => {
  it("accepts all known message types", () => {
    const accepted: InboundMessage["type"][] = [
      "message",
      "ping",
      "shutdown",
      "set_model",
      "ask_user_response",
      "ask_user_cancel",
      "cron_add",
      "cron_remove",
      "cron_toggle",
      "cron_list",
    ];
    for (const t of accepted) {
      expect(isInbound({ type: t })).toBe(true);
    }
  });

  it("rejects unknown type strings", () => {
    expect(isInbound({ type: "totally_made_up" })).toBe(false);
    expect(isInbound({ type: "" })).toBe(false);
  });

  it("rejects non-object values", () => {
    expect(isInbound(null)).toBe(false);
    expect(isInbound(undefined)).toBe(false);
    expect(isInbound("message")).toBe(false);
    expect(isInbound(42)).toBe(false);
    expect(isInbound([])).toBe(false);
  });

  it("rejects objects without a type field", () => {
    expect(isInbound({})).toBe(false);
    expect(isInbound({ payload: 1 })).toBe(false);
  });

  it("accepts ask_user_response with requestId and answers", () => {
    expect(isInbound({ type: "ask_user_response", requestId: "r1", answers: [] })).toBe(true);
  });

  it("accepts ask_user_cancel with requestId", () => {
    expect(isInbound({ type: "ask_user_cancel", requestId: "r1" })).toBe(true);
  });
});
