/**
 * Host-tool bridge — the suspend/resume path, and the schema conversion that
 * decides whether the model can call these tools at all.
 *
 * The schema cases are not incidental. `passengers` in tau2's airline domain is
 * an array of objects with three required fields, expressed through pydantic's
 * `$defs`/`$ref`; if that structure does not survive into `ToolParameter.schema`
 * the model sees the bare word "array" and guesses — which is the documented
 * main source of bad_args, and it fails as a wrong answer rather than as an
 * error anyone can trace back to here.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HostToolBridge, loadHostTools } from "../src/core/host-tool-bridge.ts";
import type { OutboundEvent, ToolContext } from "../src/types.ts";

/** Enough ToolContext for tools that only ever call the bridge. */
function ctx(sessionId = "s1", signal?: AbortSignal): ToolContext {
  return {
    sessionId,
    signal,
    fetch: (() => {
      throw new Error("host tools must not reach the network");
    }) as unknown as ToolContext["fetch"],
    audit: (() => {}) as unknown as ToolContext["audit"],
    manifest: { name: "t", description: "", permissions: [], networkAccess: false },
  };
}

function writeDecl(tools: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "hosttools-"));
  const path = join(dir, "tools.json");
  writeFileSync(path, JSON.stringify({ tools }), "utf8");
  return path;
}

describe("HostToolBridge", () => {
  test("emits tool_request and resolves on the matching tool_response", async () => {
    const events: OutboundEvent[] = [];
    const bridge = new HostToolBridge((e) => events.push(e));

    const pending = bridge.call("book_reservation", { id: "abc" }, "s1");
    expect(events).toHaveLength(1);
    const ev = events[0] as Extract<OutboundEvent, { type: "tool_request" }>;
    expect(ev.type).toBe("tool_request");
    expect(ev.tool).toBe("book_reservation");
    expect(ev.arguments).toEqual({ id: "abc" });
    expect(ev.sessionId).toBe("s1");

    expect(bridge.resolve(ev.id, "booked")).toBe(true);
    expect(await pending).toBe("booked");
    expect(bridge.pendingCount).toBe(0);
  });

  test("a host-reported error rejects that one call", async () => {
    const events: OutboundEvent[] = [];
    const bridge = new HostToolBridge((e) => events.push(e));
    const pending = bridge.call("cancel_reservation", {}, "s1");
    const id = (events[0] as { id: string }).id;

    expect(bridge.fail(id, "reservation not found")).toBe(true);
    await expect(pending).rejects.toThrow("reservation not found");
  });

  test("an unknown id is reported, not silently swallowed", () => {
    const bridge = new HostToolBridge(() => {});
    // The host must be able to tell "you answered a call nobody was waiting
    // for" from "delivered" — otherwise a late answer looks like success.
    expect(bridge.resolve("no-such-id", "x")).toBe(false);
    expect(bridge.fail("no-such-id", "x")).toBe(false);
  });

  test("times out rather than hanging forever", async () => {
    const bridge = new HostToolBridge(() => {}, 10);
    await expect(bridge.call("slow_tool", {}, "s1")).rejects.toThrow(/no answer/);
    expect(bridge.pendingCount).toBe(0);
  });

  test("the registry's abort drops the pending entry", async () => {
    // The registry gives up at 60s and fires ctx.signal; without this the entry
    // would linger for the bridge's own five minutes and a late tool_response
    // would resolve a call the agent had already moved on from.
    const bridge = new HostToolBridge(() => {});
    const ac = new AbortController();
    const pending = bridge.call("slow_tool", {}, "s1", ac.signal);
    expect(bridge.pendingCount).toBe(1);
    ac.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(bridge.pendingCount).toBe(0);
  });

  test("cancelAll rejects everything in flight", async () => {
    const bridge = new HostToolBridge(() => {});
    const a = bridge.call("a", {}, "s1");
    const b = bridge.call("b", {}, "s1");
    bridge.cancelAll("shutdown");
    await expect(a).rejects.toThrow(/shutdown/);
    await expect(b).rejects.toThrow(/shutdown/);
    expect(bridge.pendingCount).toBe(0);
  });
});

