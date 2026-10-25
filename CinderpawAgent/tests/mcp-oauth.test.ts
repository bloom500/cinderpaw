/**
 * A web extension that connects with a sign-in in the browser (Notion and
 * Linear work this way). One real local server plays both parts: the
 * service's sign-in (discovery, registration, authorize, token) and the MCP
 * endpoint that turns away anyone without its token. The "browser" is a
 * fetch that follows the authorize redirect, the way a person pressing
 * Allow would.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessToken, browser, loadTokens, signIn } from "../src/egress/mcp-oauth.ts";
import { McpManager } from "../src/egress/mcp-manager.ts";

const issued = new Map<string, string>(); // code -> code_challenge
let tokenCalls = 0;
const valid = new Set<string>();

const service = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    const base = `http://127.0.0.1:${service.port}`;
    if (u.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return Response.json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["read"] });
    }
    if (u.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
      });
    }
    if (u.pathname === "/register") {
      const body = (await req.json()) as { redirect_uris: string[]; token_endpoint_auth_method: string };
      expect(body.token_endpoint_auth_method).toBe("none");
      return Response.json({ client_id: "c1", redirect_uris: body.redirect_uris });
    }
    if (u.pathname === "/authorize") {
      expect(u.searchParams.get("code_challenge_method")).toBe("S256");
      expect(u.searchParams.get("resource")).toBe(`${base}/mcp`);
      const code = `code-${issued.size}`;
      issued.set(code, u.searchParams.get("code_challenge")!);
      const back = new URL(u.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", u.searchParams.get("state")!);
      return Response.redirect(back.href, 302);
    }
    if (u.pathname === "/token") {
      tokenCalls++;
      const form = new URLSearchParams(await req.text());
      if (form.get("grant_type") === "authorization_code") {
        const challenge = createHash("sha256").update(form.get("code_verifier")!).digest("base64url");
        if (issued.get(form.get("code")!) !== challenge) return Response.json({ error: "invalid_grant" }, { status: 400 });
        valid.add("at-1");
        return Response.json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 });
      }
      if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === "rt-1") {
        valid.add("at-2");
        return Response.json({ access_token: "at-2", expires_in: 3600 });
      }
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (u.pathname === "/mcp") {
      const auth = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      if (!valid.has(auth)) {
        return new Response("", {
          status: 401,
          headers: { "www-authenticate": `Bearer realm="OAuth", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` },
        });
      }
      const msg = (await req.json()) as { id?: number; method: string };
      if (msg.id === undefined) return new Response(null, { status: 202 });
      if (msg.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "t" } } });
      }
      return Response.json({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "search_pages", description: "Search", inputSchema: { type: "object" } }] } });
    }
    return new Response("not here", { status: 404 });
  },
});
const mcpUrl = () => `http://127.0.0.1:${service.port}/mcp`;

/** A person pressing Allow: follow the authorize redirect back to Cinderpaw. */
let opened: string[] = [];
const allow = (url: string) => {
  opened.push(url);
  void fetch(url, { redirect: "manual" }).then((r) => fetch(r.headers.get("location")!));
};
const realOpen = browser.open;
let stubbedFetch: typeof globalThis.fetch;

beforeAll(() => {
  stubbedFetch = globalThis.fetch;
  globalThis.fetch = Bun.fetch as typeof globalThis.fetch;
});
afterEach(() => {
  browser.open = realOpen;
  opened = [];
});
afterAll(() => {
  globalThis.fetch = stubbedFetch;
  service.stop(true);
});

const wwwAuth = () => `Bearer resource_metadata="http://127.0.0.1:${service.port}/.well-known/oauth-protected-resource/mcp"`;

describe("signing in to a web extension in the browser", () => {
  test("discovers, registers, signs in with PKCE, and keeps the tokens", async () => {
    const tokens = await signIn("svc-a", mcpUrl(), wwwAuth(), { open: allow, timeoutMs: 10_000 });
    expect(opened.length).toBe(1);
    expect(tokens.accessToken).toBe("at-1");
    expect(loadTokens("svc-a")?.refreshToken).toBe("rt-1");
    expect(await accessToken("svc-a")).toBe("at-1");
  });

  test("a token about to run out is refreshed before it is sent", async () => {
    const t = loadTokens("svc-a")!;
    writeFileSync(join(process.env.CINDERPAW_HOME!, "mcp-oauth", "svc-a.json"), JSON.stringify({ ...t, expiresAt: Date.now() + 1_000 }));
    expect(await accessToken("svc-a")).toBe("at-2");
    expect(loadTokens("svc-a")?.refreshToken).toBe("rt-1");
  });

  test("nobody finishing in the browser ends with a plain reason, not a hang", async () => {
    await expect(signIn("svc-b", mcpUrl(), wwwAuth(), { open: () => {}, timeoutMs: 200 })).rejects.toThrow(
      /nobody finished signing in/,
    );
  });
});

describe("the extension manager", () => {
  const registry = () => {
    const tools = new Map<string, unknown>();
    return {
      tools,
      has: (n: string) => tools.has(n),
      register: (t: { manifest: { name: string } }) => tools.set(t.manifest.name, t),
      unregister: (n: string) => tools.delete(n),
    };
  };

  test("Connect on a sign-in service opens the browser once, then its tools arrive", async () => {
    browser.open = allow;
    const reg = registry();
    const path = join(mkdtempSync(join(tmpdir(), "cinderpaw-oauth-")), "mcp.json");
    const m = new McpManager(reg as never, (() => {}) as never, path);
    const res = await m.addServer({ id: "svc-c", name: "Svc", command: "", args: [], url: mcpUrl(), enabled: true });
    expect(res).toEqual({ ok: true, tools: ["mcp_search_pages"] });
    expect(opened.length).toBe(1);
  });

  test("starting the app never opens a browser by itself", async () => {
    let asked = 0;
    browser.open = () => asked++;
    const path = join(mkdtempSync(join(tmpdir(), "cinderpaw-oauth-boot-")), "mcp.json");
    writeFileSync(path, JSON.stringify({ servers: [{ id: "svc-d", name: "Svc", command: "", args: [], url: mcpUrl(), enabled: true }] }));
    const m = new McpManager(registry() as never, (() => {}) as never, path);
    await m.reconcile();
    expect(asked).toBe(0);
    expect(m.status()[0]?.error).toContain("browser-sign-in");
  });
});
