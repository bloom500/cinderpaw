/**
 * Egress rate limit — per tool, not one global budget.
 *
 * The old limiter was a single window shared by every tool, so one
 * `deep_research` call could spend the whole minute's allowance and the next
 * `web_search` — a different tool, doing legitimate work — was refused. On an
 * unattended run that reads to the agent as a permission block, so it stops
 * trying instead of waiting.
 */

import { describe, expect, test } from "bun:test";
import { EgressProxy } from "../src/egress/egress-proxy.ts";
import type { ToolManifest } from "../src/types.ts";

const PER_TOOL_LIMIT = 20;

function toolManifest(name: string): ToolManifest {
  return {
    name,
    description: name,
    permissions: [],
    networkAccess: true,
    allowedDomains: ["example.com"],
  };
}

/** A proxy whose underlying fetch never touches the network. */
function proxy(overrides: Parameters<typeof EgressProxy.prototype.constructor>[1] = {}) {
  return new EgressProxy(() => {}, {
    underlyingFetch: async () => new Response("ok", { status: 200 }),
    ...overrides,
  });
}

async function hit(fetchFn: ReturnType<EgressProxy["forTool"]>, n: number) {
  let ok = 0;
  let blocked = 0;
  for (let i = 0; i < n; i++) {
    try {
      await fetchFn("https://example.com/");
      ok++;
    } catch {
      blocked++;
    }
  }
  return { ok, blocked };
}

describe("per-tool rate limiting", () => {
  test(`each tool gets its own window of ${PER_TOOL_LIMIT}`, async () => {
    const p = proxy();
    const research = p.forTool(toolManifest("deep_research"), "s");
    const first = await hit(research, PER_TOOL_LIMIT);
    expect(first.ok).toBe(PER_TOOL_LIMIT);
    expect(first.blocked).toBe(0);
  });

  test("the limit is enforced — request 21 is refused", async () => {
    const p = proxy();
    const research = p.forTool(toolManifest("deep_research"), "s");
    await hit(research, PER_TOOL_LIMIT);
    await expect(research("https://example.com/")).rejects.toThrow(/rate limit exceeded/i);
  });

  test("one exhausted tool does not starve another — the actual bug", async () => {
    const p = proxy();
    const research = p.forTool(toolManifest("deep_research"), "s");
    const search = p.forTool(toolManifest("web_search"), "s");

    // deep_research burns its whole budget…
    await hit(research, PER_TOOL_LIMIT + 5);
    // …and web_search is untouched.
    const after = await hit(search, PER_TOOL_LIMIT);
    expect(after.ok).toBe(PER_TOOL_LIMIT);
    expect(after.blocked).toBe(0);
  });

  test("the block message says throttling, not permission denied", async () => {
    const p = proxy();
    const search = p.forTool(toolManifest("web_search"), "s");
    await hit(search, PER_TOOL_LIMIT);
    try {
      await search("https://example.com/");
      throw new Error("should have been throttled");
    } catch (e) {
      const msg = String(e);
      expect(msg).toContain("web_search"); // which tool
      expect(msg).toMatch(/temporary/i); // and that it passes
      expect(msg).toMatch(/not a permission denial/i);
    }
  });

  test("the same tool shares one window across sessions", async () => {
    // Deliberate: the key is the tool, not tool+session, so the ceiling does
    // not multiply by however many surfaces are live.
    const p = proxy();
    const desktop = p.forTool(toolManifest("web_search"), "desktop");
    const discord = p.forTool(toolManifest("web_search"), "discord:c:u");
    await hit(desktop, PER_TOOL_LIMIT);
    await expect(discord("https://example.com/")).rejects.toThrow(/rate limit exceeded/i);
  });

  test("the window rolls — an expired budget comes back", async () => {
    const p = proxy({ windowMs: 1 });
    const search = p.forTool(toolManifest("web_search"), "s");
    await hit(search, PER_TOOL_LIMIT);
    await Bun.sleep(5);
    const after = await hit(search, 1);
    expect(after.ok).toBe(1);
  });

  test("rate limiting never overrides the security checks that run before it", async () => {
    const p = proxy();
    // An undeclared host is refused on the whitelist, not on the budget —
    // order matters, because a loosened limiter must not loosen anything else.
    const search = p.forTool(toolManifest("web_search"), "s");
    await expect(search("https://evil.com/")).rejects.toThrow(/not in allowedDomains/i);
    await expect(search("http://127.0.0.1:11435/")).rejects.toThrow(/loopback|private/i);
  });
});