describe("loadHostTools", () => {
  test("registers declared names verbatim, with no prefix", () => {
    // A prefix would break every tool reference in the host's policy document,
    // which is the text the model is reading when it decides what to call.
    const path = writeDecl([
      { name: "book_reservation", description: "Book.", inputSchema: { type: "object" } },
    ]);
    const tools = loadHostTools(path, new HostToolBridge(() => {}));
    expect(tools.map((t) => t.manifest.name)).toEqual(["book_reservation"]);
    expect(tools[0]!.manifest.permissions).toEqual([]);
    expect(tools[0]!.manifest.networkAccess).toBe(false);
  });

  test("nested $ref/$defs structure survives into ToolParameter.schema", () => {
    const path = writeDecl([
      {
        name: "book_reservation",
        inputSchema: {
          type: "object",
          $defs: {
            Passenger: {
              type: "object",
              properties: {
                first_name: { type: "string" },
                dob: { type: "string", description: "YYYY-MM-DD" },
              },
              required: ["first_name", "dob"],
            },
          },
          properties: {
            passengers: {
              type: "array",
              description: "Who is flying.",
              items: { $ref: "#/$defs/Passenger" },
            },
          },
          required: ["passengers"],
        },
      },
    ]);
    const [tool] = loadHostTools(path, new HostToolBridge(() => {}));
    const p = tool!.parameters.passengers!;
    expect(p.type).toBe("array");
    expect(p.required).toBe(true);

    // The item shape is the whole point: without it the model is guessing.
    const schema = p.schema as { items?: { properties?: Record<string, unknown>; required?: string[] } };
    expect(schema.items?.properties).toHaveProperty("first_name");
    expect(schema.items?.properties).toHaveProperty("dob");
    expect(schema.items?.required).toEqual(["first_name", "dob"]);
    // …and the pointer is gone, not passed through to dangle.
    expect(JSON.stringify(schema)).not.toContain("$ref");
    expect(JSON.stringify(schema)).not.toContain("$defs");
  });

  test("a self-referential schema degrades instead of blowing the stack", () => {
    // Legal JSON Schema. Recursing it to exhaustion would take down the whole
    // sidecar at registration time, on input the host is entitled to send.
    const path = writeDecl([
      {
        name: "walk_tree",
        inputSchema: {
          type: "object",
          $defs: {
            Node: {
              type: "object",
              properties: { child: { $ref: "#/$defs/Node" } },
            },
          },
          properties: { root: { $ref: "#/$defs/Node" } },
        },
      },
    ]);
    const [tool] = loadHostTools(path, new HostToolBridge(() => {}));
    expect(tool!.parameters.root!.type).toBe("object");
  });

  test("a broken declaration fails loudly instead of registering nothing", () => {
    // Silently coming up with zero tools is indistinguishable from a model that
    // refuses to act — the failure has to name the file.
    const bridge = new HostToolBridge(() => {});
    expect(() => loadHostTools(join(tmpdir(), "definitely-not-here.json"), bridge)).toThrow(
      /CINDERPAW_HOST_TOOLS/,
    );

    const dir = mkdtempSync(join(tmpdir(), "hosttools-"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, '{"nope": []}', "utf8");
    expect(() => loadHostTools(bad, bridge)).toThrow(/no "tools" array/);

    const nameless = writeDecl([{ description: "no name" }]);
    expect(() => loadHostTools(nameless, bridge)).toThrow(/no name/);
  });

  test("a call through the wrapped tool round-trips to the host", async () => {
    const events: OutboundEvent[] = [];
    const bridge = new HostToolBridge((e) => events.push(e));
    const path = writeDecl([{ name: "get_user_details", inputSchema: { type: "object" } }]);
    const [tool] = loadHostTools(path, bridge);

    const running = tool!.execute({ user_id: "u1" }, ctx("sess-9"));
    const ev = events[0] as Extract<OutboundEvent, { type: "tool_request" }>;
    expect(ev.sessionId).toBe("sess-9");
    bridge.resolve(ev.id, "Sofia Ahmed");
    expect(await running).toEqual({ ok: true, content: "Sofia Ahmed" });
  });

  test("a host failure reaches the model as a readable tool failure", async () => {
    const events: OutboundEvent[] = [];
    const bridge = new HostToolBridge((e) => events.push(e));
    const path = writeDecl([{ name: "cancel_reservation", inputSchema: { type: "object" } }]);
    const [tool] = loadHostTools(path, bridge);

    const running = tool!.execute({}, ctx());
    bridge.fail((events[0] as { id: string }).id, "reservation not found");
    const result = await running;
    expect(result.ok).toBe(false);
    // The model has to be able to read WHY, or it retries the same call.
    expect(result.content).toContain("reservation not found");
    expect(result.content).toContain("cancel_reservation");
  });
});
