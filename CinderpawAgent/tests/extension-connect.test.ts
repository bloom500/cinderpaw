/**
 * extension_connect: the agent connects a service from the chat, with the
 * person's "Connect" as the only way in. McpManager.addServer keeps the entry
 * only when the service really answered.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpManager, customServer, loadMcpConfig } from "../src/egress/mcp-manager.ts";
import { validateManifest } from "../src/egress/tool-permissions.ts";
import { createExtensionConnectTool } from "../src/tools/builtin/extension-connect.ts";
import type { AskUserAnswer, AskUserQuestion, Tool, ToolContext } from "../src/types.ts";

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (req.headers.get("authorization") !== "Bearer sk_good") return new Response("bad key", { status: 401 });
    const msg = await req.json();
    if (!("id" in msg)) return new Response(null, { status: 202 });
    const result =
      msg.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "t" } }
        : { tools: [{ name: "publish_post", inputSchema: { type: "object", properties: {} } }] };
    return Response.json({ jsonrpc: "2.0", id: msg.id, result });
  },
});
// The client uses the global fetch, which other files stub; give it the real
// one, as mcp-http.test.ts does (on CI a leftover stub hung every call).
let stubbedFetch: typeof globalThis.fetch;
beforeAll(() => {
  stubbedFetch = globalThis.fetch;
  globalThis.fetch = Bun.fetch as typeof globalThis.fetch;
});
afterAll(() => {
  globalThis.fetch = stubbedFetch;
  server.stop(true);
});

function fakeRegistry() {
  const tools = new Map<string, Tool>();
  return {
    tools,
    has: (n: string) => tools.has(n),
    register: (t: Tool) => void tools.set(t.manifest.name, t),
    unregister: (n: string) => void tools.delete(n),
  };
}

function ctxAnswering(answer: string | null, asked: AskUserQuestion[][] = []): ToolContext {
  return {
    sessionId: "chat",
    askUser: answer === null ? undefined : {
      ask: async (qs: AskUserQuestion[]): Promise<AskUserAnswer[]> => {
        asked.push(qs);
        return [{ question: qs[0]!.question, selected: [answer] }];
      },
      cancel: () => {},
    },
  } as unknown as ToolContext;
}

function setup(existing?: object) {
  const path = join(mkdtempSync(join(tmpdir(), "cp-ext-")), "mcp.json");
  if (existing) writeFileSync(path, JSON.stringify(existing));
  const registry = fakeRegistry();
  const manager = new McpManager(registry as never, () => {}, path);
  return { path, registry, tool: createExtensionConnectTool(manager) };
}

const url = () => server.url.href;

describe("extension_connect", () => {
  test("Connect: the service is saved, connected, and its tools are the agent's", async () => {
    const { path, registry, tool } = setup();
    const asked: AskUserQuestion[][] = [];
    const res = JSON.parse((await tool.execute({ url: url(), name: "Publora", key: "sk_good" }, ctxAnswering("Connect", asked))).content);
    expect(res).toMatchObject({ connected: true, tools: ["mcp_publish_post"] });
    expect(asked[0]![0]!.question).toContain("Publora");
    expect(registry.has("mcp_publish_post")).toBe(true);
    const saved = loadMcpConfig(path);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.headers?.Authorization).toBe("Bearer sk_good");
  });

  test("a refused key leaves the file exactly as it was, and says what to do", async () => {
    const before = { servers: [{ id: "git", name: "Git", command: "x", args: [], enabled: false }] };
    const { path, registry, tool } = setup(before);
    const res = JSON.parse((await tool.execute({ url: url(), key: "sk_bad" }, ctxAnswering("Connect"))).content);
    expect(res.connected).toBe(false);
    expect(res.next).toContain("refused the key");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(before);
    expect(registry.tools.size).toBe(0);
  });

  test("on a first install a failed add leaves no file behind", async () => {
    const { path, tool } = setup();
    await tool.execute({ url: url(), key: "sk_bad" }, ctxAnswering("Connect"));
    expect(existsSync(path)).toBe(false);
  });

  test("anything but Connect adds nothing, and a chat that cannot ask adds nothing", async () => {
    for (const ctx of [ctxAnswering("Not now"), ctxAnswering(null)]) {
      const { path, tool } = setup();
      const res = await tool.execute({ url: url(), key: "sk_good" }, ctx);
      expect(res.content).toMatch(/person_declined|needs_confirmation/);
      expect(existsSync(path)).toBe(false);
    }
  });
});

describe("customServer", () => {
  test("matches what the desktop's Add your own writes", () => {
    const s = customServer("https://mcp.publora.com", "sk_1") as Exclude<ReturnType<typeof customServer>, string>;
    expect(s.id).toBe("custom-mcp-publora-com");
    expect(s.url).toBe("https://mcp.publora.com/");
    expect(s.headers).toEqual({ Authorization: "Bearer sk_1" });
    expect(customServer("http://mcp.publora.com", "sk")).toContain("https://");
    expect(customServer("https://x.dev", "a\nb")).toContain("line break");
  });
});

test("the registry accepts extension_connect's manifest (a refused one stopped the engine at start, 22 Oct)", () => {
  const tool = createExtensionConnectTool({ addServer: async () => ({ ok: true, tools: [] }) });
  expect(() => validateManifest(tool.manifest)).not.toThrow();
});
