/**
 * DuckDuckGo Lite — the keyless search backend Cinderpaw ships with.
 *
 * Why this exists: before it, a default install had NO working web search at
 * all. `web_search` needed a self-hosted SearXNG (`CINDERPAW_SEARXNG_URL`), which
 * nobody has on first run; its no-backend path called DuckDuckGo's *Instant
 * Answer* API, a disambiguation service that returns nothing for real queries;
 * and its declared escalation, `deep_research`, searches through `s.jina.ai`,
 * which now answers 401 without an API key. Three paths, all dead — the agent
 * failed almost every search, each time for a different-looking reason.
 *
 * lite.duckduckgo.com serves ranked results as plain HTML with no key and no
 * browser User-Agent (verified live 2026-08-01: 10 results per query, ~800ms).
 *
 * ⚠️ It is BEST-EFFORT, not a search engine we control: DDG rate-limits
 * automated use after roughly 7 rapid queries and then serves an anti-bot page
 * for a long while (see ddgLiteSearch). That makes it a decent default for a
 * user who searches occasionally, and inadequate for sustained research.
 * SearXNG stays the real answer — several engines, no throttle, and the query
 * never leaves the user's machine.
 *
 * ponytail: regex over the HTML, no parser dependency. The markup is a 2000-era
 * table and has been stable for years; if DDG restyles it, `results.length === 0`
 * surfaces as an honest search failure, not as a wrong answer. Swap in a real
 * parser only if that actually starts happening.
 */

import type { FeralFetch } from "../../types.ts";
import { cfgInt } from "../../config.ts";

/** Whitelist entry covering lite.duckduckgo.com and the /l/ redirector. */
export const DDG_DOMAIN = "duckduckgo.com";

export interface DdgResult {
  title: string;
  url: string;
  snippet?: string;
}

/**
 * One pass over the document, in order: every match is either a result anchor
 * or the snippet cell that follows it. Zipping two separate scans by index
 * would silently mis-pair whenever a result ships without an abstract.
 */
const TOKEN_RE =
  /<a[^>]*?href=["']([^"']+)["'][^>]*?class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>|<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;

export function parseDdgLite(html: string, limit = 8): DdgResult[] {
  const out: DdgResult[] = [];
  for (const m of html.matchAll(TOKEN_RE)) {
    if (m[1] !== undefined) {
      if (out.length >= limit) break;
      const url = unwrapRedirect(m[1]);
      const title = clean(m[2] ?? "");
      if (url && title) out.push({ title, url });
    } else if (m[3] !== undefined) {
      const last = out[out.length - 1];
      if (last && !last.snippet) last.snippet = clean(m[3]);
    }
  }
  return out;
}

/**
 * DDG wraps every result in `//duckduckgo.com/l/?uddg=<encoded target>`. Hand
 * that to the model and read_webpage fetches a redirector instead of the page,
 * so unwrap it here. A href that isn't wrapped is passed through unchanged.
 */
function unwrapRedirect(href: string): string {
  const raw = decodeEntities(href.trim());
  try {
    const u = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    const target = u.searchParams.get("uddg");
    if (target) return target;
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : "";
  } catch {
    return "";
  }
}

function clean(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    const named = NAMED[body.toLowerCase()];
    if (named !== undefined) return named;
    const num = body.startsWith("#x") || body.startsWith("#X")
      ? Number.parseInt(body.slice(2), 16)
      : body.startsWith("#")
        ? Number.parseInt(body.slice(1), 10)
        : NaN;
    return Number.isFinite(num) ? String.fromCodePoint(num) : whole;
  });
}

export interface DdgSearchOutcome {
  results: DdgResult[];
  /** DDG served its anti-bot page instead of results. Distinct from "no
   *  results" because the fix is completely different, and reporting it as an
   *  empty search sends the user hunting for a query problem that isn't one. */
  throttled: boolean;
}

