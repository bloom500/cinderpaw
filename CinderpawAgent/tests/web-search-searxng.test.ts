/**
 * web_search over SearXNG + the egress SSRF exemption that makes a
 * self-hosted instance reachable at all.
 *
 * The bug this file pins down: web_search used to return `ok: true` with
 * "No instant answer found" when the backend gave it nothing. That reads as a
 * satisfied search, so the declared fallback chain never fired and the model
 * answered from stale training data. An empty result set must be a FAILURE.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { createWebSearchTool } from "../src/tools/builtin/web-search.ts";
import { __resetDdgPacer } from "../src/tools/builtin/ddg-lite.ts";
import { EgressBlockedError, EgressProxy } from "../src/egress/egress-proxy.ts";
import type { ToolContext } from "../src/types.ts";

const ORIGIN = "http://127.0.0.1:8888";

// The DDG pacer is module-level and defaults to a 5s gap; tests must not
// inherit a slot claimed by another file.
beforeEach(() => {
  __resetDdgPacer();
  process.env.CINDERPAW_DDG_MIN_INTERVAL_MS = "0";
});

/** Minimal ToolContext with a stubbed fetch — no network in tests. */
function ctxWith(fetch: unknown): ToolContext {
  return { fetch, sessionId: "test" } as unknown as ToolContext;
}

function jsonRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function htmlRes(html: string, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => html, json: async () => ({}) };
}

describe("web_search / SearXNG", () => {
  test("returns ranked results from a SearXNG instance", async () => {
    const tool = createWebSearchTool({ searxngOrigin: ORIGIN });
    let called = "";
    const res = await tool.execute(
      { query: "who won the 2026 super bowl" },
      ctxWith(async (url: string) => {
        called = url;
        return jsonRes({
          results: [
            { title: "Super Bowl LX", url: "https://example.com/sb", content: "Final score." },
            { title: "Recap", url: "https://example.com/recap" },
          ],
        });
      }),
    );

    expect(called).toStartWith(`${ORIGIN}/search?q=`);
    expect(called).toContain("format=json");
    expect(res.ok).toBe(true);
    expect(res.content).toContain("Super Bowl LX — Final score.");
    expect(res.content).toContain("https://example.com/sb");
    // A result with no snippet still surfaces its title.
    expect(res.content).toContain("Recap");
  });

  test("an empty result set is a failure, so the fallback chain can fire", async () => {
    const tool = createWebSearchTool({ searxngOrigin: ORIGIN });
    const res = await tool.execute(
      { query: "nothing matches this" },
      ctxWith(async () => jsonRes({ results: [] })),
    );

    // The whole point: NOT ok. An ok:true here strands the model on stale data.
    expect(res.ok).toBe(false);
    expect(res.error).toBe("no_results");
    // And the tool declares the escalation path.
    expect(tool.manifest.fallback).toContain("deep_research");
  });

  test("403 on the JSON API names the actual fix (SearXNG ships JSON disabled)", async () => {
    const tool = createWebSearchTool({ searxngOrigin: ORIGIN });
    const res = await tool.execute(
      { query: "x" },
      ctxWith(async () => jsonRes({}, 403)),
    );

    expect(res.ok).toBe(false);
    expect(res.content).toContain("settings.yml");
    expect(res.content).toContain("json");
  });

  test("with no SearXNG it searches DuckDuckGo instead of failing", async () => {
    const tool = createWebSearchTool({ searxngOrigin: null });
    let called = "";
    const res = await tool.execute(
      { query: "current events" },
      ctxWith(async (url: string) => {
        called = url;
        return htmlRes(
          `<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fnews" class='result-link'>Today</a>`,
        );
      }),
    );

    expect(called).toStartWith("https://lite.duckduckgo.com/lite/?q=");
    expect(res.ok).toBe(true);
    expect(res.content).toContain("https://example.com/news");
  });

  test("no SearXNG AND no DDG results still fails, and names the upgrade", async () => {
    const tool = createWebSearchTool({ searxngOrigin: null });
    const res = await tool.execute(
      { query: "current events" },
      ctxWith(async () => htmlRes("<html>nothing here</html>")),
    );

    expect(res.ok).toBe(false);
    expect(res.error).toBe("no_results");
    expect(res.content).toContain("CINDERPAW_SEARXNG_URL");
  });

  test("a broken SearXNG degrades to DDG and says so, rather than dying", async () => {
    const tool = createWebSearchTool({ searxngOrigin: ORIGIN });
    const res = await tool.execute(
      { query: "x" },
      ctxWith(async (url: string) =>
        url.startsWith(ORIGIN)
          ? jsonRes({}, 403)
          : htmlRes(
              `<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx" class='result-link'>X</a>`,
            ),
      ),
    );

    expect(res.ok).toBe(true);
    // The result is real, but the broken backend is not swept under the rug.
    expect(res.content).toContain("fell back to DuckDuckGo");
    expect(res.content).toContain("settings.yml");
    expect(res.content).toContain("https://example.com/x");
  });

  test("only the configured SearXNG host is whitelisted", () => {
    expect(createWebSearchTool({ searxngOrigin: ORIGIN }).manifest.allowedDomains)
      .toContain("127.0.0.1");
    expect(createWebSearchTool({ searxngOrigin: null }).manifest.allowedDomains)
      .not.toContain("127.0.0.1");
  });
});

describe("egress SSRF exemption for a self-hosted origin", () => {
  const audit = (() => {}) as never; // AuditLogger is a function, not an object
  const manifest = {
    name: "web_search",
    description: "",
    permissions: ["network:outbound"],
    networkAccess: true,
    allowedDomains: ["127.0.0.1"],
  } as never;

  test("loopback stays blocked when the operator declared nothing", async () => {
    const proxy = new EgressProxy(audit);
    const fetch = proxy.forTool(manifest, "s");
    await expect(fetch(`${ORIGIN}/search?q=x`)).rejects.toThrow(/loopback|private|link-local/i);
  });

  test("the declared origin passes the guard", async () => {
    const proxy = new EgressProxy(audit, { trustedLocalOrigins: [ORIGIN] });
    const fetch = proxy.forTool(manifest, "s");
    // Assert on the error TYPE, not on whether the connection happens to
    // succeed: whatever comes back must not be an egress block. (A connection
    // refused — nothing listening on 8888 — is a pass; it means the request
    // reached the network layer.)
    const err = await fetch(`${ORIGIN}/search?q=x`, { timeoutMs: 500 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err instanceof EgressBlockedError).toBe(false);
  });

  test("trusting one local port does not trust another", async () => {
    const proxy = new EgressProxy(audit, { trustedLocalOrigins: [ORIGIN] });
    const fetch = proxy.forTool(manifest, "s");
    // The exemption is exact-origin: a different port on the same loopback
    // interface (an internal admin panel, say) is still blocked.
    await expect(fetch("http://127.0.0.1:9000/admin")).rejects.toThrow(
      /loopback|private|link-local/i,
    );
  });

  test("the exemption does not waive the tool's domain whitelist", async () => {
    const proxy = new EgressProxy(audit, { trustedLocalOrigins: ["http://10.0.0.5:8888"] });
    const fetch = proxy.forTool(manifest, "s"); // allowedDomains: 127.0.0.1 only
    await expect(fetch("http://10.0.0.5:8888/search?q=x")).rejects.toThrow(
      /not in allowedDomains/i,
    );
  });
});
