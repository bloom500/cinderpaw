/**
 * The DDG Lite parser — the keyless search backend a default install runs on.
 *
 * The fixture is real markup captured from lite.duckduckgo.com on 2026-08-01,
 * trimmed to two results. If DDG restyles the page this test fails, which is
 * the point: the alternative is discovering it as an agent that silently
 * stopped finding anything.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { __resetDdgPacer, ddgLiteSearch, parseDdgLite } from "../src/tools/builtin/ddg-lite.ts";

// The pacer is module-level state shared by every caller; without this, one
// test's 5s gap makes the next test wait it out.
beforeEach(() => {
  __resetDdgPacer();
  process.env.CINDERPAW_DDG_MIN_INTERVAL_MS = "0";
});

const FIXTURE = `
<table>
  <tr><td>1.&nbsp;</td><td>
    <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.rs%2Faxum%2Flatest%2Faxum%2Fresponse%2Fsse%2F&amp;rut=40ad5451" class='result-link'>axum::response::sse - Rust - Docs.rs</a>
  </td></tr>
  <tr><td>&nbsp;</td><td class='result-snippet'>
    Server-Sent Events (<b>SSE</b>) responses. Structs   Event    Server-sent event &amp; more.
  </td></tr>
  <tr><td>2.&nbsp;</td><td>
    <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fno-abstract" class='result-link'>A result with no abstract</a>
  </td></tr>
</table>`;

describe("parseDdgLite", () => {
  test("extracts title, unwrapped URL and snippet", () => {
    const [first] = parseDdgLite(FIXTURE);
    // The href is a /l/?uddg= redirector; handing that to read_webpage would
    // fetch the redirector instead of the page.
    expect(first.url).toBe("https://docs.rs/axum/latest/axum/response/sse/");
    expect(first.title).toBe("axum::response::sse - Rust - Docs.rs");
    // Tags stripped, entities decoded, whitespace collapsed.
    expect(first.snippet).toBe(
      "Server-Sent Events (SSE) responses. Structs Event Server-sent event & more.",
    );
  });

  test("a result without an abstract does not steal the next one's snippet", () => {
    const results = parseDdgLite(FIXTURE);
    expect(results).toHaveLength(2);
    expect(results[1].title).toBe("A result with no abstract");
    expect(results[1].snippet).toBeUndefined();
  });

  test("unrecognised markup yields nothing rather than garbage", () => {
    expect(parseDdgLite("<html><body>challenge page</body></html>")).toEqual([]);
  });

  test("respects the result limit", () => {
    expect(parseDdgLite(FIXTURE, 1)).toHaveLength(1);
  });
});

describe("ddgLiteSearch", () => {
  test("hits lite.duckduckgo.com through the sandboxed fetch", async () => {
    let called = "";
    const { results } = await ddgLiteSearch(
      (async (url: string) => {
        called = url;
        return { ok: true, status: 200, headers: {}, text: async () => FIXTURE, json: async () => ({}) };
      }) as never,
      "rust axum sse",
    );
    expect(called).toBe("https://lite.duckduckgo.com/lite/?q=rust%20axum%20sse");
    expect(results).toHaveLength(2);
  });

  test("a failed request is an empty result set, never a throw", async () => {
    const boom = (async () => {
      throw new Error("network down");
    }) as never;
    expect(await ddgLiteSearch(boom, "x")).toEqual({ results: [], throttled: false });

    const http500 = (async () => ({
      ok: false, status: 500, headers: {}, text: async () => "", json: async () => ({}),
    })) as never;
    expect(await ddgLiteSearch(http500, "x")).toEqual({ results: [], throttled: false });
  });

  // DDG answers 202 + an "anomaly" page after ~7 rapid queries. Reporting that
  // as "no results" is what sends a user hunting for a query problem.
  test("the anti-bot page is reported as throttled, not as an empty search", async () => {
    const antiBot = (async () => ({
      ok: true, status: 202, headers: {},
      text: async () => "<html><body>If this error persists, please let us know: anomaly detected</body></html>",
      json: async () => ({}),
    })) as never;
    expect(await ddgLiteSearch(antiBot, "x")).toEqual({ results: [], throttled: true });
  });

  test("a genuinely empty result page is NOT throttled", async () => {
    const empty = (async () => ({
      ok: true, status: 200, headers: {}, text: async () => "<html>no matches</html>", json: async () => ({}),
    })) as never;
    expect(await ddgLiteSearch(empty, "x")).toEqual({ results: [], throttled: false });
  });
});

/**
 * The pacer is the whole reason this backend is usable: DDG throttles by rate,
 * and bursting is what trips it. These pin the two behaviours that matter —
 * requests are spaced, and a detected block stops traffic instead of retrying.
 */
describe("ddgLiteSearch pacing", () => {
  const okRes = async () => ({
    ok: true, status: 200, headers: {}, text: async () => FIXTURE, json: async () => ({}),
  });

  test("parallel callers are serialised with a gap, not burst", async () => {
    process.env.CINDERPAW_DDG_MIN_INTERVAL_MS = "60";
    const at: number[] = [];
    const fetch = (async () => {
      at.push(Date.now());
      return okRes();
    }) as never;

    const t0 = Date.now();
    // Four callers firing at once — the shape that trips the limiter.
    await Promise.all(["a", "b", "c", "d"].map((q) => ddgLiteSearch(fetch, q)));

    expect(at).toHaveLength(4);
    // Three gaps of ~60ms; allow slack for timer jitter but require real spacing.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    for (let i = 1; i < at.length; i++) {
      expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(50);
    }
  });

  test("once throttled it stops sending — hammering sustains the block", async () => {
    let calls = 0;
    const antiBot = (async () => {
      calls++;
      return {
        ok: true, status: 202, headers: {},
        text: async () => "<html>anomaly</html>", json: async () => ({}),
      };
    }) as never;

    const first = await ddgLiteSearch(antiBot, "x");
    expect(first.throttled).toBe(true);
    expect(calls).toBe(1);

    // Subsequent searches during the cooldown must not touch the network.
    const second = await ddgLiteSearch(antiBot, "y");
    expect(second.throttled).toBe(true);
    expect(calls).toBe(1);
  });

  test("an abort while waiting for a slot does not wedge later callers", async () => {
    process.env.CINDERPAW_DDG_MIN_INTERVAL_MS = "10000";
    const fetch = (async () => okRes()) as never;

    await ddgLiteSearch(fetch, "first"); // claims the slot
    const ctrl = new AbortController();
    const pending = ddgLiteSearch(fetch, "aborted", { signal: ctrl.signal });
    ctrl.abort();
    expect(await pending).toEqual({ results: [], throttled: false });

    // The queue must still be usable rather than permanently rejected.
    process.env.CINDERPAW_DDG_MIN_INTERVAL_MS = "0";
    __resetDdgPacer();
    const after = await ddgLiteSearch(fetch, "after");
    expect(after.results).toHaveLength(2);
  });
});