/**
 * ⭐ DDG throttles by RATE, not by volume — which is what makes a keyless
 * backend viable at all. Measured 2026-08-01 from one IP:
 *
 *   12 queries back-to-back  →  7 served, then HTTP 202 anti-bot for >10 min
 *   15 queries paced 1 / 10s →  15 / 15 served
 *   12 queries paced 1 / 5s  →  12 / 12 served
 *   12 queries paced 1 / 3s  →  12 / 12 served
 *
 * The default sits at 5s: measured clean, with margin over the tightest gap
 * that still worked, because the limit is per-IP — a second Cinderpaw, a browser,
 * or someone else in the house shares the budget. Raise it if you see
 * `rate_limited`; the ceiling on lowering it is roughly 3s.
 *
 * So the fix is a pacer, not a different engine (every other keyless engine
 * tested was either blocked outright or returned junk relevance). Requests are
 * serialised through one queue with a minimum gap; parallel tool calls line up
 * behind it rather than bursting, which is exactly the pattern that trips the
 * limiter.
 *
 * Hammering while blocked appears to SUSTAIN the block — a 1/min probe stayed
 * refused for ten minutes straight. So a detected block backs off completely
 * for `COOLDOWN_MS` instead of retrying.
 */
const DEFAULT_MIN_INTERVAL_MS = 5_000;
const COOLDOWN_MS = 120_000;

let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;
let blockedUntil = 0;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(new Error("aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Test seam: reset the module-level pacer between cases. */
export function __resetDdgPacer(): void {
  queue = Promise.resolve();
  lastRequestAt = 0;
  blockedUntil = 0;
}

function minIntervalMs(): number {
  const raw = cfgInt("CINDERPAW_DDG_MIN_INTERVAL_MS");
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MIN_INTERVAL_MS;
}

/**
 * Search DuckDuckGo Lite through the caller's sandboxed fetch, paced so we stay
 * under the rate limit. Never returns results on failure — callers must treat
 * an empty set as a failed search, never as "the web has nothing", which was
 * the original bug in this tool.
 */
export async function ddgLiteSearch(
  fetch: FeralFetch,
  query: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<DdgSearchOutcome> {
  // Already refused recently: report it without adding load.
  if (Date.now() < blockedUntil) return { results: [], throttled: true };

  const turn = queue.then(async () => {
    const wait = lastRequestAt + minIntervalMs() - Date.now();
    if (wait > 0) await sleep(wait, opts.signal);
    lastRequestAt = Date.now();
  });
  // The queue must survive a rejected turn, or one abort wedges every caller.
  queue = turn.catch(() => {});

  try {
    await turn;
  } catch {
    return { results: [], throttled: false }; // aborted while waiting
  }

  // Re-check: a request that ran while we queued may have hit the limiter.
  if (Date.now() < blockedUntil) return { results: [], throttled: true };

  try {
    const res = await fetch(
      `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query.trim())}`,
      { timeoutMs: 15_000, signal: opts.signal },
    );
    if (!res.ok) return { results: [], throttled: false };
    const html = await res.text();
    const results = parseDdgLite(html, opts.limit ?? 8);
    // 202 is DDG's anti-bot status; the marker catches it changing the code.
    const throttled =
      results.length === 0 && (res.status === 202 || /anomaly|unusual traffic/i.test(html));
    if (throttled) blockedUntil = Date.now() + COOLDOWN_MS;
    return { results, throttled };
  } catch {
    return { results: [], throttled: false };
  }
}

/** What to tell the user when DDG has cut us off despite the pacing. */
export const DDG_THROTTLED_HINT =
  "DuckDuckGo is rate-limiting this machine and searches are paused for a " +
  "couple of minutes. Cinderpaw already paces its queries to stay under the limit, " +
  "so hitting this means unusually heavy searching (or another client on the " +
  "same connection). For search with no rate limit at all, run a SearXNG " +
  "instance and set CINDERPAW_SEARXNG_URL — see docs/CONFIGURATION.md.";
