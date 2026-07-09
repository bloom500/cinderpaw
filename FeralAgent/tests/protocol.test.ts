import { describe, expect, test } from "bun:test";
import { INBOUND_TYPES, OUTBOUND_TYPES, SIDECAR_PROTOCOL } from "../src/protocol.ts";

describe("protocol.ts", () => {
  test("SIDECAR_PROTOCOL is 1", () => {
    expect(SIDECAR_PROTOCOL).toBe(1);
  });
  test("no duplicate inbound types", () => {
    expect(new Set(INBOUND_TYPES).size).toBe(INBOUND_TYPES.length);
  });
  test("no duplicate outbound types", () => {
    expect(new Set(OUTBOUND_TYPES).size).toBe(OUTBOUND_TYPES.length);
  });
});
