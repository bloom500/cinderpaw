import { describe, expect, test } from "bun:test";
import { unwrapDoubleEncodedCall } from "../src/tools/registry.ts";

// The exact strings a GLM run put in the name slot on tau2 task 32 — four
// times, differing only in whitespace, never recovering.
const OBSERVED = [
  '{"name":"get_reservation_details","args":{"reservation_id":"OWZ4XL"}}',
  '{"name":"get_reservation_details","args":{"reservation_id": "OWZ4XL"}}',
  '{"name":"get_reservation_details", "args": {"reservation_id": "OWZ4XL"}}',
];
const known = (n: string) => n === "get_reservation_details";

describe("a call the model serialised twice", () => {
  test.each(OBSERVED)("unwraps %s", (wire) => {
    const out = unwrapDoubleEncodedCall(wire, {}, known);
    expect(out.name).toBe("get_reservation_details");
    expect(out.args).toEqual({ reservation_id: "OWZ4XL" });
  });

  test("accepts the other wire spellings of the payload key", () => {
    for (const key of ["arguments", "parameters", "input"]) {
      const wire = JSON.stringify({ name: "get_reservation_details", [key]: { reservation_id: "X" } });
      expect(unwrapDoubleEncodedCall(wire, {}, known).args).toEqual({ reservation_id: "X" });
    }
  });

  test("a wrapper with no payload keeps the outer args rather than losing them", () => {
    const out = unwrapDoubleEncodedCall('{"name":"get_reservation_details"}', { a: 1 }, known);
    expect(out).toEqual({ name: "get_reservation_details", args: { a: 1 } });
  });
});

describe("everything else is left exactly alone", () => {
  test("a name that resolves is never parsed, brace or not", () => {
    const out = unwrapDoubleEncodedCall("get_reservation_details", { a: 1 }, known);
    expect(out).toEqual({ name: "get_reservation_details", args: { a: 1 } });
  });

  test("a genuinely missing tool still reports as itself", () => {
    // The honest failure must survive: unwrapping is not a place to guess.
    for (const bad of ["get_details", "{not json", "{}", '{"name":"no_such_tool"}', '["a"]']) {
      expect(unwrapDoubleEncodedCall(bad, {}, known).name).toBe(bad);
    }
  });

  test("Gemini's XML tail after the JSON is dropped, and the real call comes out", () => {
    // Observed on a voice call, 13 Sep 2026: the model wrapped the call in
    // <arg_value> markup and the closing tag rode along in the name slot.
    const wire = '{"name":"shell_exec","args":{"argv":["cmd","/c","tasklist"],"timeout_ms":15000}}</arg_value>';
    const out = unwrapDoubleEncodedCall(wire, {}, (n) => n === "shell_exec");
    expect(out.name).toBe("shell_exec");
    expect(out.args).toEqual({ argv: ["cmd", "/c", "tasklist"], timeout_ms: 15000 });
  });

  test("a twice-wrapped call (the retry echo) is peeled to the real one", () => {
    const innerWire = '{"name":"control_app","args":{"action":"list_windows"}}</arg_value>';
    const wire = JSON.stringify({ name: innerWire, args: {} });
    const out = unwrapDoubleEncodedCall(wire, {}, (n) => n === "control_app");
    expect(out.name).toBe("control_app");
    expect(out.args).toEqual({ action: "list_windows" });
  });
});
