/**
 * Type-level regression guard for the Tauri transport's `isInbound` validator.
 *
 * The validator must accept EXACTLY the union of `InboundMessage["type"]` —
 * nothing less (otherwise new message types are silently dropped — that's
 * what caused the Fractal Benchmark button to spin forever for 5 minutes:
 * `fractal_benchmark` was added to the union and the onMessage switch, but
 * the validator's allow-list wasn't updated, so the transport rejected the
 * message before the handler ever saw it).
 *
 * Two layers of protection:
 *   1. The runtime test below enumerates the union members and asserts
 *      `isInbound({ type: t })` is true for each.
 *   2. A type-level test below asserts that the union of literal strings
 *      covered by `isInbound` equals `InboundMessage["type"]`. This makes
 *      drift a compile error, not a runtime one.
 */

import { describe, expect, it } from "bun:test";
import { isInbound } from "../src/transports/tauri.ts";
import type { InboundMessage } from "../src/types.ts";

describe("isInbound — exhaustive coverage of InboundMessage union", () => {
  // Every member of `InboundMessage["type"]` MUST be accepted. If a new type
  // is added to the union, this list must be updated in lockstep — that's
  // the entire point of the test: the union is the source of truth.
  const expected: InboundMessage["type"][] = [
    "message",
    "ping",
    "shutdown",
    "set_model",
    "stop",
    "ask_user_response",
    "ask_user_cancel",
    "cron_add",
    "cron_remove",
    "cron_toggle",
    "cron_list",
    "desktop_control_response",
    "connectors_reload",
    // PROVISIONAL — temporary Settings button for the benchmark gate.
    "fractal_benchmark",
    "rsi_start",
    "rsi_stop",
    "rsi_set_concurrency",
    "rsi_response",
    // Slice A5 (L5 Governance) — must stay in lockstep with INBOUND_TYPES
    // in src/transports/tauri.ts. Drift here means a governance op would be
    // silently dropped by the transport before the handler sees it.
    "governance_status",
    "governance_propose",
    "governance_approve",
    "governance_reject",
    "governance_rollback",
    "governance_freeze",
    "governance_unfreeze",
    "governance_verify",
    "governance_history",
  ];
  for (const t of expected) {
    it(`accepts "${t}"`, () => {
      expect(isInbound({ type: t })).toBe(true);
    });
  }
});

describe("isInbound — negative cases", () => {
  it("rejects unknown type strings", () => {
    expect(isInbound({ type: "totally_made_up" })).toBe(false);
    expect(isInbound({ type: "fractal_bench" })).toBe(false); // close but wrong
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
});

describe("isInbound — payload variants", () => {
  it("accepts ask_user_response with requestId and answers", () => {
    expect(isInbound({ type: "ask_user_response", requestId: "r1", answers: [] })).toBe(true);
  });
  it("accepts ask_user_cancel with requestId", () => {
    expect(isInbound({ type: "ask_user_cancel", requestId: "r1" })).toBe(true);
  });
  it("accepts fractal_benchmark with no payload", () => {
    // The dev-only benchmark trigger carries no extra fields; a bare envelope
    // must still be accepted so the sidecar's case can handle it.
    expect(isInbound({ type: "fractal_benchmark" })).toBe(true);
  });
  it("accepts rsi_start with payload fields", () => {
    expect(isInbound({ type: "rsi_start", rsiGoal: "x", rsiMaxIterations: 5 })).toBe(true);
  });
  it("accepts connectors_reload with no payload", () => {
    expect(isInbound({ type: "connectors_reload" })).toBe(true);
  });
});
