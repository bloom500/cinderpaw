/**
 * MCPClient over HTTP — an extension on the web, no Node, no process.
 * Real local servers: one Streamable HTTP (answers in JSON and in an event
 * stream), one of the older SSE pair, one that refuses the key.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { MCPClient, fetchSameSite } from "../src/egress/mcp-client.ts";

const noAudit = () => {};
const TOOLS = { tools: [{ name: "post_now", description: "Post", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] };

function answer(id: unknown, method: string, params: { name?: string; arguments?: { text?: string } } | undefined) {
  if (method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "t" } } };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: TOOLS };
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `posted ${params?.arguments?.text}` }] } };
}

const seen: { auth: string | null; session: string | null }[] = [];

const streamable = Bun.serve({
  port: 0,
  async fetch(req) {
    const msg = await req.json();
    seen.push({ auth: req.headers.get("authorization"), session: req.headers.get("mcp-session-id") });
    if (!("id" in msg)) return new Response(null, { status: 202 });
    const body = answer(msg.id, msg.method, msg.params);
    // tools/call answers as an event stream, with a server ping first.
    if (msg.method === "tools/call") {
      const ping = JSON.stringify({ jsonrpc: "2.0", id: msg.id, method: "ping" });
      return new Response(`data: ${ping}\n\nevent: message\ndata: ${JSON.stringify(body)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json(body, { headers: { "mcp-session-id": "s-1" } });
  },
});

let push: ((s: string) => void) | null = null;
const legacy = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/sse") {
      const stream = new ReadableStream<string>({
        start(c) {
          push = (s) => c.enqueue(s);
          c.enqueue("event: endpoint\ndata: /messages?sid=1\n\n");
        },
      });
      return new Response(stream.pipeThrough(new TextEncoderStream()), { headers: { "content-type": "text/event-stream" } });
    }
    if (req.method === "POST" && url.pathname === "/messages") {
      const msg = await req.json();
      if ("id" in msg) push?.(`event: message\ndata: ${JSON.stringify(answer(msg.id, msg.method, msg.params))}\n\n`);
      return new Response(null, { status: 202 });
    }
    return new Response("not here", { status: 405 });
  },
});

const refusing = Bun.serve({
  port: 0,
  fetch: () => new Response("Upgrade to Pro to use MCP", { status: 403 }),
});

// Other files swap the global fetch for stubs; on macOS one was still in place
// when this file ran and every call hung. The client uses the global fetch,
// so give it the real one here, as redirect-credentials.test.ts does.
let stubbedFetch: typeof globalThis.fetch;
beforeAll(() => {
  stubbedFetch = globalThis.fetch;
  globalThis.fetch = Bun.fetch as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = stubbedFetch;
  streamable.stop(true);
  legacy.stop(true);
  refusing.stop(true);
});

describe("MCPClient over HTTP", () => {
  test("Streamable HTTP: key and session go with every call; an event-stream answer is read", async () => {
    const c = new MCPClient({ command: "", url: streamable.url.href, headers: { Authorization: "Bearer sk_1" } }, noAudit);
    await c.connect();
    const tools = await c.buildTools();
    expect(tools.map((t) => t.manifest.name)).toEqual(["mcp_post_now"]);
    expect(await c.callTool("post_now", { text: "hi" })).toBe("posted hi");
    await c.disconnect();
    expect(seen.every((s) => s.auth === "Bearer sk_1")).toBe(true);
    expect(seen.slice(1).every((s) => s.session === "s-1")).toBe(true);
  });

  test("an older server that turns the POST away is reached over its event stream", async () => {
    const c = new MCPClient({ command: "", url: new URL("/sse", legacy.url).href }, noAudit);
    await c.connect();
    expect((await c.listTools()).map((t) => t.name)).toEqual(["post_now"]);
    expect(await c.callTool("post_now", { text: "old" })).toBe("posted old");
    await c.disconnect();
  });

  test("a refused key fails with the status and the server's own words", async () => {
    const c = new MCPClient({ command: "", url: refusing.url.href, headers: { Authorization: "Bearer bad" } }, noAudit);
    await expect(c.connect()).rejects.toThrow(/HTTP 403 Upgrade to Pro/);
  });

  test("a redirect to another site is refused, so a key header never follows it", async () => {
    let leaked: string | null = null;
    const other = Bun.serve({ port: 0, fetch: (req) => { leaked = req.headers.get("x-api-key"); return Response.json({}); } });
    const mover = Bun.serve({
      port: 0,
      fetch: (req) => new URL(req.url).pathname === "/old"
        ? new Response(null, { status: 307, headers: { location: "/mcp" } })
        : new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${other.port}/mcp` } }),
    });
    try {
      // /old hops to /mcp on the same site (followed); /mcp points away (refused).
      await expect(fetchSameSite(new URL("/old", mover.url).href, { method: "POST", body: "{}" })).rejects.toThrow(/another site/);
      await expect(fetchSameSite(mover.url.href, { method: "POST", headers: { "X-API-Key": "sk_1" }, body: "{}" })).rejects.toThrow(/another site/);
      expect(leaked).toBeNull();
    } finally {
      other.stop(true);
      mover.stop(true);
    }
  });
});
